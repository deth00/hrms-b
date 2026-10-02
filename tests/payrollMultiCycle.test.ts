import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	agent,
	createTestCompany,
	createTestUser,
	loginAndGetCookie,
	superAdminCookie
} from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import { getPriorFinalizedPayrollCycles } from '../src/services/payrollMonthContext.service.js';

/**
 * PHASE 12A.1 — monthly salary allocation for multi-cycle (twice-monthly) payroll + statutory-month
 * foundation. `EmployeeCompensation.baseSalary` / `EmployeeRecurringPayComponent.amount` are MONTHLY
 * amounts; for a TWO/month schedule they must be split across cycle 1 / cycle 2 BEFORE any Phase 12A
 * employee-level segmentation / proration runs. PIT / Social Security are NOT implemented here.
 */
const uid = () => randomUUID().slice(0, 6).toUpperCase();
const get = (path: string, cookie: string) => agent().get(`/api/v1${path}`).set('Cookie', cookie);
const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const date = (iso: string) => new Date(`${iso}T00:00:00Z`);

let admin: string;
beforeAll(async () => {
	admin = await superAdminCookie();
});

// =================================================================================================
// fixtures
// =================================================================================================
async function newCompany() {
	const c = await createTestCompany();
	const res = await agent()
		.put(`/api/v1/payroll/settings?companyId=${c.id}`)
		.set('Cookie', admin)
		.send({ currencyCode: 'LAK' });
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return c.id;
}
async function simpleEmp(companyId: string, startDate = '2024-01-01') {
	const code = `MC_${uid()}`;
	return prisma.employee.create({
		data: {
			employeeCode: code,
			firstNameLao: 'ພະນັກງານ',
			lastNameLao: code,
			startDate: date(startDate),
			companyId
		}
	});
}
const setSalary = (empId: string, amount: string, from: string) =>
	post(`/employees/${empId}/compensation`, admin, { baseSalary: amount, effectiveFrom: from });
