import { beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import { linkedUser, setupPhase13 } from './phase13Fixture.js';
import { ACCT } from './phase14Fixture.js';
import { retryOk, reverse, validateAndExport } from './phase15Fixture.js';
import {
	accrualOk,
	confirmPaid,
	confirmFailed,
	createReversal,
	ctx,
	get,
	isolateFixtureNotifications,
	journalOf,
	payOk,
	paymentWorld,
	payrollFingerprint,
	payrollWorld,
	post,
	postJ,
	postedOk,
	settlementOk,
	validateJ
} from './phase16Fixture.js';
import { MONEY } from './phase17Fixture.js';

/**
 * Phase 17A — the SENSITIVE summary reports (payroll / payments / accounting) and their dashboard
 * widgets (tests 67–90). Worlds come from the Phase 13–16 fixtures: a FINALIZED manual run for
 * Sep 2025 (payroll month "2025-09"), payment batches with retries / reversals, Phase 16 journals.
 */
isolateFixtureNotifications();

const Dec = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
type Money = Record<string, string | number | boolean | null>;
interface Summary {
	context: Record<string, unknown>;
	totals: Money;
	groups: { key: string; code: string | null; label: string; metrics: Money }[];
	runs?: { id: string; employeeCount: number }[];
}
const summary = async (kind: string, params: string, cookie = ctx.admin) => {
	const res = await get(`/reports/${kind}/summary?${params}`, cookie);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as Summary;
};

let P: Awaited<ReturnType<typeof payrollWorld>>;
let manager: { cookie: string };

beforeAll(async () => {
	await setupPhase13();
	P = await payrollWorld({ employees: 2, org: true });
	manager = await linkedUser('MANAGER');
}, 180_000);

async function dbTotals(runId: string) {
	const rows = await prisma.payrollEmployeeResult.findMany({
		where: { payrollRunId: runId },
		include: { statutoryResult: true }
	});
	const sum = (f: (r: (typeof rows)[number]) => Prisma.Decimal.Value) =>
		rows.reduce((s, r) => s.plus(f(r)), Dec(0)).toFixed(2);
	return {
		grossEarnings: sum((r) => r.totalEarnings),
		totalDeductions: sum((r) => r.totalDeductions),
		netPay: sum((r) => r.netPay),
		pit: sum((r) => r.statutoryResult?.pitCurrentCycle ?? 0),
		employeeSso: sum((r) => r.statutoryResult?.employeeSsoCurrentCycle ?? 0),
		employerSso: sum((r) => r.statutoryResult?.employerSsoCurrentCycle ?? 0)
	};
}

// =====================================================================================
// 67–79 payroll report
// =====================================================================================
describe('payroll summary report', () => {
	it('67. uses the FINALIZED stored result of the payroll month (a DRAFT run elsewhere is ignored)', async () => {
		const r = await summary('payroll', `companyId=${P.companyId}&groupBy=none`);
		expect(r.context).toMatchObject({
			payrollMonth: '2025-09',
			source: 'FINALIZED_PAYROLL_SNAPSHOT',
			currencyCode: 'LAK'
		});
		expect(r.runs!.map((x) => x.id)).toEqual([P.runId]);
		// a DRAFT run of another month is not a finalized payroll
		const period = await post('/payroll/periods', ctx.admin, {
			companyId: P.companyId,
			code: `DRAFT_${Date.now()}`,
			name: 'ງວດ DRAFT',
			startDate: '2025-10-01',
			endDate: '2025-10-31',
			payDate: '2025-10-31'
		});
		expect(period.status, JSON.stringify(period.body)).toBe(201);
		expect(
			(
				await post('/payroll/runs', ctx.admin, {
					companyId: P.companyId,
					periodId: period.body.data.id
				})
			).status
		).toBe(201);
		const oct = await summary(
			'payroll',
			`companyId=${P.companyId}&payrollMonth=2025-10&groupBy=none`
		);
		expect(oct.totals).toMatchObject({ employeeCount: 0, netPay: '0.00' });
		expect(oct.runs).toEqual([]);
	}, 60_000);

	it('68. no payroll recalculation — the payroll snapshot is byte-identical before and after', async () => {
		const before = await payrollFingerprint(P.runId);
		await summary('payroll', `companyId=${P.companyId}`);
		await summary('payroll', `companyId=${P.companyId}&groupBy=branch`);
		expect(await payrollFingerprint(P.runId)).toBe(before);
	});

	it('69–75. employee count, gross, deductions, PIT, employee / employer SSO and net equal the stored results', async () => {
		const r = await summary('payroll', `companyId=${P.companyId}&groupBy=none`);
		const db = await dbTotals(P.runId);
		expect(r.totals).toMatchObject({
			employeeCount: 2,
			resultCount: 2,
			...db,
			resultsWithoutStatutory: 0
		});
		expect(Dec(r.totals.pit as string).greaterThan(0)).toBe(true);
		expect(Dec(r.totals.employerSso as string).greaterThan(0)).toBe(true);
	});

	it('76. every money value is a fixed-2 decimal string', async () => {
		const r = await summary('payroll', `companyId=${P.companyId}&groupBy=department`);
		for (const m of [r.totals, ...r.groups.map((g) => g.metrics)]) {
			for (const k of [
				'grossEarnings',
				'totalDeductions',
				'pit',
				'employeeSso',
				'employerSso',
				'netPay'
			]) {
				expect(m[k], k).toMatch(MONEY);
			}
		}
	});

	it('77. grouping uses the historical org SNAPSHOT, not today’s assignment', async () => {
		const before = await summary('payroll', `companyId=${P.companyId}&groupBy=branch`);
		const snaps = await prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: P.runId },
			select: { branchIdSnapshot: true }
		});
		expect(before.groups.map((g) => g.key).sort()).toEqual(
			snaps.map((x) => String(x.branchIdSnapshot)).sort()
		);
		// move employee 0 to the other branch today
		await prisma.employee.update({
			where: { id: P.emps[0]!.id },
			data: { branchId: P.units!.branches[1]!.id, departmentId: P.units!.departments[1]!.id }
		});
		const after = await summary('payroll', `companyId=${P.companyId}&groupBy=branch`);
		expect(after.groups).toEqual(before.groups);
		// the snapshot branch filter still finds the employee in its OLD branch
		const b0 = await summary(
			'payroll',
			`companyId=${P.companyId}&branchId=${P.units!.branches[0]!.id}&groupBy=none`
		);
		expect(b0.totals.employeeCount).toBe(1);
	});

	it('78. a manager is forbidden (no payroll through reporting)', async () => {
		const res = await get(`/reports/payroll/summary?companyId=${P.companyId}`, manager.cookie);
		expect(res.status).toBe(403);
		const d = await get('/dashboard/summary', manager.cookie);
		expect(d.body.data.payroll).toBeNull();
	});

	it('79. a later salary change does not move the historical report', async () => {
		const before = await summary('payroll', `companyId=${P.companyId}&groupBy=none`);
		const c = await post(`/employees/${P.emps[0]!.id}/compensation`, ctx.admin, {
			baseSalary: '9900000',
			effectiveFrom: '2025-11-01'
		});
		expect(c.status, JSON.stringify(c.body)).toBe(201);
		const after = await summary('payroll', `companyId=${P.companyId}&groupBy=none`);
		expect(after.totals).toEqual(before.totals);
	});

	it('— companyId is required for money reports (currencies are never mixed)', async () => {
		const res = await get('/reports/payroll/summary', ctx.admin);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('REPORT_FILTER_REQUIRED');
	});

	it('— dashboard payroll widget: operational counts only, no amounts', async () => {
		const d = (await get(`/dashboard/summary?companyId=${P.companyId}`, ctx.admin)).body.data;
		expect(d.payroll).toMatchObject({
			latestFinalizedMonth: '2025-09',
			finalizedEmployees: 2,
			runs: { finalized: 1, draft: 1, needsCalculation: 1 }
		});
		expect(JSON.stringify(d.payroll)).not.toMatch(/netPay|gross|salary|amount/i);
	});
});

