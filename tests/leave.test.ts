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

const uid = () => randomUUID().slice(0, 6).toUpperCase();
const at = (iso: string) => setServerClockForTests(() => new Date(iso));

// Laos = UTC+7. "Now" is Saturday 2026-09-19 10:00 Laos. Mon 21 … Fri 25 are working days
// (default shift pattern Mon–Fri), Sat 26 / Sun 27 are off, Mon 28 is the next week.
const NOW = '2026-09-19T03:00:00Z';
beforeEach(() => at(NOW));
afterEach(() => setServerClockForTests(null));

const MON = '2026-09-21';
const FRI = '2026-09-25';
const NEXT_MON = '2026-09-28';

let admin: string;
let hr: { user: { id: string }; cookie: string };
beforeAll(async () => {
	admin = await superAdminCookie();
	hr = await userWithPermissions([
		'leave.view',
		'leave.review',
		'leave_types.view',
		'leave_types.create',
		'leave_types.update',
		'leave_types.disable',
		'leave_balances.view',
		'leave_balances.manage',
		'employees.view_all',
		'attendance.view'
	]);
});

const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const patch = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().patch(`/api/v1${path}`).set('Cookie', cookie).send(body);
const get = (path: string, cookie: string) => agent().get(`/api/v1${path}`).set('Cookie', cookie);

