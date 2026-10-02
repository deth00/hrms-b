import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { calculateOvertime, overlapMinutes } from '../src/lib/overtime.js';

const uid = () => randomUUID().slice(0, 6).toUpperCase();
const at = (iso: string) => setServerClockForTests(() => new Date(iso));

// Laos = UTC+7. "Now" is Saturday 2026-09-19 10:00 Laos. Mon 21 is a working day (08:00–17:00,
// default pattern Mon–Fri); Sat 26 / Sun 27 are off days.
const NOW = '2026-09-19T03:00:00Z';
beforeEach(() => at(NOW));
afterEach(() => setServerClockForTests(null));

const MON = '2026-09-21';
const SAT = '2026-09-26';
const SUN = '2026-09-27';
const laos = (date: string, hm: string) => `${date}T${hm}:00+07:00`;
/** a Laos wall-clock time as a UTC ISO instant for the test clock */
const clockAt = (date: string, hm: string) => new Date(laos(date, hm)).toISOString();

let admin: string;
let hr: { user: { id: string }; cookie: string };
beforeAll(async () => {
	admin = await superAdminCookie();
	hr = await userWithPermissions([
		'overtime.view',
		'overtime.review',
		'overtime_rules.view',
		'overtime_rules.update',
		'employees.view_all',
		'attendance.view',
		'attendance_corrections.review',
		'leave.view',
		'leave.review'
	]);
});

const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const put = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().put(`/api/v1${path}`).set('Cookie', cookie).send(body);
const get = (path: string, cookie: string) => agent().get(`/api/v1${path}`).set('Cookie', cookie);

interface SetupOptions {
	companyId?: string;
	roleCode?: string;
	managerEmployeeId?: string;
	noSchedule?: boolean;
	employmentStatus?: 'ACTIVE' | 'SUSPENDED' | 'ON_LEAVE' | 'RESIGNED';
	existing?: { user: { id: string }; cookie: string };
	shift?: Record<string, unknown>;
}