// =====================================================================================
// 80–85 payments report
// =====================================================================================
describe('payment summary report', () => {
	let W: Awaited<ReturnType<typeof paymentWorld>>;
	let paidRefs: string[] = [];
	beforeAll(async () => {
		W = await paymentWorld({ employees: 3 });
		const [i0, i1, i2] = W.items;
		const r0 = await confirmPaid(W.batchId, i0!.id, 'QA-PAYREF-000');
		expect(r0.status, JSON.stringify(r0.body)).toBe(200);
		expect((await confirmFailed(W.batchId, i1!.id)).status).toBe(200);
		const retry = await retryOk(W.batchId, [i1!.id]);
		await validateAndExport(retry.id, W.bankProfileId);
		await payOk(retry.id, retry.items[0]!.id);
		await payOk(W.batchId, i2!.id);
		expect((await reverse(W.batchId, i2!.id)).status).toBe(200);
		paidRefs = ['QA-PAYREF-000', 'QA-REV-001'];
	}, 240_000);

	it('80–83. settlement follows the lineage: PAID, retry-PAID counted once, REVERSED latest', async () => {
		const r = await summary('payments', `companyId=${W.companyId}&groupBy=none`);
		expect(r.context).toMatchObject({
			payrollMonth: '2025-09',
			source: 'PAYMENT_OBLIGATION_RESOLVER'
		});
		expect(r.totals).toMatchObject({
			obligations: 3, // original FAILED + retry PAID is ONE obligation
			paid: 2,
			failed: 0,
			reversed: 1,
			inProgress: 0,
			unpaid: 0,
			retried: 1
		});
		const net = W.items.map((i) => Dec(i.amount));
		expect(r.totals.paidAmount).toBe(net[0]!.plus(net[1]!).toFixed(2));
		expect(r.totals.outstandingAmount).toBe(net[2]!.toFixed(2));
		expect(r.totals.paidAmount).toMatch(MONEY);
	});

	it('84–85. no bank account, account digits or bank / payment reference in the response', async () => {
		const text = JSON.stringify(await summary('payments', `companyId=${W.companyId}&groupBy=run`));
		expect(text).not.toContain(ACCT);
		expect(text).not.toContain(ACCT.slice(-4) + '"');
		for (const ref of paidRefs) expect(text).not.toContain(ref);
		expect(text).not.toMatch(
			/account|bankReference|paymentReference|transferReference|instruction/i
		);
	});

	it('— dashboard payments widget: counts only', async () => {
		const d = (await get(`/dashboard/summary?companyId=${W.companyId}`, ctx.admin)).body.data;
		expect(d.payments).toEqual({
			payrollMonth: '2025-09',
			obligations: 3,
			paid: 2,
			failed: 0,
			reversed: 1,
			inProgress: 0,
			unpaid: 0,
			retried: 1
		});
	});

	it('— accounting pending work: PAID but unaccounted items (settlement key semantics)', async () => {
		const before = await summary('accounting', `companyId=${W.companyId}`);
		expect(before.totals.pendingSettlement).toBe(2); // item 0 + the retry item (item 2 was reversed)
		await settlementOk(W.batchId); // accounts item 0 of the original batch
		const after = await summary('accounting', `companyId=${W.companyId}`);
		expect(after.totals.pendingSettlement).toBe(1);
		expect(after.totals.draft).toBe(1);
	}, 60_000);
});