async function component(companyId: string, type: 'EARNING' | 'DEDUCTION' = 'EARNING') {
	const res = await post('/pay-components', admin, {
		companyId,
		code: `C_${uid()}`,
		nameLao: 'ເງິນອຸດໜູນ',
		type,
		category: type === 'EARNING' ? 'ALLOWANCE' : 'DEDUCTION'
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; code: string };
}
const assignRecurring = (empId: string, payComponentId: string, amount: string, from: string) =>
	post(`/employees/${empId}/recurring-pay-components`, admin, {
		payComponentId,
		amount,
		effectiveFrom: from
	});

const scheduleBody = (companyId: string, extra: Record<string, unknown> = {}) => ({
	companyId,
	code: `SCH_${uid()}`,
	nameLao: 'ຮອບທົດສອບ',
	payBasis: 'MONTHLY',
	paymentsPerMonth: 'TWO',
	splitDay: 15,
	anchorDate: '2020-01-01',
	payDateRule: 'PERIOD_END',
	employeeScope: 'ALL',
	...extra
});
async function twoCycleSchedule(
	companyId: string,
	allocationMethod: 'EQUAL_SPLIT' | 'PERIOD_UNITS' | null,
	extra: Record<string, unknown> = {}
) {
	const res = await post(
		'/payroll-schedules',
		admin,
		scheduleBody(companyId, { monthlyAllocationMethod: allocationMethod, ...extra })
	);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; code: string };
}
async function oneCycleSchedule(companyId: string) {
	const res = await post(
		'/payroll-schedules',
		admin,
		scheduleBody(companyId, {
			paymentsPerMonth: 'ONE',
			splitDay: null,
			monthlyAllocationMethod: null
		})
	);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
}
async function generate(scheduleId: string, month: string) {
	const res = await post(`/payroll-schedules/${scheduleId}/generate-periods`, admin, {
		fromMonth: month,
		toMonth: month
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as { createdCount: number };
}
async function cyclePeriods(scheduleId: string) {
	return prisma.payrollPeriod.findMany({
		where: { payrollScheduleId: scheduleId },
		orderBy: { cycleNumber: 'asc' }
	});
}
async function runFor(companyId: string, periodId: string) {
	const res = await post('/payroll/runs', admin, { companyId, periodId });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
}
async function calc(runId: string) {
	const res = await post(`/payroll/runs/${runId}/calculate`, admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as {
		id: string;
		calculationVersion: number;
		cycleAllocation: {
			payrollMonth: string | null;
			cycleNumber: number | null;
			paymentsPerMonth: string | null;
			monthlyAllocationMethod: string | null;
			monthlyAllocationFactor: string | null;
		};
	};
}
async function resultRow(runId: string, empId: string) {
	const res = await get(`/payroll/runs/${runId}/results?pageSize=100`, admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	const rows = res.body.data.items as { id: string; employee: { id: string } }[];
	return rows.find((r) => r.employee.id === empId)!;
}
async function resultDetail(runId: string, empId: string) {
	const row = await resultRow(runId, empId);
	const res = await get(`/payroll/results/${row.id}`, admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as {
		id: string;
		baseSalary: string;
		monthlyBaseSalary: string | null;
		cycleAllocationFactor: string | null;
		totalEarnings: string;
		totalDeductions: string;
		netPay: string;
		calculationStatus: 'READY' | 'BLOCKED';
		issues: { code: string }[];
		items: { code: string; source: string; amount: string; type: string }[];
		segments: {
			baseSalary: string;
			proratedBaseSalary: string;
			payableUnits: string;
			periodUnits: string;
		}[];
		run: { cycleAllocation: { cycleNumber: number | null; paymentsPerMonth: string | null } };
	};
}
async function finalize(runId: string, expectedNetPay?: string) {
	return post(`/payroll/runs/${runId}/finalize`, admin, expectedNetPay ? { expectedNetPay } : {});
}
async function ruleSet(companyId: string, extra: Record<string, unknown> = {}) {
	const res = await post('/payroll-rules', admin, {
		companyId,
		nameLao: 'ກົດທົດສອບ',
		effectiveFrom: '2020-01-01',
		prorationMethod: 'CALENDAR_DAYS',
		...extra
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; version: number };
}

// =================================================================================================
// 1–3: monthly compensation semantics
// =================================================================================================
describe('monthly compensation semantics', () => {
	it('1. ONE/month: the full monthly salary is unchanged', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '5000000', '2026-01-01');
		const s = await oneCycleSchedule(a);
		await generate(s.id, '2026-10');
		const [period] = await cyclePeriods(s.id);
		const run = await runFor(a, period!.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.baseSalary).toBe('5000000.00');
		expect(d.netPay).toBe('5000000.00');
	});

	it('2–3. TWO EQUAL_SPLIT: each cycle gets 50%, and the two cycles sum EXACTLY to the monthly salary', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1, c2] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		const run2 = await runFor(a, c2!.id);
		await calc(run1.id);
		await calc(run2.id);
		const d1 = await resultDetail(run1.id, emp.id);
		const d2 = await resultDetail(run2.id, emp.id);
		expect(d1.baseSalary).toBe('3000000.00');
		expect(d2.baseSalary).toBe('3000000.00');
		expect(Number(d1.baseSalary) + Number(d2.baseSalary)).toBeCloseTo(6000000, 5);
		expect((Number(d1.baseSalary) + Number(d2.baseSalary)).toFixed(2)).toBe('6000000.00');
	});

	it('4–5. monthly recurring component splits the same way and totals the configured value', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const house = await component(a, 'EARNING');
		expect((await assignRecurring(emp.id, house.id, '1000000', '2026-01-01')).status).toBe(201);
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1, c2] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		const run2 = await runFor(a, c2!.id);
		await calc(run1.id);
		await calc(run2.id);
		const d1 = await resultDetail(run1.id, emp.id);
		const d2 = await resultDetail(run2.id, emp.id);
		const rec1 = d1.items.find((i) => i.code === house.code)!;
		const rec2 = d2.items.find((i) => i.code === house.code)!;
		expect(rec1.amount).toBe('500000.00');
		expect(rec2.amount).toBe('500000.00');
		expect((Number(rec1.amount) + Number(rec2.amount)).toFixed(2)).toBe('1000000.00');
		// combined base + recurring per cycle, and the whole month
		expect(d1.baseSalary).toBe('3000000.00');
		expect((Number(d1.totalEarnings) + Number(d2.totalEarnings)).toFixed(2)).toBe('7000000.00');
	});
});

