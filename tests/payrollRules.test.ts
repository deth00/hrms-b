import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	agent,
	createTestCompany,
	createTestUser,
	loginAndGetCookie,
	superAdminCookie,
	userWithPermissions
} from './helpers.js';
import { prisma } from '../src/config/prisma.js';

/**
 * PHASE 12A — payroll rules, proration, segments, attendance / leave deductions, OT compensation.
 * Test periods are in the past (Sep 2025: Mon 2025-09-01, 30 calendar days, 22 Mon–Fri working days)
 * so a working day without an attendance record is a real ABSENT.
 */
const uid = () => randomUUID().slice(0, 6).toUpperCase();
const get = (path: string, cookie: string) => agent().get(`/api/v1${path}`).set('Cookie', cookie);
const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const put = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().put(`/api/v1${path}`).set('Cookie', cookie).send(body);
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

let admin: string;
let actorUserId: string;
beforeAll(async () => {
	admin = await superAdminCookie();
	actorUserId = (await createTestUser()).user.id;
});

// ---------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------
const START = '2025-09-01';
const END = '2025-09-30';

function days(from: string, to: string) {
	const out: string[] = [];
	for (let d = D(from); d.getTime() <= D(to).getTime(); d = new Date(d.getTime() + 86_400_000)) {
		out.push(d.toISOString().slice(0, 10));
	}
	return out;
}
const isWeekday = (iso: string) => ![0, 6].includes(D(iso).getUTCDay());
const weekdays = (from: string, to: string) => days(from, to).filter(isWeekday);

async function newCompany() {
	const c = await createTestCompany();
	const res = await put(`/payroll/settings?companyId=${c.id}`, admin, { currencyCode: 'LAK' });
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return c.id;
}

const OT_RULES = [
	{
		overtimeType: 'BEFORE_SHIFT',
		multiplier: '1.25',
		monthlyDivisorDays: 30,
		standardDailyMinutes: 480
	},
	{
		overtimeType: 'AFTER_SHIFT',
		multiplier: '1.5',
		monthlyDivisorDays: 30,
		standardDailyMinutes: 480
	},
	{ overtimeType: 'OFF_DAY', multiplier: '2', monthlyDivisorDays: 30, standardDailyMinutes: 480 },
	{ overtimeType: 'HOLIDAY', multiplier: '3', monthlyDivisorDays: 30, standardDailyMinutes: 480 }
];
const ruleBody = (companyId: string, extra: Record<string, unknown> = {}) => ({
	companyId,
	nameLao: 'ກົດທົດສອບ',
	effectiveFrom: '2025-01-01',
	prorationMethod: 'CALENDAR_DAYS',
	...extra
});
async function mkRule(companyId: string, extra: Record<string, unknown> = {}, cookie = admin) {
	const res = await post('/payroll-rules', cookie, ruleBody(companyId, extra));
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; version: number };
}

async function shiftFor(companyId: string) {
	const days7 = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
	return prisma.shift.create({
		data: {
			companyId,
			code: `SH_${uid()}`,
			nameLao: 'ກະທົດສອບ',
			startTime: '08:00',
			endTime: '17:00',
			breakMinutes: 60,
			workDays: {
				create: days7.map((dayOfWeek, i) => ({
					dayOfWeek: dayOfWeek as never,
					isWorkingDay: i < 5
				}))
			}
		}
	});
}

interface WorldOptions {
	rule?: Record<string, unknown> | false;
	start?: string;
	end?: string | null;
	salary?: string | null;
	scheduleFrom?: string | null;
}
/** company (+ rule) + one employee with salary and a Mon–Fri 08:00–17:00 (480 paid minutes) schedule */
async function world(o: WorldOptions = {}) {
	const companyId = await newCompany();
	if (o.rule !== false) await mkRule(companyId, o.rule ?? {});
	const start = o.start ?? '2024-01-01';
	const code = `PR_${uid()}`;
	const emp = await prisma.employee.create({
		data: {
			employeeCode: code,
			firstNameLao: 'ພະນັກງານ',
			lastNameLao: code,
			startDate: D(start),
			endDate: o.end ? D(o.end) : null,
			companyId
		}
	});
	if (o.salary !== null) {
		const from = start > '2025-01-01' ? start : '2025-01-01';
		const r = await post(`/employees/${emp.id}/compensation`, admin, {
			baseSalary: o.salary ?? '3000000',
			effectiveFrom: from
		});
		expect(r.status, JSON.stringify(r.body)).toBe(201);
	}
	const shift = await shiftFor(companyId);
	if (o.scheduleFrom !== null) {
		await prisma.employeeScheduleAssignment.create({
			data: { employeeId: emp.id, shiftId: shift.id, effectiveFrom: D(o.scheduleFrom ?? start) }
		});
	}
	return { companyId, emp, shiftId: shift.id };
}

const rowFor = (
	employeeId: string,
	shiftId: string,
	iso: string,
	o: { late?: number; early?: number } = {}
) => {
	const late = o.late ?? 0;
	const early = o.early ?? 0;
	const status =
		late && early ? 'LATE_AND_EARLY' : late ? 'LATE' : early ? 'EARLY_LEAVE' : 'PRESENT';
	return {
		employeeId,
		workDate: D(iso),
		shiftId,
		scheduledStartTime: '08:00',
		scheduledEndTime: '17:00',
		scheduledBreakMinutes: 60,
		scheduledLateGraceMinutes: 0,
		scheduledEarlyLeaveGraceMinutes: 0,
		firstCheckInAt: new Date(`${iso}T01:00:00Z`),
		lastCheckOutAt: new Date(`${iso}T10:00:00Z`),
		effectiveCheckInAt: new Date(`${iso}T01:00:00Z`),
		effectiveCheckOutAt: new Date(`${iso}T10:00:00Z`),
		scheduledWorkMinutes: 480,
		workedMinutes: 480 - late - early,
		arrivalDelayMinutes: late,
		lateMinutes: late,
		earlyLeaveMinutes: early,
		calculationStatus: status as never,
		calculatedAt: new Date(),
		calculationVersion: 1,
		status: 'COMPLETED' as const,
		isWorkingDay: true
	};
};
/** a normal PRESENT record on every Mon–Fri of the range except `skip` */
async function presentAll(
	empId: string,
	shiftId: string,
	from = START,
	to = END,
	skip: string[] = [],
	special: Record<string, { late?: number; early?: number }> = {}
) {
	await prisma.attendanceRecord.createMany({
		data: weekdays(from, to)
			.filter((d) => !skip.includes(d))
			.map((d) => rowFor(empId, shiftId, d, special[d]))
	});
}

async function leave(
	companyId: string,
	empId: string,
	dates: string[],
	o: { isPaid: boolean; status?: 'APPROVED' | 'PENDING' | 'REJECTED' }
) {
	const type = await prisma.leaveType.create({
		data: { companyId, code: `LT_${uid()}`, nameLao: 'ລາ', isPaid: o.isPaid }
	});
	const status = o.status ?? 'APPROVED';
	const req = await prisma.leaveRequest.create({
		data: {
			employeeId: empId,
			leaveTypeId: type.id,
			startDate: D(dates[0]!),
			endDate: D(dates[dates.length - 1]!),
			totalDays: String(dates.length),
			reason: 'ທົດສອບ',
			status,
			requestedByUserId: actorUserId
		}
	});
	for (const d of dates) {
		await prisma.leaveRequestDay.create({
			data: {
				leaveRequestId: req.id,
				employeeId: empId,
				leaveDate: D(d),
				activeKey: status === 'REJECTED' ? null : `${empId}:${d}:${uid()}`
			}
		});
	}
	return req;
}