interface SetupOptions {
	companyId?: string;
	roleCode?: string;
	managerEmployeeId?: string;
	noSchedule?: boolean;
	employmentStatus?: 'ACTIVE' | 'SUSPENDED' | 'RESIGNED';
	endDate?: string;
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
			endDate: opts.endDate ? new Date(`${opts.endDate}T00:00:00.000Z`) : null,
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

async function mkType(companyId: string, overrides: Record<string, unknown> = {}) {
	return prisma.leaveType.create({
		data: {
			companyId,
			code: `LT_${uid()}`,
			nameLao: 'ລາພັກປະຈຳປີ',
			isPaid: true,
			requiresBalance: true,
			minNoticeDays: 0,
			...overrides
		}
	});
}
async function mkBalance(
	employeeId: string,
	leaveTypeId: string,
	entitlement: number,
	year = 2026
) {
	return prisma.leaveBalance.create({
		data: { employeeId, leaveTypeId, year, entitlementDays: entitlement.toFixed(2) }
	});
}
const request = (
	s: Ctx,
	typeId: string,
	startDate: string,
	endDate: string,
	reason = 'ທຸລະສ່ວນຕົວ'
) => post('/leave/me/requests', s.cookie, { leaveTypeId: typeId, startDate, endDate, reason });
const preview = (s: Ctx, typeId: string, startDate: string, endDate: string) =>
	post('/leave/me/requests/preview', s.cookie, { leaveTypeId: typeId, startDate, endDate });
const approve = (id: string, cookie = hr.cookie, body: Record<string, unknown> = {}) =>
	post(`/leave/requests/${id}/approve`, cookie, body);
const reject = (
	id: string,
	cookie = hr.cookie,
	body: Record<string, unknown> = { reviewNote: 'ບໍ່ສາມາດອະນຸມັດໄດ້' }
) => post(`/leave/requests/${id}/reject`, cookie, body);
const daily = (cookie: string, qs: string) => get(`/attendance/daily?${qs}`, cookie);

/** create + approve, returning the request id */
async function approvedRequest(s: Ctx, typeId: string, start: string, end: string) {
	const created = await request(s, typeId, start, end);
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	const ok = await approve(created.body.data.id);
	expect(ok.status, JSON.stringify(ok.body)).toBe(200);
	return created.body.data.id as string;
}
const balancesOf = async (s: Ctx, year = 2026) =>
	(await get(`/leave/me/balances?year=${year}`, s.cookie)).body.data.items as {
		leaveType: { id: string };
		entitled: number;
		used: number;
		pending: number;
		available: number;
		requestableAvailable: number;
		adjustment: number;
		carriedForward: number;
	}[];
const balanceFor = async (s: Ctx, typeId: string, year = 2026) =>
	(await balancesOf(s, year)).find((b) => b.leaveType.id === typeId)!;

// ============================================================================================
describe('leave types', () => {
	it('1. requires authentication', async () => {
		expect((await agent().get('/api/v1/leave-types')).status).toBe(401);
	});

	it('2. requires permission', async () => {
		const u = await userWithPermissions(['dashboard.view']);
		expect((await get('/leave-types', u.cookie)).status).toBe(403);
		expect((await post('/leave-types', u.cookie, {})).status).toBe(403);
	});

	it('3. creates a leave type (decimals leave as numbers)', async () => {
		const company = await createTestCompany();
		const res = await post('/leave-types', hr.cookie, {
			companyId: company.id,
			code: 'ANNUAL',
			nameLao: 'ລາພັກປະຈຳປີ',
			defaultEntitlementDays: 15,
			minNoticeDays: 3,
			maxConsecutiveDays: 10
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data).toMatchObject({
			code: 'ANNUAL',
			isPaid: true,
			requiresBalance: true,
			defaultEntitlementDays: 15,
			minNoticeDays: 3,
			maxConsecutiveDays: 10,
			status: 'ACTIVE'
		});
		expect((await get(`/leave-types?companyId=${company.id}`, hr.cookie)).body.data.total).toBe(1);
	});

	it('4. rejects a duplicate company + code', async () => {
		const company = await createTestCompany();
		const body = { companyId: company.id, code: 'SICK', nameLao: 'ລາປ່ວຍ' };
		expect((await post('/leave-types', hr.cookie, body)).status).toBe(201);
		const dup = await post('/leave-types', hr.cookie, body);
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('LEAVE_TYPE_CODE_TAKEN');
		// same code in ANOTHER company is fine
		const other = await createTestCompany();
		expect((await post('/leave-types', hr.cookie, { ...body, companyId: other.id })).status).toBe(
			201
		);
	});

	it('5. updates a leave type; company / code are immutable', async () => {
		const company = await createTestCompany();
		const type = await mkType(company.id);
		const res = await patch(`/leave-types/${type.id}`, hr.cookie, {
			nameLao: 'ຊື່ໃໝ່',
			isPaid: false,
			requiresBalance: false,
			defaultEntitlementDays: 7.5
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data).toMatchObject({
			nameLao: 'ຊື່ໃໝ່',
			isPaid: false,
			requiresBalance: false,
			defaultEntitlementDays: 7.5
		});
		expect((await patch(`/leave-types/${type.id}`, hr.cookie, { code: 'X' })).status).toBe(400);
	});

	it('6. changing status requires leave_types.disable', async () => {
		const company = await createTestCompany();
		const type = await mkType(company.id);
		const updater = await userWithPermissions(['leave_types.update']);
		expect((await patch(`/leave-types/${type.id}`, updater.cookie, { nameLao: 'ກ' })).status).toBe(
			200
		);
		expect(
			(await patch(`/leave-types/${type.id}`, updater.cookie, { status: 'INACTIVE' })).status
		).toBe(403);
		const off = await patch(`/leave-types/${type.id}`, hr.cookie, { status: 'INACTIVE' });
		expect(off.status).toBe(200);
		expect(off.body.data.status).toBe('INACTIVE');
	});

	it('7. an inactive company rejects an ACTIVE leave type', async () => {
		const company = await createTestCompany({ status: 'INACTIVE' });
		const res = await post('/leave-types', hr.cookie, {
			companyId: company.id,
			code: 'ANNUAL',
			nameLao: 'ລາ'
		});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INACTIVE_PARENT');
		expect(
			(
				await post('/leave-types', hr.cookie, {
					companyId: company.id,
					code: 'OFF',
					nameLao: 'ລາ',
					status: 'INACTIVE'
				})
			).status
		).toBe(201);
	});
});

// ============================================================================================
describe('leave balances', () => {
	it('8. creates a leave balance', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		const res = await post('/leave-balances', hr.cookie, {
			employeeId: s.employee.id,
			leaveTypeId: type.id,
			year: 2026,
			entitlementDays: 15
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data).toMatchObject({
			entitled: 15,
			carriedForward: 0,
			adjustment: 0,
			used: 0,
			pending: 0,
			available: 15,
			requestableAvailable: 15,
			year: 2026
		});
	});

	it('9. employee + type + year is unique (a second POST updates the same row)', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		const body = {
			employeeId: s.employee.id,
			leaveTypeId: type.id,
			year: 2026,
			entitlementDays: 10
		};
		const first = await post('/leave-balances', hr.cookie, body);
		const second = await post('/leave-balances', hr.cookie, { ...body, entitlementDays: 12 });
		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		expect(second.body.data.id).toBe(first.body.data.id);
		expect(second.body.data.entitled).toBe(12);
		expect(await prisma.leaveBalance.count({ where: { employeeId: s.employee.id } })).toBe(1);
	});

	it('10. a leave type from another company is rejected', async () => {
		const s = await setup();
		const other = await createTestCompany();
		const foreign = await mkType(other.id);
		const res = await post('/leave-balances', hr.cookie, {
			employeeId: s.employee.id,
			leaveTypeId: foreign.id,
			year: 2026,
			entitlementDays: 5
		});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('LEAVE_TYPE_COMPANY_MISMATCH');
	});

	it('11. entitlement = entitled + carried forward (+ adjustments)', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		await post('/leave-balances', hr.cookie, {
			employeeId: s.employee.id,
			leaveTypeId: type.id,
			year: 2026,
			entitlementDays: 15,
			carriedForwardDays: 2
		});
		const b = await balanceFor(s, type.id);
		expect(b).toMatchObject({
			entitled: 15,
			carriedForward: 2,
			available: 17,
			requestableAvailable: 17
		});
	});

	async function withBalance() {
		const s = await setup();
		const type = await mkType(s.company.id);
		const row = await mkBalance(s.employee.id, type.id, 10);
		return { s, type, row };
	}

	it('12. positive adjustment raises the balance', async () => {
		const { s, type, row } = await withBalance();
		const res = await post(`/leave-balances/${row.id}/adjustments`, hr.cookie, {
			days: 2,
			reason: 'ສິດພິເສດ'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data.adjustment).toMatchObject({ days: 2, reason: 'ສິດພິເສດ' });
		expect(res.body.data.balance.available).toBe(12);
		expect((await balanceFor(s, type.id)).adjustment).toBe(2);
	});

	it('13. negative adjustment lowers the balance (and cannot make it negative)', async () => {
		const { s, type, row } = await withBalance();
		expect(
			(await post(`/leave-balances/${row.id}/adjustments`, hr.cookie, { days: -1, reason: 'ຫັກ' }))
				.status
		).toBe(201);
		expect((await balanceFor(s, type.id)).available).toBe(9);
		const tooMuch = await post(`/leave-balances/${row.id}/adjustments`, hr.cookie, {
			days: -50,
			reason: 'ຫັກຫຼາຍ'
		});
		expect(tooMuch.status).toBe(400);
		expect(tooMuch.body.error.code).toBe('BALANCE_NEGATIVE');
		expect(
			(await post(`/leave-balances/${row.id}/adjustments`, hr.cookie, { days: 0, reason: 'ສູນ' }))
				.status
		).toBe(400);
	});

	it('14. adjustment history is immutable (append-only, editing a balance never rewrites it)', async () => {
		const { row } = await withBalance();
		const a = await post(`/leave-balances/${row.id}/adjustments`, hr.cookie, {
			days: 1,
			reason: 'ຄັ້ງທີ 1'
		});
		await post(`/leave-balances/${row.id}/adjustments`, hr.cookie, {
			days: -0.5,
			reason: 'ຄັ້ງທີ 2'
		});
		await patch(`/leave-balances/${row.id}`, hr.cookie, { entitlementDays: 20 });
		const id = a.body.data.adjustment.id;
		// no route edits or deletes an adjustment
		expect(
			(
				await agent()
					.delete(`/api/v1/leave-balances/${row.id}/adjustments/${id}`)
					.set('Cookie', hr.cookie)
			).status
		).toBe(404);
		expect(
			(await patch(`/leave-balances/${row.id}/adjustments/${id}`, hr.cookie, { days: 9 })).status
		).toBe(404);
		const list = await get(`/leave-balances/${row.id}/adjustments`, hr.cookie);
		expect(list.body.data.total).toBe(2);
		expect(list.body.data.items.map((i: { days: number }) => i.days)).toEqual([-0.5, 1]);
		expect(list.body.data.items[0].createdBy.displayName).toBeTruthy();
	});

	it('15. used is derived from APPROVED request days', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		await mkBalance(s.employee.id, type.id, 15);
		await approvedRequest(s, type.id, MON, FRI);
		expect(await balanceFor(s, type.id)).toMatchObject({ used: 5, pending: 0, available: 10 });
	});

	it('16. pending is derived from PENDING request days', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		await mkBalance(s.employee.id, type.id, 15);
		expect((await request(s, type.id, MON, FRI)).status).toBe(201);
		expect(await balanceFor(s, type.id)).toMatchObject({
			used: 0,
			pending: 5,
			available: 15,
			requestableAvailable: 10
		});
	});

	it('17. available = base - used (with carry forward and adjustment)', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		const row = await prisma.leaveBalance.create({
			data: {
				employeeId: s.employee.id,
				leaveTypeId: type.id,
				year: 2026,
				entitlementDays: '10.00',
				carriedForwardDays: '2.00'
			}
		});
		await post(`/leave-balances/${row.id}/adjustments`, hr.cookie, { days: 1, reason: 'ເພີ່ມ' });
		await approvedRequest(s, type.id, MON, '2026-09-23'); // 3 days
		expect(await balanceFor(s, type.id)).toMatchObject({
			used: 3,
			available: 10,
			requestableAvailable: 10
		});
		const listed = await get(`/leave-balances?year=2026&employeeId=${s.employee.id}`, hr.cookie);
		expect(listed.body.data.items[0]).toMatchObject({
			entitled: 10,
			carriedForward: 2,
			adjustment: 1,
			used: 3,
			available: 10
		});
	});
});

