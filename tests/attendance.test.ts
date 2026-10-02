import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	agent,
	createTestCompany,
	createTestUser,
	loginAndGetCookie,
	superAdminCookie,
	userWithPermissions
} from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import { setServerClockForTests } from '../src/lib/clock.js';
import { distanceMeters } from '../src/lib/geo.js';

const uid = () => randomUUID().slice(0, 6).toUpperCase();

// Laos = UTC+7. Monday 2026-09-21, Saturday 2026-09-19.
const MON_0755 = '2026-09-21T00:55:00Z'; // 07:55 Laos
const MON_0803 = '2026-09-21T01:03:00Z'; // 08:03 Laos
const MON_0920 = '2026-09-21T02:20:00Z'; // 09:20 Laos (late — still allowed)
const MON_1712 = '2026-09-21T10:12:00Z'; // 17:12 Laos
const MON_0500 = '2026-09-20T22:00:00Z'; // 05:00 Laos Monday (too early)
const MON_1800 = '2026-09-21T11:00:00Z'; // 18:00 Laos (shift over)
const SAT_NOON = '2026-09-19T05:00:00Z'; // 12:00 Laos Saturday

let admin: string;
beforeAll(async () => {
	admin = await superAdminCookie();
});
afterEach(() => setServerClockForTests(null));

const at = (iso: string) => setServerClockForTests(() => new Date(iso));

const OFFICE = { startTime: '08:00', endTime: '17:00', breakMinutes: 60 };

async function createShift(companyId: string, body: Record<string, unknown> = {}) {
	const res = await agent()
		.post('/api/v1/shifts')
		.set('Cookie', admin)
		.send({ companyId, code: `S_${uid()}`, nameLao: 'ກະທົດສອບ', ...OFFICE, ...body });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
}

interface SetupOptions {
	shift?: Record<string, unknown>;
	employmentStatus?: string;
	withBranch?: boolean;
	noSchedule?: boolean;
	companyId?: string;
}