async function setup(opts: SetupOptions = {}) {
	const company = opts.companyId
		? await prisma.company.findUniqueOrThrow({ where: { id: opts.companyId } })
		: await createTestCompany();
	const shiftRes = await post('/shifts', admin, {
		companyId: company.id,
		code: `S_${uid()}`,
		nameLao: 'ກະ',
		startTime: '08:00',
		endTime: '17:00',
		breakMinutes: 60,
		lateGraceMinutes: 5,
		earlyLeaveGraceMinutes: 5,
		...opts.shift
	});
	expect(shiftRes.status, JSON.stringify(shiftRes.body)).toBe(201);
	const shift = shiftRes.body.data as { id: string };

	let user: { id: string };
	let cookie: string;
	if (opts.existing) {
		user = opts.existing.user;
		cookie = opts.existing.cookie;
	} else {
		const created = await createTestUser({ roleCode: opts.roleCode ?? 'EMPLOYEE' });
		user = created.user;
		cookie = await loginAndGetCookie(created.username, created.password);
	}
	const employee = await prisma.employee.create({
		data: {
			employeeCode: `E_${uid()}`,
			firstNameLao: 'ພະນັກງານ',
			lastNameLao: 'ທົດສອບ',
			startDate: new Date('2024-01-01T00:00:00.000Z'),
			employmentStatus: opts.employmentStatus ?? 'ACTIVE',
			companyId: company.id,
			userId: user.id,
			managerEmployeeId: opts.managerEmployeeId ?? null
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
	return { company, shift, user, employee, cookie };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const body = (date: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({
	workDate: date,
	requestedStartAt: from.includes('T') ? from : laos(date, from),
	requestedEndAt: to.includes('T') ? to : laos(date, to),
	...extra
});
/** to may be given as "HH:mm" (same date) or a full instant */
const request = (s: Ctx, date: string, from: string, to: string, reason = 'ງານດ່ວນ') =>
	post('/overtime/me/requests', s.cookie, body(date, from, to, { reason }));
const preview = (s: Ctx, date: string, from: string, to: string) =>
	post('/overtime/me/requests/preview', s.cookie, body(date, from, to));
const approve = (id: string, cookie = hr.cookie, b: Record<string, unknown> = {}) =>
	post(`/overtime/requests/${id}/approve`, cookie, b);
const reject = (
	id: string,
	cookie = hr.cookie,
	b: Record<string, unknown> = { reviewNote: 'ບໍ່ຈຳເປັນ' }
) => post(`/overtime/requests/${id}/reject`, cookie, b);
const daily = (cookie: string, qs: string) => get(`/attendance/daily?${qs}`, cookie);

async function approved(s: Ctx, date: string, from: string, to: string) {
	const created = await request(s, date, from, to);
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	const ok = await approve(created.body.data.id);
	expect(ok.status, JSON.stringify(ok.body)).toBe(200);
	return created.body.data.id as string;
}
const otOf = async (s: Ctx, id: string) =>
	(await get(`/overtime/me/requests/${id}`, s.cookie)).body.data;

async function checkIn(s: Ctx, date: string, hm: string) {
	at(clockAt(date, hm));
	return post('/attendance/me/check-in', s.cookie);
}
async function checkOut(s: Ctx, date: string, hm: string) {
	at(clockAt(date, hm));
	return post('/attendance/me/check-out', s.cookie);
}
const setPolicy = (companyId: string, values: Record<string, unknown>) =>
	put(`/overtime-policies?companyId=${companyId}`, hr.cookie, values);

/** rows inserted straight into the DB (for revalidation scenarios the API would refuse) */
async function rawOt(
	s: Ctx,
	data: {
		date: string;
		type: 'BEFORE_SHIFT' | 'AFTER_SHIFT' | 'OFF_DAY' | 'HOLIDAY';
		from: string;
		to: string;
		status?: 'PENDING' | 'APPROVED';
	}
) {
	const start = new Date(laos(data.date, data.from));
	const end = new Date(laos(data.date, data.to));
	return prisma.overtimeRequest.create({
		data: {
			employeeId: s.employee.id,
			workDate: new Date(`${data.date}T00:00:00Z`),
			type: data.type,
			requestedStartAt: start,
			requestedEndAt: end,
			plannedMinutes: Math.round((end.getTime() - start.getTime()) / 60000),
			reason: 'ຂໍ້ມູນທົດສອບ',
			status: data.status ?? 'PENDING',
			requestedByUserId: s.user.id,
			isWorkingDay: true,
			activeKey: null
		}
	});
}

// ============================================================================================
describe('overtime policy', () => {
	it('1. requires authentication', async () => {
		expect((await agent().get('/api/v1/overtime-policies?companyId=x')).status).toBe(401);
	});

	it('2. viewing requires overtime_rules.view', async () => {
		const company = await createTestCompany();
		const none = await userWithPermissions(['dashboard.view']);
		expect((await get(`/overtime-policies?companyId=${company.id}`, none.cookie)).status).toBe(403);
		const viewer = await userWithPermissions(['overtime_rules.view']);
		expect((await get(`/overtime-policies?companyId=${company.id}`, viewer.cookie)).status).toBe(
			200
		);
	});

	it('3. updating requires overtime_rules.update', async () => {
		const company = await createTestCompany();
		const viewer = await userWithPermissions(['overtime_rules.view']);
		expect(
			(
				await put(`/overtime-policies?companyId=${company.id}`, viewer.cookie, {
					checkInEarlyMinutes: 15
				})
			).status
		).toBe(403);
		const res = await setPolicy(company.id, { checkInEarlyMinutes: 15, allowHoliday: false });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data).toMatchObject({
			isDefault: false,
			checkInEarlyMinutes: 15,
			allowHoliday: false
		});
		expect(res.body.data.minimumRequestMinutes).toBe(30); // untouched fields keep their defaults
	});

	it('4. defaults apply when a company has no policy row', async () => {
		const company = await createTestCompany();
		const res = await get(`/overtime-policies?companyId=${company.id}`, hr.cookie);
		expect(res.body.data).toMatchObject({
			isDefault: true,
			minimumRequestMinutes: 30,
			maximumRequestMinutesPerDay: 480,
			allowBeforeShift: true,
			allowAfterShift: true,
			allowOffDay: true,
			allowHoliday: true,
			checkInEarlyMinutes: 60
		});
		expect(await prisma.overtimePolicy.count({ where: { companyId: company.id } })).toBe(0);
	});

	it('5. min / max are validated and no pay-rate fields exist', async () => {
		const company = await createTestCompany();
		const bad = await setPolicy(company.id, {
			minimumRequestMinutes: 120,
			maximumRequestMinutesPerDay: 60
		});
		expect(bad.status).toBe(400);
		expect(bad.body.error.code).toBe('INVALID_OVERTIME_LIMITS');
		expect((await setPolicy(company.id, { minimumRequestMinutes: 0 })).status).toBe(400);
		expect((await setPolicy(company.id, { maximumRequestMinutesPerDay: 2000 })).status).toBe(400);
		expect((await setPolicy(company.id, {})).status).toBe(400);
		expect((await setPolicy(company.id, { weekdayRate: 1.5 })).status).toBe(400);
		expect((await setPolicy(company.id, { holidayMultiplier: 3 })).status).toBe(400);
	});
});

// ============================================================================================
describe('overtime request preview', () => {
	it('6. requires a linked employee', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);
		const res = await post('/overtime/me/requests/preview', cookie, body(MON, '17:30', '19:30'));
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('NO_LINKED_EMPLOYEE');
	});

	it('7. a window before the regular start is BEFORE_SHIFT', async () => {
		const s = await setup();
		const res = await preview(s, MON, '06:00', '07:30');
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data).toMatchObject({
			derivedType: 'BEFORE_SHIFT',
			plannedMinutes: 90,
			canSubmit: true,
			blockers: []
		});
		expect(res.body.data.schedule.shift.id).toBe(s.shift.id);
		expect(await prisma.overtimeRequest.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	it('8. a window after the regular end is AFTER_SHIFT', async () => {
		const s = await setup();
		const res = await preview(s, MON, '17:30', '19:30');
		expect(res.body.data).toMatchObject({
			derivedType: 'AFTER_SHIFT',
			plannedMinutes: 120,
			canSubmit: true
		});
		expect(res.body.data.schedule.regularStartAt).toBe(new Date(laos(MON, '08:00')).toISOString());
		expect(res.body.data.schedule.regularEndAt).toBe(new Date(laos(MON, '17:00')).toISOString());
	});

	it('9. a window overlapping regular hours is rejected (OT_OVERLAPS_REGULAR_HOURS)', async () => {
		const s = await setup();
		const res = await preview(s, MON, '16:00', '18:00');
		expect(res.body.data.canSubmit).toBe(false);
		expect(res.body.data.derivedType).toBeNull();
		expect(res.body.data.blockers[0].code).toBe('OT_OVERLAPS_REGULAR_HOURS');
		const create = await request(s, MON, '16:00', '18:00');
		expect(create.status).toBe(400);
		expect(create.body.error.code).toBe('OT_OVERLAPS_REGULAR_HOURS');
	});

	it('10. a non-working day is OFF_DAY', async () => {
		const s = await setup();
		const res = await preview(s, SAT, '09:00', '13:00');
		expect(res.body.data).toMatchObject({
			derivedType: 'OFF_DAY',
			plannedMinutes: 240,
			canSubmit: true
		});
		expect(res.body.data.schedule).toMatchObject({ isWorkingDay: false, isHoliday: false });
	});

	it('11. a company holiday is HOLIDAY (and wins over an off-day)', async () => {
		const s = await setup();
		await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				nameLao: 'ວັນພັກ',
				holidayDate: new Date(`${SAT}T00:00:00Z`)
			}
		});
		await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				nameLao: 'ວັນພັກຈັນ',
				holidayDate: new Date(`${MON}T00:00:00Z`)
			}
		});
		const sat = await preview(s, SAT, '09:00', '13:00'); // holiday on an off-day
		expect(sat.body.data.derivedType).toBe('HOLIDAY');
		const mon = await preview(s, MON, '09:00', '13:00'); // holiday on a working day: regular hours are irrelevant
		expect(mon.body.data).toMatchObject({ derivedType: 'HOLIDAY', canSubmit: true });
		expect(mon.body.data.schedule.holiday.nameLao).toBe('ວັນພັກຈັນ');
	});

	it('12. overnight shift: before-shift is derived from real instants', async () => {
		const s = await setup({ shift: { startTime: '22:00', endTime: '06:00' } });
		const res = await preview(s, MON, '20:00', '22:00');
		expect(res.body.data).toMatchObject({ derivedType: 'BEFORE_SHIFT', plannedMinutes: 120 });
		expect(res.body.data.schedule.regularEndAt).toBe(
			new Date(laos('2026-09-22', '06:00')).toISOString()
		);
		// inside the overnight regular interval → rejected
		expect((await preview(s, MON, '23:00', '23:59')).body.data.blockers[0].code).toBe(
			'OT_OVERLAPS_REGULAR_HOURS'
		);
	});

	it('13. overnight shift: after-shift starts the next morning yet keeps the work date', async () => {
		const s = await setup({ shift: { startTime: '22:00', endTime: '06:00' } });
		const res = await post('/overtime/me/requests/preview', s.cookie, {
			workDate: MON,
			requestedStartAt: laos('2026-09-22', '06:00'),
			requestedEndAt: laos('2026-09-22', '08:00')
		});
		expect(res.body.data).toMatchObject({
			derivedType: 'AFTER_SHIFT',
			plannedMinutes: 120,
			canSubmit: true
		});
	});

	it('14. the minimum duration is enforced', async () => {
		const s = await setup();
		const res = await preview(s, MON, '17:30', '17:50');
		expect(res.body.data.canSubmit).toBe(false);
		expect(res.body.data.blockers[0]).toMatchObject({ code: 'OT_TOO_SHORT' });
		expect(res.body.data.blockers[0].details).toMatchObject({
			minimumRequestMinutes: 30,
			plannedMinutes: 20
		});
		expect((await request(s, MON, '17:30', '17:50')).status).toBe(400);
	});

	it('15. the maximum duration is enforced (and never more than 24 hours)', async () => {
		const s = await setup();
		const over = await preview(s, SAT, '06:00', '15:00'); // 540 min > 480
		expect(over.body.data.blockers[0].code).toBe('OT_TOO_LONG');
		const day = await post('/overtime/me/requests/preview', s.cookie, {
			workDate: SAT,
			requestedStartAt: laos(SAT, '00:00'),
			requestedEndAt: laos(SUN, '00:01')
		});
		expect(day.body.data.blockers[0].code).toBe('OT_TOO_LONG');
		await setPolicy(s.company.id, { maximumRequestMinutesPerDay: 600 });
		expect((await preview(s, SAT, '06:00', '15:00')).body.data.canSubmit).toBe(true);
		const backwards = await preview(s, SAT, '13:00', '09:00');
		expect(backwards.body.data.blockers[0].code).toBe('INVALID_TIME_RANGE');
	});

	it('16. a policy that disallows the derived type blocks it', async () => {
		const s = await setup();
		await setPolicy(s.company.id, { allowAfterShift: false, allowOffDay: false });
		const after = await preview(s, MON, '17:30', '19:30');
		expect(after.body.data.blockers[0]).toMatchObject({
			code: 'OT_TYPE_NOT_ALLOWED',
			details: { type: 'AFTER_SHIFT' }
		});
		expect((await preview(s, SAT, '09:00', '13:00')).body.data.blockers[0].code).toBe(
			'OT_TYPE_NOT_ALLOWED'
		);
		expect((await preview(s, MON, '06:00', '07:30')).body.data.canSubmit).toBe(true);
	});

	it('17. a date with no schedule assignment is rejected (NO_ACTIVE_SCHEDULE)', async () => {
		const s = await setup({ noSchedule: true });
		const res = await preview(s, MON, '17:30', '19:30');
		expect(res.body.data.canSubmit).toBe(false);
		expect(res.body.data.blockers[0].code).toBe('NO_ACTIVE_SCHEDULE');
	});

	async function leaveOn(s: Ctx, status: 'PENDING' | 'APPROVED', date = MON) {
		const type = await prisma.leaveType.create({
			data: { companyId: s.company.id, code: `LT_${uid()}`, nameLao: 'ລາ', requiresBalance: false }
		});
		const day = new Date(`${date}T00:00:00Z`);
		const req = await prisma.leaveRequest.create({
			data: {
				employeeId: s.employee.id,
				leaveTypeId: type.id,
				startDate: day,
				endDate: day,
				totalDays: '1.00',
				reason: 'ລາ',
				status,
				requestedByUserId: s.user.id
			}
		});
		await prisma.leaveRequestDay.create({
			data: {
				leaveRequestId: req.id,
				employeeId: s.employee.id,
				leaveDate: day,
				activeKey: `${s.employee.id}:${date}`
			}
		});
		return req;
	}

	it('18. approved leave on the date is rejected (APPROVED_LEAVE_DAY)', async () => {
		const s = await setup();
		await leaveOn(s, 'APPROVED');
		const res = await preview(s, MON, '17:30', '19:30');
		expect(res.body.data.existingLeaveConflict).toBe('APPROVED');
		expect(res.body.data.blockers[0].code).toBe('APPROVED_LEAVE_DAY');
		const create = await request(s, MON, '17:30', '19:30');
		expect(create.status).toBe(400);
		expect(create.body.error.code).toBe('APPROVED_LEAVE_DAY');
	});

	it('19. a pending leave request on the date blocks a new OT request', async () => {
		const s = await setup();
		await leaveOn(s, 'PENDING');
		const res = await preview(s, MON, '17:30', '19:30');
		expect(res.body.data.existingLeaveConflict).toBe('PENDING');
		const create = await request(s, MON, '17:30', '19:30');
		expect(create.status).toBe(409);
		expect(create.body.error.code).toBe('PENDING_LEAVE_CONFLICT');
	});
});