// ============================================================================================
describe('leave request preview', () => {
	it('18. requires a linked employee', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);
		const res = await post('/leave/me/requests/preview', cookie, {
			leaveTypeId: 2147483647,
			startDate: MON,
			endDate: FRI
		});
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('NO_LINKED_EMPLOYEE');
	});

	it('19. Mon–Fri counts 5 working days', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		await mkBalance(s.employee.id, type.id, 15);
		const res = await preview(s, type.id, MON, FRI);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data).toMatchObject({
			totalDays: 5,
			excludedDays: [],
			canSubmit: true,
			blockers: []
		});
		expect(res.body.data.balance).toEqual([
			{ year: 2026, available: 15, before: 15, after: 10, requestedDays: 5 }
		]);
		// preview never mutates
		expect(await prisma.leaveRequest.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	it('20. weekends are excluded (Fri → next Mon = 2 days)', async () => {
		const s = await setup();
		const type = await mkType(s.company.id, { requiresBalance: false });
		const res = await preview(s, type.id, FRI, NEXT_MON);
		expect(res.body.data.totalDays).toBe(2);
		expect(res.body.data.days.map((d: { leaveDate: string }) => d.leaveDate.slice(0, 10))).toEqual([
			FRI,
			NEXT_MON
		]);
		expect(res.body.data.excludedDays.map((e: { reason: string }) => e.reason)).toEqual([
			'OFF_DAY',
			'OFF_DAY'
		]);
	});

	it('21. company holidays are excluded', async () => {
		const s = await setup();
		const type = await mkType(s.company.id, { requiresBalance: false });
		await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				nameLao: 'ວັນພັກ',
				holidayDate: new Date(`${NEXT_MON}T00:00:00Z`)
			}
		});
		const res = await preview(s, type.id, FRI, NEXT_MON);
		expect(res.body.data.totalDays).toBe(1);
		expect(res.body.data.excludedDays.some((e: { reason: string }) => e.reason === 'HOLIDAY')).toBe(
			true
		);
	});

	it('22. a range with no work days is rejected (NO_LEAVE_WORK_DAYS)', async () => {
		const s = await setup();
		const type = await mkType(s.company.id, { requiresBalance: false });
		const res = await preview(s, type.id, '2026-09-26', '2026-09-27');
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('NO_LEAVE_WORK_DAYS');
	});

	it('23. a date with no schedule assignment is rejected safely (no guessing)', async () => {
		const s = await setup({ noSchedule: true });
		const type = await mkType(s.company.id, { requiresBalance: false });
		const res = await preview(s, type.id, MON, FRI);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('NO_ACTIVE_SCHEDULE');
	});

	it('24. the notice period is enforced', async () => {
		const s = await setup();
		const type = await mkType(s.company.id, { requiresBalance: false, minNoticeDays: 3 });
		// today Sat 19 → earliest allowed start is Tue 22
		const tooSoon = await preview(s, type.id, MON, MON);
		expect(tooSoon.status).toBe(400);
		expect(tooSoon.body.error.code).toBe('LEAVE_NOTICE_TOO_SHORT');
		expect(tooSoon.body.error.details).toMatchObject({
			minNoticeDays: 3,
			earliestStartDate: '2026-09-22'
		});
		expect((await preview(s, type.id, '2026-09-22', '2026-09-22')).status).toBe(200);
	});

	it('25. max consecutive days counts CHARGED days, not the calendar range', async () => {
		const s = await setup();
		const type = await mkType(s.company.id, { requiresBalance: false, maxConsecutiveDays: 3 });
		const tooLong = await preview(s, type.id, MON, FRI);
		expect(tooLong.status).toBe(400);
		expect(tooLong.body.error.code).toBe('LEAVE_MAX_CONSECUTIVE_EXCEEDED');
		// Fri → Mon spans 4 calendar days but is only 2 charged days
		expect((await preview(s, type.id, FRI, NEXT_MON)).status).toBe(200);
	});
});