async function overtime(
	empId: string,
	date: string,
	type: 'BEFORE_SHIFT' | 'AFTER_SHIFT' | 'OFF_DAY' | 'HOLIDAY',
	eligible: number,
	o: { planned?: number; actual?: number } = {}
) {
	return prisma.overtimeRequest.create({
		data: {
			employeeId: empId,
			workDate: D(date),
			type,
			requestedStartAt: new Date(`${date}T10:00:00Z`),
			requestedEndAt: new Date(`${date}T13:00:00Z`),
			plannedMinutes: o.planned ?? eligible,
			reason: 'ທົດສອບ',
			status: 'APPROVED',
			requestedByUserId: actorUserId,
			isWorkingDay: isWeekday(date),
			actualMinutes: o.actual ?? eligible,
			eligibleMinutes: eligible,
			calculationStatus: 'CALCULATED',
			calculatedAt: new Date(),
			calculationVersion: 1
		}
	});
}

async function holiday(companyId: string, date: string) {
	return prisma.holiday.create({
		data: { companyId, nameLao: `ວັນພັກ ${uid()}`, holidayDate: D(date), type: 'PUBLIC' }
	});
}

async function periodOf(companyId: string, start = START, end = END, code = `P_${uid()}`) {
	const res = await post('/payroll/periods', admin, {
		companyId,
		code,
		name: code,
		startDate: start,
		endDate: end,
		payDate: end
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
}
async function runOn(companyId: string, periodId?: string) {
	const p = periodId ?? (await periodOf(companyId)).id;
	const res = await post('/payroll/runs', admin, { companyId, periodId: p });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return { id: res.body.data.id as string, periodId: p };
}
const calculate = (runId: string, cookie = admin) =>
	post(`/payroll/runs/${runId}/calculate`, cookie);
const finalize = (runId: string, body: Record<string, unknown> = {}) =>
	post(`/payroll/runs/${runId}/finalize`, admin, body);

interface Item {
	code: string;
	source: string;
	type: string;
	amount: string;
	details: Record<string, unknown> | null;
}
interface Detail {
	id: string;
	netPay: string;
	totalEarnings: string;
	totalDeductions: string;
	baseSalary: string | null;
	calculationStatus: 'READY' | 'BLOCKED';
	calculationVersion: number;
	issues: { code: string }[];
	items: Item[];
	segments: {
		segmentStart: string;
		segmentEnd: string;
		company: { id: string; nameLao: string };
		branch: { id: string; nameLao: string } | null;
		baseSalary: string;
		periodUnits: string;
		payableUnits: string;
		prorationFactor: string;
		proratedBaseSalary: string;
		prorationMethod: string;
	}[];
	ruleSnapshot: Record<string, unknown> | null;
	attendanceSummary: Record<string, number> | null;
	leaveSummary: { paidDays: string; unpaidDays: string } | null;
	overtimeSummary: { totalEligibleMinutes: number; requests: unknown[] } | null;
}
async function outcome(runId: string, empId: string): Promise<Detail> {
	const list = await get(`/payroll/runs/${runId}/results?pageSize=100`, admin);
	expect(list.status, JSON.stringify(list.body)).toBe(200);
	const row = (list.body.data.items as { id: string; employee: { id: string } }[]).find(
		(r) => r.employee.id === empId
	);
	expect(row, 'employee result present').toBeTruthy();
	const d = await get(`/payroll/results/${row!.id}`, admin);
	expect(d.status, JSON.stringify(d.body)).toBe(200);
	return d.body.data as Detail;
}
/** world → period → run → calculate → the employee's result */
async function calcFor(
	companyId: string,
	empId: string,
	start = START,
	end = END
): Promise<{ runId: string; result: Detail }> {
	const r = await runOn(companyId, (await periodOf(companyId, start, end)).id);
	const c = await calculate(r.id);
	expect(c.status, JSON.stringify(c.body)).toBe(200);
	return { runId: r.id, result: await outcome(r.id, empId) };
}
const item = (d: Detail, source: string) => d.items.find((i) => i.source === source);
const amountOf = (d: Detail, source: string) => item(d, source)?.amount;
const codes = (d: Detail) => d.issues.map((i) => i.code);

// =============================================================================================
describe('payroll rule sets', () => {
	it('1. requires authentication', async () => {
		expect((await agent().get('/api/v1/payroll-rules')).status).toBe(401);
		expect((await agent().post('/api/v1/payroll-rules').send({})).status).toBe(401);
	});

	it('2. payroll.view reads, payroll.manage writes (each with the broad scope)', async () => {
		const companyId = await newCompany();
		const viewer = await userWithPermissions(['payroll.view', 'employees.view_all']);
		expect((await get(`/payroll-rules?companyId=${companyId}`, viewer.cookie)).status).toBe(200);
		expect((await post('/payroll-rules', viewer.cookie, ruleBody(companyId))).status).toBe(403);
		const manager = await userWithPermissions(['payroll.manage', 'employees.view_all']);
		expect((await post('/payroll-rules', manager.cookie, ruleBody(companyId))).status).toBe(201);
		const none = await userWithPermissions(['dashboard.view']);
		expect((await get('/payroll-rules', none.cookie)).status).toBe(403);
	});

	it('3. payroll permission without the broad employee scope is refused', async () => {
		const companyId = await newCompany();
		const narrow = await userWithPermissions(['payroll.view', 'payroll.manage']);
		expect((await get(`/payroll-rules?companyId=${companyId}`, narrow.cookie)).status).toBe(403);
		expect((await post('/payroll-rules', narrow.cookie, ruleBody(companyId))).status).toBe(403);
	});

	it('4. creates a rule set with OT rules (multiplier is a decimal string, never a legal constant)', async () => {
		const companyId = await newCompany();
		const res = await post(
			'/payroll-rules',
			admin,
			ruleBody(companyId, {
				absenceDeductionEnabled: true,
				overtimeRules: [OT_RULES[1]]
			})
		);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data).toMatchObject({
			version: 1,
			prorationMethod: 'CALENDAR_DAYS',
			absenceDeductionEnabled: true,
			lateDeductionEnabled: false,
			minuteDeductionBasis: 'SCHEDULED_DAILY_MINUTES',
			status: 'ACTIVE',
			effectiveTo: null
		});
		expect(res.body.data.overtimeRules).toHaveLength(1);
		expect(res.body.data.overtimeRules[0]).toMatchObject({
			overtimeType: 'AFTER_SHIFT',
			multiplier: '1.5000',
			monthlyDivisorDays: 30
		});
		const read = await get(`/payroll-rules/${res.body.data.id}`, admin);
		expect(read.status).toBe(200);
		expect(read.body.data.id).toBe(res.body.data.id);
	});

	it('5. effective dating: a new version closes the previous one and versions increment', async () => {
		const companyId = await newCompany();
		const v1 = await mkRule(companyId, { effectiveFrom: '2025-01-01' });
		const v2 = await mkRule(companyId, {
			effectiveFrom: '2025-10-01',
			prorationMethod: 'WORKING_DAYS'
		});
		expect([v1.version, v2.version]).toEqual([1, 2]);
		const first = await get(`/payroll-rules/${v1.id}`, admin);
		expect(first.body.data.effectiveTo).toMatch(/^2025-09-30/);
		// each period resolves the version effective on its END date (and stores that snapshot)
		const emp = await prisma.employee.create({
			data: {
				employeeCode: `PR_${uid()}`,
				firstNameLao: 'ກ',
				lastNameLao: 'ຂ',
				startDate: D('2024-01-01'),
				companyId
			}
		});
		await post(`/employees/${emp.id}/compensation`, admin, {
			baseSalary: '1000',
			effectiveFrom: '2025-01-01'
		});
		const septRun = await runOn(companyId, (await periodOf(companyId)).id);
		await calculate(septRun.id);
		expect((await get(`/payroll/runs/${septRun.id}`, admin)).body.data.ruleSnapshot.version).toBe(
			1
		);
	});

	it('6. an overlapping / earlier effective date is rejected', async () => {
		const companyId = await newCompany();
		await mkRule(companyId, { effectiveFrom: '2025-06-01' });
		for (const from of ['2025-06-01', '2025-01-01']) {
			const res = await post('/payroll-rules', admin, ruleBody(companyId, { effectiveFrom: from }));
			expect(res.status, from).toBe(409);
			expect(res.body.error.code).toBe('PAYROLL_RULE_PERIOD_OVERLAP');
		}
		expect(await prisma.payrollRuleSet.count({ where: { companyId } })).toBe(1);
	});

	it('7. an unknown proration method / overtime type / non-positive multiplier is rejected', async () => {
		const companyId = await newCompany();
		const bad = [
			{ prorationMethod: 'FIXED_30' },
			{
				prorationMethod: 'WORKING_DAYS',
				overtimeRules: [{ ...OT_RULES[1], overtimeType: 'NIGHT' }]
			},
			{ overtimeRules: [{ ...OT_RULES[1], multiplier: '0' }] },
			{ overtimeRules: [{ ...OT_RULES[1], multiplier: '-1.5' }] },
			{ overtimeRules: [OT_RULES[1], OT_RULES[1]] }
		];
		for (const extra of bad) {
			const res = await post('/payroll-rules', admin, ruleBody(companyId, extra));
			expect(res.status, JSON.stringify(extra)).toBe(400);
		}
		expect(await prisma.payrollRuleSet.count({ where: { companyId } })).toBe(0);
	});

	it('8. STANDARD_DAILY_MINUTES requires standardDailyMinutes', async () => {
		const companyId = await newCompany();
		const bad = await post(
			'/payroll-rules',
			admin,
			ruleBody(companyId, { minuteDeductionBasis: 'STANDARD_DAILY_MINUTES' })
		);
		expect(bad.status).toBe(400);
		const ok = await post(
			'/payroll-rules',
			admin,
			ruleBody(companyId, {
				minuteDeductionBasis: 'STANDARD_DAILY_MINUTES',
				standardDailyMinutes: 450
			})
		);
		expect(ok.status, JSON.stringify(ok.body)).toBe(201);
		expect(ok.body.data.standardDailyMinutes).toBe(450);
	});

	it('9. versions are immutable: no update / delete route, content unchanged by a newer version', async () => {
		const companyId = await newCompany();
		const v1 = await mkRule(companyId, {
			lateDeductionEnabled: true,
			overtimeRules: [OT_RULES[1]]
		});
		const before = (await get(`/payroll-rules/${v1.id}`, admin)).body.data;
		for (const method of ['patch', 'put', 'delete'] as const) {
			const res = await agent()
				[method](`/api/v1/payroll-rules/${v1.id}`)
				.set('Cookie', admin)
				.send({ nameLao: 'x' });
			expect(res.status, method).toBe(404);
		}
		await mkRule(companyId, { effectiveFrom: '2026-01-01', lateDeductionEnabled: false });
		const after = (await get(`/payroll-rules/${v1.id}`, admin)).body.data;
		expect({ ...after, effectiveTo: null }).toEqual({ ...before, effectiveTo: null });
		expect(after.lateDeductionEnabled).toBe(true);
	});
});

// =============================================================================================
describe('proration', () => {
	it('10. a full period is paid unchanged (source BASE_SALARY, one segment, factor 1)', async () => {
		const w = await world();
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.calculationStatus).toBe('READY');
		expect(result.netPay).toBe('3000000.00');
		expect(amountOf(result, 'BASE_SALARY')).toBe('3000000.00');
		expect(result.segments).toHaveLength(1);
		expect(result.segments[0]).toMatchObject({
			periodUnits: '30',
			payableUnits: '30',
			prorationFactor: '1.0000000000',
			proratedBaseSalary: '3000000.00'
		});
	});

	it('11. starts mid-month, CALENDAR_DAYS: only Sep 16–30 is paid (15 / 30)', async () => {
		const w = await world({ start: '2025-09-16' });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.calculationStatus, JSON.stringify(result.issues)).toBe('READY');
		expect(amountOf(result, 'PRORATED_BASE_SALARY')).toBe('1500000.00');
		expect(result.netPay).toBe('1500000.00');
		expect(result.segments).toHaveLength(1);
		expect(result.segments[0]).toMatchObject({
			segmentStart: expect.stringMatching(/^2025-09-16/),
			segmentEnd: expect.stringMatching(/^2025-09-30/),
			periodUnits: '30',
			payableUnits: '15'
		});
	});

	it('12. ends mid-month, CALENDAR_DAYS: paid through Sep 20 only (20 / 30)', async () => {
		const w = await world({ end: '2025-09-20' });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.calculationStatus, JSON.stringify(result.issues)).toBe('READY');
		expect(result.netPay).toBe('2000000.00');
		expect(result.segments[0]).toMatchObject({ payableUnits: '20', periodUnits: '30' });
		expect(result.segments[0]!.segmentEnd).toMatch(/^2025-09-20/);
	});

	it('13. starts mid-month, WORKING_DAYS: 11 of the 22 scheduled working days', async () => {
		const w = await world({
			start: '2025-09-16',
			salary: '2200000',
			rule: { prorationMethod: 'WORKING_DAYS' }
		});
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.calculationStatus, JSON.stringify(result.issues)).toBe('READY');
		expect(result.segments[0]).toMatchObject({
			prorationMethod: 'WORKING_DAYS',
			periodUnits: '22',
			payableUnits: '11'
		});
		expect(result.netPay).toBe('1100000.00');
	});

	it('14. ends mid-month, WORKING_DAYS: 15 of the 22 scheduled working days', async () => {
		const w = await world({
			end: '2025-09-20',
			salary: '2200000',
			rule: { prorationMethod: 'WORKING_DAYS' }
		});
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.segments[0]).toMatchObject({ periodUnits: '22', payableUnits: '15' });
		expect(result.netPay).toBe('1500000.00');
	});

	it('15. leap February uses the real 29 calendar days (no 30-day month)', async () => {
		const w = await world({ start: '2028-02-15', salary: '2900000' });
		const { result } = await calcFor(w.companyId, w.emp.id, '2028-02-01', '2028-02-29');
		expect(result.segments[0]).toMatchObject({ periodUnits: '29', payableUnits: '15' });
		expect(result.netPay).toBe('1500000.00');
	});

	it('16–17. a salary change inside the period creates two independently calculated segments', async () => {
		const w = await world();
		await post(`/employees/${w.emp.id}/compensation`, admin, {
			baseSalary: '3600000',
			effectiveFrom: '2025-09-15'
		});
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.calculationStatus, JSON.stringify(result.issues)).toBe('READY');
		expect(codes(result)).not.toContain('COMPENSATION_CHANGE_WITHIN_PERIOD');
		expect(result.segments).toHaveLength(2);
		expect(result.segments[0]).toMatchObject({
			baseSalary: '3000000.00',
			payableUnits: '14',
			periodUnits: '30',
			proratedBaseSalary: '1400000.00'
		});
		expect(result.segments[1]).toMatchObject({
			baseSalary: '3600000.00',
			payableUnits: '16',
			proratedBaseSalary: '1920000.00'
		});
		expect(amountOf(result, 'PRORATED_BASE_SALARY')).toBe('3320000.00');
		// compensation history is untouched (still exactly two rows)
		expect(await prisma.employeeCompensation.count({ where: { employeeId: w.emp.id } })).toBe(2);
	});

	it('18. a recurring earning that changes inside the period is prorated per segment', async () => {
		const w = await world();
		const house = (
			await post('/pay-components', admin, {
				companyId: w.companyId,
				code: `H_${uid()}`,
				nameLao: 'ຄ່າທີ່ພັກ',
				type: 'EARNING',
				category: 'ALLOWANCE'
			})
		).body.data;
		await post(`/employees/${w.emp.id}/recurring-pay-components`, admin, {
			payComponentId: house.id,
			amount: '500000',
			effectiveFrom: '2025-01-01'
		});
		await post(`/employees/${w.emp.id}/recurring-pay-components`, admin, {
			payComponentId: house.id,
			amount: '750000',
			effectiveFrom: '2025-09-15'
		});
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.calculationStatus, JSON.stringify(result.issues)).toBe('READY');
		expect(codes(result)).not.toContain('PAY_COMPONENT_CHANGE_WITHIN_PERIOD');
		// 500,000 × 14/30 + 750,000 × 16/30 = 233,333.33 + 400,000.00
		expect(amountOf(result, 'PRORATED_RECURRING')).toBe('633333.33');
		// the unchanged base salary is still a plain full-period line
		expect(amountOf(result, 'BASE_SALARY')).toBe('3000000.00');
		expect(result.netPay).toBe('3633333.33');
	});

	it('19. a recurring deduction that changes inside the period is prorated per segment', async () => {
		const w = await world();
		const loan = (
			await post('/pay-components', admin, {
				companyId: w.companyId,
				code: `L_${uid()}`,
				nameLao: 'ຫັກເງິນກູ້',
				type: 'DEDUCTION',
				category: 'DEDUCTION'
			})
		).body.data;
		await post(`/employees/${w.emp.id}/recurring-pay-components`, admin, {
			payComponentId: loan.id,
			amount: '300000',
			effectiveFrom: '2025-01-01'
		});
		await post(`/employees/${w.emp.id}/recurring-pay-components`, admin, {
			payComponentId: loan.id,
			amount: '600000',
			effectiveFrom: '2025-09-15'
		});
		const { result } = await calcFor(w.companyId, w.emp.id);
		const line = item(result, 'PRORATED_RECURRING')!;
		expect(line.type).toBe('DEDUCTION');
		expect(line.amount).toBe('460000.00'); // 140,000 + 320,000
		expect(result.netPay).toBe('2540000.00');
	});

	it('20. proration is exact Decimal arithmetic (no floating-point drift)', async () => {
		const w = await world({ start: '2025-09-24', salary: '1000.00' });
		const { result } = await calcFor(w.companyId, w.emp.id);
		// 1000 × 7 / 30 = 233.3333… → 233.33 (HALF_UP at the line, never earlier)
		expect(amountOf(result, 'PRORATED_BASE_SALARY')).toBe('233.33');
		const w2 = await world({ start: '2025-09-04', salary: '100000.10' });
		const r2 = await calcFor(w2.companyId, w2.emp.id);
		// 100000.10 × 27 / 30 = 90000.09 exactly
		expect(amountOf(r2.result, 'PRORATED_BASE_SALARY')).toBe('90000.09');
	});

	it('21–24. company transfer inside the period: each company pays only its own segment', async () => {
		const a = await newCompany();
		const b = await newCompany();
		await mkRule(a);
		await mkRule(b);
		const emp = await prisma.employee.create({
			data: {
				employeeCode: `PT_${uid()}`,
				firstNameLao: 'ຍ້າຍ',
				lastNameLao: 'ບໍລິສັດ',
				startDate: D('2024-01-01'),
				companyId: b
			}
		});
		await prisma.employeeAssignmentHistory.createMany({
			data: [
				{
					employeeId: emp.id,
					companyId: a,
					effectiveFrom: D('2024-01-01'),
					effectiveTo: D('2025-09-15')
				},
				{ employeeId: emp.id, companyId: b, effectiveFrom: D('2025-09-15'), effectiveTo: null }
			]
		});
		await prisma.employeeCompensation.createMany({
			data: [
				{
					employeeId: emp.id,
					companyId: a,
					baseSalary: '5000000',
					currencyCode: 'LAK',
					effectiveFrom: D('2025-01-01'),
					effectiveTo: D('2025-09-14')
				},
				{
					employeeId: emp.id,
					companyId: b,
					baseSalary: '6000000',
					currencyCode: 'LAK',
					effectiveFrom: D('2025-09-15'),
					effectiveTo: null
				}
			]
		});
		const ra = await calcFor(a, emp.id);
		const rb = await calcFor(b, emp.id);
		// 21 — company A: Sep 1–14 only, and no COMPANY_CHANGE blocker any more
		expect(ra.result.calculationStatus, JSON.stringify(ra.result.issues)).toBe('READY');
		expect(ra.result.segments).toHaveLength(1);
		expect(ra.result.segments[0]).toMatchObject({ payableUnits: '14', baseSalary: '5000000.00' });
		expect(ra.result.segments[0]!.segmentEnd).toMatch(/^2025-09-14/);
		expect(amountOf(ra.result, 'PRORATED_BASE_SALARY')).toBe('2333333.33');
		// 22 — company B: Sep 15–30 only
		expect(rb.result.calculationStatus, JSON.stringify(rb.result.issues)).toBe('READY');
		expect(rb.result.segments[0]).toMatchObject({ payableUnits: '16', baseSalary: '6000000.00' });
		expect(rb.result.segments[0]!.segmentStart).toMatch(/^2025-09-15/);
		expect(amountOf(rb.result, 'PRORATED_BASE_SALARY')).toBe('3200000.00');
		// 23 — the two runs together cover the 30 days exactly once
		expect(
			Number(ra.result.segments[0]!.payableUnits) + Number(rb.result.segments[0]!.payableUnits)
		).toBe(30);
		// 24 — a finalized run is a snapshot: later master-data changes never move it
		expect((await finalize(ra.runId)).status).toBe(200);
		await prisma.employeeCompensation.updateMany({
			where: { employeeId: emp.id },
			data: { baseSalary: '9999999' }
		});
		await prisma.employeeAssignmentHistory.deleteMany({
			where: { employeeId: emp.id, companyId: a }
		});
		const frozen = await outcome(ra.runId, emp.id);
		expect(frozen.netPay).toBe('2333333.33');
		expect(frozen.segments[0]!.baseSalary).toBe('5000000.00');
		expect((await calculate(ra.runId)).status).toBe(409);
	});
});

