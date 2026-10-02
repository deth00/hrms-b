import { beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import { setupPhase13 } from './phase13Fixture.js';
import {
	ACCOUNTS,
	accountingSetup,
	accrualOk,
	amountNeedles,
	byCode,
	cancelJ,
	createAccrual,
	ctx,
	get,
	patch,
	payrollFingerprint,
	payrollWorld,
	sumOf,
	type LineView
} from './phase16Fixture.js';
import { isolateFixtureNotifications } from './phase16Fixture.js';
import { calc, manualPeriod, newCompany, newRun, employee } from './phase13Fixture.js';

/** Phase 16 — PAYROLL ACCRUAL journals from FINALIZED payroll (tests 1-24). */
isolateFixtureNotifications();
beforeAll(async () => {
	await setupPhase13();
});

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

async function resultsOf(runId: string) {
	return prisma.payrollEmployeeResult.findMany({
		where: { payrollRunId: runId },
		include: { items: true, statutoryResult: true }
	});
}
const sumItems = (
	rs: Awaited<ReturnType<typeof resultsOf>>,
	source: string,
	type: 'EARNING' | 'DEDUCTION' = 'DEDUCTION'
) =>
	rs
		.flatMap((r) => r.items)
		.filter((i) => i.source === source && i.type === type)
		.reduce((s, i) => s.plus(i.amount), D(0));
const dec = (l: LineView) => ({ debit: D(l.debit), credit: D(l.credit) });

describe('accrual journal — creation', () => {
	it('1. creates a balanced DRAFT accrual journal from a FINALIZED run', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		expect(j.status).toBe('DRAFT');
		expect(j.journalType).toBe('PAYROLL_ACCRUAL');
		expect(j.sourceType).toBe('PAYROLL_RUN');
		expect(j.sourceId).toBe(w.runId);
		expect(j.totalDebit).toBe(j.totalCredit);
		expect(sumOf(j.lines, 'debit')).toBe(sumOf(j.lines, 'credit'));
		expect(j.lineCount).toBe(j.lines.length);
		expect(j.currencyCode).toBe('LAK');
	});

	it('2. lines reproduce the finalized result items exactly (salary, PIT, SSO, net, employer SSO)', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		const rs = await resultsOf(w.runId);
		const base = sumItems(rs, 'BASE_SALARY', 'EARNING');
		const pit = sumItems(rs, 'PIT');
		const sso = sumItems(rs, 'SOCIAL_SECURITY_EMPLOYEE');
		const net = rs.reduce((s, r) => s.plus(r.netPay), D(0));
		const employer = rs.reduce((s, r) => s.plus(r.statutoryResult!.employerSsoCurrentCycle), D(0));
		expect(pit.greaterThan(0)).toBe(true);
		expect(employer.greaterThan(0)).toBe(true);
		const line = (src: string, code: string) =>
			j.lines.filter((l) => l.sourceType === src && l.accountCode === code).map(dec);
		expect(line('BASE_SALARY', ACCOUNTS.SALARY_EXP.code)[0]!.debit.equals(base)).toBe(true);
		expect(line('EMPLOYEE_PIT', ACCOUNTS.PIT.code)[0]!.credit.equals(pit)).toBe(true);
		expect(line('EMPLOYEE_SSO', ACCOUNTS.SSO.code)[0]!.credit.equals(sso)).toBe(true);
		expect(line('NET_PAYABLE', ACCOUNTS.PAYABLE.code)[0]!.credit.equals(net)).toBe(true);
		expect(line('EMPLOYER_SSO', ACCOUNTS.EMPLOYER_EXP.code)[0]!.debit.equals(employer)).toBe(true);
		expect(line('EMPLOYER_SSO', ACCOUNTS.SSO.code)[0]!.credit.equals(employer)).toBe(true);
		expect(D(j.totalDebit).equals(base.plus(employer))).toBe(true);
	});

	it('3. every line has exactly one side > 0 and no negative value', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		for (const l of j.lines) {
			const { debit, credit } = dec(l);
			expect(debit.isNegative() || credit.isNegative()).toBe(false);
			expect(debit.greaterThan(0) !== credit.greaterThan(0)).toBe(true);
		}
	});

	it('4. zero amounts are omitted (no statutory → no PIT / SSO / employer lines)', async () => {
		const w = await payrollWorld({ statutory: false });
		const j = await accrualOk(w.runId);
		const sources = new Set(j.lines.map((l) => l.sourceType));
		expect([...sources].sort()).toEqual(['BASE_SALARY', 'NET_PAYABLE']);
		expect(j.lines.every((l) => l.debit !== '0.00' || l.credit !== '0.00')).toBe(true);
	});

	it('5. journal number PAYGL-{periodCode}, accounting date = period end, rule set version snapshot', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		expect(j.journalNumber).toBe(`PAYGL-${w.period.code.replace(/_/g, '-')}`);
		expect(j.accountingDate).toBe('2025-09-30');
		expect(j.ruleSetId).toBe(w.acct!.ruleSetId);
		expect(j.ruleSetVersion).toBe(1);
	});

	it('6. line snapshots: account code / name and the period as source reference', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		const l = j.lines.find((x) => x.sourceType === 'BASE_SALARY')!;
		expect(l.accountCode).toBe(ACCOUNTS.SALARY_EXP.code);
		expect(l.accountName).toBe(ACCOUNTS.SALARY_EXP.name);
		expect(l.sourceReference).toBe(w.period.code);
		// renaming the account later never changes the journal
		await patch(`/payroll/accounting/gl-accounts/${w.acct!.ids.SALARY_EXP}`, ctx.admin, {
			name: 'Renamed expense'
		});
		const res = await get(`/payroll/accounting/journals/${j.id}`, ctx.admin);
		expect(
			(res.body.data.lines as LineView[]).find((x) => x.sourceType === 'BASE_SALARY')!.accountName
		).toBe(ACCOUNTS.SALARY_EXP.name);
	});
});