// ============================================================================================
describe('overtime request creation', () => {
	it('20. creates a before-shift request with a schedule snapshot', async () => {
		const s = await setup();
		const res = await request(s, MON, '06:00', '07:30');
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data).toMatchObject({
			type: 'BEFORE_SHIFT',
			status: 'PENDING',
			plannedMinutes: 90,
			actualMinutes: null,
			eligibleMinutes: null
		});
		expect(res.body.data.schedule).toMatchObject({
			shiftId: s.shift.id,
			isWorkingDay: true,
			isHoliday: false
		});
		const row = await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: res.body.data.id } });
		expect(row.regularScheduledStartAt?.toISOString()).toBe(
			new Date(laos(MON, '08:00')).toISOString()
		);
		expect(row.requestedStartAt.toISOString()).toBe('2026-09-20T23:00:00.000Z'); // stored in UTC
		expect(row.activeKey).toBe(`${s.employee.id}:${MON}:BEFORE_SHIFT`);
	});

	it('21. creates an after-shift request', async () => {
		const s = await setup();
		const res = await request(s, MON, '17:30', '19:30');
		expect(res.body.data).toMatchObject({
			type: 'AFTER_SHIFT',
			plannedMinutes: 120,
			status: 'PENDING'
		});
	});

	it('22. creates an off-day request', async () => {
		const s = await setup();
		const res = await request(s, SAT, '09:00', '13:00');
		expect(res.body.data).toMatchObject({ type: 'OFF_DAY', plannedMinutes: 240 });
		expect(res.body.data.schedule).toMatchObject({ isWorkingDay: false, regularStartAt: null });
	});

	it('23. creates a holiday request', async () => {
		const s = await setup();
		const holiday = await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				nameLao: 'ວັນພັກ',
				holidayDate: new Date(`${SAT}T00:00:00Z`)
			}
		});
		const res = await request(s, SAT, '09:00', '13:00');
		expect(res.body.data.type).toBe('HOLIDAY');
		expect(res.body.data.schedule).toMatchObject({ isHoliday: true, holidayId: holiday.id });
	});

	it('24. a client-supplied type is rejected', async () => {
		const s = await setup();
		const res = await post(
			'/overtime/me/requests',
			s.cookie,
			body(MON, '17:30', '19:30', { reason: 'ງານດ່ວນ', type: 'OFF_DAY' })
		);
		expect(res.status).toBe(400);
		const p = await post(
			'/overtime/me/requests/preview',
			s.cookie,
			body(MON, '17:30', '19:30', { type: 'OFF_DAY' })
		);
		expect(p.status).toBe(400);
	});

	it('25. client-supplied planned / actual / eligible / status / employee fields are rejected', async () => {
		const s = await setup();
		for (const extra of [
			{ actualMinutes: 60 },
			{ eligibleMinutes: 60 },
			{ plannedMinutes: 999 },
			{ status: 'APPROVED' },
			{ employeeId: 'someone' },
			{ reviewedByUserId: 'x' }
		]) {
			const res = await post(
				'/overtime/me/requests',
				s.cookie,
				body(MON, '17:30', '19:30', { reason: 'ງານດ່ວນ', ...extra })
			);
			expect(res.status, JSON.stringify(extra)).toBe(400);
		}
		expect((await request(s, MON, '17:30', '19:30', '   ')).status).toBe(400);
		expect(await prisma.overtimeRequest.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	it('26. past dates / windows are rejected (employee backdating is not supported)', async () => {
		const s = await setup();
		const pastDay = await request(s, '2026-09-18', '17:30', '19:30');
		expect(pastDay.status).toBe(400);
		expect(pastDay.body.error.code).toBe('OT_DATE_IN_PAST');
		// today, but the window already ended (now = Sat 10:00)
		const pastWindow = await request(s, '2026-09-19', '06:00', '08:00');
		expect(pastWindow.body.error.code).toBe('OT_DATE_IN_PAST');
		// today, window still ahead → fine
		expect((await request(s, '2026-09-19', '13:00', '15:00')).status).toBe(201);
	});

	it('27. an inactive employee (suspended / on leave / resigned) is rejected', async () => {
		for (const employmentStatus of ['SUSPENDED', 'ON_LEAVE', 'RESIGNED'] as const) {
			const s = await setup({ employmentStatus });
			const res = await request(s, MON, '17:30', '19:30');
			expect(res.status, employmentStatus).toBe(403);
			expect(res.body.error.code).toBe('EMPLOYEE_NOT_ACTIVE');
		}
	});

	it('28. overlapping active OT is rejected', async () => {
		const s = await setup();
		expect((await request(s, MON, '17:30', '19:30')).status).toBe(201);
		const clash = await request(s, MON, '19:00', '20:30');
		expect(clash.status).toBe(409);
		expect(clash.body.error.code).toBe('OVERTIME_OVERLAP');
		expect(clash.body.error.details.conflicts).toHaveLength(1);
		// before + after on the same day may coexist when they do not overlap
		expect((await request(s, MON, '06:00', '07:30')).status).toBe(201);
		// the same type on the same date is one request (activeKey)
		expect((await request(s, MON, '20:00', '21:00')).status).toBe(409);
	});

	it('29. a rejected OT does not block the window', async () => {
		const s = await setup();
		const first = await request(s, MON, '17:30', '19:30');
		expect((await reject(first.body.data.id)).status).toBe(200);
		expect((await request(s, MON, '17:30', '19:30')).status).toBe(201);
		const row = await prisma.overtimeRequest.findUniqueOrThrow({
			where: { id: first.body.data.id }
		});
		expect(row.activeKey).toBeNull();
	});

	it('30. a cancelled OT does not block the window', async () => {
		const s = await setup();
		const first = await request(s, MON, '17:30', '19:30');
		expect(
			(await post(`/overtime/me/requests/${first.body.data.id}/cancel`, s.cookie)).status
		).toBe(200);
		expect((await request(s, MON, '18:00', '19:00')).status).toBe(201);
	});

	it('31. concurrent identical requests: exactly one succeeds', async () => {
		const s = await setup();
		const results = await Promise.all([
			request(s, MON, '17:30', '19:30'),
			request(s, MON, '17:30', '19:30'),
			request(s, MON, '17:45', '19:00'),
			request(s, MON, '17:30', '19:30')
		]);
		expect(results.filter((r) => r.status === 201)).toHaveLength(1);
		expect(results.filter((r) => r.status === 409)).toHaveLength(3);
		expect(await prisma.overtimeRequest.count({ where: { employeeId: s.employee.id } })).toBe(1);
	});
});

// ============================================================================================
describe('self service', () => {
	it('32. an employee lists only their own requests', async () => {
		const a = await setup();
		const b = await setup({ companyId: a.company.id });
		await request(a, MON, '17:30', '19:30');
		await request(b, MON, '17:30', '19:30');
		const list = await get('/overtime/me/requests', a.cookie);
		expect(list.body.data.total).toBe(1);
		expect(list.body.data.items[0].employee.id).toBe(a.employee.id);
		expect((await get('/overtime/me/requests?status=APPROVED', a.cookie)).body.data.total).toBe(0);
		expect((await get('/overtime/me/requests?year=2026', a.cookie)).body.data.total).toBe(1);
		expect((await get('/overtime/me/requests?year=2027', a.cookie)).body.data.total).toBe(0);
	});

	it('33. own detail', async () => {
		const s = await setup();
		const req = await request(s, MON, '17:30', '19:30');
		const res = await get(`/overtime/me/requests/${req.body.data.id}`, s.cookie);
		expect(res.status).toBe(200);
		expect(res.body.data).toMatchObject({
			type: 'AFTER_SHIFT',
			plannedMinutes: 120,
			reason: 'ງານດ່ວນ'
		});
	});

	it("34. another employee's request cannot be opened or cancelled", async () => {
		const a = await setup();
		const b = await setup({ companyId: a.company.id });
		const req = await request(a, MON, '17:30', '19:30');
		expect((await get(`/overtime/me/requests/${req.body.data.id}`, b.cookie)).status).toBe(404);
		expect((await post(`/overtime/me/requests/${req.body.data.id}/cancel`, b.cookie)).status).toBe(
			404
		);
	});

	it('35. cancelling a PENDING request succeeds', async () => {
		const s = await setup();
		const req = await request(s, MON, '17:30', '19:30');
		const res = await post(`/overtime/me/requests/${req.body.data.id}/cancel`, s.cookie);
		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe('CANCELLED');
	});

	it('36. cancelling an APPROVED request is rejected', async () => {
		const s = await setup();
		const id = await approved(s, MON, '17:30', '19:30');
		const res = await post(`/overtime/me/requests/${id}/cancel`, s.cookie);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('OVERTIME_NOT_CANCELLABLE');
	});
});

// ============================================================================================
describe('overtime review', () => {
	async function pending() {
		const s = await setup();
		const req = await request(s, MON, '17:30', '19:30');
		expect(req.status, JSON.stringify(req.body)).toBe(201);
		return { s, id: req.body.data.id as string };
	}

	it('37. review requires overtime.review (viewing requires overtime.view)', async () => {
		const { s, id } = await pending();
		expect((await approve(id, s.cookie)).status).toBe(403);
		expect((await reject(id, s.cookie)).status).toBe(403);
		expect((await get('/overtime/requests', s.cookie)).status).toBe(403);
		const viewOnly = await userWithPermissions(['overtime.view', 'employees.view_all']);
		expect((await get(`/overtime/requests/${id}`, viewOnly.cookie)).status).toBe(200);
		expect((await approve(id, viewOnly.cookie)).status).toBe(403);
	});

	it('38. employee data scope is enforced', async () => {
		const manager = await setup({ roleCode: 'MANAGER' });
		const report = await setup({
			companyId: manager.company.id,
			managerEmployeeId: manager.employee.id
		});
		const stranger = await setup({ companyId: manager.company.id });
		const mine = await request(report, MON, '17:30', '19:30');
		const theirs = await request(stranger, MON, '17:30', '19:30');
		expect((await get(`/overtime/requests/${theirs.body.data.id}`, manager.cookie)).status).toBe(
			403
		);
		expect((await approve(theirs.body.data.id, manager.cookie)).status).toBe(403);
		expect((await reject(theirs.body.data.id, manager.cookie)).status).toBe(403);
		expect((await approve(mine.body.data.id, manager.cookie)).status).toBe(200);
		expect(
			(await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: theirs.body.data.id } }))
				.status
		).toBe('PENDING');
	});

	it('39. a reviewer cannot approve or reject their own request', async () => {
		const reviewer = await userWithPermissions([
			'overtime.self',
			'overtime.view',
			'overtime.review',
			'employees.view_all'
		]);
		const s = await setup({ existing: reviewer });
		const req = await request(s, MON, '17:30', '19:30');
		for (const res of [
			await approve(req.body.data.id, reviewer.cookie),
			await reject(req.body.data.id, reviewer.cookie)
		]) {
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe('CANNOT_REVIEW_OWN_OVERTIME');
		}
		const detail = await get(`/overtime/requests/${req.body.data.id}`, reviewer.cookie);
		expect(detail.body.data).toMatchObject({ isOwnRequest: true, canReview: false });
	});

	it('40. approves a PENDING request', async () => {
		const { id } = await pending();
		const res = await approve(id, hr.cookie, { reviewNote: 'ຕົກລົງ' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data).toMatchObject({
			status: 'APPROVED',
			reviewNote: 'ຕົກລົງ',
			calculationStatus: 'PENDING_ATTENDANCE'
		});
		expect(res.body.data.reviewedBy.id).toBe(hr.user.id);
		expect(res.body.data.reviewedAt).toBeTruthy();
	});

	it('41. rejects a PENDING request (a note is required)', async () => {
		const { id } = await pending();
		expect((await post(`/overtime/requests/${id}/reject`, hr.cookie, {})).status).toBe(400);
		const res = await reject(id);
		expect(res.status).toBe(200);
		expect(res.body.data).toMatchObject({
			status: 'REJECTED',
			reviewNote: 'ບໍ່ຈຳເປັນ',
			actualMinutes: null
		});
	});

	it('42. approving twice / approving a rejected request is refused', async () => {
		const a = await pending();
		expect((await approve(a.id)).status).toBe(200);
		const again = await approve(a.id);
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('OVERTIME_ALREADY_REVIEWED');
		const b = await pending();
		await reject(b.id);
		expect((await approve(b.id)).body.error.code).toBe('OVERTIME_ALREADY_REVIEWED');
		expect((await reject(a.id)).status).toBe(409);
	});

	it('43. the policy is re-checked on approval', async () => {
		const { s, id } = await pending();
		await setPolicy(s.company.id, { allowAfterShift: false });
		const res = await approve(id);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('OT_TYPE_NOT_ALLOWED');
	});

	it('44. a leave conflict is re-checked on approval', async () => {
		const { s, id } = await pending();
		const type = await prisma.leaveType.create({
			data: { companyId: s.company.id, code: `LT_${uid()}`, nameLao: 'ລາ', requiresBalance: false }
		});
		const day = new Date(`${MON}T00:00:00Z`);
		const leave = await prisma.leaveRequest.create({
			data: {
				employeeId: s.employee.id,
				leaveTypeId: type.id,
				startDate: day,
				endDate: day,
				totalDays: '1.00',
				reason: 'ລາ',
				status: 'APPROVED',
				requestedByUserId: s.user.id
			}
		});
		await prisma.leaveRequestDay.create({
			data: {
				leaveRequestId: leave.id,
				employeeId: s.employee.id,
				leaveDate: day,
				activeKey: `${s.employee.id}:${MON}`
			}
		});
		const res = await approve(id);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('APPROVED_LEAVE_DAY');
	});

	it('45. overlap is re-checked on approval', async () => {
		const { s, id } = await pending();
		await rawOt(s, {
			date: MON,
			type: 'AFTER_SHIFT',
			from: '18:00',
			to: '20:00',
			status: 'APPROVED'
		});
		const res = await approve(id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('OVERTIME_OVERLAP');
	});

	it('46. a failed approval leaves the request untouched (rollback safe)', async () => {
		const { s, id } = await pending();
		await setPolicy(s.company.id, { allowAfterShift: false });
		expect((await approve(id)).status).toBe(400);
		const row = await prisma.overtimeRequest.findUniqueOrThrow({ where: { id } });
		expect(row).toMatchObject({ status: 'PENDING', reviewedByUserId: null, reviewedAt: null });
		expect(row.activeKey).toBe(`${s.employee.id}:${MON}:AFTER_SHIFT`);
	});

	it('review detail: schedule context, warnings and a potential-OT preview', async () => {
		const { s, id } = await pending();
		const detail = await get(`/overtime/requests/${id}`, hr.cookie);
		expect(detail.body.data).toMatchObject({
			canReview: true,
			type: 'AFTER_SHIFT',
			potential: { calculationStatus: 'PENDING_ATTENDANCE' }
		});
		expect(detail.body.data.warnings).toEqual({
			leaveConflict: null,
			typeNotAllowed: false,
			scheduleChanged: false,
			overlapsOther: false
		});
		expect(detail.body.data.schedule.regularEndAt).toBe(new Date(laos(MON, '17:00')).toISOString());
		await setPolicy(s.company.id, { allowAfterShift: false });
		expect(
			(await get(`/overtime/requests/${id}`, hr.cookie)).body.data.warnings.typeNotAllowed
		).toBe(true);
	});
});