// =================================================================================================
// 6–8: PERIOD_UNITS, leap February, rounding residual
// =================================================================================================
describe('PERIOD_UNITS cycle allocation and rounding', () => {
	it('6. PERIOD_UNITS: October (31 days) splits 15/31 + 16/31', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6200000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'PERIOD_UNITS');
		await generate(s.id, '2026-10');
		const [c1, c2] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		const run2 = await runFor(a, c2!.id);
		await calc(run1.id);
		await calc(run2.id);
		const d1 = await resultDetail(run1.id, emp.id);
		const d2 = await resultDetail(run2.id, emp.id);
		expect(d1.baseSalary).toBe('3000000.00');
		expect(d2.baseSalary).toBe('3200000.00');
		expect((Number(d1.baseSalary) + Number(d2.baseSalary)).toFixed(2)).toBe('6200000.00');
	});

	it('7. leap February (2028, 29 days): PERIOD_UNITS splits 15/29 + 14/29 exactly', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a, '2026-01-01');
		await setSalary(emp.id, '2900000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'PERIOD_UNITS');
		await generate(s.id, '2028-02');
		const [c1, c2] = await cyclePeriods(s.id);
		expect(c1!.endDate.getUTCDate()).toBe(15);
		expect(c2!.endDate.getUTCDate()).toBe(29); // 2028 is a leap year
		const run1 = await runFor(a, c1!.id);
		const run2 = await runFor(a, c2!.id);
		await calc(run1.id);
		await calc(run2.id);
		const d1 = await resultDetail(run1.id, emp.id);
		const d2 = await resultDetail(run2.id, emp.id);
		expect(d1.baseSalary).toBe('1500000.00'); // 2,900,000 * 15/29
		expect(d2.baseSalary).toBe('1400000.00'); // 2,900,000 * 14/29
		expect((Number(d1.baseSalary) + Number(d2.baseSalary)).toFixed(2)).toBe('2900000.00');
	});

	it('8. rounding residual: an odd-cent monthly salary still sums EXACTLY across both cycles', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000.01', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1, c2] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		const run2 = await runFor(a, c2!.id);
		await calc(run1.id);
		await calc(run2.id);
		const d1 = await resultDetail(run1.id, emp.id);
		const d2 = await resultDetail(run2.id, emp.id);
		expect((Number(d1.baseSalary) + Number(d2.baseSalary)).toFixed(2)).toBe('6000000.01');
		// residual assigned to the LAST cycle
		expect(d1.baseSalary).toBe('3000000.01');
		expect(d2.baseSalary).toBe('3000000.00');
	});
});

