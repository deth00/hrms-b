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

/**
 * PHASE 12A.2 — OT rate basis correction for multi-cycle payroll. The OT minute rate must branch from
 * the employee's MONTHLY compensation effective on the OT's OWN work date — never the cycle-allocated
 * (Phase 12A.1) or segment-prorated (Phase 12A) amount. Payroll payment frequency (once vs. twice a
 * month) must never change an employee's OT rate; `monthlyDivisorDays` / `standardDailyMinutes` stay
 * monthly constants regardless of `paymentsPerMonth`.
 */
const uid = () => randomUUID().slice(0, 6).toUpperCase();
const get = (path: string, cookie: string) => agent().get(`/api/v1${path}`).set('Cookie', cookie);
const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const date = (iso: string) => new Date(`${iso}T00:00:00Z`);

let admin: string;
let actorUserId: string;
beforeAll(async () => {
	admin = await superAdminCookie();
	actorUserId = (await createTestUser()).user.id;
});

// =================================================================================================
// fixtures (same shape as tests/payrollMultiCycle.test.ts)
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
	const code = `OT_${uid()}`;
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

const OT_RULE = {
	overtimeType: 'AFTER_SHIFT',
	multiplier: '1.5',
	monthlyDivisorDays: 30,
	standardDailyMinutes: 480
};
async function ruleSet(companyId: string, extra: Record<string, unknown> = {}) {
	const res = await post('/payroll-rules', admin, {
		companyId,
		nameLao: 'ກົດທົດສອບ OT',
		effectiveFrom: '2020-01-01',
		prorationMethod: 'CALENDAR_DAYS',
		overtimeRules: [OT_RULE],
		...extra
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; version: number };
}
/** an APPROVED OvertimeRequest with a fixed eligibleMinutes, created directly (Phase 8 flow not driven) */
async function overtime(
	empId: string,
	workDate: string,
	eligible: number,
	o: { planned?: number; actual?: number; type?: string } = {}
) {
	return prisma.overtimeRequest.create({
		data: {
			employeeId: empId,
			workDate: date(workDate),
			type: (o.type ?? 'AFTER_SHIFT') as never,
			requestedStartAt: new Date(`${workDate}T18:00:00Z`),
			requestedEndAt: new Date(`${workDate}T20:00:00Z`),
			plannedMinutes: o.planned ?? eligible,
			reason: 'ທົດສອບ',
			status: 'APPROVED',
			requestedByUserId: actorUserId,
			isWorkingDay: true,
			actualMinutes: o.actual ?? eligible,
			eligibleMinutes: eligible,
			calculationStatus: 'CALCULATED',
			calculatedAt: new Date(),
			calculationVersion: 1
		}
	});
}

const scheduleBody = (companyId: string, extra: Record<string, unknown> = {}) => ({
	companyId,
	code: `SCH_${uid()}`,
	nameLao: 'ຮອບທົດສອບ OT',
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
	allocationMethod: 'EQUAL_SPLIT' | 'PERIOD_UNITS'
) {
	const res = await post(
		'/payroll-schedules',
		admin,
		scheduleBody(companyId, { monthlyAllocationMethod: allocationMethod })
	);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
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
}
async function cyclePeriods(scheduleId: string) {
	return prisma.payrollPeriod.findMany({
		where: { payrollScheduleId: scheduleId },
		orderBy: { cycleNumber: 'asc' }
	});
}
async function manualPeriod(companyId: string, start: string, end: string) {
	const res = await post('/payroll/periods', admin, {
		companyId,
		code: `MAN_${uid()}`,
		name: `Manual ${start}`,
		startDate: start,
		endDate: end,
		payDate: end
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
}
async function runFor(companyId: string, periodId: string) {
	const res = await post('/payroll/runs', admin, { companyId, periodId });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
}
async function calc(runId: string) {
	const res = await post(`/payroll/runs/${runId}/calculate`, admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as { id: string; calculationVersion: number };
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
		netPay: string;
		calculationStatus: 'READY' | 'BLOCKED';
		items: {
			id: string;
			code: string;
			source: string;
			amount: string;
			details: Record<string, unknown> | null;
		}[];
	};
}
async function finalize(runId: string, expectedNetPay?: string) {
	return post(`/payroll/runs/${runId}/finalize`, admin, expectedNetPay ? { expectedNetPay } : {});
}
const otItem = (d: Awaited<ReturnType<typeof resultDetail>>) =>
	d.items.find((i) => i.source === 'OVERTIME');
const otRequests = (d: Awaited<ReturnType<typeof resultDetail>>) =>
	(otItem(d)?.details?.requests ?? []) as Record<string, unknown>[];

// =================================================================================================
// 1: ONE/month unchanged
// =================================================================================================
describe('OT rate basis — ONE/month unchanged', () => {
	it('1. ONE/month OT is unchanged: 6,000,000 / 30 / 480 x 60 x 1.5 = 37,500', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await oneCycleSchedule(a);
		await generate(s.id, '2026-10');
		const [period] = await cyclePeriods(s.id);
		await overtime(emp.id, '2026-10-10', 60);
		const run = await runFor(a, period!.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(otItem(d)?.amount).toBe('37500.00');
	});
});

// =================================================================================================
// 2–3, 9–13: TWO/month EQUAL_SPLIT — OT rate independent of the cycle
// =================================================================================================
describe('OT rate basis — TWO/month EQUAL_SPLIT is cycle-independent', () => {
	it('2–3, 9–13. both cycles use the MONTHLY 6,000,000, not the 3,000,000 cycle base; eligibleMinutes only', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1, c2] = await cyclePeriods(s.id);
		// eligibleMinutes=60 but planned/actual are deliberately different (§9-10)
		await overtime(emp.id, '2026-10-10', 60, { planned: 999, actual: 5 });
		await overtime(emp.id, '2026-10-20', 60, { planned: 1, actual: 999 });

		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		const base1 = d1.items.find(
			(i) => i.source === 'PRORATED_BASE_SALARY' || i.source === 'BASE_SALARY'
		);
		expect(base1?.amount).toBe('3000000.00'); // cycle salary is still correctly halved
		expect(otItem(d1)?.amount).toBe('37500.00'); // OT uses the MONTHLY 6,000,000, not 3,000,000
		expect(otRequests(d1)[0]).toMatchObject({ eligibleMinutes: 60 });

		const run2 = await runFor(a, c2!.id);
		await calc(run2.id);
		const d2 = await resultDetail(run2.id, emp.id);
		expect(otItem(d2)?.amount).toBe('37500.00'); // same monthly salary, same rule -> SAME OT amount
	});
});

// =================================================================================================
// 4: PERIOD_UNITS — OT rate still uses the undivided monthly salary
// =================================================================================================
describe('OT rate basis — PERIOD_UNITS cycle salary differs but OT rate does not', () => {
	it('4. cycle salaries are 3,000,000 / 3,200,000 but OT in both cycles uses 6,200,000', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6200000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'PERIOD_UNITS');
		await generate(s.id, '2026-10'); // Oct 31 days: cycle1 15/31, cycle2 16/31
		const [c1, c2] = await cyclePeriods(s.id);
		await overtime(emp.id, '2026-10-05', 60);
		await overtime(emp.id, '2026-10-25', 60);

		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		const base1 = d1.items.find(
			(i) => i.source === 'PRORATED_BASE_SALARY' || i.source === 'BASE_SALARY'
		);
		expect(base1?.amount).toBe('3000000.00'); // 6,200,000 * 15/31
		// 6,200,000 / 30 / 480 * 60 * 1.5 = 38,750.00 (NOT based on 3,000,000)
		expect(otItem(d1)?.amount).toBe('38750.00');

		const run2 = await runFor(a, c2!.id);
		await calc(run2.id);
		const d2 = await resultDetail(run2.id, emp.id);
		const base2 = d2.items.find(
			(i) => i.source === 'PRORATED_BASE_SALARY' || i.source === 'BASE_SALARY'
		);
		expect(base2?.amount).toBe('3200000.00'); // 6,200,000 * 16/31
		expect(otItem(d2)?.amount).toBe('38750.00'); // identical OT rate basis
	});
});