// =============================================================================================
describe('branch segments', () => {
	async function branchWorld(groupByBranch: boolean) {
		const companyId = await newCompany();
		await mkRule(companyId);
		const x = await prisma.branch.create({
			data: { companyId, code: `BX_${uid()}`, nameLao: 'ສາຂາ X' }
		});
		const y = await prisma.branch.create({
			data: { companyId, code: `BY_${uid()}`, nameLao: 'ສາຂາ Y' }
		});
		const emp = await prisma.employee.create({
			data: {
				employeeCode: `PB_${uid()}`,
				firstNameLao: 'ສາຂາ',
				lastNameLao: 'ຍ້າຍ',
				startDate: D('2024-01-01'),
				companyId,
				branchId: y.id
			}
		});
		await prisma.employeeAssignmentHistory.createMany({
			data: [
				{
					employeeId: emp.id,
					companyId,
					branchId: x.id,
					effectiveFrom: D('2024-01-01'),
					effectiveTo: D('2025-09-15')
				},
				{
					employeeId: emp.id,
					companyId,
					branchId: y.id,
					effectiveFrom: D('2025-09-15'),
					effectiveTo: null
				}
			]
		});
		await post(`/employees/${emp.id}/compensation`, admin, {
			baseSalary: '3000000',
			effectiveFrom: '2025-01-01'
		});
		const sched = await post('/payroll-schedules', admin, {
			companyId,
			code: `SCH_${uid()}`,
			nameLao: 'ລາຍເດືອນ',
			payBasis: 'MONTHLY',
			paymentsPerMonth: 'ONE',
			anchorDate: '2025-01-01',
			payDateRule: 'PERIOD_END',
			employeeScope: 'ALL',
			groupByBranch
		});
		expect(sched.status, JSON.stringify(sched.body)).toBe(201);
		const gen = await post(`/payroll-schedules/${sched.body.data.id}/generate-periods`, admin, {
			fromMonth: '2025-09',
			toMonth: '2025-09'
		});
		expect(gen.status, JSON.stringify(gen.body)).toBe(200);
		const periods = await get(`/payroll/periods?companyId=${companyId}`, admin);
		const run = await runOn(companyId, periods.body.data.items[0].id);
		await calculate(run.id);
		return { companyId, emp, run, x, y };
	}

	it('25. groupByBranch: a branch change creates one segment per branch (no blocker)', async () => {
		const w = await branchWorld(true);
		const result = await outcome(w.run.id, w.emp.id);
		expect(result.calculationStatus, JSON.stringify(result.issues)).toBe('READY');
		expect(codes(result)).not.toContain('BRANCH_CHANGE_WITHIN_PERIOD');
		expect(result.segments).toHaveLength(2);
		expect(result.segments.map((s) => s.branch?.nameLao)).toEqual(['ສາຂາ X', 'ສາຂາ Y']);
		expect(result.segments.map((s) => s.payableUnits)).toEqual(['14', '16']);
		expect(result.netPay).toBe('3000000.00');
	});

	it('26. the branch snapshot is historical; without groupByBranch the branch never splits pay', async () => {
		const w = await branchWorld(true);
		await prisma.employee.update({ where: { id: w.emp.id }, data: { branchId: w.x.id } });
		await calculate(w.run.id);
		const result = await outcome(w.run.id, w.emp.id);
		// the CURRENT branch (X) does not rewrite the branch that applied at the end of the period (Y)
		expect(result.segments.at(-1)!.branch?.nameLao).toBe('ສາຂາ Y');
		const flat = await branchWorld(false);
		const r2 = await outcome(flat.run.id, flat.emp.id);
		expect(r2.segments).toHaveLength(1);
		expect(r2.calculationStatus).toBe('READY');
	});
});

