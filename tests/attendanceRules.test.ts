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
import {
	calculateAttendance,
	resolveEffectiveAttendanceTimes
} from '../src/lib/attendanceCalculation.js';
import { recalculateAttendanceRecord } from '../src/services/attendanceCalculation.service.js';

const uid = () => randomUUID().slice(0, 6).toUpperCase();
const at = (iso: string) => setServerClockForTests(() => new Date(iso));
afterEach(() => setServerClockForTests(null));

// Laos = UTC+7. Monday 2026-09-21, Saturday 2026-09-19.
const MON = '2026-09-21';
const T = {
	in0758: '2026-09-21T00:58:00Z',
	in0803: '2026-09-21T01:03:00Z',
	in0808: '2026-09-21T01:08:00Z',
	out1640: '2026-09-21T09:40:00Z',
	out1658: '2026-09-21T09:58:00Z',
	out1700: '2026-09-21T10:00:00Z',
	out1705: '2026-09-21T10:05:00Z',
	tueNoon: '2026-09-22T05:00:00Z', // Tue 12:00 Laos (Monday's work date is history)
	monNoon: '2026-09-21T05:00:00Z'
};
const laos = (date: string, hm: string) => `${date}T${hm}:00+07:00`;

let admin: string;
let hr: { user: { id: string }; cookie: string };
beforeAll(async () => {
	admin = await superAdminCookie();
	hr = await userWithPermissions([
		'attendance.view',
		'attendance_corrections.review',
		'attendance_rules.view',
		'attendance_rules.update',
		'employees.view_all'
	]);
});

interface SetupOptions {
	shift?: Record<string, unknown>;
	companyId?: string;
	startDate?: string;
	endDate?: string | null;
	managerEmployeeId?: string;
	departmentId?: string;
	existing?: { user: { id: string }; cookie: string };
	roleCode?: string;
	noSchedule?: boolean;
}