// =====================================================================================
// 86–90 accounting report
// =====================================================================================
describe('accounting summary report', () => {
	it('86–87. journal status counts; posted totals are the journals’ own stored totals', async () => {
		const j = await accrualOk(P.runId);
		let r = await summary('accounting', `companyId=${P.companyId}`);
		expect(r.totals).toMatchObject({
			draft: 1,
			validated: 0,
			posted: 0,
			cancelled: 0,
			postedDebit: '0.00'
		});
		expect((await validateJ(j.id)).status).toBe(200);
		r = await summary('accounting', `companyId=${P.companyId}`);
		expect(r.totals).toMatchObject({ draft: 0, validated: 1 });
		expect((await postJ(j.id)).status).toBe(200);
		const posted = await journalOf(j.id);
		r = await summary('accounting', `companyId=${P.companyId}`);
		expect(r.totals).toMatchObject({
			posted: 1,
			postedDebit: posted.totalDebit,
			postedCredit: posted.totalCredit,
			postedBalanced: true
		});
		const accrual = r.groups.find((g) => g.key === 'PAYROLL_ACCRUAL')!;
		expect(accrual.metrics).toMatchObject({ posted: 1, postedDebit: posted.totalDebit });
		const d = (await get(`/dashboard/summary?companyId=${P.companyId}`, ctx.admin)).body.data;
		expect(d.accounting).toMatchObject({ draft: 0, validated: 0, posted: 1, cancelled: 0 });
		expect(JSON.stringify(d.accounting)).not.toMatch(/debit|credit|amount/i);
	}, 60_000);

	it('88. no payroll recomputation — the payroll snapshot is unchanged by accounting reporting', async () => {
		const before = await payrollFingerprint(P.runId);
		await summary('accounting', `companyId=${P.companyId}&groupBy=journalType`);
		expect(await payrollFingerprint(P.runId)).toBe(before);
	});

	it('89. posted totals are fixed-2 decimal strings', async () => {
		const r = await summary('accounting', `companyId=${P.companyId}`);
		expect(r.totals.postedDebit).toMatch(MONEY);
		expect(r.totals.postedCredit).toMatch(MONEY);
		const t = await summary(
			'accounting',
			`companyId=${P.companyId}&journalType=PAYMENT_SETTLEMENT`
		);
		expect(t.totals).toMatchObject({ posted: 0, postedDebit: '0.00' });
	});

	it('90. a manager is forbidden', async () => {
		const res = await get(`/reports/accounting/summary?companyId=${P.companyId}`, manager.cookie);
		expect(res.status).toBe(403);
		const pay = await get(`/reports/payments/summary?companyId=${P.companyId}`, manager.cookie);
		expect(pay.status).toBe(403);
	});

	it('— pending reversal accounting: needs the POSTED settlement, cleared by the reversal journal', async () => {
		const w = await paymentWorld({ employees: 1 });
		await payOk(w.batchId, w.items[0]!.id);
		const s = await settlementOk(w.batchId);
		await postedOk(s.id);
		expect((await reverse(w.batchId, w.items[0]!.id)).status).toBe(200);
		let r = await summary('accounting', `companyId=${w.companyId}`);
		expect(r.totals).toMatchObject({ pendingReversal: 1, pendingSettlement: 0 });
		const rev = await prisma.payrollPaymentReversal.findUniqueOrThrow({
			where: { paymentItemId: w.items[0]!.id }
		});
		expect((await createReversal(rev.id)).status).toBe(201);
		r = await summary('accounting', `companyId=${w.companyId}`);
		expect(r.totals.pendingReversal).toBe(0);
	}, 120_000);
});