// ============================================================================================
describe('leave integration', () => {
	async function otAndLeave(otStatusAction?: 'approve' | 'reject' | 'cancel') {
		const s = await setup();
		const type = await prisma.leaveType.create({
			data: { companyId: s.company.id, code: `LT_${uid()}`, nameLao: 'ລາ', requiresBalance: false }
		});
		const ot = await request(s, MON, '17:30', '19:30');
		expect(ot.status).toBe(201);
		// an APPROVED OT also blocks approving a pending leave, but a pending leave blocks approving
		// the OT — so the OT is resolved first, then the leave is requested
		if (otStatusAction === 'approve') expect((await approve(ot.body.data.id)).status).toBe(200);
		if (otStatusAction === 'reject') expect((await reject(ot.body.data.id)).status).toBe(200);
		if (otStatusAction === 'cancel')
			expect((await post(`/overtime/me/requests/${ot.body.data.id}/cancel`, s.cookie)).status).toBe(
				200
			);
		const leave = await post('/leave/me/requests', s.cookie, {
			leaveTypeId: type.id,
			startDate: MON,
			endDate: MON,
			reason: 'ລາພັກ'
		});
		expect(leave.status, JSON.stringify(leave.body)).toBe(201);
		return { s, ot: ot.body.data.id as string, leave: leave.body.data.id as string };
	}
	const approveLeave = (id: string) => post(`/leave/requests/${id}/approve`, hr.cookie, {});

	it('47. leave approval is blocked by a PENDING OT', async () => {
		const { leave, s } = await otAndLeave();
		const res = await approveLeave(leave);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('OVERTIME_CONFLICT');
		expect(res.body.error.details.dates).toEqual([MON]);
		// neither request was touched, and the reviewer sees the warning on the leave detail
		expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: leave } })).status).toBe(
			'PENDING'
		);
		expect(
			(await get(`/leave/requests/${leave}`, hr.cookie)).body.data.warnings.overtimeConflictDates
		).toEqual([MON]);
		const pv = await post('/leave/me/requests/preview', s.cookie, {
			leaveTypeId: (await prisma.leaveType.findFirstOrThrow({ where: { companyId: s.company.id } }))
				.id,
			startDate: '2026-09-22',
			endDate: '2026-09-22'
		});
		expect(pv.body.data.overtimeConflictDates).toEqual([]);
	});

	it('48. leave approval is blocked by an APPROVED OT', async () => {
		const { leave, ot } = await otAndLeave('approve');
		const res = await approveLeave(leave);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('OVERTIME_CONFLICT');
		expect((await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: ot } })).status).toBe(
			'APPROVED'
		);
	});

	it('49. a rejected OT allows the leave approval', async () => {
		const { leave } = await otAndLeave('reject');
		expect((await approveLeave(leave)).status).toBe(200);
	});

	it('50. a cancelled OT allows the leave approval', async () => {
		const { leave } = await otAndLeave('cancel');
		expect((await approveLeave(leave)).status).toBe(200);
	});
});