async function setup(opts: SetupOptions = {}) {
	const company = opts.companyId
		? await prisma.company.findUniqueOrThrow({ where: { id: opts.companyId } })
		: await createTestCompany();
	const shiftRes = await agent()
		.post('/api/v1/shifts')
		.set('Cookie', admin)
		.send({
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
			startDate: new Date(`${opts.startDate ?? '2024-01-01'}T00:00:00.000Z`),
			endDate: opts.endDate ? new Date(`${opts.endDate}T00:00:00.000Z`) : null,
			companyId: company.id,
			userId: user.id,
			managerEmployeeId: opts.managerEmployeeId ?? null,
			departmentId: opts.departmentId ?? null
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

const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const get = (path: string, cookie: string) => agent().get(`/api/v1${path}`).set('Cookie', cookie);

async function punch(s: Ctx, inIso: string, outIso?: string) {
	at(inIso);
	const a = await post('/attendance/me/check-in', s.cookie);
	expect(a.status, JSON.stringify(a.body)).toBe(201);
	if (outIso) {
		at(outIso);
		const b = await post('/attendance/me/check-out', s.cookie);
		expect(b.status, JSON.stringify(b.body)).toBe(200);
	}
	return prisma.attendanceRecord.findFirstOrThrow({ where: { employeeId: s.employee.id } });
}

const requestCorrection = (s: Ctx, body: Record<string, unknown>) =>
	post('/attendance/me/corrections', s.cookie, body);
const approve = (id: string, cookie = hr.cookie, body: Record<string, unknown> = {}) =>
	post(`/attendance/corrections/${id}/approve`, cookie, body);
const reject = (
	id: string,
	cookie = hr.cookie,
	body: Record<string, unknown> = { reviewNote: 'ບໍ່ຖືກຕ້ອງ' }
) => post(`/attendance/corrections/${id}/reject`, cookie, body);

// ============================================================================================
describe('calculation formulas (pure)', () => {
	const snap = {
		workDate: new Date('2026-09-21T00:00:00Z'),
		startTime: '08:00',
		endTime: '17:00',
		breakMinutes: 60,
		crossesMidnight: false,
		lateGraceMinutes: 5,
		earlyLeaveGraceMinutes: 5
	};
	const d = (iso: string) => new Date(iso);

	it('scheduled minutes: 08:00–17:00 with a 60 min break = 480; overnight 22:00–06:00 = 420', () => {
		expect(
			calculateAttendance(
				snap,
				{ checkInAt: null, checkOutAt: null },
				{ deductScheduledBreak: true }
			).scheduledWorkMinutes
		).toBe(480);
		const night = { ...snap, startTime: '22:00', endTime: '06:00', crossesMidnight: true };
		expect(
			calculateAttendance(
				night,
				{ checkInAt: null, checkOutAt: null },
				{ deductScheduledBreak: true }
			).scheduledWorkMinutes
		).toBe(420);
	});

	it('raw vs effective: an overlay wins, otherwise effective = raw', () => {
		const raw = { firstCheckInAt: d('2026-09-21T01:08:00Z'), lastCheckOutAt: null };
		expect(resolveEffectiveAttendanceTimes(raw, null)).toMatchObject({
			checkOutAt: null,
			source: 'PUNCH'
		});
		const eff = resolveEffectiveAttendanceTimes(raw, {
			effectiveCheckInAt: null,
			effectiveCheckOutAt: d('2026-09-21T10:05:00Z')
		});
		expect(eff.checkInAt?.toISOString()).toBe('2026-09-21T01:08:00.000Z'); // untouched side falls back to raw
		expect(eff.checkOutAt?.toISOString()).toBe('2026-09-21T10:05:00.000Z');
		expect(eff.source).toBe('CORRECTION');
	});

	it('overnight worked minutes with the scheduled break deducted', () => {
		const night = { ...snap, startTime: '22:00', endTime: '06:00', crossesMidnight: true };
		const r = calculateAttendance(
			night,
			{ checkInAt: d('2026-09-21T15:05:00Z'), checkOutAt: d('2026-09-21T22:55:00Z') }, // 22:05 → 05:55
			{ deductScheduledBreak: true }
		);
		expect(r.workedMinutes).toBe(410); // 470 elapsed - 60
		expect(r.arrivalDelayMinutes).toBe(5);
		expect(r.lateMinutes).toBe(0); // inside the 5 min grace
		expect(r.earlyLeaveMinutes).toBe(0); // 5 min early, inside grace
		expect(r.calculationStatus).toBe('PRESENT');
	});

	it('never caps worked time and never invents overtime', () => {
		const r = calculateAttendance(
			snap,
			{ checkInAt: d('2026-09-21T01:00:00Z'), checkOutAt: d('2026-09-21T12:00:00Z') }, // 08:00–19:00
			{ deductScheduledBreak: true }
		);
		expect(r.workedMinutes).toBe(600);
		expect(r.calculationStatus).toBe('PRESENT');
		expect(JSON.stringify(r)).not.toMatch(/overtime/i);
	});
});

describe('calculation on real attendance (snapshot-based)', () => {
	async function calcFor(s: Ctx) {
		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		return get(`/attendance/${record.id}`, hr.cookie).then((r) => r.body.data);
	}

	it('present on time', async () => {
		const s = await setup();
		await punch(s, T.in0758, T.out1700);
		const rec = await calcFor(s);
		expect(rec.result).toBe('PRESENT');
		expect(rec.calculation).toMatchObject({
			lateMinutes: 0,
			earlyLeaveMinutes: 0,
			arrivalDelayMinutes: 0,
			scheduledWorkMinutes: 480,
			calculationVersion: 1
		});
	});

	it('arrival delay is recorded separately from late minutes; grace applies', async () => {
		const within = await setup();
		await punch(within, T.in0803, T.out1700);
		expect((await calcFor(within)).calculation).toMatchObject({
			arrivalDelayMinutes: 3,
			lateMinutes: 0
		});
		const late = await setup();
		await punch(late, T.in0808, T.out1700);
		const rec = await calcFor(late);
		expect(rec.calculation).toMatchObject({ arrivalDelayMinutes: 8, lateMinutes: 3 });
		expect(rec.result).toBe('LATE');
	});

	it('early leave respects the grace; 16:40 = 15 min, 16:58 = 0', async () => {
		const early = await setup();
		await punch(early, T.in0758, T.out1640);
		const rec = await calcFor(early);
		expect(rec.calculation.earlyLeaveMinutes).toBe(15);
		expect(rec.result).toBe('EARLY_LEAVE');
		const ok = await setup();
		await punch(ok, T.in0758, T.out1658);
		expect((await calcFor(ok)).calculation.earlyLeaveMinutes).toBe(0);
	});

	it('late + early leave; worked = elapsed − break (08:08 → 16:40 = 7h32m)', async () => {
		const s = await setup();
		await punch(s, T.in0808, T.out1640);
		const rec = await calcFor(s);
		expect(rec.result).toBe('LATE_AND_EARLY');
		expect(rec.calculation).toMatchObject({
			arrivalDelayMinutes: 8,
			lateMinutes: 3,
			earlyLeaveMinutes: 15,
			workedMinutes: 452
		});
		// raw facts stay separate from the effective values
		expect(rec.firstCheckInAt).toBe('2026-09-21T01:08:00.000Z');
		expect(rec.isCorrected).toBe(false);
	});

	it('without the break deduction policy, worked = elapsed', async () => {
		const s = await setup();
		const patched = await agent()
			.patch(`/api/v1/attendance-policies/${s.company.id}`)
			.set('Cookie', hr.cookie)
			.send({ deductScheduledBreak: false });
		expect(patched.status).toBe(200);
		await punch(s, T.in0808, T.out1640);
		expect((await calcFor(s)).calculation.workedMinutes).toBe(512);
	});

	it('overnight attendance is calculated against the following-day end', async () => {
		const s = await setup({ shift: { startTime: '22:00', endTime: '06:00' } });
		const record = await punch(s, '2026-09-21T15:05:00Z', '2026-09-21T22:55:00Z');
		expect(record.workDate.toISOString().slice(0, 10)).toBe(MON);
		const rec = await calcFor(s);
		expect(rec.calculation).toMatchObject({
			scheduledWorkMinutes: 420,
			workedMinutes: 410,
			lateMinutes: 0,
			earlyLeaveMinutes: 0
		});
	});

	it('an unfinished day is IN_PROGRESS, then INCOMPLETE once the missing-check-out grace has passed', async () => {
		const s = await setup();
		await punch(s, T.in0803);
		const during = await get('/attendance/me/today', s.cookie);
		expect(during.body.data.attendance.result).toBe('IN_PROGRESS');
		at('2026-09-21T15:30:00Z'); // 22:30, past 17:00 + 240 min
		const after = await get('/attendance/me/history', s.cookie);
		expect(after.body.data.items[0].result).toBe('INCOMPLETE');
		expect(after.body.data.items[0].status).toBe('MISSING_CHECK_OUT');
	});

	it('the missing-check-out grace comes from the company policy', async () => {
		const s = await setup();
		await agent()
			.patch(`/api/v1/attendance-policies/${s.company.id}`)
			.set('Cookie', hr.cookie)
			.send({ missingCheckOutGraceMinutes: 30 });
		await punch(s, T.in0803);
		at('2026-09-21T10:45:00Z'); // 17:45 Laos: past 17:00 + 30
		expect((await get('/attendance/me/history', s.cookie)).body.data.items[0].status).toBe(
			'MISSING_CHECK_OUT'
		);
		at('2026-09-21T10:20:00Z'); // 17:20: still inside the grace
		expect((await get('/attendance/me/history', s.cookie)).body.data.items[0].status).toBe(
			'IN_PROGRESS'
		);
	});
});

describe('absence derivation (daily result)', () => {
	const daily = (cookie: string, qs: string) => get(`/attendance/daily?${qs}`, cookie);

	it('scheduled workday with no punch on a finished day = ABSENT (and no fake record is created)', async () => {
		const s = await setup();
		at(T.tueNoon);
		const res = await daily(hr.cookie, `date=${MON}&employeeId=${s.employee.id}`);
		expect(res.body.data.items[0].result).toBe('ABSENT');
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(0);
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	it('a shift that has not ended yet is PENDING, not ABSENT', async () => {
		const s = await setup();
		at(T.monNoon); // Monday 12:00 Laos, shift ends 17:00
		const res = await daily(hr.cookie, `date=${MON}&employeeId=${s.employee.id}`);
		expect(res.body.data.items[0].result).toBe('PENDING');
	});

	it('an off day is OFF_DAY', async () => {
		const s = await setup();
		at('2026-09-20T05:00:00Z');
		const res = await daily(hr.cookie, `date=2026-09-19&employeeId=${s.employee.id}`);
		expect(res.body.data.items[0].result).toBe('OFF_DAY');
	});

	it('a holiday is HOLIDAY', async () => {
		const s = await setup();
		await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				holidayDate: new Date(`${MON}T00:00:00Z`),
				nameLao: 'ວັນພັກ',
				type: 'COMPANY'
			}
		});
		at(T.tueNoon);
		expect(
			(await daily(hr.cookie, `date=${MON}&employeeId=${s.employee.id}`)).body.data.items[0].result
		).toBe('HOLIDAY');
	});

	it('nobody is ABSENT before their start date', async () => {
		const s = await setup({ startDate: '2026-09-25' });
		at('2026-09-28T05:00:00Z');
		const res = await daily(hr.cookie, `date=${MON}&employeeId=${s.employee.id}`);
		expect(res.body.data.total).toBe(0);
		const onStart = await daily(hr.cookie, `date=2026-09-25&employeeId=${s.employee.id}`);
		expect(onStart.body.data.items[0].result).toBe('ABSENT');
	});

	it('nobody is ABSENT after their end date', async () => {
		const s = await setup({ endDate: '2026-09-18' });
		at(T.tueNoon);
		expect(
			(await daily(hr.cookie, `date=${MON}&employeeId=${s.employee.id}`)).body.data.total
		).toBe(0);
		expect(
			(await daily(hr.cookie, `date=2026-09-18&employeeId=${s.employee.id}`)).body.data.items[0]
				.result
		).toBe('ABSENT');
	});

	it('no schedule is reported as NO_SCHEDULE, never ABSENT', async () => {
		const s = await setup({ noSchedule: true });
		at(T.tueNoon);
		expect(
			(await daily(hr.cookie, `date=${MON}&employeeId=${s.employee.id}`)).body.data.items[0].result
		).toBe('NO_SCHEDULE');
	});
});

describe('daily attendance API', () => {
	async function three() {
		const company = await createTestCompany();
		const dept = await prisma.department.create({
			data: { companyId: company.id, code: `D_${uid()}`, nameLao: 'ພະແນກ' }
		});
		const a = await setup({ companyId: company.id, departmentId: dept.id });
		const b = await setup({ companyId: company.id });
		const c = await setup({ companyId: company.id });
		return { company, dept, a, b, c };
	}

	it('includes employees with a record AND absent employees without one', async () => {
		const { company, a, b } = await three();
		await punch(a, T.in0808, T.out1640);
		at(T.tueNoon);
		const res = await get(`/attendance/daily?date=${MON}&companyId=${company.id}`, hr.cookie);
		const byId = new Map(
			res.body.data.items.map((i: { employee: { id: string }; result: string }) => [
				i.employee.id,
				i
			])
		);
		expect((byId.get(a.employee.id) as { result: string }).result).toBe('LATE_AND_EARLY');
		expect(
			(byId.get(a.employee.id) as { attendance: { calculation: { lateMinutes: number } } })
				.attendance.calculation.lateMinutes
		).toBe(3);
		expect((byId.get(b.employee.id) as { result: string }).result).toBe('ABSENT');
		expect(res.body.data.total).toBe(3);
	});

	it('paginates', async () => {
		const { company } = await three();
		at(T.tueNoon);
		const p1 = await get(
			`/attendance/daily?date=${MON}&companyId=${company.id}&page=1&pageSize=2`,
			hr.cookie
		);
		expect(p1.body.data.items.length).toBe(2);
		expect(p1.body.data.total).toBe(3);
		expect(p1.body.data.totalPages).toBe(2);
		const p2 = await get(
			`/attendance/daily?date=${MON}&companyId=${company.id}&page=2&pageSize=2`,
			hr.cookie
		);
		expect(p2.body.data.items.length).toBe(1);
	});

	it('filters by department and by result', async () => {
		const { company, dept, a, b } = await three();
		await punch(b, T.in0758, T.out1700);
		at(T.tueNoon);
		const byDept = await get(
			`/attendance/daily?date=${MON}&companyId=${company.id}&departmentId=${dept.id}`,
			hr.cookie
		);
		expect(byDept.body.data.items.map((i: { employee: { id: string } }) => i.employee.id)).toEqual([
			a.employee.id
		]);
		const absent = await get(
			`/attendance/daily?date=${MON}&companyId=${company.id}&result=ABSENT`,
			hr.cookie
		);
		expect(absent.body.data.total).toBe(2);
		const present = await get(
			`/attendance/daily?date=${MON}&companyId=${company.id}&result=PRESENT&pageSize=1`,
			hr.cookie
		);
		expect(present.body.data.items[0].employee.id).toBe(b.employee.id);
		expect(present.body.data.total).toBe(1);
	});

	it('requires attendance.view and respects the manager scope', async () => {
		const company = await createTestCompany();
		const mgrUser = await createTestUser({ roleCode: 'MANAGER' });
		const mgrCookie = await loginAndGetCookie(mgrUser.username, mgrUser.password);
		const mgr = await setup({
			companyId: company.id,
			existing: { user: mgrUser.user, cookie: mgrCookie }
		});
		const report = await setup({ companyId: company.id, managerEmployeeId: mgr.employee.id });
		await setup({ companyId: company.id }); // outsider
		at(T.tueNoon);
		const list = await get(`/attendance/daily?date=${MON}&companyId=${company.id}`, mgrCookie);
		expect(
			list.body.data.items.map((i: { employee: { id: string } }) => i.employee.id).sort()
		).toEqual([mgr.employee.id, report.employee.id].sort());
		const emp = await setup();
		expect((await get('/attendance/daily', emp.cookie)).status).toBe(403);
	});
});

describe('correction requests', () => {
	const REQ_OUT = {
		type: 'MISSING_CHECK_OUT',
		requestedCheckOutAt: laos(MON, '17:05'),
		reason: 'ລືມ Check-out'
	};

	it('requires the request permission and a linked employee', async () => {
		const noPerm = await userWithPermissions(['attendance.self']);
		at(T.tueNoon);
		expect(
			(await post('/attendance/me/corrections', noPerm.cookie, { workDate: MON, ...REQ_OUT }))
				.status
		).toBe(403);
		const created = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(created.username, created.password);
		const res = await post('/attendance/me/corrections', cookie, { workDate: MON, ...REQ_OUT });
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('NO_LINKED_EMPLOYEE');
	});

	it('is refused when the company policy disallows employee corrections', async () => {
		const s = await setup();
		await agent()
			.patch(`/api/v1/attendance-policies/${s.company.id}`)
			.set('Cookie', hr.cookie)
			.send({ allowEmployeeCorrection: false });
		at(T.tueNoon);
		const res = await requestCorrection(s, { workDate: MON, ...REQ_OUT });
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('CORRECTION_NOT_ALLOWED');
	});

	it('rejects a work date outside the request window and in the future', async () => {
		const s = await setup();
		at(T.tueNoon);
		const old = await requestCorrection(s, {
			workDate: '2026-08-04',
			type: 'MISSING_BOTH',
			requestedCheckInAt: laos('2026-08-04', '08:00'),
			requestedCheckOutAt: laos('2026-08-04', '17:00'),
			reason: 'ລືມ'
		});
		expect(old.body.error.code).toBe('CORRECTION_WINDOW_EXPIRED');
		const future = await requestCorrection(s, {
			workDate: '2026-09-25',
			type: 'MISSING_BOTH',
			requestedCheckInAt: laos('2026-09-25', '08:00'),
			requestedCheckOutAt: laos('2026-09-25', '17:00'),
			reason: 'ລືມ'
		});
		expect(future.body.error.code).toBe('CORRECTION_FUTURE_DATE');
		// a wider window (policy) makes the older day requestable
		await agent()
			.patch(`/api/v1/attendance-policies/${s.company.id}`)
			.set('Cookie', hr.cookie)
			.send({ correctionRequestWindowDays: 90 });
		const ok = await requestCorrection(s, {
			workDate: '2026-08-04',
			type: 'MISSING_BOTH',
			requestedCheckInAt: laos('2026-08-04', '08:00'),
			requestedCheckOutAt: laos('2026-08-04', '17:00'),
			reason: 'ລືມ'
		});
		expect(ok.status, JSON.stringify(ok.body)).toBe(201);
	});

	it('rejects an off-day and a holiday', async () => {
		const s = await setup();
		await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				holidayDate: new Date(`${MON}T00:00:00Z`),
				nameLao: 'ວັນພັກ',
				type: 'COMPANY'
			}
		});
		at(T.tueNoon);
		const off = await requestCorrection(s, {
			workDate: '2026-09-19',
			type: 'MISSING_BOTH',
			requestedCheckInAt: laos('2026-09-19', '08:00'),
			requestedCheckOutAt: laos('2026-09-19', '17:00'),
			reason: 'ລືມ'
		});
		expect(off.body.error.code).toBe('NO_SCHEDULED_WORK');
		const hol = await requestCorrection(s, { workDate: MON, ...REQ_OUT });
		expect(hol.body.error.code).toBe('NO_SCHEDULED_WORK');
	});

	it('accepts MISSING_CHECK_OUT for an existing incomplete record', async () => {
		const s = await setup();
		await punch(s, T.in0808);
		at(T.tueNoon);
		const res = await requestCorrection(s, { workDate: MON, ...REQ_OUT });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data.status).toBe('PENDING');
		expect(res.body.data.attendanceRecordId).not.toBeNull();
	});

	it('accepts MISSING_CHECK_IN', async () => {
		const s = await setup();
		at(T.tueNoon);
		const res = await requestCorrection(s, {
			workDate: MON,
			type: 'MISSING_CHECK_IN',
			requestedCheckInAt: laos(MON, '08:05'),
			reason: 'ລືມ Check-in'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
	});

	it('accepts MISSING_BOTH for a day with NO attendance record', async () => {
		const s = await setup();
		at(T.tueNoon);
		const res = await requestCorrection(s, {
			workDate: MON,
			type: 'MISSING_BOTH',
			requestedCheckInAt: laos(MON, '08:01'),
			requestedCheckOutAt: laos(MON, '17:03'),
			reason: 'ລືມທັງສອງ'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data.attendanceRecordId).toBeNull();
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	it('accepts an overnight correction whose check-out is on the next calendar day', async () => {
		const s = await setup({ shift: { startTime: '22:00', endTime: '06:00' } });
		at(T.tueNoon);
		const res = await requestCorrection(s, {
			workDate: MON,
			type: 'MISSING_BOTH',
			requestedCheckInAt: laos(MON, '22:05'),
			requestedCheckOutAt: laos('2026-09-22', '05:55'),
			reason: 'ລືມ'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data.workDate.slice(0, 10)).toBe(MON);
	});

	it('rejects check-out before check-in, out-of-range and future times, and mismatched types', async () => {
		const s = await setup();
		at(T.tueNoon);
		const both = (inAt: string, outAt: string) =>
			requestCorrection(s, {
				workDate: MON,
				type: 'MISSING_BOTH',
				requestedCheckInAt: inAt,
				requestedCheckOutAt: outAt,
				reason: 'ລືມ'
			});
		expect((await both(laos(MON, '17:00'), laos(MON, '08:00'))).body.error.code).toBe(
			'INVALID_CORRECTION_TIMES'
		);
		expect((await both(laos(MON, '08:00'), laos('2026-09-24', '08:00'))).body.error.code).toBe(
			'CORRECTION_TIME_OUT_OF_RANGE'
		);
		const bad = await requestCorrection(s, {
			workDate: MON,
			type: 'MISSING_CHECK_OUT',
			requestedCheckInAt: laos(MON, '08:00'),
			reason: 'ລືມ'
		});
		expect(bad.body.error.code).toBe('INVALID_CORRECTION_FIELDS');
		const naive = await requestCorrection(s, {
			workDate: MON,
			type: 'MISSING_CHECK_OUT',
			requestedCheckOutAt: `${MON}T17:05:00`,
			reason: 'ລືມ'
		});
		expect(naive.status).toBe(400); // no timezone → not an acceptable instant
		const unknown = await post('/attendance/me/corrections', s.cookie, {
			workDate: MON,
			...REQ_OUT,
			employeeId: 'someone-else'
		});
		expect(unknown.status).toBe(400); // self API never accepts an employee id
	});

	it('rejects a second PENDING request for the same day', async () => {
		const s = await setup();
		at(T.tueNoon);
		expect((await requestCorrection(s, { workDate: MON, ...REQ_OUT })).status).toBe(201);
		const dup = await requestCorrection(s, { workDate: MON, ...REQ_OUT });
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('CORRECTION_ALREADY_PENDING');
		const race = await Promise.all(
			[1, 2].map(() =>
				requestCorrection(s, {
					workDate: '2026-09-18',
					type: 'MISSING_BOTH',
					requestedCheckInAt: laos('2026-09-18', '08:00'),
					requestedCheckOutAt: laos('2026-09-18', '17:00'),
					reason: 'ລືມ'
				})
			)
		);
		expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
	});

	it('lets the employee cancel a PENDING request (and then file a new one), but not an approved one', async () => {
		const s = await setup();
		at(T.tueNoon);
		const created = await requestCorrection(s, { workDate: MON, ...REQ_OUT });
		const id = created.body.data.id;
		const cancelled = await post(`/attendance/me/corrections/${id}/cancel`, s.cookie);
		expect(cancelled.status).toBe(200);
		expect(cancelled.body.data.status).toBe('CANCELLED');
		const again = await requestCorrection(s, { workDate: MON, ...REQ_OUT });
		expect(again.status).toBe(201);
		expect((await approve(again.body.data.id)).status).toBe(200);
		const late = await post(`/attendance/me/corrections/${again.body.data.id}/cancel`, s.cookie);
		expect(late.status).toBe(409);
		expect(late.body.error.code).toBe('CORRECTION_NOT_PENDING');
	});

	it('the correction-context endpoint reports raw times, the schedule and eligibility', async () => {
		const s = await setup();
		await punch(s, T.in0808);
		at(T.tueNoon);
		const ctx = await get(`/attendance/me/correction-context?workDate=${MON}`, s.cookie);
		expect(ctx.body.data.eligible).toBe(true);
		expect(ctx.body.data.schedule).toMatchObject({ startTime: '08:00', endTime: '17:00' });
		expect(ctx.body.data.recorded).toMatchObject({ hasRecord: true, rawCheckOutAt: null });
		const sat = await get('/attendance/me/correction-context?workDate=2026-09-19', s.cookie);
		expect(sat.body.data.eligible).toBe(false);
		expect(sat.body.data.blocked.code).toBe('NO_SCHEDULED_WORK');
	});
});

describe('correction review', () => {
	async function pendingFor(s: Ctx, body?: Record<string, unknown>) {
		at(T.tueNoon);
		const res = await requestCorrection(
			s,
			body ?? {
				workDate: MON,
				type: 'MISSING_CHECK_OUT',
				requestedCheckOutAt: laos(MON, '17:05'),
				reason: 'ລືມ Check-out'
			}
		);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return res.body.data.id as string;
	}

	it('requires attendance_corrections.review', async () => {
		const s = await setup();
		const id = await pendingFor(s);
		expect((await get('/attendance/corrections', s.cookie)).status).toBe(403);
		expect((await approve(id, s.cookie)).status).toBe(403);
		const viewOnly = await userWithPermissions(['attendance.view', 'employees.view_all']);
		expect((await get('/attendance/corrections', viewOnly.cookie)).status).toBe(403);
	});

	it("enforces the reviewer's Employee data scope", async () => {
		const s = await setup();
		const id = await pendingFor(s);
		const scoped = await userWithPermissions(['attendance_corrections.review']); // no view_all, no employee
		const list = await get('/attendance/corrections', scoped.cookie);
		expect(list.status).toBe(200);
		expect(list.body.data.items).toEqual([]);
		expect((await get(`/attendance/corrections/${id}`, scoped.cookie)).status).toBe(403);
		expect((await approve(id, scoped.cookie)).status).toBe(403);
		expect((await reject(id, scoped.cookie)).status).toBe(403);
		expect(
			(await prisma.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id } })).status
		).toBe('PENDING');
	});

	it('a reviewer cannot approve or reject their own request', async () => {
		const self = await userWithPermissions([
			'attendance.self',
			'attendance_corrections.request',
			'attendance_corrections.review',
			'employees.view_all'
		]);
		const s = await setup({ existing: self });
		const id = await pendingFor(s);
		for (const act of [approve, reject]) {
			const res = await act(id, self.cookie);
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe('CANNOT_REVIEW_OWN_REQUEST');
		}
		const detail = await get(`/attendance/corrections/${id}`, self.cookie);
		expect(detail.body.data.canReview).toBe(false);
		expect(
			(await prisma.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id } })).status
		).toBe('PENDING');
		expect((await approve(id)).status).toBe(200); // someone else can
	});

	it('rejects a request (a review note is required) and a rejected request cannot be re-reviewed', async () => {
		const s = await setup();
		const id = await pendingFor(s);
		expect((await reject(id, hr.cookie, {})).status).toBe(400);
		const res = await reject(id, hr.cookie, { reviewNote: 'ຂໍ້ມູນບໍ່ຄົບ' });
		expect(res.status).toBe(200);
		expect(res.body.data).toMatchObject({ status: 'REJECTED', reviewNote: 'ຂໍ້ມູນບໍ່ຄົບ' });
		expect(res.body.data.reviewedBy.id).toBe(hr.user.id);
		expect((await approve(id)).body.error.code).toBe('CORRECTION_ALREADY_REVIEWED');
		expect(
			await prisma.attendanceCorrectionApplication.count({ where: { correctionRequestId: id } })
		).toBe(0);
	});

	it('approves a correction for an existing record — raw punches untouched, effective overlay applied, recalculated', async () => {
		const s = await setup();
		const record = await punch(s, T.in0808);
		const punchesBefore = await prisma.attendancePunch.findMany({
			where: { employeeId: s.employee.id },
			orderBy: { punchedAt: 'asc' }
		});
		const id = await pendingFor(s);

		const detail = await get(`/attendance/corrections/${id}`, hr.cookie);
		expect(detail.body.data.preview.before.calculationStatus).toBe('INCOMPLETE');
		expect(detail.body.data.preview.after).toMatchObject({
			calculationStatus: 'LATE',
			lateMinutes: 3,
			earlyLeaveMinutes: 0,
			workedMinutes: 477
		});

		const res = await approve(id, hr.cookie, { reviewNote: 'OK' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data.status).toBe('APPROVED');

		// raw punches and raw record columns are unchanged
		const punchesAfter = await prisma.attendancePunch.findMany({
			where: { employeeId: s.employee.id },
			orderBy: { punchedAt: 'asc' }
		});
		expect(punchesAfter).toEqual(punchesBefore);
		expect(punchesAfter.map((p) => p.type)).toEqual(['CHECK_IN']);
		const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
		expect(after.lastCheckOutAt).toBeNull();
		expect(after.firstCheckInAt?.toISOString()).toBe('2026-09-21T01:08:00.000Z');
		// effective overlay + recalculation
		expect(after.effectiveCheckOutAt?.toISOString()).toBe('2026-09-21T10:05:00.000Z');
		expect(after.effectiveCheckInAt?.toISOString()).toBe('2026-09-21T01:08:00.000Z');
		expect(after).toMatchObject({
			isCorrected: true,
			status: 'COMPLETED',
			calculationStatus: 'LATE',
			lateMinutes: 3,
			workedMinutes: 477
		});
		const overlay = await prisma.attendanceCorrectionApplication.findUniqueOrThrow({
			where: { correctionRequestId: id }
		});
		expect(overlay.attendanceRecordId).toBe(record.id);

		const view = await get(`/attendance/${record.id}`, hr.cookie);
		expect(view.body.data).toMatchObject({ isCorrected: true, result: 'LATE' });
		expect(view.body.data.lastCheckOutAt).toBeNull(); // raw stays raw
		expect(view.body.data.effectiveCheckOutAt).toBe('2026-09-21T10:05:00.000Z');
	});

	it('approving a correction for a day with NO record creates the AttendanceRecord from the historical snapshot, with no fake punch', async () => {
		const s = await setup();
		const id = await pendingFor(s, {
			workDate: MON,
			type: 'MISSING_BOTH',
			requestedCheckInAt: laos(MON, '08:01'),
			requestedCheckOutAt: laos(MON, '17:03'),
			reason: 'ລືມທັງສອງ'
		});
		// the shift is edited AFTER the request — the record must still use the schedule of that day (snapshot at approval time from the resolver of the historical date)
		const res = await approve(id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(record).toMatchObject({
			scheduledStartTime: '08:00',
			scheduledEndTime: '17:00',
			scheduledBreakMinutes: 60,
			scheduledLateGraceMinutes: 5,
			isCorrected: true,
			status: 'COMPLETED'
		});
		expect(record.workDate.toISOString().slice(0, 10)).toBe(MON);
		expect(record.firstCheckInAt).toBeNull();
		expect(record.lastCheckOutAt).toBeNull();
		expect(record.effectiveCheckInAt?.toISOString()).toBe('2026-09-21T01:01:00.000Z');
		expect(record).toMatchObject({
			calculationStatus: 'PRESENT',
			lateMinutes: 0,
			workedMinutes: 482
		});
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	it('overnight correction gets the right work date and calculation', async () => {
		const s = await setup({ shift: { startTime: '22:00', endTime: '06:00' } });
		const id = await pendingFor(s, {
			workDate: MON,
			type: 'MISSING_BOTH',
			requestedCheckInAt: laos(MON, '22:05'),
			requestedCheckOutAt: laos('2026-09-22', '05:55'),
			reason: 'ລືມ'
		});
		expect((await approve(id)).status).toBe(200);
		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(record.workDate.toISOString().slice(0, 10)).toBe(MON);
		expect(record).toMatchObject({
			scheduledCrossesMidnight: true,
			scheduledWorkMinutes: 420,
			workedMinutes: 410,
			lateMinutes: 0,
			earlyLeaveMinutes: 0,
			calculationStatus: 'PRESENT'
		});
	});

	it('cannot be approved twice; parallel approvals apply exactly once', async () => {
		const s = await setup();
		const id = await pendingFor(s);
		const results = await Promise.all([approve(id), approve(id), approve(id)]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
		expect(
			await prisma.attendanceCorrectionApplication.count({ where: { correctionRequestId: id } })
		).toBe(1);
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(1);
		expect((await approve(id)).body.error.code).toBe('CORRECTION_ALREADY_REVIEWED');
	});

	it('a failed approval leaves nothing partially applied', async () => {
		const s = await setup();
		const id = await pendingFor(s, {
			workDate: MON,
			type: 'MISSING_BOTH',
			requestedCheckInAt: laos(MON, '08:01'),
			requestedCheckOutAt: laos(MON, '17:03'),
			reason: 'ລືມ'
		});
		// the day becomes a holiday after the request was filed → approval must be refused
		await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				holidayDate: new Date(`${MON}T00:00:00Z`),
				nameLao: 'ວັນພັກໃໝ່',
				type: 'COMPANY'
			}
		});
		const res = await approve(id);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('NO_SCHEDULED_WORK');
		expect(
			(await prisma.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id } })).status
		).toBe('PENDING');
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(0);
		expect(
			await prisma.attendanceCorrectionApplication.count({ where: { correctionRequestId: id } })
		).toBe(0);
	});
});