// =================================================================================================
// 9–12: salary/recurring changes, and proration order
// =================================================================================================
describe('salary changes and proration order', () => {
	it('9. salary change landing exactly on the cycle boundary is NOT averaged', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		expect((await setSalary(emp.id, '8000000', '2026-10-16')).status).toBe(201);
		const [c1, c2] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		const run2 = await runFor(a, c2!.id);
		await calc(run1.id);
		await calc(run2.id);
		const d1 = await resultDetail(run1.id, emp.id);
		const d2 = await resultDetail(run2.id, emp.id);
		expect(d1.baseSalary).toBe('3000000.00'); // old 6,000,000 * 0.5
		expect(d2.baseSalary).toBe('4000000.00'); // new 8,000,000 * 0.5 (never 3,500,000 averaged)
	});

	it('10. salary change INSIDE a cycle is still segmented/prorated on top of the cycle base', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-11'); // Nov: cycle1 1-15 (15d), cycle2 16-30 (15d)
		expect((await setSalary(emp.id, '8000000', '2026-11-24')).status).toBe(201);
		const [, c2] = await cyclePeriods(s.id);
		const run2 = await runFor(a, c2!.id);
		await calc(run2.id);
		const d2 = await resultDetail(run2.id, emp.id);
		expect(d2.calculationStatus).toBe('READY');
		expect(d2.segments).toHaveLength(2);
		const [seg1, seg2] = [...d2.segments].sort(
			(x, y) => Number(x.periodUnits) - Number(y.periodUnits) || 0
		);
		void seg1;
		// each segment's OWN base is the CYCLE-allocated amount (3,000,000 / 4,000,000), not the raw
		// monthly amount (6,000,000 / 8,000,000)
		const bases = d2.segments.map((s2) => s2.baseSalary).sort();
		expect(bases).toEqual(['3000000.00', '4000000.00']);
		// 3,000,000 * 8/15 + 4,000,000 * 7/15 = 1,600,000.00 + 1,866,666.67
		expect(d2.baseSalary).toBe('4000000.00'); // snapshot = the LAST segment's cycle base
		const proratedItem = d2.items.find((i) => i.source === 'PRORATED_BASE_SALARY');
		expect(proratedItem?.amount).toBe('3466666.67');
		void seg2;
	});

	it('11. a recurring-component change INSIDE a cycle is segmented on top of the cycle base', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const house = await component(a, 'EARNING');
		expect((await assignRecurring(emp.id, house.id, '1000000', '2026-01-01')).status).toBe(201);
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-12'); // Dec: cycle1 1-15 (15d, NOT last), cycle2 16-31 (16d, last)
		expect((await assignRecurring(emp.id, house.id, '2000000', '2026-12-10')).status).toBe(201);
		const [c1] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		const recItems = d1.items.filter((i) => i.code === house.code);
		// 500,000 * 9/15 + 1,000,000 * 6/15 = 300,000 + 400,000 = 700,000.00
		const total = recItems.reduce((n, i) => n + Number(i.amount), 0);
		expect(total.toFixed(2)).toBe('700000.00');
	});

	it('12. Phase 12A employee-period proration is applied AFTER cycle allocation, never before', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a, '2026-10-08'); // hired mid cycle 1
		await setSalary(emp.id, '6000000', '2026-10-08');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10'); // cycle1 = Oct 1-15 (15 days)
		const [c1] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		// cycle base = 6,000,000 * 0.5 = 3,000,000 (NOT the raw 6,000,000)
		expect(d1.segments[0]?.baseSalary).toBe('3000000.00');
		// employee covers Oct 8-15 = 8 of the cycle's 15 days: 3,000,000 * 8/15 = 1,600,000.00
		// (if cycle allocation were applied AFTER proration, or skipped, this would be 3,200,000.00)
		expect(d1.segments[0]?.proratedBaseSalary).toBe('1600000.00');
		const item = d1.items.find((i) => i.source === 'PRORATED_BASE_SALARY');
		expect(item?.amount).toBe('1600000.00');
	});
});

// =================================================================================================
// 13: manual adjustments stay per-run
// =================================================================================================
describe('manual adjustments are never split', () => {
	it('13. a manual adjustment is applied in FULL to the cycle it was added to', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const row = await resultRow(run1.id, emp.id);
		const adj = await post(`/payroll/runs/${run1.id}/employees/${emp.id}/adjustments`, admin, {
			type: 'EARNING',
			code: 'BONUS_TEST',
			nameLao: 'ໂບນັດ',
			amount: '100000',
			reason: 'ໂບນັດພິເສດສຳລັບການທົດສອບ'
		});
		expect(adj.status, JSON.stringify(adj.body)).toBe(201);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		const manual = d1.items.find((i) => i.code === 'BONUS_TEST');
		expect(manual?.amount).toBe('100000.00'); // never halved
		void row;
	});
});