// ============================================================================================
describe('leave request creation', () => {
	async function ready(balance = 15, typeOverrides: Record<string, unknown> = {}) {
		const s = await setup();
		const type = await mkType(s.company.id, typeOverrides);
		if (balance > 0) await mkBalance(s.employee.id, type.id, balance);
		return { s, type };
	}

	it('26. creates a PENDING request', async () => {
		const { s, type } = await ready();
		const res = await request(s, type.id, MON, FRI, '  ໄປທຸລະ  ');
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data).toMatchObject({ status: 'PENDING', totalDays: 5, reason: 'ໄປທຸລະ' });
		expect(res.body.data.leaveType.id).toBe(type.id);
	});

	it('27. persists one LeaveRequestDay per charged date, with the schedule snapshot', async () => {
		const { s, type } = await ready();
		const res = await request(s, type.id, FRI, NEXT_MON);
		const days = await prisma.leaveRequestDay.findMany({
			where: { leaveRequestId: res.body.data.id },
			orderBy: { leaveDate: 'asc' }
		});
		expect(days.map((d) => d.leaveDate.toISOString().slice(0, 10))).toEqual([FRI, NEXT_MON]);
		expect(days[0]).toMatchObject({
			scheduledStartTime: '08:00',
			scheduledEndTime: '17:00',
			scheduledBreakMinutes: 60,
			scheduledCrossesMidnight: false,
			activeKey: `${s.employee.id}:${FRI}`
		});
		expect(days[0]!.dayValue.toNumber()).toBe(1);
		expect(days[0]!.shiftId).toBe(s.shift.id);
	});

	it('28. totalDays is the charged count', async () => {
		const { s, type } = await ready();
		const res = await request(s, type.id, FRI, NEXT_MON);
		expect(res.body.data.totalDays).toBe(2);
		expect(res.body.data.startDate.slice(0, 10)).toBe(FRI);
		expect(res.body.data.endDate.slice(0, 10)).toBe(NEXT_MON);
	});

	it('29. past dates are rejected (Laos calendar)', async () => {
		const { s, type } = await ready();
		const res = await request(s, type.id, '2026-09-18', '2026-09-18');
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('LEAVE_DATE_IN_PAST');
	});

	it('30. an ended / out-of-employment employee cannot request', async () => {
		const resigned = await setup({ employmentStatus: 'RESIGNED', endDate: '2026-09-01' });
		const t1 = await mkType(resigned.company.id, { requiresBalance: false });
		const r1 = await request(resigned, t1.id, MON, FRI);
		expect(r1.status).toBe(403);
		expect(r1.body.error.code).toBe('EMPLOYEE_NOT_ACTIVE');

		// still ACTIVE but employment ends mid-range
		const leaving = await setup({ endDate: '2026-09-23' });
		const t2 = await mkType(leaving.company.id, { requiresBalance: false });
		const r2 = await request(leaving, t2.id, MON, FRI);
		expect(r2.status).toBe(400);
		expect(r2.body.error.code).toBe('OUTSIDE_EMPLOYMENT');
		expect((await request(leaving, t2.id, MON, '2026-09-23')).status).toBe(201);
	});

	it('31. a suspended employee cannot request', async () => {
		const s = await setup({ employmentStatus: 'SUSPENDED' });
		const type = await mkType(s.company.id, { requiresBalance: false });
		const res = await request(s, type.id, MON, FRI);
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('EMPLOYEE_NOT_ACTIVE');
	});

	it('32. an inactive leave type is rejected', async () => {
		const { s, type } = await ready(15, { status: 'INACTIVE' });
		const res = await request(s, type.id, MON, FRI);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('LEAVE_TYPE_INACTIVE');
	});

	it('33. a leave type of another company is rejected', async () => {
		const s = await setup();
		const foreign = await mkType((await createTestCompany()).id, { requiresBalance: false });
		const res = await request(s, foreign.id, MON, FRI);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('LEAVE_TYPE_COMPANY_MISMATCH');
	});

	it('34. overlapping PENDING leave is rejected', async () => {
		const { s, type } = await ready();
		expect((await request(s, type.id, MON, '2026-09-23')).status).toBe(201);
		const dup = await request(s, type.id, '2026-09-23', FRI);
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('LEAVE_DATE_OVERLAP');
		expect(dup.body.error.details.dates).toEqual(['2026-09-23']);
	});

	it('35. overlapping APPROVED leave is rejected', async () => {
		const { s, type } = await ready();
		await approvedRequest(s, type.id, MON, MON);
		const dup = await request(s, type.id, MON, MON);
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('LEAVE_DATE_OVERLAP');
	});

	it('36. a REJECTED request does not block the dates', async () => {
		const { s, type } = await ready();
		const first = await request(s, type.id, MON, MON);
		expect((await reject(first.body.data.id)).status).toBe(200);
		expect((await request(s, type.id, MON, MON)).status).toBe(201);
	});

	it('37. a CANCELLED request does not block the dates', async () => {
		const { s, type } = await ready();
		const first = await request(s, type.id, MON, MON);
		expect((await post(`/leave/me/requests/${first.body.data.id}/cancel`, s.cookie)).status).toBe(
			200
		);
		expect((await request(s, type.id, MON, MON)).status).toBe(201);
	});

	it('38. insufficient balance is rejected with year / requested / available', async () => {
		const { s, type } = await ready(3);
		const res = await request(s, type.id, MON, FRI);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INSUFFICIENT_LEAVE_BALANCE');
		expect(res.body.error.details).toEqual({ year: 2026, requestedDays: 5, availableDays: 3 });
		expect(await prisma.leaveRequest.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	it('39. PENDING days reserve the requestable balance', async () => {
		const { s, type } = await ready(5);
		expect((await request(s, type.id, MON, '2026-09-23')).status).toBe(201); // 3
		expect((await request(s, type.id, '2026-09-24', FRI)).status).toBe(201); // 2 → 5 reserved
		const third = await request(s, type.id, NEXT_MON, NEXT_MON);
		expect(third.status).toBe(400);
		expect(third.body.error.details).toMatchObject({ requestedDays: 1, availableDays: 0 });
		expect(await balanceFor(s, type.id)).toMatchObject({
			pending: 5,
			available: 5,
			requestableAvailable: 0
		});
	});

	it('40. requiresBalance=false needs no balance row', async () => {
		const { s, type } = await ready(0, { requiresBalance: false, isPaid: false });
		const res = await request(s, type.id, MON, FRI);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect((await approve(res.body.data.id)).status).toBe(200);
	});

	it('the employee id is never accepted (strict body)', async () => {
		const { s, type } = await ready();
		const res = await post('/leave/me/requests', s.cookie, {
			leaveTypeId: type.id,
			startDate: MON,
			endDate: FRI,
			reason: 'ເຫດຜົນ',
			employeeId: 'someone-else'
		});
		expect(res.status).toBe(400);
		expect((await request(s, type.id, MON, FRI, '   ')).status).toBe(400);
	});

	it('concurrent identical requests: exactly one wins, no partial data', async () => {
		const { s, type } = await ready();
		const results = await Promise.all([
			request(s, type.id, MON, FRI),
			request(s, type.id, MON, FRI),
			request(s, type.id, MON, FRI)
		]);
		expect(results.filter((r) => r.status === 201)).toHaveLength(1);
		expect(results.filter((r) => r.status === 409)).toHaveLength(2);
		expect(await prisma.leaveRequest.count({ where: { employeeId: s.employee.id } })).toBe(1);
		expect(await prisma.leaveRequestDay.count({ where: { employeeId: s.employee.id } })).toBe(5);
	});
});

// ============================================================================================
describe('cross-year leave', () => {
	const START = '2026-12-30'; // Wed
	const END = '2027-01-03'; // Sun → charged: Dec 30, Dec 31 (2026) + Jan 1 (2027)

	it('41. succeeds with balances in both years and splits usage per year', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		await mkBalance(s.employee.id, type.id, 5, 2026);
		await mkBalance(s.employee.id, type.id, 5, 2027);
		const res = await request(s, type.id, START, END);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data.totalDays).toBe(3);
		expect((await balanceFor(s, type.id, 2026)).pending).toBe(2);
		expect((await balanceFor(s, type.id, 2027)).pending).toBe(1);
		expect((await approve(res.body.data.id)).status).toBe(200);
		expect((await balanceFor(s, type.id, 2026)).used).toBe(2);
		expect((await balanceFor(s, type.id, 2027)).used).toBe(1);
	});

	it('42. an insufficient second-year balance rejects the whole request', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		await mkBalance(s.employee.id, type.id, 5, 2026);
		// no 2027 balance
		const res = await request(s, type.id, START, END);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INSUFFICIENT_LEAVE_BALANCE');
		expect(res.body.error.details).toMatchObject({
			year: 2027,
			requestedDays: 1,
			availableDays: 0
		});
	});

	it('43. a rejected creation leaves no partial request or days', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		await mkBalance(s.employee.id, type.id, 5, 2026);
		await request(s, type.id, START, END);
		expect(await prisma.leaveRequest.count({ where: { employeeId: s.employee.id } })).toBe(0);
		expect(await prisma.leaveRequestDay.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});
});