describe('snapshots and recalculation', () => {
	it('editing the Shift later does not change historical schedule/calculation', async () => {
		const s = await setup();
		const record = await punch(s, T.in0808, T.out1640);
		await agent()
			.patch(`/api/v1/shifts/${s.shift.id}`)
			.set('Cookie', admin)
			.send({ startTime: '09:30', endTime: '18:30', breakMinutes: 30, lateGraceMinutes: 30 });
		const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
		expect(after).toMatchObject({
			scheduledStartTime: '08:00',
			scheduledEndTime: '17:00',
			scheduledLateGraceMinutes: 5,
			lateMinutes: 3,
			earlyLeaveMinutes: 15,
			workedMinutes: 452
		});
	});

	it("recalculation uses the record snapshot, not today's Shift", async () => {
		const s = await setup();
		const record = await punch(s, T.in0808, T.out1640);
		await agent()
			.patch(`/api/v1/shifts/${s.shift.id}`)
			.set('Cookie', admin)
			.send({ startTime: '10:00', endTime: '19:00' });
		const recalculated = await recalculateAttendanceRecord(record.id);
		expect(recalculated).toMatchObject({
			lateMinutes: 3,
			earlyLeaveMinutes: 15,
			scheduledWorkMinutes: 480
		});
	});

	it('a policy change never rewrites raw data or already-cached results', async () => {
		const s = await setup();
		const record = await punch(s, T.in0808, T.out1640);
		const before = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
		await agent()
			.patch(`/api/v1/attendance-policies/${s.company.id}`)
			.set('Cookie', hr.cookie)
			.send({ deductScheduledBreak: false });
		const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
		expect(after.firstCheckInAt).toEqual(before.firstCheckInAt);
		expect(after.lastCheckOutAt).toEqual(before.lastCheckOutAt);
		expect(after.workedMinutes).toBe(452); // cached value unchanged until a recalculation event
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(2);
	});
});