// ============================================================================================
describe('actual overtime calculation', () => {
	it('pure: overlap of attendance with the approved window, exact minutes', () => {
		const w = { start: new Date('2026-09-21T10:30:00Z'), end: new Date('2026-09-21T12:30:00Z') };
		expect(
			overlapMinutes(
				{ start: new Date('2026-09-21T01:00:00Z'), end: new Date('2026-09-21T12:00:00Z') },
				w
			)
		).toBe(90);
		expect(
			overlapMinutes(
				{ start: new Date('2026-09-21T13:00:00Z'), end: new Date('2026-09-21T14:00:00Z') },
				w
			)
		).toBe(0);
		const c = calculateOvertime({
			window: w,
			effective: {
				checkInAt: new Date('2026-09-21T01:00:00Z'),
				checkOutAt: new Date('2026-09-21T11:32:00Z')
			},
			now: new Date('2026-09-22T00:00:00Z')
		});
		expect(c).toEqual({ calculationStatus: 'CALCULATED', actualMinutes: 62, eligibleMinutes: 62 }); // 62, not rounded
		expect(
			calculateOvertime({
				window: w,
				effective: {
					checkInAt: new Date('2026-09-21T01:00:00Z'),
					checkOutAt: new Date('2026-09-21T10:44:00Z')
				},
				now: new Date('2026-09-22T00:00:00Z')
			}).eligibleMinutes
		).toBe(14);
	});

	it('51. approved 120 min, attendance 08:00–19:00 → 90 actual / eligible', async () => {
		const s = await setup();
		const id = await approved(s, MON, '17:30', '19:30');
		expect((await checkIn(s, MON, '08:00')).status).toBe(201);
		expect((await checkOut(s, MON, '19:00')).status).toBe(200);
		const ot = await otOf(s, id);
		expect(ot).toMatchObject({
			plannedMinutes: 120,
			actualMinutes: 90,
			eligibleMinutes: 90,
			calculationStatus: 'CALCULATED'
		});
	});

	it('52. checking out later than the approved end is capped to the approved window', async () => {
		const s = await setup();
		const id = await approved(s, MON, '17:30', '19:30');
		await checkIn(s, MON, '08:03');
		await checkOut(s, MON, '20:30');
		const ot = await otOf(s, id);
		expect(ot.actualMinutes).toBe(120);
		expect(ot.eligibleMinutes).toBe(120); // NOT 180
	});

	it('53. time before the approved start is not counted', async () => {
		const s = await setup();
		const id = await approved(s, SAT, '09:00', '13:00');
		expect((await checkIn(s, SAT, '08:30')).status).toBe(201);
		await checkOut(s, SAT, '12:00');
		expect((await otOf(s, id)).eligibleMinutes).toBe(180); // 09:00–12:00, not 210
	});

	it('54. time after the approved end is not counted', async () => {
		const s = await setup();
		const id = await approved(s, SAT, '09:00', '13:00');
		await checkIn(s, SAT, '09:00');
		await checkOut(s, SAT, '15:00');
		expect((await otOf(s, id)).eligibleMinutes).toBe(240);
	});

	it('55. before-shift overlap: 06:30–08:00 with attendance 06:40–17:10 → 80', async () => {
		const s = await setup();
		const id = await approved(s, MON, '06:30', '08:00');
		expect((await checkIn(s, MON, '06:40')).status).toBe(201);
		await checkOut(s, MON, '17:10');
		const ot = await otOf(s, id);
		expect(ot).toMatchObject({ type: 'BEFORE_SHIFT', actualMinutes: 80, eligibleMinutes: 80 });
	});

	it('56. after-shift overlap: 17:30–19:30 with attendance 08:03–19:10 → 100', async () => {
		const s = await setup();
		const id = await approved(s, MON, '17:30', '19:30');
		await checkIn(s, MON, '08:03');
		await checkOut(s, MON, '19:10');
		expect((await otOf(s, id)).eligibleMinutes).toBe(100);
	});

	it('57. off-day overlap', async () => {
		const s = await setup();
		const id = await approved(s, SAT, '09:00', '13:00');
		await checkIn(s, SAT, '09:20');
		await checkOut(s, SAT, '12:50');
		expect((await otOf(s, id)).eligibleMinutes).toBe(210);
	});

	it('58. holiday overlap', async () => {
		const s = await setup();
		await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				nameLao: 'ວັນພັກ',
				holidayDate: new Date(`${MON}T00:00:00Z`)
			}
		});
		const id = await approved(s, MON, '09:00', '13:00');
		expect((await checkIn(s, MON, '09:00')).status).toBe(201);
		await checkOut(s, MON, '11:00');
		expect(await otOf(s, id)).toMatchObject({ type: 'HOLIDAY', eligibleMinutes: 120 });
	});

	it('59. incomplete attendance (no check-out) → INCOMPLETE_ATTENDANCE, nothing fabricated', async () => {
		const s = await setup();
		const id = await approved(s, MON, '17:30', '19:30');
		await checkIn(s, MON, '08:00');
		at(clockAt(MON, '21:00'));
		const ot = await otOf(s, id);
		expect(ot).toMatchObject({
			calculationStatus: 'INCOMPLETE_ATTENDANCE',
			actualMinutes: null,
			eligibleMinutes: null
		});
	});

	it('60. missing attendance: pending until the window ends, then 0 (derived on read)', async () => {
		const s = await setup();
		const id = await approved(s, MON, '17:30', '19:30');
		at(clockAt(MON, '18:00'));
		expect(await otOf(s, id)).toMatchObject({
			calculationStatus: 'PENDING_ATTENDANCE',
			actualMinutes: null,
			eligibleMinutes: null
		});
		at(clockAt(MON, '19:31'));
		expect(await otOf(s, id)).toMatchObject({
			calculationStatus: 'CALCULATED',
			actualMinutes: 0,
			eligibleMinutes: 0
		});
		// no attendance record was fabricated
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	async function correctedScenario() {
		const s = await setup();
		const id = await approved(s, MON, '17:30', '19:30');
		await checkIn(s, MON, '08:00');
		await checkOut(s, MON, '18:00');
		expect((await otOf(s, id)).eligibleMinutes).toBe(30);
		return { s, id };
	}

	it('61. an approved correction changes the effective checkout and recalculates the OT', async () => {
		const { s, id } = await correctedScenario();
		at(clockAt('2026-09-22', '09:00'));
		const corr = await post('/attendance/me/corrections', s.cookie, {
			workDate: MON,
			type: 'TIME_ADJUSTMENT',
			requestedCheckOutAt: laos(MON, '19:00'),
			reason: 'ລືມ Check-out ຕາມເວລາຈິງ'
		});
		expect(corr.status, JSON.stringify(corr.body)).toBe(201);
		expect((await otOf(s, id)).eligibleMinutes).toBe(30); // pending correction changes nothing
		const ok = await post(`/attendance/corrections/${corr.body.data.id}/approve`, hr.cookie, {});
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect(await otOf(s, id)).toMatchObject({
			actualMinutes: 90,
			eligibleMinutes: 90,
			calculationStatus: 'CALCULATED'
		});
	});

	it('62. raw punches stay unchanged by OT approval / recalculation / correction', async () => {
		const { s } = await correctedScenario();
		const before = await prisma.attendancePunch.findMany({
			where: { employeeId: s.employee.id },
			orderBy: { punchedAt: 'asc' }
		});
		at(clockAt('2026-09-22', '09:00'));
		const corr = await post('/attendance/me/corrections', s.cookie, {
			workDate: MON,
			type: 'TIME_ADJUSTMENT',
			requestedCheckOutAt: laos(MON, '19:00'),
			reason: 'ແກ້ໄຂເວລາ'
		});
		await post(`/attendance/corrections/${corr.body.data.id}/approve`, hr.cookie, {});
		const after = await prisma.attendancePunch.findMany({
			where: { employeeId: s.employee.id },
			orderBy: { punchedAt: 'asc' }
		});
		expect(after).toEqual(before);
		expect(after).toHaveLength(2);
		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(record.lastCheckOutAt?.toISOString()).toBe(new Date(laos(MON, '18:00')).toISOString());
		expect(record.effectiveCheckOutAt?.toISOString()).toBe(
			new Date(laos(MON, '19:00')).toISOString()
		);
	});

	it('approving after the attendance already exists calculates immediately', async () => {
		const s = await setup();
		const req = await request(s, MON, '17:30', '19:30');
		await checkIn(s, MON, '08:00');
		await checkOut(s, MON, '19:00');
		at(NOW);
		await approve(req.body.data.id);
		expect(await otOf(s, req.body.data.id)).toMatchObject({
			eligibleMinutes: 90,
			calculationStatus: 'CALCULATED'
		});
	});

	it('no money / rate fields exist anywhere in the payload', async () => {
		const s = await setup();
		const id = await approved(s, MON, '17:30', '19:30');
		const ot = await otOf(s, id);
		const keys = Object.keys(ot).join(',').toLowerCase();
		expect(keys).not.toMatch(/rate|pay|amount|salary|multiplier|money|cost/);
	});
});