describe('accrual journal — refusals', () => {
	it('7. a run that is not FINALIZED → 409 PAYROLL_RUN_NOT_FINALIZED', async () => {
		const companyId = await newCompany();
		await employee(companyId);
		await accountingSetup(companyId);
		const period = await manualPeriod(companyId);
		const run = await newRun(companyId, period.id);
		await calc(run.id);
		const res = await createAccrual(run.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_RUN_NOT_FINALIZED');
		expect(await prisma.payrollJournal.count({ where: { sourceId: run.id } })).toBe(0);
	});

	it('8. unknown run → 404', async () => {
		const res = await createAccrual(2147483647 as never);
		expect(res.status).toBe(404);
		// numeric-ID contract: a malformed id is a 400, never a lookup
		const bad = await createAccrual('does-not-exist');
		expect(bad.status).toBe(400);
		expect(bad.body.error.code).toBe('VALIDATION_ERROR');
	});

	it('9. no ACTIVE rule set for the accounting date → 409 ACCOUNTING_RULESET_NOT_FOUND', async () => {
		const w = await payrollWorld({ setup: { activate: false } });
		const res = await createAccrual(w.runId);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('ACCOUNTING_RULESET_NOT_FOUND');
	});

	it('10. a source with an amount but no mapping → 409 MISSING_ACCOUNTING_MAPPING with source, dimension, count', async () => {
		const w = await payrollWorld({ setup: { accrual: { EMPLOYEE_PIT: null } } });
		const res = await createAccrual(w.runId);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('MISSING_ACCOUNTING_MAPPING');
		expect(res.body.error.message).toContain('ຍັງບໍ່ໄດ້ຕັ້ງຄ່າບັນຊີສຳລັບ');
		expect(res.body.error.details.sourceType).toBe('EMPLOYEE_PIT');
		expect(res.body.error.details).toHaveProperty('dimension');
		expect(res.body.error.details.affectedCount).toBe(2);
		expect(await prisma.payrollJournal.count({ where: { sourceId: w.runId } })).toBe(0);
	});

	it('11. a zero-amount source needs no mapping (no statutory, PIT unmapped → still OK)', async () => {
		const w = await payrollWorld({ statutory: false, setup: { accrual: { EMPLOYEE_PIT: null } } });
		await accrualOk(w.runId);
	});

	it('12. a mapped account that was deactivated → 409 ACCOUNTING_ACCOUNT_INACTIVE', async () => {
		const w = await payrollWorld();
		await patch(`/payroll/accounting/gl-accounts/${w.acct!.ids.PIT}`, ctx.admin, {
			status: 'INACTIVE'
		});
		const res = await createAccrual(w.runId);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('ACCOUNTING_ACCOUNT_INACTIVE');
		expect(res.body.error.details.accountCodes).toEqual([ACCOUNTS.PIT.code]);
	});

	it('13. legacy / incomplete itemization (items do not explain net pay) → 409 ACCOUNTING_SOURCE_DATA_UNAVAILABLE', async () => {
		const w = await payrollWorld({ employees: 1, statutory: false });
		// simulate a legacy result whose items are missing
		const r = await prisma.payrollEmployeeResult.findFirstOrThrow({
			where: { payrollRunId: w.runId }
		});
		await prisma.payrollResultItem.deleteMany({ where: { payrollEmployeeResultId: r.id } });
		const res = await createAccrual(w.runId);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('ACCOUNTING_SOURCE_DATA_UNAVAILABLE');
	});
});

describe('accrual journal — duplicates', () => {
	it('14. a second accrual for the same run → 409 PAYROLL_ACCRUAL_JOURNAL_ALREADY_EXISTS', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		const res = await createAccrual(w.runId);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_ACCRUAL_JOURNAL_ALREADY_EXISTS');
		expect(res.body.error.details.journalId).toBe(j.id);
	});

	it('15. concurrent creation → exactly ONE journal (row lock + unique source key)', async () => {
		const w = await payrollWorld();
		const results = await Promise.all([1, 2, 3, 4].map(() => createAccrual(w.runId)));
		expect(results.filter((r) => r.status === 201)).toHaveLength(1);
		for (const r of results.filter((x) => x.status !== 201)) {
			expect(r.body.error.code).toBe('PAYROLL_ACCRUAL_JOURNAL_ALREADY_EXISTS');
		}
		expect(await prisma.payrollJournal.count({ where: { sourceId: w.runId } })).toBe(1);
	});

	it('16. the DB rejects a second live source key even without the service', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		await expect(
			prisma.payrollJournalSource.create({
				data: {
					journalId: j.id,
					journalType: 'PAYROLL_ACCRUAL',
					sourceType: 'PAYROLL_RUN',
					sourceId: w.runId,
					activeKey: `ACCRUAL:${w.runId}`
				}
			})
		).rejects.toMatchObject({ code: 'P2002' });
	});

	it('17. cancel keeps history and frees the run; the new journal gets a stable suffixed number', async () => {
		const w = await payrollWorld();
		const first = await accrualOk(w.runId);
		const c = await cancelJ(first.id);
		expect(c.status).toBe(200);
		expect(c.body.data.status).toBe('CANCELLED');
		const second = await accrualOk(w.runId);
		expect(second.id).not.toBe(first.id);
		expect(second.journalNumber).toBe(`${first.journalNumber}-2`);
		const all = await prisma.payrollJournal.findMany({ where: { sourceId: w.runId } });
		expect(all.map((j) => j.status).sort()).toEqual(['CANCELLED', 'DRAFT']);
	});
});