describe('correction data scope', () => {
	it('HR (broad scope) lists everyone; a manager only their reports; an employee only their own', async () => {
		const company = await createTestCompany();
		const mgrUser = await createTestUser({ roleCode: 'MANAGER' });
		const mgrCookie = await loginAndGetCookie(mgrUser.username, mgrUser.password);
		const mgr = await setup({
			companyId: company.id,
			existing: { user: mgrUser.user, cookie: mgrCookie }
		});
		const report = await setup({ companyId: company.id, managerEmployeeId: mgr.employee.id });
		const outsider = await setup({ companyId: company.id });
		at(T.tueNoon);
		const body = {
			workDate: MON,
			type: 'MISSING_BOTH',
			requestedCheckInAt: laos(MON, '08:00'),
			requestedCheckOutAt: laos(MON, '17:00'),
			reason: 'ລືມ'
		};
		const rReq = (await requestCorrection(report, body)).body.data.id;
		const oReq = (await requestCorrection(outsider, body)).body.data.id;

		const all = await get('/attendance/corrections?pageSize=100', hr.cookie);
		const ids = all.body.data.items.map((i: { id: string }) => i.id);
		expect(ids).toEqual(expect.arrayContaining([rReq, oReq]));

		const scoped = await get('/attendance/corrections?pageSize=100', mgrCookie);
		const scopedIds = scoped.body.data.items.map((i: { id: string }) => i.id);
		expect(scopedIds).toContain(rReq);
		expect(scopedIds).not.toContain(oReq);
		expect((await get(`/attendance/corrections/${oReq}`, mgrCookie)).status).toBe(403);
		expect((await approve(oReq, mgrCookie)).status).toBe(403);
		expect((await approve(rReq, mgrCookie)).status).toBe(200); // a manager may review a report's request

		const mine = await get('/attendance/me/corrections', outsider.cookie);
		expect(mine.body.data.items.map((i: { id: string }) => i.id)).toEqual([oReq]);
		expect((await get(`/attendance/me/corrections/${rReq}`, outsider.cookie)).status).toBe(404);
	});
});