// =============================================================================================
describe('leave', () => {
	const RULE = { unpaidLeaveDeductionEnabled: true };

	it('27. approved PAID leave never reduces salary', async () => {
		const w = await world({ rule: RULE });
		const days2 = ['2025-09-03', '2025-09-04'];
		await presentAll(w.emp.id, w.shiftId, START, END, days2);
		await leave(w.companyId, w.emp.id, days2, { isPaid: true });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.netPay).toBe('3000000.00');
		expect(result.items.map((i) => i.source)).toEqual(['BASE_SALARY']);
		expect(result.leaveSummary).toMatchObject({ paidDays: '2', unpaidDays: '0' });
	});

	it('28. approved UNPAID leave deducts the day rate per approved day', async () => {
		const w = await world({ rule: RULE });
		const days2 = ['2025-09-03', '2025-09-04'];
		await presentAll(w.emp.id, w.shiftId, START, END, days2);
		await leave(w.companyId, w.emp.id, days2, { isPaid: false });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(amountOf(result, 'UNPAID_LEAVE')).toBe('200000.00'); // 2 × 3,000,000 / 30
		expect(item(result, 'UNPAID_LEAVE')!.type).toBe('DEDUCTION');
		expect(result.netPay).toBe('2800000.00');
		expect(result.leaveSummary).toMatchObject({ unpaidDays: '2' });
	});

	it('28b. unpaid leave with the switch OFF creates no deduction', async () => {
		const w = await world({ rule: { unpaidLeaveDeductionEnabled: false } });
		await presentAll(w.emp.id, w.shiftId, START, END, ['2025-09-03']);
		await leave(w.companyId, w.emp.id, ['2025-09-03'], { isPaid: false });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(item(result, 'UNPAID_LEAVE')).toBeUndefined();
		expect(result.netPay).toBe('3000000.00');
	});

	it('29–30. PENDING and REJECTED leave are ignored', async () => {
		const w = await world({ rule: RULE });
		const skip = ['2025-09-03', '2025-09-04'];
		await presentAll(w.emp.id, w.shiftId, START, END, skip);
		await leave(w.companyId, w.emp.id, ['2025-09-03'], { isPaid: false, status: 'PENDING' });
		await leave(w.companyId, w.emp.id, ['2025-09-04'], { isPaid: false, status: 'REJECTED' });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(item(result, 'UNPAID_LEAVE')).toBeUndefined();
		expect(result.leaveSummary).toMatchObject({ unpaidDays: '0', paidDays: '0' });
	});

	it('31. leave on a holiday is not charged (the holiday wins)', async () => {
		const w = await world({ rule: RULE });
		await holiday(w.companyId, '2025-09-10');
		await presentAll(w.emp.id, w.shiftId, START, END, ['2025-09-10']);
		await leave(w.companyId, w.emp.id, ['2025-09-10'], { isPaid: false });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(item(result, 'UNPAID_LEAVE')).toBeUndefined();
		expect(result.attendanceSummary).toMatchObject({ holidayDays: 1 });
	});

	it('32. one day is never deducted twice (unpaid leave + late record + absence switches on)', async () => {
		const w = await world({
			rule: { ...RULE, absenceDeductionEnabled: true, lateDeductionEnabled: true }
		});
		await presentAll(w.emp.id, w.shiftId, START, END, ['2025-09-05'], {});
		// an attendance record exists on the leave day (with late minutes) — LEAVE still wins
		await prisma.attendanceRecord.create({
			data: rowFor(w.emp.id, w.shiftId, '2025-09-05', { late: 30 })
		});
		await leave(w.companyId, w.emp.id, ['2025-09-05'], { isPaid: false });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.items.map((i) => i.source).sort()).toEqual(['BASE_SALARY', 'UNPAID_LEAVE']);
		expect(amountOf(result, 'UNPAID_LEAVE')).toBe('100000.00');
		expect(result.netPay).toBe('2900000.00');
	});
});