// ============================================================================================
describe('attendance integration', () => {
	it('63. off-day check-in without an approved OT is rejected', async () => {
		const s = await setup();
		const res = await checkIn(s, SAT, '09:00');
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('NO_SCHEDULED_WORK');
		// a merely PENDING request does not open the door either
		await request(s, SAT, '09:00', '13:00');
		expect((await checkIn(s, SAT, '09:00')).body.error.code).toBe('NO_SCHEDULED_WORK');
	});

	it('64. approved off-day OT allows check-in (record has no regular schedule snapshot)', async () => {
		const s = await setup();
		await approved(s, SAT, '09:00', '13:00');
		const res = await checkIn(s, SAT, '09:00');
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(record).toMatchObject({
			isWorkingDay: false,
			isHoliday: false,
			scheduledStartTime: null,
			scheduledEndTime: null,
			scheduledLateGraceMinutes: null
		});
		expect(record.workDate.toISOString().slice(0, 10)).toBe(SAT);
		// out of the window (after it ended) → closed again for a fresh employee
		const other = await setup();
		await approved(other, SAT, '09:00', '13:00');
		expect((await checkIn(other, SAT, '13:30')).body.error.code).toBe('NO_SCHEDULED_WORK');
		// the attendance calculation never invents late / early leave for it
		await checkOut(s, SAT, '12:00');
		const done = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(done).toMatchObject({
			lateMinutes: null,
			earlyLeaveMinutes: null,
			calculationStatus: 'PRESENT'
		});
	});

	it('65. a holiday without an approved OT is rejected', async () => {
		const s = await setup();
		await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				nameLao: 'ວັນພັກ',
				holidayDate: new Date(`${MON}T00:00:00Z`)
			}
		});
		const res = await checkIn(s, MON, '09:00');
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('NO_SCHEDULED_WORK');
	});

	it('66. approved holiday OT allows check-in', async () => {
		const s = await setup();
		await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				nameLao: 'ວັນພັກ',
				holidayDate: new Date(`${MON}T00:00:00Z`)
			}
		});
		await approved(s, MON, '09:00', '13:00');
		const res = await checkIn(s, MON, '09:05');
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(record.isHoliday).toBe(true);
		expect(record.holidayId).toBeTruthy();
	});

	it('67. the OT early check-in window (policy) is enforced', async () => {
		const s = await setup();
		await setPolicy(s.company.id, { checkInEarlyMinutes: 30 });
		await approved(s, SAT, '09:00', '13:00');
		expect((await checkIn(s, SAT, '08:20')).body.error.code).toBe('NO_SCHEDULED_WORK'); // earliest 08:30
		const today = await get('/attendance/me/today', s.cookie);
		expect(today.body.data.overtime.checkInEarlyMinutes).toBe(30);
		expect((await checkIn(s, SAT, '08:31')).status).toBe(201);
	});

	it('68. an approved before-shift OT extends the normal check-in window', async () => {
		const s = await setup({ shift: { earlyCheckInMinutes: 30 } });
		// without OT: 06:20 is too early (normal window opens 07:30)
		const plain = await checkIn(s, MON, '06:20');
		expect(plain.status).toBe(400);
		expect(plain.body.error.code).toBe('TOO_EARLY_CHECK_IN');
		at(NOW);
		await approved(s, MON, '06:30', '08:00');
		const res = await checkIn(s, MON, '06:20'); // OT start 06:30 - 60 policy minutes = 05:30
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(record.scheduledStartTime).toBe('08:00'); // a normal record: lateness still measured from the shift
		expect(record.isWorkingDay).toBe(true);
	});

	it('69. daily attendance includes overtimeRequests (and the eligible total)', async () => {
		const s = await setup();
		const before = await approved(s, MON, '06:30', '08:00');
		const after = await approved(s, MON, '17:30', '19:30');
		await checkIn(s, MON, '06:40');
		await checkOut(s, MON, '19:10');
		const res = await daily(hr.cookie, `date=${MON}&employeeId=${s.employee.id}`);
		const row = res.body.data.items[0];
		expect(row.overtimeRequests.map((o: { requestId: string }) => o.requestId)).toEqual([
			before,
			after
		]);
		expect(row.overtimeRequests[0]).toMatchObject({
			type: 'BEFORE_SHIFT',
			status: 'APPROVED',
			plannedMinutes: 90,
			eligibleMinutes: 80
		});
		expect(row.overtimeRequests[1]).toMatchObject({
			type: 'AFTER_SHIFT',
			plannedMinutes: 120,
			eligibleMinutes: 100
		});
		expect(row.overtimeEligibleMinutesTotal).toBe(180);
		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		const detail = await get(`/attendance/${record.id}`, hr.cookie);
		expect(detail.body.data.overtimeRequests).toHaveLength(2);
	});

	it('70. an off-day stays OFF_DAY with OT context (before and after attendance exists)', async () => {
		const s = await setup();
		await approved(s, SAT, '09:00', '13:00');
		const pre = (await daily(hr.cookie, `date=${SAT}&employeeId=${s.employee.id}`)).body.data
			.items[0];
		expect(pre.result).toBe('OFF_DAY');
		expect(pre.overtimeRequests).toHaveLength(1);
		await checkIn(s, SAT, '09:00');
		await checkOut(s, SAT, '12:00');
		const post = (await daily(hr.cookie, `date=${SAT}&employeeId=${s.employee.id}`)).body.data
			.items[0];
		expect(post.result).toBe('OFF_DAY');
		expect(post.attendance).toBeTruthy();
		expect(post.overtimeRequests[0]).toMatchObject({ type: 'OFF_DAY', eligibleMinutes: 180 });
		expect(post.overtimeEligibleMinutesTotal).toBe(180);
	});

	it('71. a holiday stays HOLIDAY with OT context', async () => {
		const s = await setup();
		await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				nameLao: 'ວັນພັກ',
				holidayDate: new Date(`${MON}T00:00:00Z`)
			}
		});
		await approved(s, MON, '09:00', '13:00');
		await checkIn(s, MON, '09:00');
		await checkOut(s, MON, '13:00');
		const row = (await daily(hr.cookie, `date=${MON}&employeeId=${s.employee.id}`)).body.data
			.items[0];
		expect(row.result).toBe('HOLIDAY');
		expect(row.overtimeRequests[0]).toMatchObject({ type: 'HOLIDAY', eligibleMinutes: 240 });
	});

	it("today state exposes the employee's own OT (dashboard / attendance card)", async () => {
		const s = await setup();
		await approved(s, SAT, '09:00', '13:00');
		const pending = await request(s, SUN, '09:00', '11:00');
		at(clockAt(SAT, '08:00'));
		const today = await get('/attendance/me/today', s.cookie);
		expect(today.body.data.overtime.items.map((o: { status: string }) => o.status)).toEqual([
			'APPROVED'
		]);
		void pending;
	});
});