// ============================================================================================
describe('self service', () => {
	it('44. an employee lists only their own requests', async () => {
		const a = await setup();
		const b = await setup({ companyId: a.company.id });
		const type = await mkType(a.company.id, { requiresBalance: false });
		await request(a, type.id, MON, MON);
		await request(b, type.id, MON, MON);
		const listA = await get('/leave/me/requests', a.cookie);
		expect(listA.body.data.total).toBe(1);
		expect(listA.body.data.items[0].employee.id).toBe(a.employee.id);
		expect((await get('/leave/me/requests?status=APPROVED', a.cookie)).body.data.total).toBe(0);
		expect((await get('/leave/me/requests?year=2026', a.cookie)).body.data.total).toBe(1);
		expect((await get('/leave/me/requests?year=2027', a.cookie)).body.data.total).toBe(0);
	});

	it('45. an employee sees their own balances', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		await mkBalance(s.employee.id, type.id, 15);
		const res = await get('/leave/me/balances?year=2026', s.cookie);
		expect(res.status).toBe(200);
		expect(res.body.data.year).toBe(2026);
		const row = res.body.data.items.find(
			(i: { leaveType: { id: string } }) => i.leaveType.id === type.id
		);
		expect(row).toMatchObject({ entitled: 15, available: 15, used: 0, pending: 0 });
	});

	it("46. another employee's request cannot be opened or cancelled", async () => {
		const a = await setup();
		const b = await setup({ companyId: a.company.id });
		const type = await mkType(a.company.id, { requiresBalance: false });
		const req = await request(a, type.id, MON, MON);
		expect((await get(`/leave/me/requests/${req.body.data.id}`, b.cookie)).status).toBe(404);
		expect((await post(`/leave/me/requests/${req.body.data.id}/cancel`, b.cookie)).status).toBe(
			404
		);
		expect((await get(`/leave/me/requests/${req.body.data.id}`, a.cookie)).status).toBe(200);
	});

	it('47. cancelling a PENDING request succeeds and releases the reservation', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		await mkBalance(s.employee.id, type.id, 5);
		const req = await request(s, type.id, MON, FRI);
		expect((await balanceFor(s, type.id)).requestableAvailable).toBe(0);
		const res = await post(`/leave/me/requests/${req.body.data.id}/cancel`, s.cookie);
		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe('CANCELLED');
		expect((await balanceFor(s, type.id)).requestableAvailable).toBe(5);
		expect(
			await prisma.leaveRequestDay.count({
				where: { leaveRequestId: req.body.data.id, activeKey: { not: null } }
			})
		).toBe(0);
	});

	it('48. cancelling an APPROVED request is rejected', async () => {
		const s = await setup();
		const type = await mkType(s.company.id, { requiresBalance: false });
		const id = await approvedRequest(s, type.id, MON, MON);
		const res = await post(`/leave/me/requests/${id}/cancel`, s.cookie);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('LEAVE_NOT_CANCELLABLE');
		expect((await get(`/leave/me/requests/${id}`, s.cookie)).body.data.status).toBe('APPROVED');
	});
});