// =================================================================================================
// 14–15: cycle snapshots and calculationVersion
// =================================================================================================
describe('cycle allocation snapshots', () => {
	it('14–15. the run stores payrollMonth / cycle / method / factor, and calculationVersion = 4 (Phase 12A.2 supersedes 3)', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1, c2] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		const run2 = await runFor(a, c2!.id);
		const calc1 = await calc(run1.id);
		const calc2 = await calc(run2.id);
		expect(calc1.calculationVersion).toBe(4);
		expect(calc2.calculationVersion).toBe(4);
		expect(calc1.cycleAllocation).toMatchObject({
			payrollMonth: '2026-10',
			cycleNumber: 1,
			paymentsPerMonth: 'TWO',
			monthlyAllocationMethod: 'EQUAL_SPLIT'
		});
		expect(Number(calc1.cycleAllocation.monthlyAllocationFactor)).toBeCloseTo(0.5, 9);
		expect(calc2.cycleAllocation.cycleNumber).toBe(2);
		// stored on the DB row directly, independent of a later schedule edit
		const stored = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run1.id } });
		expect(stored.payrollMonth).toBe('2026-10');
		expect(stored.cycleNumber).toBe(1);
	});
});

// =================================================================================================
// 16–18: old v1 / v2 behaviour is unchanged
// =================================================================================================
describe('backward compatibility — v1 / v2 payroll unchanged', () => {
	it('16. a ONE/month run with NO rule set keeps calculationVersion 1 and the Phase 11 formula', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '5200000', '2026-01-01');
		const s = await oneCycleSchedule(a);
		await generate(s.id, '2026-10');
		const [period] = await cyclePeriods(s.id);
		const run = await runFor(a, period!.id);
		const calculated = await calc(run.id);
		expect(calculated.calculationVersion).toBe(1);
		const d = await resultDetail(run.id, emp.id);
		expect(d.baseSalary).toBe('5200000.00');
		expect(d.netPay).toBe('5200000.00');
		expect(await finalize(run.id, d.netPay).then((r) => r.status)).toBe(200);
	});

	it('17. a ONE/month run WITH a rule set keeps calculationVersion 2 unchanged', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '5300000', '2026-01-01');
		const s = await oneCycleSchedule(a);
		await generate(s.id, '2026-10');
		const [period] = await cyclePeriods(s.id);
		const run = await runFor(a, period!.id);
		const calculated = await calc(run.id);
		expect(calculated.calculationVersion).toBe(2);
		const d = await resultDetail(run.id, emp.id);
		expect(d.baseSalary).toBe('5300000.00');
	});

	it('18. existing ONE/month results (base + recurring, manual period) are byte-for-byte unchanged', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '5000000', '2026-01-01');
		const house = await component(a, 'EARNING');
		const loan = await component(a, 'DEDUCTION');
		await assignRecurring(emp.id, house.id, '500000', '2026-01-01');
		await assignRecurring(emp.id, loan.id, '300000', '2026-01-01');
		const manual = await post('/payroll/periods', admin, {
			companyId: a,
			code: `MAN_${uid()}`,
			name: 'Manual Oct 2026',
			startDate: '2026-10-01',
			endDate: '2026-10-31',
			payDate: '2026-10-31'
		});
		expect(manual.status).toBe(201);
		const run = await runFor(a, manual.body.data.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.baseSalary).toBe('5000000.00');
		expect(d.totalEarnings).toBe('5500000.00');
		expect(d.totalDeductions).toBe('300000.00');
		expect(d.netPay).toBe('5200000.00');
	});
});