// =============================================================================================
describe('attendance deductions', () => {
	it('33. PRESENT days create no deduction', async () => {
		const w = await world({ rule: { absenceDeductionEnabled: true, lateDeductionEnabled: true } });
		await presentAll(w.emp.id, w.shiftId);
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.netPay).toBe('3000000.00');
		expect(result.attendanceSummary).toMatchObject({ presentDays: 22, absentDays: 0 });
	});

	it('34. a derived ABSENT day deducts one day rate (switch on) and nothing (switch off)', async () => {
		const on = await world({ rule: { absenceDeductionEnabled: true } });
		await presentAll(on.emp.id, on.shiftId, START, END, ['2025-09-08']);
		const a = await calcFor(on.companyId, on.emp.id);
		expect(amountOf(a.result, 'ATTENDANCE_DEDUCTION')).toBe('100000.00');
		expect(a.result.netPay).toBe('2900000.00');
		expect(a.result.attendanceSummary).toMatchObject({ absentDays: 1 });
		const off = await world({ rule: { absenceDeductionEnabled: false } });
		await presentAll(off.emp.id, off.shiftId, START, END, ['2025-09-08']);
		const b = await calcFor(off.companyId, off.emp.id);
		expect(item(b.result, 'ATTENDANCE_DEDUCTION')).toBeUndefined();
		expect(b.result.attendanceSummary).toMatchObject({ absentDays: 1 });
		expect(b.result.netPay).toBe('3000000.00');
	});

	it('35–36. OFF_DAY and HOLIDAY are never absences', async () => {
		const w = await world({ rule: { absenceDeductionEnabled: true } });
		await holiday(w.companyId, '2025-09-10');
		await presentAll(w.emp.id, w.shiftId, START, END, ['2025-09-10']);
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(item(result, 'ATTENDANCE_DEDUCTION')).toBeUndefined();
		expect(result.attendanceSummary).toMatchObject({ offDays: 8, holidayDays: 1, absentDays: 0 });
	});

	it('37. late minutes are ignored when the late switch is off', async () => {
		const w = await world({ rule: { lateDeductionEnabled: false } });
		await presentAll(w.emp.id, w.shiftId, START, END, [], { '2025-09-03': { late: 30 } });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(item(result, 'LATE_DEDUCTION')).toBeUndefined();
		expect(result.attendanceSummary).toMatchObject({ lateMinutes: 30 });
	});

	it('38. late minutes deduct dayRate × minutes ÷ scheduled daily minutes', async () => {
		const w = await world({ rule: { lateDeductionEnabled: true } });
		await presentAll(w.emp.id, w.shiftId, START, END, [], { '2025-09-03': { late: 30 } });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(amountOf(result, 'LATE_DEDUCTION')).toBe('6250.00'); // 100,000 × 30 / 480
		expect(result.netPay).toBe('2993750.00');
	});

	it('39. early-leave minutes deduct (scheduled basis) and honour STANDARD_DAILY_MINUTES', async () => {
		const w = await world({ rule: { earlyLeaveDeductionEnabled: true } });
		await presentAll(w.emp.id, w.shiftId, START, END, [], { '2025-09-03': { early: 45 } });
		const a = await calcFor(w.companyId, w.emp.id);
		expect(amountOf(a.result, 'EARLY_LEAVE_DEDUCTION')).toBe('9375.00'); // 100,000 × 45 / 480
		const s = await world({
			rule: {
				earlyLeaveDeductionEnabled: true,
				minuteDeductionBasis: 'STANDARD_DAILY_MINUTES',
				standardDailyMinutes: 450
			}
		});
		await presentAll(s.emp.id, s.shiftId, START, END, [], { '2025-09-03': { early: 45 } });
		const b = await calcFor(s.companyId, s.emp.id);
		expect(amountOf(b.result, 'EARLY_LEAVE_DEDUCTION')).toBe('10000.00'); // 100,000 × 45 / 450
	});

	it('40. an attendance correction changes the deduction after recalculation', async () => {
		const w = await world({ rule: { lateDeductionEnabled: true } });
		await presentAll(w.emp.id, w.shiftId, START, END, [], { '2025-09-03': { late: 30 } });
		const first = await calcFor(w.companyId, w.emp.id);
		expect(amountOf(first.result, 'LATE_DEDUCTION')).toBe('6250.00');
		// what an approved correction leaves behind: recalculated, corrected record
		await prisma.attendanceRecord.update({
			where: { employeeId_workDate: { employeeId: w.emp.id, workDate: D('2025-09-03') } },
			data: {
				isCorrected: true,
				lateMinutes: 0,
				arrivalDelayMinutes: 0,
				calculationStatus: 'PRESENT'
			}
		});
		expect((await calculate(first.runId)).status).toBe(200);
		const after = await outcome(first.runId, w.emp.id);
		expect(item(after, 'LATE_DEDUCTION')).toBeUndefined();
		expect(after.netPay).toBe('3000000.00');
	});
});