// =================================================================================================
// 5: salary change BETWEEN cycles
// =================================================================================================
describe('OT rate basis — salary change between cycles', () => {
	it('5. cycle 1 OT uses the OLD monthly salary, cycle 2 OT uses the NEW one', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		expect((await setSalary(emp.id, '8000000', '2026-10-16')).status).toBe(201);
		const [c1, c2] = await cyclePeriods(s.id);
		await overtime(emp.id, '2026-10-10', 60);
		await overtime(emp.id, '2026-10-20', 60);

		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		expect(otItem(d1)?.amount).toBe('37500.00'); // 6,000,000 basis

		const run2 = await runFor(a, c2!.id);
		await calc(run2.id);
		const d2 = await resultDetail(run2.id, emp.id);
		expect(otItem(d2)?.amount).toBe('50000.00'); // 8,000,000 basis, never 3,000,000/4,000,000
	});
});

// =================================================================================================
// 6: salary change INSIDE a cycle
// =================================================================================================
describe('OT rate basis — salary change inside a cycle', () => {
	it('6. OT before the change uses the old salary, OT after uses the new salary, same run', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10'); // cycle2 = Oct16-31
		expect((await setSalary(emp.id, '8000000', '2026-10-24')).status).toBe(201);
		const [, c2] = await cyclePeriods(s.id);
		await overtime(emp.id, '2026-10-20', 60); // before the change
		await overtime(emp.id, '2026-10-28', 60); // after the change

		const run2 = await runFor(a, c2!.id);
		await calc(run2.id);
		const d2 = await resultDetail(run2.id, emp.id);
		const reqs = otRequests(d2);
		const before = reqs.find((r) => r.workDate === '2026-10-20');
		const after = reqs.find((r) => r.workDate === '2026-10-28');
		expect(before).toMatchObject({ monthlyBaseSalary: '6000000.00' });
		expect(after).toMatchObject({ monthlyBaseSalary: '8000000.00' });
		// 37,500 (old) + 50,000 (new) = 87,500.00
		expect(otItem(d2)?.amount).toBe('87500.00');
	});
});