async function setup(opts: SetupOptions = {}) {
	const company = opts.companyId
		? await prisma.company.findUniqueOrThrow({ where: { id: opts.companyId } })
		: await createTestCompany();
	const branch = opts.withBranch
		? await prisma.branch.create({
				data: { companyId: company.id, code: `B_${uid()}`, nameLao: 'ສາຂາ' }
			})
		: null;
	const shift = await createShift(company.id, opts.shift);
	const { user, username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
	const employee = await prisma.employee.create({
		data: {
			employeeCode: `E_${uid()}`,
			firstNameLao: 'ທົດສອບ',
			lastNameLao: 'ເຂົ້າວຽກ',
			startDate: new Date('2024-01-01T00:00:00.000Z'),
			companyId: company.id,
			branchId: branch?.id ?? null,
			userId: user.id,
			employmentStatus: (opts.employmentStatus ?? 'ACTIVE') as never
		}
	});
	if (!opts.noSchedule) {
		await prisma.employeeScheduleAssignment.create({
			data: {
				employeeId: employee.id,
				shiftId: shift.id,
				effectiveFrom: new Date('2026-01-01T00:00:00.000Z')
			}
		});
	}
	const cookie = await loginAndGetCookie(username, password);
	return { company, branch, shift, user, employee, cookie };
}

const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1/attendance/me/${path}`).set('Cookie', cookie).send(body);
const checkIn = (cookie: string, body: Record<string, unknown> = {}) =>
	post('check-in', cookie, body);
const checkOut = (cookie: string, body: Record<string, unknown> = {}) =>
	post('check-out', cookie, body);
const today = (cookie: string) => agent().get('/api/v1/attendance/me/today').set('Cookie', cookie);

const HQ = { latitude: 17.9757, longitude: 102.6331 };
async function makeLocation(companyId: string, overrides: Record<string, unknown> = {}) {
	return prisma.workLocation.create({
		data: {
			companyId,
			code: `L_${uid()}`,
			nameLao: 'ສຳນັກງານໃຫຍ່',
			...HQ,
			radiusMeters: 150,
			requireGps: false,
			...overrides
		}
	});
}

describe('self attendance — authentication & eligibility', () => {
	it('requires authentication (401)', async () => {
		expect((await agent().get('/api/v1/attendance/me/today')).status).toBe(401);
		expect((await agent().post('/api/v1/attendance/me/check-in').send({})).status).toBe(401);
	});

	it('requires attendance.self (403)', async () => {
		const { cookie } = await userWithPermissions(['dashboard.view']);
		expect((await today(cookie)).status).toBe(403);
		expect((await checkIn(cookie)).status).toBe(403);
	});

	it('rejects a user with no linked employee', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);
		const res = await checkIn(cookie);
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('NO_LINKED_EMPLOYEE');
	});

	it('an inactive User is rejected by the session layer (401)', async () => {
		const s = await setup();
		await prisma.user.update({ where: { id: s.user.id }, data: { status: 'INACTIVE' } });
		at(MON_0803);
		expect((await checkIn(s.cookie)).status).toBe(401);
	});

	it('rejects RESIGNED, TERMINATED, SUSPENDED and ON_LEAVE employees', async () => {
		for (const employmentStatus of ['RESIGNED', 'TERMINATED', 'SUSPENDED', 'ON_LEAVE']) {
			const s = await setup({ employmentStatus });
			at(MON_0803);
			const res = await checkIn(s.cookie);
			expect(res.status, employmentStatus).toBe(403);
			expect(res.body.error.code).toBe('EMPLOYEE_NOT_ACTIVE');
			const state = await today(s.cookie);
			expect(state.body.data.allowedActions).toEqual({ checkIn: false, checkOut: false });
			expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(0);
		}
	});
});

describe('schedule rules', () => {
	it('rejects check-in with no active schedule', async () => {
		const s = await setup({ noSchedule: true });
		at(MON_0803);
		const res = await checkIn(s.cookie);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('NO_ACTIVE_SCHEDULE');
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	it('rejects check-in on a non-working weekday', async () => {
		const s = await setup();
		at(SAT_NOON);
		const res = await checkIn(s.cookie);
		expect(res.body.error.code).toBe('NO_SCHEDULED_WORK');
	});

	it('rejects check-in on a holiday', async () => {
		const s = await setup();
		await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				holidayDate: new Date('2026-09-21T00:00:00.000Z'),
				nameLao: 'ວັນພັກບໍລິສັດ',
				type: 'COMPANY'
			}
		});
		at(MON_0803);
		const res = await checkIn(s.cookie);
		expect(res.body.error.code).toBe('NO_SCHEDULED_WORK');
		expect((await today(s.cookie)).body.data.checkInBlocked.code).toBe('NO_SCHEDULED_WORK');
	});

	it('allows check-in on a normal working day (even a few minutes before the shift)', async () => {
		const s = await setup();
		at(MON_0755);
		const state = await today(s.cookie);
		expect(state.body.data.allowedActions).toEqual({ checkIn: true, checkOut: false });
		expect(state.body.data.schedule.expected).toMatchObject({
			startTime: '08:00',
			endTime: '17:00'
		});
		expect((await checkIn(s.cookie)).status).toBe(201);
	});

	it('refuses check-in far before the shift and after it has ended, but allows a late one', async () => {
		const early = await setup();
		at(MON_0500);
		const tooEarly = await checkIn(early.cookie);
		expect(tooEarly.body.error.code).toBe('TOO_EARLY_CHECK_IN');
		expect(await prisma.attendanceRecord.count({ where: { employeeId: early.employee.id } })).toBe(
			0
		);

		const late = await setup();
		at(MON_0920);
		expect((await checkIn(late.cookie)).status).toBe(201);

		const over = await setup();
		at(MON_1800);
		expect((await checkIn(over.cookie)).body.error.code).toBe('CHECK_IN_WINDOW_CLOSED');
	});

	it('honours the shift earlyCheckInMinutes window', async () => {
		const s = await setup({ shift: { earlyCheckInMinutes: 30 } });
		at('2026-09-21T00:25:00Z'); // 07:25 — before 07:30
		expect((await checkIn(s.cookie)).body.error.code).toBe('TOO_EARLY_CHECK_IN');
		at('2026-09-21T00:35:00Z'); // 07:35
		expect((await checkIn(s.cookie)).status).toBe(201);
	});
});

describe('check-in', () => {
	it('records a check-in with the SERVER timestamp and an immutable punch', async () => {
		const s = await setup();
		at(MON_0803);
		const res = await checkIn(s.cookie);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(new Date(res.body.data.punchedAt).toISOString()).toBe('2026-09-21T01:03:00.000Z');
		expect(res.body.data.attendance.status).toBe('IN_PROGRESS');

		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id },
			include: { punches: true }
		});
		expect(record.firstCheckInAt?.toISOString()).toBe('2026-09-21T01:03:00.000Z');
		expect(record.workDate.toISOString().slice(0, 10)).toBe('2026-09-21');
		expect(record.punches.length).toBe(1);
		expect(record.punches[0]).toMatchObject({ type: 'CHECK_IN', createdByUserId: s.user.id });
	});

	it('rejects any client-supplied timestamp or client-computed verdict', async () => {
		const s = await setup();
		at(MON_0803);
		for (const extra of [
			{ punchedAt: '2026-09-21T00:00:00Z' },
			{ time: '08:00' },
			{ checkInAt: '2026-09-21T00:00:00Z' },
			{ isInside: true },
			{ distanceMeters: 0 }
		]) {
			const res = await checkIn(s.cookie, extra);
			expect(res.status, JSON.stringify(extra)).toBe(400);
		}
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	it('rejects a duplicate check-in and returns the current attendance', async () => {
		const s = await setup();
		at(MON_0803);
		await checkIn(s.cookie);
		at('2026-09-21T01:30:00Z');
		const dup = await checkIn(s.cookie);
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('ALREADY_CHECKED_IN');
		expect(dup.body.error.details.attendance.status).toBe('IN_PROGRESS');
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(1);
	});

	it('keeps exactly one AttendanceRecord per employee and work date', async () => {
		const s = await setup();
		at(MON_0803);
		await checkIn(s.cookie);
		await expect(
			prisma.attendanceRecord.create({
				data: { employeeId: s.employee.id, workDate: new Date('2026-09-21T00:00:00.000Z') }
			})
		).rejects.toThrow();
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(1);
	});

	it('exposes no route to edit or delete records or punches', async () => {
		const s = await setup();
		at(MON_0803);
		await checkIn(s.cookie);
		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		const punch = await prisma.attendancePunch.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		for (const path of [
			`/api/v1/attendance/${record.id}`,
			`/api/v1/attendance-punches/${punch.id}`,
			`/api/v1/attendance/punches/${punch.id}`
		]) {
			expect(
				(await agent().patch(path).set('Cookie', admin).send({})).status,
				`PATCH ${path}`
			).toBe(404);
			expect((await agent().delete(path).set('Cookie', admin)).status, `DELETE ${path}`).toBe(404);
		}
	});
});

describe('check-out', () => {
	it('requires a prior check-in', async () => {
		const s = await setup();
		at(MON_1712);
		const res = await checkOut(s.cookie);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('NOT_CHECKED_IN');
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	it('completes the SAME attendance record', async () => {
		const s = await setup();
		at(MON_0803);
		const inRes = await checkIn(s.cookie);
		at(MON_1712);
		const out = await checkOut(s.cookie);
		expect(out.status, JSON.stringify(out.body)).toBe(200);
		expect(out.body.data.attendance.id).toBe(inRes.body.data.attendance.id);
		expect(out.body.data.attendance.status).toBe('COMPLETED');
		expect(new Date(out.body.data.attendance.lastCheckOutAt).toISOString()).toBe(
			'2026-09-21T10:12:00.000Z'
		);

		const punches = await prisma.attendancePunch.findMany({
			where: { employeeId: s.employee.id },
			orderBy: { punchedAt: 'asc' }
		});
		expect(punches.map((p) => p.type)).toEqual(['CHECK_IN', 'CHECK_OUT']);
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(1);
		// the state survives a "refresh"
		const state = (await today(s.cookie)).body.data;
		expect(state.attendance.status).toBe('COMPLETED');
		expect(state.allowedActions).toEqual({ checkIn: false, checkOut: false });
	});

	it('rejects a duplicate check-out and a second check-in for the completed day', async () => {
		const s = await setup();
		at(MON_0803);
		await checkIn(s.cookie);
		at(MON_1712);
		await checkOut(s.cookie);
		const dup = await checkOut(s.cookie);
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('ALREADY_CHECKED_OUT');
		expect((await checkIn(s.cookie)).body.error.code).toBe('ALREADY_COMPLETED');
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(2);
	});

	it('shows an unfinished record as MISSING_CHECK_OUT (derived) and refuses a late self check-out', async () => {
		const s = await setup();
		at(MON_0803);
		await checkIn(s.cookie);
		at('2026-09-21T15:30:00Z'); // 22:30 — past 17:00 + 4h grace
		const out = await checkOut(s.cookie);
		expect(out.status).toBe(409);
		expect(out.body.error.code).toBe('MISSING_CHECK_OUT');

		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(record.status).toBe('IN_PROGRESS'); // stored state untouched
		const detail = await agent().get(`/api/v1/attendance/${record.id}`).set('Cookie', admin);
		expect(detail.body.data.status).toBe('MISSING_CHECK_OUT');

		// the next working day starts a fresh record
		at('2026-09-22T01:03:00Z');
		expect((await checkIn(s.cookie)).status).toBe(201);
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(2);
	});
});

describe('overnight shifts', () => {
	const NIGHT = { startTime: '22:00', endTime: '06:00' };

	it('resolves the work date of an evening check-in', async () => {
		const s = await setup({ shift: NIGHT });
		at('2026-09-21T14:55:00Z'); // Mon 21:55 Laos
		const res = await checkIn(s.cookie);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data.attendance.workDate.slice(0, 10)).toBe('2026-09-21');
		expect(res.body.data.attendance.scheduled.crossesMidnight).toBe(true);
	});

	it('checks out after midnight into the SAME (previous-day) record without creating a next-day one', async () => {
		const s = await setup({ shift: NIGHT });
		at('2026-09-21T14:55:00Z'); // Mon 21:55
		const inRes = await checkIn(s.cookie);
		at('2026-09-21T22:55:00Z'); // Tue 05:55 Laos
		const state = (await today(s.cookie)).body.data;
		expect(state.workDate.slice(0, 10)).toBe('2026-09-21');
		expect(state.allowedActions).toEqual({ checkIn: false, checkOut: true });

		const out = await checkOut(s.cookie);
		expect(out.status, JSON.stringify(out.body)).toBe(200);
		expect(out.body.data.attendance.id).toBe(inRes.body.data.attendance.id);
		expect(out.body.data.attendance.workDate.slice(0, 10)).toBe('2026-09-21');

		const records = await prisma.attendanceRecord.findMany({
			where: { employeeId: s.employee.id }
		});
		expect(records.length).toBe(1);
		expect(records[0]!.workDate.toISOString().slice(0, 10)).toBe('2026-09-21');
		expect(records[0]!.status).toBe('COMPLETED');
	});

	it('a check-in at 00:30 belongs to the shift that started the previous evening', async () => {
		const s = await setup({ shift: NIGHT });
		at('2026-09-21T17:30:00Z'); // Tue 00:30 Laos
		const res = await checkIn(s.cookie);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data.attendance.workDate.slice(0, 10)).toBe('2026-09-21');
	});

	it('a day-shift check-in just after midnight is not attached to the previous day', async () => {
		const s = await setup();
		at('2026-09-21T17:05:00Z'); // Tue 00:05 Laos, 08:00 shift
		const res = await checkIn(s.cookie);
		expect(res.body.error.code).toBe('TOO_EARLY_CHECK_IN');
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	it('the Laos calendar-date boundary: 23:59 vs 00:00', async () => {
		const s = await setup({ shift: NIGHT });
		at('2026-09-21T16:59:00Z'); // Mon 23:59
		const before = await checkIn(s.cookie);
		expect(before.body.data.attendance.workDate.slice(0, 10)).toBe('2026-09-21');
	});
});

describe('GPS and work locations', () => {
	it('does not require GPS when the location has requireGps=false', async () => {
		const s = await setup();
		await makeLocation(s.company.id, { requireGps: false });
		at(MON_0803);
		expect((await checkIn(s.cookie)).status).toBe(201);
	});

	it('rejects a missing GPS fix when the location requires it — and creates nothing', async () => {
		const s = await setup();
		await makeLocation(s.company.id, { requireGps: true });
		at(MON_0803);
		const res = await checkIn(s.cookie);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('GPS_REQUIRED');
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(0);
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(0);
		expect((await today(s.cookie)).body.data.gpsRequired).toBe(true);
	});

	it('accepts a check-in inside the radius and stores the server-computed distance', async () => {
		const s = await setup();
		await makeLocation(s.company.id, { requireGps: true });
		at(MON_0803);
		const res = await checkIn(s.cookie, {
			latitude: HQ.latitude + 0.0009,
			longitude: HQ.longitude,
			accuracyMeters: 12
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const punch = await prisma.attendancePunch.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		const expected = distanceMeters(
			{ latitude: HQ.latitude + 0.0009, longitude: HQ.longitude },
			HQ
		);
		expect(punch.distanceMeters).toBeCloseTo(expected, 3);
		expect(punch.distanceMeters).toBeGreaterThan(95);
		expect(punch.distanceMeters).toBeLessThan(105);
		expect(punch.locationRadiusMeters).toBe(150);
		expect(punch.accuracyMeters).toBe(12);
	});

	it('rejects a check-in outside the radius (with the measured distance)', async () => {
		const s = await setup();
		await makeLocation(s.company.id, { requireGps: true });
		at(MON_0803);
		const res = await checkIn(s.cookie, {
			latitude: HQ.latitude + 0.0036,
			longitude: HQ.longitude,
			accuracyMeters: 10
		});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('OUTSIDE_WORK_LOCATION');
		expect(res.body.error.details.radiusMeters).toBe(150);
		expect(res.body.error.details.distanceMeters).toBeGreaterThan(350);
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	it('rejects a very inaccurate GPS fix', async () => {
		const s = await setup();
		await makeLocation(s.company.id, { requireGps: true });
		at(MON_0803);
		const res = await checkIn(s.cookie, { ...HQ, accuracyMeters: 950 });
		expect(res.body.error.code).toBe('GPS_ACCURACY_POOR');
	});

	it('verifies the haversine distance', () => {
		expect(distanceMeters(HQ, HQ)).toBe(0);
		// 1 degree of latitude ~ 111.19 km
		expect(
			distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })
		).toBeCloseTo(111_195, -2);
	});

	it('cannot be tricked with a client-side "inside" flag or a fake distance', async () => {
		const s = await setup();
		await makeLocation(s.company.id, { requireGps: true });
		at(MON_0803);
		const faked = await checkIn(s.cookie, {
			latitude: HQ.latitude + 0.05,
			longitude: HQ.longitude,
			accuracyMeters: 5,
			isInside: true
		});
		expect(faked.status).toBe(400);
		const honest = await checkIn(s.cookie, {
			latitude: HQ.latitude + 0.05,
			longitude: HQ.longitude,
			accuracyMeters: 5
		});
		expect(honest.body.error.code).toBe('OUTSIDE_WORK_LOCATION');
	});

	it('applies the same GPS policy to check-out', async () => {
		const s = await setup();
		const location = await makeLocation(s.company.id, { requireGps: false });
		at(MON_0803);
		await checkIn(s.cookie);
		await prisma.workLocation.update({ where: { id: location.id }, data: { requireGps: true } });
		at(MON_1712);
		expect((await checkOut(s.cookie)).body.error.code).toBe('GPS_REQUIRED');
		expect((await checkOut(s.cookie, { ...HQ, accuracyMeters: 8 })).status).toBe(200);
	});

	it('stores volunteered GPS even when the location does not require it', async () => {
		const s = await setup();
		await makeLocation(s.company.id, { requireGps: false });
		at(MON_0803);
		await checkIn(s.cookie, { ...HQ, accuracyMeters: 20 });
		const punch = await prisma.attendancePunch.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(punch.latitude).toBe(HQ.latitude);
		expect(punch.workLocationId).not.toBeNull();
	});

	it('prefers the employee branch location over the company-level one', async () => {
		const s = await setup({ withBranch: true });
		await makeLocation(s.company.id, { requireGps: false });
		await makeLocation(s.company.id, { branchId: s.branch!.id, requireGps: true });
		at(MON_0803);
		expect((await checkIn(s.cookie)).body.error.code).toBe('GPS_REQUIRED');
		expect((await today(s.cookie)).body.data.workLocation.requireGps).toBe(true);
	});

	it('falls back to the company-level location when the branch has none', async () => {
		const s = await setup({ withBranch: true });
		await makeLocation(s.company.id, { requireGps: true });
		at(MON_0803);
		expect((await checkIn(s.cookie)).body.error.code).toBe('GPS_REQUIRED');
	});

	it('ignores an INACTIVE location', async () => {
		const s = await setup({ withBranch: true });
		await makeLocation(s.company.id, {
			branchId: s.branch!.id,
			requireGps: true,
			status: 'INACTIVE'
		});
		at(MON_0803);
		const state = (await today(s.cookie)).body.data;
		expect(state.workLocation).toBeNull();
		expect((await checkIn(s.cookie)).status).toBe(201);
	});

	it('work-location API: company/branch mismatch is rejected; duplicate code 409; permissions', async () => {
		const a = await createTestCompany();
		const b = await createTestCompany();
		const foreignBranch = await prisma.branch.create({
			data: { companyId: b.id, code: `B_${uid()}`, nameLao: 'ສາຂາອື່ນ' }
		});
		const body = {
			companyId: a.id,
			code: `HO_${uid()}`,
			nameLao: 'ສຳນັກງານໃຫຍ່',
			...HQ,
			radiusMeters: 150
		};
		const mismatch = await agent()
			.post('/api/v1/work-locations')
			.set('Cookie', admin)
			.send({ ...body, branchId: foreignBranch.id });
		expect(mismatch.status).toBe(400);
		expect(mismatch.body.error.code).toBe('BRANCH_COMPANY_MISMATCH');

		expect(
			(await agent().post('/api/v1/work-locations').set('Cookie', admin).send(body)).status
		).toBe(201);
		expect(
			(await agent().post('/api/v1/work-locations').set('Cookie', admin).send(body)).status
		).toBe(409);
		expect(
			(
				await agent()
					.post('/api/v1/work-locations')
					.set('Cookie', admin)
					.send({ ...body, code: 'X', latitude: 200 })
			).status
		).toBe(400);

		const { cookie } = await userWithPermissions(['work_locations.view', 'work_locations.update']);
		const list = await agent()
			.get(`/api/v1/work-locations?companyId=${a.id}`)
			.set('Cookie', cookie);
		expect(list.body.data.total).toBe(1);
		const id = list.body.data.items[0].id;
		expect(
			(
				await agent()
					.patch(`/api/v1/work-locations/${id}`)
					.set('Cookie', cookie)
					.send({ status: 'INACTIVE' })
			).status
		).toBe(403);
		expect(
			(
				await agent()
					.patch(`/api/v1/work-locations/${id}`)
					.set('Cookie', cookie)
					.send({ radiusMeters: 200 })
			).status
		).toBe(200);
		expect(
			(await agent().post('/api/v1/work-locations').set('Cookie', cookie).send(body)).status
		).toBe(403);
	});
});

describe('snapshots', () => {
	it('keeps the original scheduled times after the Shift is edited', async () => {
		const s = await setup();
		at(MON_0803);
		await checkIn(s.cookie);
		const edit = await agent()
			.patch(`/api/v1/shifts/${s.shift.id}`)
			.set('Cookie', admin)
			.send({ startTime: '09:30', endTime: '18:30', breakMinutes: 30 });
		expect(edit.status).toBe(200);

		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(record).toMatchObject({
			scheduledStartTime: '08:00',
			scheduledEndTime: '17:00',
			scheduledBreakMinutes: 60,
			scheduledCrossesMidnight: false
		});
		const detail = await agent().get(`/api/v1/attendance/${record.id}`).set('Cookie', admin);
		expect(detail.body.data.scheduled).toMatchObject({
			startTime: '08:00',
			endTime: '17:00',
			breakMinutes: 60
		});
	});

	it('keeps the location/distance snapshot on a punch after the WorkLocation is edited', async () => {
		const s = await setup();
		const location = await makeLocation(s.company.id, { requireGps: true });
		at(MON_0803);
		await checkIn(s.cookie, {
			latitude: HQ.latitude + 0.0009,
			longitude: HQ.longitude,
			accuracyMeters: 10
		});
		const before = await prisma.attendancePunch.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});

		await agent()
			.patch(`/api/v1/work-locations/${location.id}`)
			.set('Cookie', admin)
			.send({ radiusMeters: 30, latitude: 10, longitude: 10 });
		const after = await prisma.attendancePunch.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(after.locationRadiusMeters).toBe(150);
		expect(after.distanceMeters).toBe(before.distanceMeters);
		expect(after.workLocationId).toBe(location.id);
	});
});

describe('admin attendance view', () => {
	async function twoEmployeesWithRecords() {
		const s = await setup();
		const other = await setup({ companyId: s.company.id });
		at(MON_0803);
		await checkIn(s.cookie);
		await checkIn(other.cookie);
		return { s, other };
	}

	it('requires attendance.view (403 for an employee)', async () => {
		const s = await setup();
		expect((await agent().get('/api/v1/attendance').set('Cookie', s.cookie)).status).toBe(403);
		expect(
			(
				await agent()
					.get('/api/v1/attendance')
					.set('Cookie', (await userWithPermissions([])).cookie)
			).status
		).toBe(403);
	});

	it('HR broad scope sees every employee, with filters, raw punches and location metadata', async () => {
		const { s, other } = await twoEmployeesWithRecords();
		const location = await makeLocation(s.company.id, { requireGps: false });
		at(MON_1712);
		await checkOut(s.cookie, { ...HQ, accuracyMeters: 15 });

		const { cookie } = await userWithPermissions(['attendance.view', 'employees.view_all']);
		const list = await agent()
			.get(`/api/v1/attendance?companyId=${s.company.id}&date=2026-09-21`)
			.set('Cookie', cookie);
		const ids = list.body.data.items.map((i: { employeeId: string }) => i.employeeId).sort();
		expect(ids).toEqual([s.employee.id, other.employee.id].sort());

		const completed = await agent()
			.get(`/api/v1/attendance?companyId=${s.company.id}&status=COMPLETED`)
			.set('Cookie', cookie);
		expect(completed.body.data.items.map((i: { employeeId: string }) => i.employeeId)).toEqual([
			s.employee.id
		]);
		const inProgress = await agent()
			.get(`/api/v1/attendance?companyId=${s.company.id}&status=IN_PROGRESS`)
			.set('Cookie', cookie);
		expect(inProgress.body.data.items.map((i: { employeeId: string }) => i.employeeId)).toEqual([
			other.employee.id
		]);
		const bySearch = await agent()
			.get(`/api/v1/attendance?search=${s.employee.employeeCode}`)
			.set('Cookie', cookie);
		expect(bySearch.body.data.total).toBe(1);

		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		const detail = await agent().get(`/api/v1/attendance/${record.id}`).set('Cookie', cookie);
		expect(detail.status).toBe(200);
		expect(detail.body.data.punches.map((p: { type: string }) => p.type)).toEqual([
			'CHECK_IN',
			'CHECK_OUT'
		]);
		const outPunch = detail.body.data.punches[1];
		expect(outPunch.latitude).toBe(HQ.latitude);
		expect(outPunch.workLocation.id).toBe(location.id);
		expect(outPunch.source).toBe('WEB');
		expect(detail.body.data.employee.employeeCode).toBe(s.employee.employeeCode);
	});

	it('a manager sees only their own record and reports, never unrelated employees', async () => {
		const s = await setup();
		const { user, username, password } = await createTestUser({ roleCode: 'MANAGER' });
		const mgr = await prisma.employee.create({
			data: {
				employeeCode: `M_${uid()}`,
				firstNameLao: 'ຫົວໜ້າ',
				lastNameLao: 'ທົດສອບ',
				startDate: new Date('2024-01-01T00:00:00.000Z'),
				companyId: s.company.id,
				userId: user.id
			}
		});
		await prisma.employee.update({
			where: { id: s.employee.id },
			data: { managerEmployeeId: mgr.id }
		});
		const outsider = await setup({ companyId: s.company.id });
		at(MON_0803);
		await checkIn(s.cookie);
		await checkIn(outsider.cookie);
		const mgrCookie = await loginAndGetCookie(username, password);

		const list = await agent()
			.get(`/api/v1/attendance?date=2026-09-21&companyId=${s.company.id}`)
			.set('Cookie', mgrCookie);
		expect(list.status).toBe(200);
		expect(list.body.data.items.map((i: { employeeId: string }) => i.employeeId)).toEqual([
			s.employee.id
		]);

		const own = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		const foreign = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: outsider.employee.id }
		});
		expect(
			(await agent().get(`/api/v1/attendance/${own.id}`).set('Cookie', mgrCookie)).status
		).toBe(200);
		expect(
			(await agent().get(`/api/v1/attendance/${foreign.id}`).set('Cookie', mgrCookie)).status
		).toBe(403);
	});

	it('an attendance.view user without employee scope sees nothing (no directory leak)', async () => {
		await twoEmployeesWithRecords();
		const { cookie } = await userWithPermissions(['attendance.view']);
		const res = await agent().get('/api/v1/attendance?date=2026-09-21').set('Cookie', cookie);
		expect(res.status).toBe(200);
		expect(res.body.data.items).toEqual([]);
	});

	it("self history lists only the caller's own records, newest first", async () => {
		const { s, other } = await twoEmployeesWithRecords();
		const res = await agent().get('/api/v1/attendance/me/history').set('Cookie', s.cookie);
		expect(res.status).toBe(200);
		expect(res.body.data.items.length).toBe(1);
		expect(res.body.data.items[0].employeeId).toBe(s.employee.id);
		expect(other.employee.id).not.toBe(s.employee.id);
		const range = await agent()
			.get('/api/v1/attendance/me/history?from=2026-10-01&to=2026-10-31')
			.set('Cookie', s.cookie);
		expect(range.body.data.total).toBe(0);
		// self endpoints never accept an employee id
		expect(
			(
				await agent()
					.get(`/api/v1/attendance/me/history?employeeId=${other.employee.id}`)
					.set('Cookie', s.cookie)
			).body.data.items[0].employeeId
		).toBe(s.employee.id);
	});
});

describe('races and double submissions', () => {
	it('two simultaneous check-ins create one record and one punch', async () => {
		const s = await setup();
		at(MON_0803);
		const results = await Promise.all([checkIn(s.cookie), checkIn(s.cookie), checkIn(s.cookie)]);
		expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(1);
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(1);
	});

	it('two simultaneous check-outs create one CHECK_OUT punch', async () => {
		const s = await setup();
		at(MON_0803);
		await checkIn(s.cookie);
		at(MON_1712);
		const results = await Promise.all([checkOut(s.cookie), checkOut(s.cookie), checkOut(s.cookie)]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
		expect(
			await prisma.attendancePunch.count({
				where: { employeeId: s.employee.id, type: 'CHECK_OUT' }
			})
		).toBe(1);
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(2);
	});
});

describe('source hint', () => {
	it('records WEB / MOBILE_WEB (informational) and the request metadata', async () => {
		const s = await setup();
		at(MON_0803);
		const res = await agent()
			.post('/api/v1/attendance/me/check-in')
			.set('Cookie', s.cookie)
			.set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Safari')
			.send({});
		expect(res.status).toBe(201);
		const punch = await prisma.attendancePunch.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(punch.source).toBe('MOBILE_WEB');
		expect(punch.userAgent).toContain('iPhone');
		at(MON_1712);
		await checkOut(s.cookie, { source: 'WEB' });
		const out = await prisma.attendancePunch.findFirstOrThrow({
			where: { employeeId: s.employee.id, type: 'CHECK_OUT' }
		});
		expect(out.source).toBe('WEB');
	});
});