// =============================================================================================
describe('overtime compensation', () => {
	const RULE = { overtimeRules: OT_RULES };

	it('41 + 45. approved eligible minutes are paid; AFTER_SHIFT uses its own multiplier', async () => {
		const w = await world({ rule: RULE });
		await presentAll(w.emp.id, w.shiftId);
		await overtime(w.emp.id, '2025-09-03', 'AFTER_SHIFT', 60);
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.calculationStatus, JSON.stringify(result.issues)).toBe('READY');
		// 3,000,000 / 30 / 480 = 208.333…/min × 60 × 1.5
		expect(amountOf(result, 'OVERTIME')).toBe('18750.00');
		expect(item(result, 'OVERTIME')!.type).toBe('EARNING');
		expect(result.netPay).toBe('3018750.00');
		expect(result.overtimeSummary).toMatchObject({ totalEligibleMinutes: 60 });
	});

	it('42–43. plannedMinutes and actualMinutes are never used — only eligibleMinutes', async () => {
		const w = await world({ rule: RULE });
		await presentAll(w.emp.id, w.shiftId);
		await overtime(w.emp.id, '2025-09-03', 'AFTER_SHIFT', 60, { planned: 600, actual: 200 });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(amountOf(result, 'OVERTIME')).toBe('18750.00');
		expect(item(result, 'OVERTIME')!.details).toMatchObject({ minutes: 60 });
	});

	it('44. BEFORE_SHIFT compensation', async () => {
		const w = await world({ rule: RULE });
		await presentAll(w.emp.id, w.shiftId);
		await overtime(w.emp.id, '2025-09-03', 'BEFORE_SHIFT', 30);
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(amountOf(result, 'OVERTIME')).toBe('7812.50'); // 208.333… × 30 × 1.25
		expect(item(result, 'OVERTIME')!.code).toBe('OT_BEFORE_SHIFT');
	});

	it('46. OFF_DAY compensation (Saturday)', async () => {
		const w = await world({ rule: RULE });
		await presentAll(w.emp.id, w.shiftId);
		await overtime(w.emp.id, '2025-09-06', 'OFF_DAY', 60);
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(amountOf(result, 'OVERTIME')).toBe('25000.00'); // 12,500 × 2
		expect(item(result, 'OVERTIME')!.code).toBe('OT_OFF_DAY');
	});

	it('47. HOLIDAY compensation', async () => {
		const w = await world({ rule: RULE });
		await holiday(w.companyId, '2025-09-10');
		await presentAll(w.emp.id, w.shiftId, START, END, ['2025-09-10']);
		await overtime(w.emp.id, '2025-09-10', 'HOLIDAY', 60);
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(amountOf(result, 'OVERTIME')).toBe('37500.00'); // 12,500 × 3
		expect(item(result, 'OVERTIME')!.code).toBe('OT_HOLIDAY');
	});

	it('48. the multiplier is configurable (nothing is a legal constant)', async () => {
		const w = await world({
			rule: {
				overtimeRules: [
					{
						overtimeType: 'AFTER_SHIFT',
						multiplier: '1.75',
						monthlyDivisorDays: 30,
						standardDailyMinutes: 480
					}
				]
			}
		});
		await presentAll(w.emp.id, w.shiftId);
		await overtime(w.emp.id, '2025-09-03', 'AFTER_SHIFT', 60);
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(amountOf(result, 'OVERTIME')).toBe('21875.00'); // 12,500 × 1.75
	});

	it('49. a missing / incomplete OT rule BLOCKS the employee (nothing is guessed)', async () => {
		const missing = await world({ rule: { overtimeRules: [OT_RULES[1]] } });
		await presentAll(missing.emp.id, missing.shiftId);
		await holiday(missing.companyId, '2025-09-10');
		await overtime(missing.emp.id, '2025-09-10', 'HOLIDAY', 60); // no HOLIDAY rule configured
		const a = await calcFor(missing.companyId, missing.emp.id);
		expect(a.result.calculationStatus).toBe('BLOCKED');
		expect(codes(a.result)).toContain('OT_COMPENSATION_RULE_INCOMPLETE');
		expect((await finalize(a.runId)).status).toBe(409);

		const incomplete = await world({
			rule: { overtimeRules: [{ overtimeType: 'AFTER_SHIFT', multiplier: '1.5' }] }
		});
		await presentAll(incomplete.emp.id, incomplete.shiftId);
		await overtime(incomplete.emp.id, '2025-09-03', 'AFTER_SHIFT', 60);
		const b = await calcFor(incomplete.companyId, incomplete.emp.id);
		expect(codes(b.result)).toContain('OT_COMPENSATION_RULE_INCOMPLETE');
		expect(item(b.result, 'OVERTIME')).toBeUndefined();
	});

	it('50. several approved OT requests are calculated independently and stay traceable', async () => {
		const w = await world({ rule: RULE });
		await presentAll(w.emp.id, w.shiftId);
		const r1 = await overtime(w.emp.id, '2025-09-03', 'AFTER_SHIFT', 60);
		const r2 = await overtime(w.emp.id, '2025-09-04', 'AFTER_SHIFT', 30);
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(amountOf(result, 'OVERTIME')).toBe('28125.00'); // 18,750 + 9,375
		const requests = (item(result, 'OVERTIME')!.details as { requests: { requestId: string }[] })
			.requests;
		expect(requests.map((r) => r.requestId).sort()).toEqual([r1.id, r2.id].sort());
	});

	it('51. a corrected eligible-minutes figure changes the OT pay after recalculation', async () => {
		const w = await world({ rule: RULE });
		await presentAll(w.emp.id, w.shiftId);
		const ot = await overtime(w.emp.id, '2025-09-03', 'AFTER_SHIFT', 60);
		const first = await calcFor(w.companyId, w.emp.id);
		expect(amountOf(first.result, 'OVERTIME')).toBe('18750.00');
		await prisma.overtimeRequest.update({ where: { id: ot.id }, data: { eligibleMinutes: 90 } });
		await calculate(first.runId);
		expect(amountOf(await outcome(first.runId, w.emp.id), 'OVERTIME')).toBe('28125.00');
	});

	it('51b. PENDING OT is not paid', async () => {
		const w = await world({ rule: RULE });
		await presentAll(w.emp.id, w.shiftId);
		const ot = await overtime(w.emp.id, '2025-09-03', 'AFTER_SHIFT', 60);
		await prisma.overtimeRequest.update({ where: { id: ot.id }, data: { status: 'PENDING' } });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(item(result, 'OVERTIME')).toBeUndefined();
	});
});