// =================================================================================================
// 7: partial-period employee — OT rate not partialized
// =================================================================================================
describe('OT rate basis — a partial-period employee gets the full monthly OT rate', () => {
	it('7. hired mid-cycle: normal salary is prorated, OT rate is NOT', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a, '2026-10-08'); // hired 8 days into cycle 1 (Oct 1-15)
		await setSalary(emp.id, '6000000', '2026-10-08');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1] = await cyclePeriods(s.id);
		await overtime(emp.id, '2026-10-10', 60);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		const base1 = d1.items.find((i) => i.source === 'PRORATED_BASE_SALARY');
		expect(base1?.amount).toBe('1600000.00'); // 3,000,000 cycle base * 8/15 (employment proration)
		expect(otItem(d1)?.amount).toBe('37500.00'); // OT still uses the FULL 6,000,000 monthly rate
	});
});

// =================================================================================================
// 8: company transfer — historical compensation on the OT date
// =================================================================================================
describe('OT rate basis — company transfer resolves the historical monthly salary', () => {
	it('8. OT inside the OLD company period uses the OLD monthly salary, never the current one', async () => {
		const a = await newCompany();
		const b = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a, '2024-01-01');
		expect((await setSalary(emp.id, '5000000', '2024-01-01')).status).toBe(201);
		// transfers to company B on 2026-06-01, with a NEW (current) salary there
		await prisma.employeeAssignmentHistory.create({
			data: {
				employeeId: emp.id,
				companyId: a,
				effectiveFrom: date('2024-01-01'),
				effectiveTo: date('2026-06-01')
			}
		});
		await prisma.employeeAssignmentHistory.create({
			data: {
				employeeId: emp.id,
				companyId: b,
				effectiveFrom: date('2026-06-01'),
				effectiveTo: null
			}
		});
		await prisma.employee.update({ where: { id: emp.id }, data: { companyId: b } });
		expect((await setSalary(emp.id, '9000000', '2026-06-01')).status).toBe(201);

		// a manual period entirely BEFORE the transfer, in company A
		const period = await manualPeriod(a, '2026-03-01', '2026-03-31');
		await overtime(emp.id, '2026-03-10', 60);
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(otItem(d)?.amount).toBe('31250.00'); // 5,000,000 / 30 / 480 * 60 * 1.5 -- NOT 9,000,000
	});
});