// ============================================================================================
describe('overtime data scope', () => {
	it('72. HR (employees.view_all) sees requests broadly', async () => {
		const a = await setup();
		const b = await setup();
		const ra = await request(a, MON, '17:30', '19:30');
		const rb = await request(b, MON, '17:30', '19:30');
		const ids = (await get('/overtime/requests?pageSize=100', hr.cookie)).body.data.items.map(
			(i: { id: string }) => i.id
		);
		expect(ids).toContain(ra.body.data.id);
		expect(ids).toContain(rb.body.data.id);
		const only = await get(
			`/overtime/requests?companyId=${a.company.id}&type=AFTER_SHIFT&status=PENDING`,
			hr.cookie
		);
		expect(only.body.data.items.map((i: { id: string }) => i.id)).toEqual([ra.body.data.id]);
	});

	it("73. a manager sees only their own and their reports' requests", async () => {
		const manager = await setup({ roleCode: 'MANAGER' });
		const report = await setup({
			companyId: manager.company.id,
			managerEmployeeId: manager.employee.id
		});
		const stranger = await setup({ companyId: manager.company.id });
		const own = await request(manager, MON, '17:30', '19:30');
		const rep = await request(report, MON, '17:30', '19:30');
		const other = await request(stranger, MON, '17:30', '19:30');
		const ids = (await get('/overtime/requests?pageSize=100', manager.cookie)).body.data.items.map(
			(i: { id: string }) => i.id
		);
		expect(ids.sort()).toEqual([own.body.data.id, rep.body.data.id].sort());
		expect(ids).not.toContain(other.body.data.id);
	});

	it("74. an unrelated request's detail is 403", async () => {
		const manager = await setup({ roleCode: 'MANAGER' });
		const stranger = await setup({ companyId: manager.company.id });
		const req = await request(stranger, MON, '17:30', '19:30');
		expect((await get(`/overtime/requests/${req.body.data.id}`, manager.cookie)).status).toBe(403);
	});

	it('role defaults: HR_ADMIN has all overtime permissions; MANAGER / EMPLOYEE are limited', async () => {
		const codesOf = async (role: string) =>
			(
				await prisma.rolePermission.findMany({
					where: { role: { code: role } },
					select: { permission: { select: { code: true } } }
				})
			)
				.map((r) => r.permission.code)
				.filter((c) => c.startsWith('overtime'))
				.sort();
		expect(await codesOf('HR_ADMIN')).toEqual(
			[
				'overtime.self',
				'overtime.view',
				'overtime.review',
				'overtime_rules.view',
				'overtime_rules.update'
			].sort()
		);
		expect(await codesOf('MANAGER')).toEqual(
			['overtime.self', 'overtime.view', 'overtime.review', 'overtime_rules.view'].sort()
		);
		expect(await codesOf('EMPLOYEE')).toEqual(['overtime.self']);
	});
});