describe('accrual journal — grouping and dimensions', () => {
	it('18. COMPANY grouping: one line per source/account', async () => {
		const w = await payrollWorld({ employees: 3 });
		const j = await accrualOk(w.runId);
		expect(j.lines.filter((l) => l.sourceType === 'BASE_SALARY')).toHaveLength(1);
		expect(j.lines.every((l) => l.employeeCode === null)).toBe(true);
	});

	it('19. EMPLOYEE grouping: one NET_PAYABLE line per employee with the employee code snapshot', async () => {
		const w = await payrollWorld({
			employees: 2,
			setup: { accrual: { NET_PAYABLE: { credit: 'PAYABLE', dim: 'EMPLOYEE' } } }
		});
		const j = await accrualOk(w.runId);
		const net = j.lines.filter((l) => l.sourceType === 'NET_PAYABLE');
		expect(net).toHaveLength(2);
		expect(net.map((l) => l.employeeCode).sort()).toEqual(w.emps.map((e) => e.employeeCode).sort());
		expect(j.totalDebit).toBe(j.totalCredit);
	});

	it('20. DEPARTMENT / BRANCH grouping uses the codes of the payroll SNAPSHOT', async () => {
		const w = await payrollWorld({
			employees: 2,
			org: true,
			setup: {
				accrual: {
					BASE_SALARY: { debit: 'SALARY_EXP', dim: 'DEPARTMENT' },
					NET_PAYABLE: { credit: 'PAYABLE', dim: 'BRANCH' }
				}
			}
		});
		const j = await accrualOk(w.runId);
		const dept = j.lines.filter((l) => l.sourceType === 'BASE_SALARY');
		expect(dept.map((l) => l.departmentCode).sort()).toEqual(
			w.units!.departments.map((d) => d.code).sort()
		);
		const br = j.lines.filter((l) => l.sourceType === 'NET_PAYABLE');
		expect(br.map((l) => l.branchCode).sort()).toEqual(w.units!.branches.map((b) => b.code).sort());
	});

	it('21. a later assignment change does NOT move lines (historical snapshot, not the current employee)', async () => {
		const w = await payrollWorld({
			employees: 2,
			org: true,
			setup: { accrual: { BASE_SALARY: { debit: 'SALARY_EXP', dim: 'DEPARTMENT' } } }
		});
		// both employees move to department #1 AFTER finalization
		for (const e of w.emps) {
			await prisma.employee.update({
				where: { id: e.id },
				data: { departmentId: w.units!.departments[0]!.id }
			});
		}
		const j = await accrualOk(w.runId);
		expect(j.lines.filter((l) => l.sourceType === 'BASE_SALARY')).toHaveLength(2);
	});

	it('22. a missing department snapshot groups as unassigned (no code) and stays balanced', async () => {
		const w = await payrollWorld({
			employees: 2,
			setup: { accrual: { BASE_SALARY: { debit: 'SALARY_EXP', dim: 'DEPARTMENT' } } }
		});
		const j = await accrualOk(w.runId);
		const lines = j.lines.filter((l) => l.sourceType === 'BASE_SALARY');
		expect(lines).toHaveLength(1);
		expect(lines[0]!.departmentCode).toBeNull();
		expect(j.totalDebit).toBe(j.totalCredit);
	});
});