describe('timezone boundaries', () => {
	it('the work date follows the Laos calendar at 23:59 / 00:00 (UTC date boundary)', async () => {
		const s = await setup();
		const tue = {
			workDate: '2026-09-22',
			type: 'MISSING_CHECK_IN',
			requestedCheckInAt: laos('2026-09-22', '00:00'),
			reason: 'ລືມ'
		};
		at('2026-09-21T16:59:00Z'); // Mon 23:59 Laos → Tuesday is still the future
		const before = await requestCorrection(s, tue);
		expect(before.body.error.code).toBe('CORRECTION_FUTURE_DATE');
		at('2026-09-21T17:00:00Z'); // Tue 00:00 Laos → Tuesday is today
		const now = await requestCorrection(s, tue);
		expect(now.status, JSON.stringify(now.body)).toBe(201);
		expect(now.body.data.workDate.slice(0, 10)).toBe('2026-09-22');
		// a UTC-looking instant on the same UTC date is still judged by Laos time
		expect(now.body.data.requestedCheckInAt).toBe('2026-09-21T17:00:00.000Z');
	});

	it('an after-midnight overnight check-out keeps the evening work date', async () => {
		const s = await setup({ shift: { startTime: '22:00', endTime: '06:00' } });
		const record = await punch(s, '2026-09-21T15:05:00Z', '2026-09-21T22:55:00Z'); // 22:05 → 05:55 next morning
		expect(record.workDate.toISOString().slice(0, 10)).toBe(MON);
		expect(record.lastCheckOutAt?.toISOString()).toBe('2026-09-21T22:55:00.000Z');
	});
});