// ============================================================================================
describe('timezone', () => {
	it('75. requested instants are Laos-offset aware (the same instant in UTC works, naive strings do not)', async () => {
		const s = await setup();
		const utc = await post('/overtime/me/requests/preview', s.cookie, {
			workDate: MON,
			requestedStartAt: '2026-09-21T10:30:00Z', // = 17:30 Laos
			requestedEndAt: '2026-09-21T12:30:00Z'
		});
		expect(utc.body.data).toMatchObject({ derivedType: 'AFTER_SHIFT', plannedMinutes: 120 });
		const naive = await post('/overtime/me/requests/preview', s.cookie, {
			workDate: MON,
			requestedStartAt: '2026-09-21T17:30:00',
			requestedEndAt: '2026-09-21T19:30:00'
		});
		expect(naive.status).toBe(400);
	});

	it('76. an overnight shift accepts a next-day after-shift request; an off-day window may cross midnight', async () => {
		const s = await setup({ shift: { startTime: '22:00', endTime: '06:00' } });
		const next = await post('/overtime/me/requests', s.cookie, {
			workDate: MON,
			requestedStartAt: laos('2026-09-22', '06:00'),
			requestedEndAt: laos('2026-09-22', '08:00'),
			reason: 'ຕໍ່ເວລາຫຼັງກະກາງຄືນ'
		});
		expect(next.status, JSON.stringify(next.body)).toBe(201);
		expect(next.body.data).toMatchObject({ type: 'AFTER_SHIFT', plannedMinutes: 120 });
		expect(next.body.data.workDate.slice(0, 10)).toBe(MON);
		const cross = await post('/overtime/me/requests/preview', s.cookie, {
			workDate: SAT,
			requestedStartAt: laos(SAT, '22:00'),
			requestedEndAt: laos(SUN, '02:00')
		});
		expect(cross.body.data).toMatchObject({
			derivedType: 'OFF_DAY',
			plannedMinutes: 240,
			canSubmit: true
		});
		// starting on the wrong calendar day for an off-day is refused
		const wrongDay = await post('/overtime/me/requests/preview', s.cookie, {
			workDate: SAT,
			requestedStartAt: laos(SUN, '01:00'),
			requestedEndAt: laos(SUN, '03:00')
		});
		expect(wrongDay.body.data.blockers[0].code).toBe('OT_TIME_OUT_OF_RANGE');
	});

	it('77. UTC boundary: a 00:30 Laos window belongs to the Laos date, and "past" uses the Laos calendar', async () => {
		const s = await setup();
		// Sun 00:30–02:00 Laos = Sat 17:30–19:00 UTC → still the work date 2026-09-27
		const res = await post('/overtime/me/requests/preview', s.cookie, {
			workDate: SUN,
			requestedStartAt: laos(SUN, '00:30'),
			requestedEndAt: laos(SUN, '02:00')
		});
		expect(res.body.data).toMatchObject({ derivedType: 'OFF_DAY', canSubmit: true });
		// 2026-09-20T18:00Z is already Mon 01:00 in Laos while the UTC date is Sunday: Sunday is the past
		at('2026-09-20T18:00:00Z');
		const past = await request(s, '2026-09-20', '09:00', '11:00');
		expect(past.body.error.code).toBe('OT_DATE_IN_PAST');
		expect((await request(s, MON, '17:30', '19:30')).status).toBe(201);
	});
});