describe('accrual journal — signs, immutability of payroll, audit', () => {
	it('23. a PIT CREDIT (EARNING item of source PIT) swaps to the debit side of the PIT account', async () => {
		const w = await payrollWorld({ employees: 1 });
		// simulate a later cycle whose PIT current cycle is negative (engine stores an EARNING PIT item)
		const r = await prisma.payrollEmployeeResult.findFirstOrThrow({
			where: { payrollRunId: w.runId },
			include: { items: true }
		});
		const pit = r.items.find((i) => i.source === 'PIT')!;
		await prisma.payrollResultItem.update({ where: { id: pit.id }, data: { type: 'EARNING' } });
		await prisma.payrollEmployeeResult.update({
			where: { id: r.id },
			data: { netPay: r.netPay.plus(pit.amount.times(2)) }
		});
		const j = await accrualOk(w.runId);
		const pitLines = byCode(j.lines, ACCOUNTS.PIT.code);
		expect(pitLines).toHaveLength(1);
		expect(D(pitLines[0]!.debit).equals(pit.amount)).toBe(true);
		expect(pitLines[0]!.credit).toBe('0.00');
		expect(j.totalDebit).toBe(j.totalCredit);
	});

	it('24. creating / cancelling journals never modifies payroll, payslips or payments; audit has no amounts', async () => {
		const w = await payrollWorld();
		const before = await payrollFingerprint(w.runId);
		const j = await accrualOk(w.runId);
		await cancelJ(j.id);
		await accrualOk(w.runId);
		expect(await payrollFingerprint(w.runId)).toBe(before);
		const events = await prisma.auditEvent.findMany({
			where: { entityType: 'PAYROLL_JOURNAL', entityId: String(j.id) }
		});
		expect(events.map((e) => e.action).sort()).toEqual([
			'PAYROLL_ACCOUNTING.JOURNAL_CANCELLED',
			'PAYROLL_ACCOUNTING.JOURNAL_CREATED'
		]);
		const blob = JSON.stringify(events);
		const rs = await resultsOf(w.runId);
		for (const r of rs) {
			for (const needle of amountNeedles(r.netPay.toFixed(2))) expect(blob).not.toContain(needle);
		}
		expect(blob).not.toContain(j.totalDebit);
		// a mapping created for the accounting settings — no employee notification about accounting
		expect(await prisma.notification.count({ where: { type: { contains: 'ACCOUNTING' } } })).toBe(
			0
		);
	});
});