// =============================================================================================
describe('result structure', () => {
	async function rich() {
		const w = await world({
			start: '2025-09-04',
			rule: {
				unpaidLeaveDeductionEnabled: true,
				absenceDeductionEnabled: true,
				lateDeductionEnabled: true,
				earlyLeaveDeductionEnabled: true,
				overtimeRules: OT_RULES
			}
		});
		const house = (
			await post('/pay-components', admin, {
				companyId: w.companyId,
				code: `H_${uid()}`,
				nameLao: 'ຄ່າທີ່ພັກ',
				type: 'EARNING',
				category: 'ALLOWANCE'
			})
		).body.data;
		await post(`/employees/${w.emp.id}/recurring-pay-components`, admin, {
			payComponentId: house.id,
			amount: '300000',
			effectiveFrom: '2025-09-04'
		});
		// Sep 5 absent, Sep 8 unpaid leave, Sep 9 late 60, Sep 10 early 120
		await presentAll(w.emp.id, w.shiftId, '2025-09-04', END, [
			'2025-09-05',
			'2025-09-08',
			'2025-09-09',
			'2025-09-10'
		]);
		await prisma.attendanceRecord.createMany({
			data: [
				rowFor(w.emp.id, w.shiftId, '2025-09-09', { late: 60 }),
				rowFor(w.emp.id, w.shiftId, '2025-09-10', { early: 120 })
			]
		});
		await leave(w.companyId, w.emp.id, ['2025-09-08'], { isPaid: false });
		await overtime(w.emp.id, '2025-09-11', 'AFTER_SHIFT', 60);
		return w;
	}

	it('52–56. new item sources, version 2, persisted segments + rule snapshot, reconciling totals', async () => {
		const w = await rich();
		const { runId, result } = await calcFor(w.companyId, w.emp.id);
		expect(result.calculationStatus, JSON.stringify(result.issues)).toBe('READY');
		// 52 — sources
		expect(new Set(result.items.map((i) => i.source))).toEqual(
			new Set([
				'PRORATED_BASE_SALARY',
				'PRORATED_RECURRING',
				'ATTENDANCE_DEDUCTION',
				'UNPAID_LEAVE',
				'LATE_DEDUCTION',
				'EARLY_LEAVE_DEDUCTION',
				'OVERTIME'
			])
		);
		// 27/30 of the period × day rate 100,000: 2,700,000 − 100k absence − 100k unpaid − 12,500 late − 25,000 early + OT
		expect(amountOf(result, 'PRORATED_BASE_SALARY')).toBe('2700000.00');
		expect(amountOf(result, 'PRORATED_RECURRING')).toBe('270000.00');
		expect(amountOf(result, 'ATTENDANCE_DEDUCTION')).toBe('100000.00');
		expect(amountOf(result, 'UNPAID_LEAVE')).toBe('100000.00');
		expect(amountOf(result, 'LATE_DEDUCTION')).toBe('12500.00');
		expect(amountOf(result, 'EARLY_LEAVE_DEDUCTION')).toBe('25000.00');
		expect(amountOf(result, 'OVERTIME')).toBe('18750.00');
		// 53 — version
		expect(result.calculationVersion).toBe(2);
		const run = (await get(`/payroll/runs/${runId}`, admin)).body.data;
		expect(run.calculationVersion).toBe(2);
		// 54 — segments persisted
		const resultRow = await prisma.payrollEmployeeResult.findFirstOrThrow({
			where: { payrollRunId: runId }
		});
		expect(
			await prisma.payrollResultSegment.count({ where: { payrollEmployeeResultId: resultRow.id } })
		).toBe(1);
		// 55 — rule snapshot persisted with the OT multipliers
		expect(run.ruleSnapshot).toMatchObject({ version: 1, prorationMethod: 'CALENDAR_DAYS' });
		expect(run.ruleSnapshot.overtimeRules).toHaveLength(4);
		expect(result.ruleSnapshot).toMatchObject({ version: 1 });
		// 56 — reconcile: totals are exactly the sums of the lines, net = earnings − deductions
		const sum = (type: string) =>
			result.items
				.filter((i) => i.type === type)
				.reduce((n, i) => n + Math.round(Number(i.amount) * 100), 0);
		expect(Math.round(Number(result.totalEarnings) * 100)).toBe(sum('EARNING'));
		expect(Math.round(Number(result.totalDeductions) * 100)).toBe(sum('DEDUCTION'));
		expect(Math.round(Number(result.netPay) * 100)).toBe(sum('EARNING') - sum('DEDUCTION'));
		expect(result.netPay).toBe('2751250.00'); // 2,970,000 + 18,750 − 237,500
	});

	it('57. a result that would be negative is BLOCKED', async () => {
		const w = await world({ salary: '100000' });
		const big = (
			await post('/pay-components', admin, {
				companyId: w.companyId,
				code: `L_${uid()}`,
				nameLao: 'ຫັກ',
				type: 'DEDUCTION',
				category: 'DEDUCTION'
			})
		).body.data;
		await post(`/employees/${w.emp.id}/recurring-pay-components`, admin, {
			payComponentId: big.id,
			amount: '500000',
			effectiveFrom: '2025-01-01'
		});
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.calculationStatus).toBe('BLOCKED');
		expect(codes(result)).toContain('NEGATIVE_NET_PAY');
	});

	it('58. no effective rule for the period BLOCKS with MISSING_PAYROLL_RULE', async () => {
		const w = await world({ rule: { effectiveFrom: '2026-01-01' } });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.calculationStatus).toBe('BLOCKED');
		expect(codes(result)).toEqual(['MISSING_PAYROLL_RULE']);
		expect(result.items).toHaveLength(0);
	});

	it('59. WORKING_DAYS without a schedule BLOCKS with MISSING_SCHEDULE_FOR_WORKING_DAY', async () => {
		const w = await world({ rule: { prorationMethod: 'WORKING_DAYS' }, scheduleFrom: null });
		const { result } = await calcFor(w.companyId, w.emp.id);
		expect(result.calculationStatus).toBe('BLOCKED');
		expect(codes(result)).toContain('MISSING_SCHEDULE_FOR_WORKING_DAY');
	});

	it('60. missing compensation still BLOCKS; a company with NO rule keeps the Phase 11 engine (v1)', async () => {
		const noSalary = await world({ salary: null });
		const a = await calcFor(noSalary.companyId, noSalary.emp.id);
		expect(codes(a.result)).toContain('MISSING_COMPENSATION');
		const legacy = await world({ rule: false, start: '2025-09-16' });
		const b = await calcFor(legacy.companyId, legacy.emp.id);
		expect(b.result.calculationVersion).toBe(1);
		expect(codes(b.result)).toContain('EMPLOYEE_PARTIAL_PERIOD'); // Phase 11 behaviour is untouched
		expect((await get(`/payroll/runs/${b.runId}`, admin)).body.data.calculationVersion).toBe(1);
	});
});