describe('attendance policy API', () => {
	it('returns defaults, updates per company, and enforces permissions', async () => {
		const a = await createTestCompany();
		const b = await createTestCompany();
		const def = await get(`/attendance-policies?companyId=${a.id}`, hr.cookie);
		expect(def.body.data).toMatchObject({
			isDefault: true,
			deductScheduledBreak: true,
			missingCheckOutGraceMinutes: 240,
			allowEmployeeCorrection: true,
			correctionRequestWindowDays: 30
		});

		const upd = await agent()
			.patch(`/api/v1/attendance-policies/${a.id}`)
			.set('Cookie', hr.cookie)
			.send({ missingCheckOutGraceMinutes: 120, correctionRequestWindowDays: 14 });
		expect(upd.status).toBe(200);
		expect(upd.body.data).toMatchObject({
			isDefault: false,
			missingCheckOutGraceMinutes: 120,
			correctionRequestWindowDays: 14,
			deductScheduledBreak: true
		});
		expect(
			(await get(`/attendance-policies?companyId=${b.id}`, hr.cookie)).body.data.isDefault
		).toBe(true);
		expect(
			(
				await agent()
					.patch(`/api/v1/attendance-policies/${a.id}`)
					.set('Cookie', hr.cookie)
					.send({ missingCheckOutGraceMinutes: -1 })
			).status
		).toBe(400);
		expect(
			(
				await agent()
					.patch(`/api/v1/attendance-policies/${a.id}`)
					.set('Cookie', hr.cookie)
					.send({ bogus: true })
			).status
		).toBe(400);

		const viewOnly = await userWithPermissions(['attendance_rules.view']);
		expect((await get(`/attendance-policies?companyId=${a.id}`, viewOnly.cookie)).status).toBe(200);
		expect(
			(
				await agent()
					.patch(`/api/v1/attendance-policies/${a.id}`)
					.set('Cookie', viewOnly.cookie)
					.send({ deductScheduledBreak: false })
			).status
		).toBe(403);
		const emp = await setup();
		expect((await get(`/attendance-policies?companyId=${a.id}`, emp.cookie)).status).toBe(403);
	});

	it('the role defaults hold: employee=request; manager=rules view + request + review; HR=all', async () => {
		const perms = async (code: string) =>
			(
				await prisma.role.findUniqueOrThrow({
					where: { code },
					include: { permissions: { include: { permission: true } } }
				})
			).permissions.map((p) => p.permission.code);
		const emp = await perms('EMPLOYEE');
		expect(emp).toContain('attendance_corrections.request');
		expect(emp).not.toContain('attendance_corrections.review');
		const mgr = await perms('MANAGER');
		expect(mgr).toEqual(
			expect.arrayContaining([
				'attendance_rules.view',
				'attendance_corrections.request',
				'attendance_corrections.review'
			])
		);
		expect(mgr).not.toContain('attendance_rules.update');
		expect(await perms('HR_ADMIN')).toEqual(
			expect.arrayContaining([
				'attendance_rules.view',
				'attendance_rules.update',
				'attendance_corrections.request',
				'attendance_corrections.review'
			])
		);
	});
});