// ============================================================================================
describe('leave review', () => {
	async function pending(balance = 15) {
		const s = await setup();
		const type = await mkType(s.company.id);
		if (balance > 0) await mkBalance(s.employee.id, type.id, balance);
		const req = await request(s, type.id, MON, FRI);
		expect(req.status, JSON.stringify(req.body)).toBe(201);
		return { s, type, id: req.body.data.id as string };
	}

	it('49. review requires leave.review (and viewing requires leave.view)', async () => {
		const { s, id } = await pending();
		expect((await approve(id, s.cookie)).status).toBe(403);
		expect((await reject(id, s.cookie)).status).toBe(403);
		expect((await get('/leave/requests', s.cookie)).status).toBe(403);
		const viewOnly = await userWithPermissions(['leave.view', 'employees.view_all']);
		expect((await get(`/leave/requests/${id}`, viewOnly.cookie)).status).toBe(200);
		expect((await approve(id, viewOnly.cookie)).status).toBe(403);
	});

	it('50. employee data scope is enforced', async () => {
		const manager = await setup({ roleCode: 'MANAGER' });
		const report = await setup({
			companyId: manager.company.id,
			managerEmployeeId: manager.employee.id
		});
		const stranger = await setup({ companyId: manager.company.id });
		const type = await mkType(manager.company.id, { requiresBalance: false });
		const mine = await request(report, type.id, MON, MON);
		const theirs = await request(stranger, type.id, MON, MON);

		expect((await get(`/leave/requests/${theirs.body.data.id}`, manager.cookie)).status).toBe(403);
		expect((await approve(theirs.body.data.id, manager.cookie)).status).toBe(403);
		expect((await reject(theirs.body.data.id, manager.cookie)).status).toBe(403);
		expect((await approve(mine.body.data.id, manager.cookie)).status).toBe(200);
		const status = await prisma.leaveRequest.findUniqueOrThrow({
			where: { id: theirs.body.data.id }
		});
		expect(status.status).toBe('PENDING');
	});

	it('51. a reviewer cannot approve or reject their own request', async () => {
		const reviewer = await userWithPermissions([
			'leave.self',
			'leave.view',
			'leave.review',
			'employees.view_all'
		]);
		const s = await setup({ existing: reviewer });
		const type = await mkType(s.company.id, { requiresBalance: false });
		const req = await request(s, type.id, MON, MON);
		const a = await approve(req.body.data.id, reviewer.cookie);
		expect(a.status).toBe(403);
		expect(a.body.error.code).toBe('CANNOT_REVIEW_OWN_LEAVE');
		const r = await reject(req.body.data.id, reviewer.cookie);
		expect(r.status).toBe(403);
		expect(r.body.error.code).toBe('CANNOT_REVIEW_OWN_LEAVE');
		const detail = await get(`/leave/requests/${req.body.data.id}`, reviewer.cookie);
		expect(detail.body.data).toMatchObject({ isOwnRequest: true, canReview: false });
	});

	it('52. approves a PENDING request', async () => {
		const { s, type, id } = await pending();
		const res = await approve(id, hr.cookie, { reviewNote: 'ຕົກລົງ' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data).toMatchObject({ status: 'APPROVED', reviewNote: 'ຕົກລົງ' });
		expect(res.body.data.reviewedBy.id).toBe(hr.user.id);
		expect(res.body.data.reviewedAt).toBeTruthy();
		expect(await balanceFor(s, type.id)).toMatchObject({ used: 5, pending: 0, available: 10 });
	});

	it('53. rejects a PENDING request (a note is required) and releases the balance', async () => {
		const { s, type, id } = await pending();
		expect((await post(`/leave/requests/${id}/reject`, hr.cookie, {})).status).toBe(400);
		const res = await reject(id);
		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe('REJECTED');
		expect(res.body.data.reviewNote).toBe('ບໍ່ສາມາດອະນຸມັດໄດ້');
		expect(await balanceFor(s, type.id)).toMatchObject({ used: 0, pending: 0, available: 15 });
	});

	it('54. the balance is re-validated on approval', async () => {
		const { s, type, id } = await pending(5);
		const row = await prisma.leaveBalance.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(
			(await patch(`/leave-balances/${row.id}`, hr.cookie, { entitlementDays: 3 })).status
		).toBe(200);
		const res = await approve(id);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INSUFFICIENT_LEAVE_BALANCE');
		expect(res.body.error.details).toEqual({ year: 2026, requestedDays: 5, availableDays: 3 });
		expect((await balanceFor(s, type.id)).used).toBe(0);
	});

	it('55. an inactive leave type blocks approval; history stays visible', async () => {
		const { s, type, id } = await pending();
		await prisma.leaveType.update({ where: { id: type.id }, data: { status: 'INACTIVE' } });
		const res = await approve(id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('LEAVE_TYPE_INACTIVE');
		const detail = await get(`/leave/requests/${id}`, hr.cookie);
		expect(detail.body.data.warnings.leaveTypeInactive).toBe(true);
		expect((await get(`/leave/me/requests/${id}`, s.cookie)).status).toBe(200);
	});

	it('56. approving twice is rejected', async () => {
		const { id } = await pending();
		expect((await approve(id)).status).toBe(200);
		const again = await approve(id);
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('LEAVE_ALREADY_REVIEWED');
	});

	it('57. a rejected request cannot be approved', async () => {
		const { id } = await pending();
		await reject(id);
		const res = await approve(id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('LEAVE_ALREADY_REVIEWED');
	});

	it('58. a failed approval leaves the request untouched (rollback safe)', async () => {
		const { s, type, id } = await pending(5);
		await prisma.leaveType.update({ where: { id: type.id }, data: { status: 'INACTIVE' } });
		expect((await approve(id)).status).toBe(409);
		const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
		expect(row).toMatchObject({ status: 'PENDING', reviewedByUserId: null, reviewedAt: null });
		expect(
			await prisma.leaveRequestDay.count({
				where: { leaveRequestId: id, activeKey: { not: null } }
			})
		).toBe(5);
		expect((await balanceFor(s, type.id)).pending).toBe(5);
	});

	it('review detail: charged dates, balance, and an attendance-conflict warning', async () => {
		const { s, id } = await pending();
		await prisma.attendanceRecord.create({
			data: {
				employeeId: s.employee.id,
				workDate: new Date(`${MON}T00:00:00Z`),
				scheduledStartTime: '08:00',
				scheduledEndTime: '17:00',
				scheduledBreakMinutes: 60,
				firstCheckInAt: new Date('2026-09-21T01:00:00Z'),
				status: 'IN_PROGRESS'
			}
		});
		const detail = await get(`/leave/requests/${id}`, hr.cookie);
		expect(detail.body.data.days).toHaveLength(5);
		expect(detail.body.data.balances[0]).toMatchObject({
			year: 2026,
			entitled: 15,
			requestedDays: 5
		});
		expect(detail.body.data.warnings.attendanceConflictDates).toEqual([MON]);
		expect(detail.body.data.warnings.balanceInsufficient).toEqual([]);
		// the conflict does NOT block approval
		expect((await approve(id)).status).toBe(200);
	});
});

// ============================================================================================
describe('attendance integration', () => {
	const AFTER_MON = '2026-09-22T03:00:00Z'; // Tue 10:00 Laos — Monday's shift is over
	const MON_0800 = '2026-09-21T01:00:00Z';

	async function ready(requiresBalance = false) {
		const s = await setup();
		const type = await mkType(s.company.id, { requiresBalance, nameLao: 'ລາພັກປະຈຳປີ' });
		if (requiresBalance) await mkBalance(s.employee.id, type.id, 15);
		return { s, type };
	}
	const resultOn = async (s: Ctx, date = MON) => {
		const res = await daily(hr.cookie, `date=${date}&employeeId=${s.employee.id}`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return res.body.data.items[0];
	};

	it('59. an APPROVED leave day is LEAVE, not ABSENT', async () => {
		const { s, type } = await ready();
		const id = await approvedRequest(s, type.id, MON, MON);
		at(AFTER_MON);
		const row = await resultOn(s);
		expect(row.result).toBe('LEAVE');
		expect(row.leave).toMatchObject({
			requestId: id,
			leaveTypeId: type.id,
			leaveTypeCode: type.code,
			leaveTypeNameLao: 'ລາພັກປະຈຳປີ',
			isPaid: true,
			dayValue: 1
		});
		expect(row.attendanceConflict).toBe(false);
		expect(row.attendance).toBeNull();
	});

	it('60. a PENDING leave does not override ABSENT', async () => {
		const { s, type } = await ready();
		await request(s, type.id, MON, MON);
		at(AFTER_MON);
		expect((await resultOn(s)).result).toBe('ABSENT');
	});

	it('61. a REJECTED leave does not override ABSENT', async () => {
		const { s, type } = await ready();
		const req = await request(s, type.id, MON, MON);
		await reject(req.body.data.id);
		at(AFTER_MON);
		expect((await resultOn(s)).result).toBe('ABSENT');
	});

	it('62. a CANCELLED leave does not override ABSENT', async () => {
		const { s, type } = await ready();
		const req = await request(s, type.id, MON, MON);
		await post(`/leave/me/requests/${req.body.data.id}/cancel`, s.cookie);
		at(AFTER_MON);
		expect((await resultOn(s)).result).toBe('ABSENT');
	});

	it('63. a holiday stays HOLIDAY even if leave exists for it', async () => {
		const { s, type } = await ready();
		await approvedRequest(s, type.id, MON, MON);
		await prisma.holiday.create({
			data: {
				companyId: s.company.id,
				nameLao: 'ວັນພັກໃໝ່',
				holidayDate: new Date(`${MON}T00:00:00Z`)
			}
		});
		at(AFTER_MON);
		expect((await resultOn(s)).result).toBe('HOLIDAY');
	});

	it('64. an off-day stays OFF_DAY (weekend inside a leave range is never LEAVE)', async () => {
		const { s, type } = await ready();
		await approvedRequest(s, type.id, FRI, NEXT_MON);
		at('2026-09-29T03:00:00Z');
		expect((await resultOn(s, '2026-09-26')).result).toBe('OFF_DAY');
		expect((await resultOn(s, FRI)).result).toBe('LEAVE');
		expect((await resultOn(s, NEXT_MON)).result).toBe('LEAVE');
		expect(await prisma.leaveRequestDay.count({ where: { employeeId: s.employee.id } })).toBe(2);
	});

	it('65. approved leave prevents a normal self check-in', async () => {
		const { s, type } = await ready();
		await approvedRequest(s, type.id, MON, MON);
		at(MON_0800);
		const today = await get('/attendance/me/today', s.cookie);
		expect(today.body.data.allowedActions.checkIn).toBe(false);
		expect(today.body.data.checkInBlocked.code).toBe('APPROVED_LEAVE_DAY');
		expect(today.body.data.leave).toMatchObject({
			leaveTypeCode: type.code,
			leaveTypeNameLao: 'ລາພັກປະຈຳປີ'
		});
		const res = await post('/attendance/me/check-in', s.cookie);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('APPROVED_LEAVE_DAY');
		expect(res.body.error.details.leave.leaveTypeCode).toBe(type.code);
	});

	it('66. no AttendanceRecord or punch is created for a leave day', async () => {
		const { s, type } = await ready();
		await approvedRequest(s, type.id, MON, MON);
		at(AFTER_MON);
		await resultOn(s);
		at(MON_0800);
		expect((await post('/attendance/me/check-in', s.cookie)).status).toBe(400); // refused
		expect(await prisma.attendanceRecord.count({ where: { employeeId: s.employee.id } })).toBe(0);
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});

	async function withPunchThenLeave() {
		const { s, type } = await ready();
		at(MON_0800);
		expect((await post('/attendance/me/check-in', s.cookie)).status).toBe(201);
		const before = await prisma.attendancePunch.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		// the employee requests leave for today (Laos today is allowed) and it gets approved
		await approvedRequest(s, type.id, MON, MON);
		return { s, type, before };
	}

	it('67. approved leave with an existing punch reports attendanceConflict=true', async () => {
		const { s } = await withPunchThenLeave();
		const row = await resultOn(s);
		expect(row.result).toBe('LEAVE');
		expect(row.attendanceConflict).toBe(true);
		expect(row.attendance).toMatchObject({ firstCheckInAt: '2026-09-21T01:00:00.000Z' });
		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		const detail = await get(`/attendance/${record.id}`, hr.cookie);
		expect(detail.body.data.leave).toMatchObject({ isPaid: true });
	});

	it('68. the raw AttendancePunch stays unchanged', async () => {
		const { s, before } = await withPunchThenLeave();
		const after = await prisma.attendancePunch.findMany({ where: { employeeId: s.employee.id } });
		expect(after).toHaveLength(1);
		expect(after[0]).toEqual(before);
		const record = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(record.firstCheckInAt?.toISOString()).toBe('2026-09-21T01:00:00.000Z');
	});

	it('69. approved leave blocks a new attendance correction request', async () => {
		const { s, type } = await ready();
		await approvedRequest(s, type.id, MON, MON);
		at(AFTER_MON);
		const res = await post('/attendance/me/corrections', s.cookie, {
			workDate: MON,
			type: 'MISSING_BOTH',
			requestedCheckInAt: `${MON}T08:00:00+07:00`,
			requestedCheckOutAt: `${MON}T17:00:00+07:00`,
			reason: 'ລືມ Check-in'
		});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('APPROVED_LEAVE_DAY');
		const ctx = await get(`/attendance/me/correction-context?workDate=${MON}`, s.cookie);
		expect(ctx.body.data.eligible).toBe(false);
		expect(ctx.body.data.blocked.code).toBe('APPROVED_LEAVE_DAY');
	});

	it('70. the daily endpoint can filter result=LEAVE', async () => {
		const { s, type } = await ready();
		const other = await setup({ companyId: s.company.id });
		await approvedRequest(s, type.id, MON, MON);
		at(AFTER_MON);
		const res = await daily(hr.cookie, `date=${MON}&companyId=${s.company.id}&result=LEAVE`);
		expect(res.status).toBe(200);
		expect(res.body.data.total).toBe(1);
		expect(res.body.data.items[0].employee.id).toBe(s.employee.id);
		const absent = await daily(hr.cookie, `date=${MON}&companyId=${s.company.id}&result=ABSENT`);
		expect(absent.body.data.items.map((i: { employee: { id: string } }) => i.employee.id)).toEqual([
			other.employee.id
		]);
	});
});

// ============================================================================================
describe('leave data scope', () => {
	it('71. HR (employees.view_all) sees requests broadly', async () => {
		const a = await setup();
		const b = await setup();
		const ta = await mkType(a.company.id, { requiresBalance: false });
		const tb = await mkType(b.company.id, { requiresBalance: false });
		const ra = await request(a, ta.id, MON, MON);
		const rb = await request(b, tb.id, MON, MON);
		const ids = (await get('/leave/requests?pageSize=100', hr.cookie)).body.data.items.map(
			(i: { id: string }) => i.id
		);
		expect(ids).toContain(ra.body.data.id);
		expect(ids).toContain(rb.body.data.id);
		const byCompany = await get(`/leave/requests?companyId=${a.company.id}`, hr.cookie);
		expect(byCompany.body.data.items.map((i: { id: string }) => i.id)).toEqual([ra.body.data.id]);
	});

	it("72. a manager sees only their own and their reports' requests", async () => {
		const manager = await setup({ roleCode: 'MANAGER' });
		const report = await setup({
			companyId: manager.company.id,
			managerEmployeeId: manager.employee.id
		});
		const stranger = await setup({ companyId: manager.company.id });
		const type = await mkType(manager.company.id, { requiresBalance: false });
		const own = await request(manager, type.id, MON, MON);
		const rep = await request(report, type.id, MON, MON);
		const other = await request(stranger, type.id, MON, MON);
		const ids = (await get('/leave/requests?pageSize=100', manager.cookie)).body.data.items.map(
			(i: { id: string }) => i.id
		);
		expect(ids.sort()).toEqual([own.body.data.id, rep.body.data.id].sort());
		expect(ids).not.toContain(other.body.data.id);
		// balances are scoped the same way
		const bal = await get('/leave-balances?year=2026', manager.cookie);
		expect(bal.status).toBe(200);
	});

	it("73. an unrelated request's detail is 403", async () => {
		const manager = await setup({ roleCode: 'MANAGER' });
		const stranger = await setup({ companyId: manager.company.id });
		const type = await mkType(manager.company.id, { requiresBalance: false });
		const req = await request(stranger, type.id, MON, MON);
		expect((await get(`/leave/requests/${req.body.data.id}`, manager.cookie)).status).toBe(403);
	});

	it('role defaults: HR_ADMIN has all leave permissions; MANAGER / EMPLOYEE are limited', async () => {
		const codesOf = async (role: string) =>
			(
				await prisma.rolePermission.findMany({
					where: { role: { code: role } },
					select: { permission: { select: { code: true } } }
				})
			)
				.map((r) => r.permission.code)
				.filter((c) => c.startsWith('leave'))
				.sort();
		expect(await codesOf('HR_ADMIN')).toEqual(
			[
				'leave.self',
				'leave.view',
				'leave.review',
				'leave_types.view',
				'leave_types.create',
				'leave_types.update',
				'leave_types.disable',
				'leave_balances.view',
				'leave_balances.manage'
			].sort()
		);
		expect(await codesOf('MANAGER')).toEqual(
			['leave.self', 'leave.view', 'leave.review', 'leave_balances.view'].sort()
		);
		expect(await codesOf('EMPLOYEE')).toEqual(['leave.self']);
	});
});

// ============================================================================================
describe('decimal safety', () => {
	it('74. decimal arithmetic is stable (0.1 + 0.2 = 0.3 exactly)', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		const row = await mkBalance(s.employee.id, type.id, 0);
		await post(`/leave-balances/${row.id}/adjustments`, hr.cookie, {
			days: 0.1,
			reason: 'ຫນຶ່ງສ່ວນສິບ'
		});
		await post(`/leave-balances/${row.id}/adjustments`, hr.cookie, {
			days: 0.2,
			reason: 'ສອງສ່ວນສິບ'
		});
		const b = await balanceFor(s, type.id);
		expect(b.adjustment).toBe(0.3); // a float sum would be 0.30000000000000004
		expect(b.available).toBe(0.3);
	});

	it('75. no float rounding corrupts a balance', async () => {
		const s = await setup();
		const type = await mkType(s.company.id);
		const res = await post('/leave-balances', hr.cookie, {
			employeeId: s.employee.id,
			leaveTypeId: type.id,
			year: 2026,
			entitlementDays: 10.1,
			carriedForwardDays: 0.2
		});
		expect(res.body.data.available).toBe(10.3);
		await post(`/leave-balances/${res.body.data.id}/adjustments`, hr.cookie, {
			days: -0.3,
			reason: 'ຫັກ'
		});
		expect((await balanceFor(s, type.id)).available).toBe(10);
		// more than 2 decimals is refused instead of silently rounded
		expect(
			(
				await post(`/leave-balances/${res.body.data.id}/adjustments`, hr.cookie, {
					days: 0.125,
					reason: 'ທົດສອບ'
				})
			).status
		).toBe(400);
	});
});

// ============================================================================================
describe('timezone', () => {
	it('76. the Laos calendar date decides "in the past" (not the UTC date)', async () => {
		// 2026-09-20T18:00Z is already Monday 2026-09-21 01:00 in Laos, while the UTC date is still Sunday
		at('2026-09-20T18:00:00Z');
		const s = await setup();
		const type = await mkType(s.company.id, { requiresBalance: false });
		const past = await request(s, type.id, '2026-09-20', '2026-09-20');
		expect(past.status).toBe(400);
		expect(past.body.error.code).toBe('LEAVE_DATE_IN_PAST');
		expect((await request(s, type.id, MON, MON)).status).toBe(201);
	});

	it('77. the notice-day boundary follows Laos midnight around the UTC date change', async () => {
		const s = await setup();
		const type = await mkType(s.company.id, { requiresBalance: false, minNoticeDays: 1 });
		// Sun 23:30 Laos (16:30Z, UTC date is Sunday too): Monday is exactly 1 day away → allowed
		at('2026-09-20T16:30:00Z');
		expect((await preview(s, type.id, MON, MON)).status).toBe(200);
		// Mon 00:30 Laos (17:30Z, UTC date still Sunday): today is Monday → Monday is 0 days away
		at('2026-09-20T17:30:00Z');
		const tooSoon = await preview(s, type.id, MON, MON);
		expect(tooSoon.status).toBe(400);
		expect(tooSoon.body.error.code).toBe('LEAVE_NOTICE_TOO_SHORT');
		expect((await preview(s, type.id, '2026-09-22', '2026-09-22')).status).toBe(200);
	});
});