// =================================================================================================
// 19–20: finalization order + prior-cycle resolver
// =================================================================================================
describe('cycle finalization order', () => {
	it('19. cycle 2 cannot finalize before cycle 1; cycle 1 finalizes normally and unblocks cycle 2', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1, c2] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		const run2 = await runFor(a, c2!.id);
		await calc(run1.id);
		await calc(run2.id);
		const before = await finalize(run2.id);
		expect(before.status, JSON.stringify(before.body)).toBe(409);
		expect(before.body.error?.code ?? before.body.code).toBe('PRIOR_PAYROLL_CYCLE_NOT_FINALIZED');
		const d1 = await resultDetail(run1.id, emp.id);
		const ok1 = await finalize(run1.id, d1.netPay);
		expect(ok1.status, JSON.stringify(ok1.body)).toBe(200);
		const d2 = await resultDetail(run2.id, emp.id);
		const ok2 = await finalize(run2.id, d2.netPay);
		expect(ok2.status, JSON.stringify(ok2.body)).toBe(200);
	});

	it('19b. cycle 1 finalizes normally without cycle 2 ever existing', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		const res = await post(`/payroll-schedules/${s.id}/generate-periods`, admin, {
			fromMonth: '2026-10',
			toMonth: '2026-10'
		});
		expect(res.status).toBe(200);
		const [c1] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		expect((await finalize(run1.id, d1.netPay)).status).toBe(200);
	});

	it('20. getPriorFinalizedPayrollCycles returns cycle 1 once finalized, and nothing before that', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1, c2] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		const run2 = await runFor(a, c2!.id);
		await calc(run1.id);
		await calc(run2.id);
		const beforeFinalize = await getPriorFinalizedPayrollCycles(
			prisma,
			a,
			s.id,
			'2026-10',
			2,
			emp.id
		);
		expect(beforeFinalize).toHaveLength(0);
		const d1 = await resultDetail(run1.id, emp.id);
		expect((await finalize(run1.id, d1.netPay)).status).toBe(200);
		const afterFinalize = await getPriorFinalizedPayrollCycles(
			prisma,
			a,
			s.id,
			'2026-10',
			2,
			emp.id
		);
		expect(afterFinalize).toHaveLength(1);
		expect(afterFinalize[0]!.cycleNumber).toBe(1);
		expect(afterFinalize[0]!.results[0]!.employeeId).toBe(emp.id);
		expect(afterFinalize[0]!.results[0]!.totalEarnings.toFixed(2)).toBe('3000000.00');
	});
});

// =================================================================================================
// 5 (§5 block) and security / audit
// =================================================================================================
describe('unconfigured allocation method blocks calculation', () => {
	it('an existing TWO/month schedule with monthlyAllocationMethod = null BLOCKS every employee', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, null);
		await generate(s.id, '2026-10');
		const [c1] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		expect(d1.calculationStatus).toBe('BLOCKED');
		expect(d1.issues.map((i) => i.code)).toContain('PAYROLL_CYCLE_ALLOCATION_REQUIRED');
		expect(d1.netPay).toBe('0.00');
	});
});

describe('security, audit and privacy', () => {
	it('21. MANAGER and EMPLOYEE cannot read the multi-cycle run / result', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '7412583', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const row = await resultRow(run1.id, emp.id);
		for (const roleCode of ['MANAGER', 'EMPLOYEE']) {
			const u = await createTestUser({ roleCode });
			const cookie = await loginAndGetCookie(u.username, u.password);
			expect((await get(`/payroll/runs/${run1.id}`, cookie)).status, roleCode).toBe(403);
			expect((await get(`/payroll/results/${row.id}`, cookie)).status, roleCode).toBe(403);
		}
	});

	it('22. the distinctive monthly salary never leaks into employee / attendance / leave / OT APIs', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '7412583', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const paths = [
			`/employees?search=${emp.employeeCode}`,
			`/employees/${emp.id}`,
			`/employees/lookup?search=${emp.employeeCode}`,
			`/leave/requests?employeeId=${emp.id}`,
			`/overtime/requests?employeeId=${emp.id}`
		];
		for (const p of paths) {
			const res = await get(p, admin);
			expect(res.status, p).toBeLessThan(500);
			expect(JSON.stringify(res.body), p).not.toMatch(/7412583/);
		}
	});

	it('23. audit events for the multi-cycle run carry payrollMonth / cycle context but NO money', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '7412583', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		expect((await finalize(run1.id, d1.netPay)).status).toBe(200);
		const rows = await prisma.auditEvent.findMany({ where: { companyId: a } });
		const calculated = rows.filter((r) => r.action === 'PAYROLL.RUN_CALCULATED');
		expect(calculated.length).toBeGreaterThan(0);
		expect(calculated[0]!.metadataJson).toMatchObject({
			calculationVersion: 4,
			payrollMonth: '2026-10',
			cycleNumber: 1
		});
		const text = JSON.stringify(rows);
		for (const money of ['7412583', d1.netPay, d1.totalEarnings, d1.totalDeductions]) {
			if (money.length >= 5) expect(text, money).not.toContain(money.replace(/\.00$/, ''));
		}
	});
});