// =============================================================================================
describe('finalization and immutability', () => {
	async function finalizedRun() {
		const w = await world({
			rule: {
				unpaidLeaveDeductionEnabled: true,
				lateDeductionEnabled: true,
				overtimeRules: OT_RULES
			}
		});
		await presentAll(w.emp.id, w.shiftId, START, END, ['2025-09-08'], {});
		await leave(w.companyId, w.emp.id, ['2025-09-08'], { isPaid: false });
		const ot = await overtime(w.emp.id, '2025-09-03', 'AFTER_SHIFT', 60);
		const { runId, result } = await calcFor(w.companyId, w.emp.id);
		expect(result.calculationStatus, JSON.stringify(result.issues)).toBe('READY');
		const fin = await finalize(runId, { expectedNetPay: result.netPay });
		expect(fin.status, JSON.stringify(fin.body)).toBe(200);
		return { ...w, runId, before: await outcome(runId, w.emp.id), ot };
	}

	it('61. finalization freezes the v2 results (segments, items, rule reference)', async () => {
		const f = await finalizedRun();
		const after = await outcome(f.runId, f.emp.id);
		expect(after.calculationVersion).toBe(2);
		expect(after.segments).toHaveLength(1);
		expect(after.netPay).toBe(f.before.netPay);
		expect(after.items.map((i) => i.source).sort()).toEqual(
			f.before.items.map((i) => i.source).sort()
		);
		const run = (await get(`/payroll/runs/${f.runId}`, admin)).body.data;
		expect(run.status).toBe('FINALIZED');
		expect(run.ruleSnapshot.version).toBe(1);
		expect(run.payrollRuleSetId).toBeTruthy();
		expect(
			await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: run.period.id } })
		).toMatchObject({
			status: 'CLOSED'
		});
	});

	it('62–65. later attendance / leave / OT / rule-version changes never alter a finalized run', async () => {
		const f = await finalizedRun();
		// attendance: a late record appears
		await prisma.attendanceRecord.update({
			where: { employeeId_workDate: { employeeId: f.emp.id, workDate: D('2025-09-03') } },
			data: { lateMinutes: 120, calculationStatus: 'LATE' }
		});
		// leave: another unpaid day
		await prisma.attendanceRecord.deleteMany({
			where: { employeeId: f.emp.id, workDate: D('2025-09-09') }
		});
		await leave(f.companyId, f.emp.id, ['2025-09-09'], { isPaid: false });
		// OT: eligible minutes change
		await prisma.overtimeRequest.update({ where: { id: f.ot.id }, data: { eligibleMinutes: 240 } });
		// a newer payroll rule version
		await mkRule(f.companyId, { effectiveFrom: '2025-10-01', prorationMethod: 'WORKING_DAYS' });
		const after = await outcome(f.runId, f.emp.id);
		expect(after.netPay).toBe(f.before.netPay);
		expect(after.items).toEqual(f.before.items);
		expect(after.segments).toEqual(f.before.segments);
		expect(after.ruleSnapshot).toEqual(f.before.ruleSnapshot);
		expect((await calculate(f.runId)).status).toBe(409);
		expect((await finalize(f.runId)).status).toBe(409);
	});

	it('66. a non-finalized run picks up a new payroll rule version on recalculation', async () => {
		const w = await world({
			rule: { effectiveFrom: '2025-01-01', absenceDeductionEnabled: false }
		});
		await presentAll(w.emp.id, w.shiftId, START, END, ['2025-09-08']);
		const first = await calcFor(w.companyId, w.emp.id);
		expect(item(first.result, 'ATTENDANCE_DEDUCTION')).toBeUndefined();
		await mkRule(w.companyId, { effectiveFrom: '2025-09-15', absenceDeductionEnabled: true });
		await calculate(first.runId);
		const after = await outcome(first.runId, w.emp.id);
		expect(amountOf(after, 'ATTENDANCE_DEDUCTION')).toBe('100000.00');
		expect(after.ruleSnapshot).toMatchObject({ version: 2 });
	});
});

// =============================================================================================
describe('security, audit and privacy', () => {
	it('67. MANAGER and EMPLOYEE roles cannot read or write payroll rules or results', async () => {
		const w = await world({ salary: '7654321' });
		const r = await calcFor(w.companyId, w.emp.id);
		for (const roleCode of ['MANAGER', 'EMPLOYEE']) {
			const u = await createTestUser({ roleCode });
			const cookie = await loginAndGetCookie(u.username, u.password);
			expect((await get('/payroll-rules', cookie)).status, roleCode).toBe(403);
			expect(
				(
					await post(
						'/payroll-rules',
						cookie,
						ruleBody(w.companyId, { effectiveFrom: '2030-01-01' })
					)
				).status,
				roleCode
			).toBe(403);
			expect((await get(`/payroll/results/${r.result.id}`, cookie)).status, roleCode).toBe(403);
		}
	});

	it('68. salary never leaks into employee / attendance / leave / OT / approval / notification APIs', async () => {
		const w = await world({ salary: '7654321', rule: { overtimeRules: OT_RULES } });
		await presentAll(w.emp.id, w.shiftId);
		await overtime(w.emp.id, '2025-09-03', 'AFTER_SHIFT', 60);
		await calcFor(w.companyId, w.emp.id);
		const paths = [
			`/employees?search=${w.emp.employeeCode}`,
			`/employees/${w.emp.id}`,
			`/employees/lookup?search=${w.emp.employeeCode}`,
			`/attendance/daily?date=2025-09-03&employeeId=${w.emp.id}`,
			`/leave/requests?employeeId=${w.emp.id}`,
			`/overtime/requests?employeeId=${w.emp.id}`,
			`/audit-events?employeeId=${w.emp.id}&pageSize=100`
		];
		for (const p of paths) {
			const res = await get(p, admin);
			expect(res.status, p).toBeLessThan(500);
			expect(JSON.stringify(res.body), p).not.toMatch(/7654321/);
			if (!p.startsWith('/audit-events')) {
				expect(JSON.stringify(res.body), p).not.toMatch(/baseSalary|netPay/i);
			}
		}
		expect(JSON.stringify(await prisma.notification.findMany())).not.toMatch(/7654321|PAYROLL/i);
	});

	it('69. the audit log records the rule creation but never an employee amount', async () => {
		const w = await world({
			salary: '7654321',
			rule: { unpaidLeaveDeductionEnabled: true, overtimeRules: OT_RULES }
		});
		await presentAll(w.emp.id, w.shiftId, START, END, ['2025-09-08']);
		await leave(w.companyId, w.emp.id, ['2025-09-08'], { isPaid: false });
		await overtime(w.emp.id, '2025-09-03', 'AFTER_SHIFT', 60);
		const { runId, result } = await calcFor(w.companyId, w.emp.id);
		await finalize(runId, { expectedNetPay: result.netPay });
		const rows = await prisma.auditEvent.findMany({
			where: { OR: [{ companyId: w.companyId }, { employeeId: w.emp.id }] }
		});
		expect(rows.some((r) => r.action === 'PAYROLL_RULE.CREATED')).toBe(true);
		const calculated = rows.filter((r) => r.action === 'PAYROLL.RUN_CALCULATED');
		expect(calculated.length).toBeGreaterThan(0);
		expect(calculated[0]!.metadataJson).toMatchObject({ calculationVersion: 2 });
		const text = JSON.stringify(rows);
		for (const money of [result.netPay, result.totalEarnings, result.totalDeductions, '7654321']) {
			if (money.length >= 5) expect(text, money).not.toContain(money.replace(/\.00$/, ''));
		}
	});

	it('70. no notification is created by rule creation, calculation or finalization', async () => {
		const before = await prisma.notification.count();
		const w = await world();
		await presentAll(w.emp.id, w.shiftId);
		const { runId, result } = await calcFor(w.companyId, w.emp.id);
		await finalize(runId, { expectedNetPay: result.netPay });
		expect(await prisma.notification.count()).toBe(before);
	});
});