// =================================================================================================
// 14: OT result item stores the full rate snapshot
// =================================================================================================
describe('OT result snapshot', () => {
	it('14. the OVERTIME item details carry the monthly salary / divisor / minutes / rate / multiplier used', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1] = await cyclePeriods(s.id);
		await overtime(emp.id, '2026-10-10', 60);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		expect(otRequests(d1)[0]).toMatchObject({
			monthlyBaseSalary: '6000000.00',
			monthlyDivisorDays: 30,
			standardDailyMinutes: 480,
			multiplier: '1.5000',
			eligibleMinutes: 60
		});
		expect(Number((otRequests(d1)[0] as { minuteRate: string }).minuteRate)).toBeCloseTo(
			6000000 / 30 / 480,
			6
		);
	});
});

// =================================================================================================
// 15–17: calculation version
// =================================================================================================
describe('calculation version', () => {
	it('17. a fresh multi-cycle calculation stamps calculationVersion = 4', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		const calculated = await calc(run1.id);
		expect(calculated.calculationVersion).toBe(4);
	});

	it('15. a FINALIZED run stamped v3 is never rewritten by any later calculate/finalize attempt', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		// simulate a historical v3 finalized run (pre-12A.2 data)
		await prisma.payrollRun.update({
			where: { id: run1.id },
			data: { calculationVersion: 3, status: 'FINALIZED', finalizedAt: new Date() }
		});
		await prisma.payrollPeriod.update({ where: { id: c1!.id }, data: { status: 'CLOSED' } });
		const recalc = await post(`/payroll/runs/${run1.id}/calculate`, admin);
		expect(recalc.status).toBe(409);
		const stored = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run1.id } });
		expect(stored.calculationVersion).toBe(3);
	});

	it('16. a NON-finalized run stamped v3 recalculates under the corrected v4 semantics', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1] = await cyclePeriods(s.id);
		await overtime(emp.id, '2026-10-10', 60);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		// simulate a historical, still-open v3 run
		await prisma.payrollRun.update({ where: { id: run1.id }, data: { calculationVersion: 3 } });
		const recalculated = await calc(run1.id);
		expect(recalculated.calculationVersion).toBe(4);
		const d1 = await resultDetail(run1.id, emp.id);
		expect(otItem(d1)?.amount).toBe('37500.00'); // corrected semantics applied on recalculation
	});
});

// =================================================================================================
// 18–20: privacy / permissions
// =================================================================================================
describe('security, audit and privacy', () => {
	it('18. audit events for the OT-bearing run carry no salary / rate values', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6741235', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1] = await cyclePeriods(s.id);
		await overtime(emp.id, '2026-10-10', 60);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		expect((await finalize(run1.id, d1.netPay)).status).toBe(200);
		const rows = await prisma.auditEvent.findMany({ where: { companyId: a } });
		const text = JSON.stringify(rows);
		for (const money of ['6741235', d1.netPay, otItem(d1)?.amount]) {
			if (money && money.length >= 5) expect(text, money).not.toContain(money.replace(/\.00$/, ''));
		}
	});

	it('19–20. MANAGER and EMPLOYEE cannot read the OT rate breakdown', async () => {
		const a = await newCompany();
		await ruleSet(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a, 'EQUAL_SPLIT');
		await generate(s.id, '2026-10');
		const [c1] = await cyclePeriods(s.id);
		await overtime(emp.id, '2026-10-10', 60);
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
});
