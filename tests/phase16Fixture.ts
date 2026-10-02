import { afterAll, beforeAll, expect } from 'vitest';
import type { Response } from 'supertest';
import { agent } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import {
	calc,
	ctx,
	employee,
	finalize,
	get,
	manualPeriod,
	newCompany,
	newRun,
	post,
	profile,
	put,
	statutoryRule,
	uid
} from './phase13Fixture.js';
import {
	batchOk,
	exportFile,
	exportProfile,
	setBank,
	setMethod,
	validateOk
} from './phase14Fixture.js';
import { confirmFailed, confirmPaid, V15_COLUMNS } from './phase15Fixture.js';

/**
 * The Phase 16 fixtures finalize payroll (payslip notifications) and confirm payments (payment
 * notifications) as SIDE EFFECTS. Older suites scan every notification row for salary data, so each
 * Phase 16 file removes the notifications created while it ran (files run sequentially —
 * fileParallelism: false — so nothing of another file is touched). Accounting itself never notifies:
 * tests 24 and 93 assert that separately.
 */
export function isolateFixtureNotifications() {
	let since = new Date();
	beforeAll(() => {
		since = new Date(Date.now() - 1000);
	});
	afterAll(async () => {
		await prisma.notification.deleteMany({ where: { createdAt: { gte: since } } });
	});
}

/**
 * Shared fixtures for the Phase 16 suites (payroll accounting). Builds on Phase 13-15 fixtures
 * (ctx.admin = SUPER_ADMIN cookie: every permission incl. payroll.accounting.*).
 */
export { ctx, get, post, put, uid, confirmPaid, confirmFailed };

export const patch = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().patch(`/api/v1${path}`).set('Cookie', cookie).send(body);

// ---------- the QA chart of accounts ----------
export const ACCOUNTS = {
	SALARY_EXP: { code: '5100', name: 'QA Salary expense', type: 'EXPENSE' },
	EMPLOYER_EXP: { code: '5110', name: 'QA Employer SSO expense', type: 'EXPENSE' },
	PAYABLE: { code: '2100', name: 'QA Payroll payable', type: 'LIABILITY' },
	PIT: { code: '2110', name: 'QA PIT payable', type: 'LIABILITY' },
	SSO: { code: '2120', name: 'QA Social security payable', type: 'LIABILITY' },
	OTHER_DED: { code: '2130', name: 'QA Other deductions payable', type: 'LIABILITY' },
	BANK: { code: '1100', name: 'QA Bank clearing', type: 'ASSET' },
	CASH: { code: '1110', name: 'QA Cash', type: 'ASSET' }
} as const;
export type AccountKey = keyof typeof ACCOUNTS;

export async function glAccount(
	companyId: string,
	a: { code: string; name: string; type: string }
) {
	const res = await post('/payroll/accounting/gl-accounts', ctx.admin, { companyId, ...a });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; code: string; status: string };
}

export async function chartOf(companyId: string) {
	const ids = {} as Record<AccountKey, string>;
	for (const [k, a] of Object.entries(ACCOUNTS))
		ids[k as AccountKey] = (await glAccount(companyId, a)).id;
	return ids;
}

export type Dim = 'COMPANY' | 'BRANCH' | 'DEPARTMENT' | 'EMPLOYEE';
type MappingSpec = { debit?: AccountKey; credit?: AccountKey; dim?: Dim };

export const DEFAULT_ACCRUAL: Record<string, MappingSpec> = {
	BASE_SALARY: { debit: 'SALARY_EXP' },
	RECURRING_EARNING: { debit: 'SALARY_EXP' },
	OVERTIME: { debit: 'SALARY_EXP' },
	OTHER_EARNING: { debit: 'SALARY_EXP' },
	ATTENDANCE_DEDUCTION: { credit: 'OTHER_DED' },
	UNPAID_LEAVE: { credit: 'OTHER_DED' },
	LATE_DEDUCTION: { credit: 'OTHER_DED' },
	EARLY_DEDUCTION: { credit: 'OTHER_DED' },
	EMPLOYEE_PIT: { credit: 'PIT' },
	EMPLOYEE_SSO: { credit: 'SSO' },
	OTHER_DEDUCTION: { credit: 'OTHER_DED' },
	NET_PAYABLE: { credit: 'PAYABLE' },
	EMPLOYER_SSO: { debit: 'EMPLOYER_EXP', credit: 'SSO' },
	EMPLOYER_CONTRIBUTION: { debit: 'EMPLOYER_EXP', credit: 'OTHER_DED' }
};
export const DEFAULT_SETTLEMENT: Record<string, MappingSpec> = {
	PAYROLL_PAYABLE: { debit: 'PAYABLE' },
	BANK_CLEARING: { credit: 'BANK' },
	CASH_CLEARING: { credit: 'CASH' }
};

export const mapping = (
	ruleSetId: string,
	eventType: string,
	sourceType: string,
	body: Record<string, unknown>,
	cookie = ctx.admin
) =>
	put(`/payroll/accounting/rule-sets/${ruleSetId}/mappings`, cookie, {
		eventType,
		sourceType,
		...body
	});

export async function mapOk(
	ruleSetId: string,
	eventType: string,
	sourceType: string,
	spec: MappingSpec,
	ids: Record<AccountKey, string>
) {
	const res = await mapping(ruleSetId, eventType, sourceType, {
		debitAccountId: spec.debit ? ids[spec.debit] : null,
		creditAccountId: spec.credit ? ids[spec.credit] : null,
		groupingDimension: spec.dim ?? 'COMPANY'
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
}

export async function ruleSet(
	companyId: string,
	o: { effectiveFrom?: string; effectiveTo?: string | null; name?: string } = {}
) {
	const res = await post('/payroll/accounting/rule-sets', ctx.admin, {
		companyId,
		name: o.name ?? `QA rules ${uid()}`,
		effectiveFrom: o.effectiveFrom ?? '2020-01-01',
		effectiveTo: o.effectiveTo ?? null
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; version: number; status: string };
}
export const activate = (id: string, cookie = ctx.admin) =>
	post(`/payroll/accounting/rule-sets/${id}/activate`, cookie);

/** a chart of accounts + an ACTIVE rule set mapping every source (overridable / omittable) */
export async function accountingSetup(
	companyId: string,
	o: {
		accrual?: Record<string, MappingSpec | null>;
		settlement?: Record<string, MappingSpec | null>;
		activate?: boolean;
	} = {}
) {
	const ids = await chartOf(companyId);
	const rs = await ruleSet(companyId);
	const accrual = { ...DEFAULT_ACCRUAL, ...o.accrual };
	for (const [s, spec] of Object.entries(accrual)) {
		if (spec) await mapOk(rs.id, 'PAYROLL_ACCRUAL', s, spec, ids);
	}
	const settlement = { ...DEFAULT_SETTLEMENT, ...o.settlement };
	for (const [s, spec] of Object.entries(settlement)) {
		if (spec) await mapOk(rs.id, 'PAYMENT_SETTLEMENT', s, spec, ids);
	}
	if (o.activate !== false) {
		const a = await activate(rs.id);
		expect(a.status, JSON.stringify(a.body)).toBe(200);
	}
	return { ids, ruleSetId: rs.id };
}

// ---------- payroll worlds ----------
export interface OrgUnits {
	branches: { id: string; code: string }[];
	departments: { id: string; code: string }[];
}
export async function orgUnits(companyId: string, n = 2): Promise<OrgUnits> {
	const branches = [];
	const departments = [];
	for (let i = 0; i < n; i++) {
		const code = `BR${i + 1}_${uid()}`;
		branches.push(
			await prisma.branch.create({
				data: { companyId, code, nameLao: `ສາຂາ ${code}` },
				select: { id: true, code: true }
			})
		);
		const dcode = `DP${i + 1}_${uid()}`;
		departments.push(
			await prisma.department.create({
				data: { companyId, code: dcode, nameLao: `ພະແນກ ${dcode}` },
				select: { id: true, code: true }
			})
		);
	}
	return { branches, departments };
}

/**
 * A FINALIZED payroll run. statutory = PIT + SSO calculated (employer SSO too). Employee i is placed in
 * branch/department (i % 2) when `org` is given.
 */
export async function payrollWorld(
	o: {
		employees?: number;
		salaries?: string[];
		statutory?: boolean;
		org?: boolean;
		setup?: boolean | Parameters<typeof accountingSetup>[1];
		userIds?: (string | null)[];
	} = {}
) {
	const companyId = await newCompany();
	if (o.statutory !== false) await statutoryRule(companyId);
	const units = o.org ? await orgUnits(companyId) : null;
	const n = o.employees ?? 2;
	const emps: { id: string; employeeCode: string }[] = [];
	for (let i = 0; i < n; i++) {
		const e = await employee(companyId, {
			salary: o.salaries?.[i] ?? (i % 2 === 0 ? '5000000' : '3000000'),
			userId: o.userIds?.[i] ?? null
		});
		if (units) {
			await prisma.employee.update({
				where: { id: e.id },
				data: { branchId: units.branches[i % 2]!.id, departmentId: units.departments[i % 2]!.id }
			});
		}
		if (o.statutory !== false) await profile(e.id);
		emps.push({ id: e.id, employeeCode: e.employeeCode });
	}
	const period = await manualPeriod(companyId);
	const run = await newRun(companyId, period.id);
	await calc(run.id);
	const fin = await finalize(run.id);
	expect(fin.status, JSON.stringify(fin.body)).toBe(200);
	const acct =
		o.setup === false
			? null
			: await accountingSetup(companyId, typeof o.setup === 'object' ? o.setup : {});
	return { companyId, emps, period, runId: run.id, units, acct };
}

/** + a payment batch (bank transfer, or CASH for the given employee indexes) exported */
export async function paymentWorld(
	o: Parameters<typeof payrollWorld>[0] & { cashIndexes?: number[] } = {}
) {
	const w = await payrollWorld(o);
	for (let i = 0; i < w.emps.length; i++) {
		if (o.cashIndexes?.includes(i)) await setMethod(w.emps[i]!.id, 'CASH');
		else await setBank(w.emps[i]!.id);
	}
	const batch = await batchOk(w.runId);
	await validateOk(batch.id);
	const bankProfile = await exportProfile(w.companyId, { columns: V15_COLUMNS });
	const ex = await exportFile(batch.id, bankProfile.id);
	expect(ex.res.status, ex.bytes.toString()).toBe(200);
	const items = await prisma.payrollPaymentItem.findMany({
		where: { paymentBatchId: batch.id },
		orderBy: { employeeCodeSnapshot: 'asc' }
	});
	return {
		...w,
		batchId: batch.id,
		batchNumber: batch.batchNumber,
		bankProfileId: bankProfile.id,
		items
	};
}

export async function payOk(batchId: string, itemId: string) {
	const r = await confirmPaid(batchId, itemId);
	expect(r.status, JSON.stringify(r.body)).toBe(200);
}

// ---------- journals ----------
export interface LineView {
	lineNo: number;
	accountId: string;
	accountCode: string;
	accountName: string;
	debit: string;
	credit: string;
	description: string;
	employeeCode: string | null;
	branchCode: string | null;
	departmentCode: string | null;
	sourceType: string;
	sourceId: string | null;
	sourceReference: string | null;
}
export interface JournalView {
	id: string;
	journalNumber: string;
	journalType: string;
	sourceType: string;
	sourceId: string;
	accountingDate: string;
	currencyCode: string;
	status: string;
	ruleSetId: string | null;
	ruleSetVersion: number | null;
	totalDebit: string;
	totalCredit: string;
	lineCount: number;
	reversedJournalId: string | null;
	source: Record<string, unknown> | null;
	lines: LineView[];
	exports: { id: string; fileHash: string; fileName: string; rowCount: number }[];
	alreadyPosted?: boolean;
}

export const createAccrual = (runId: string, cookie = ctx.admin) =>
	post(`/payroll/runs/${runId}/accounting-journal`, cookie);
export async function accrualOk(runId: string) {
	const res = await createAccrual(runId);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as JournalView;
}
export const createSettlement = (batchId: string, cookie = ctx.admin) =>
	post(`/payroll/payment-batches/${batchId}/accounting-journal`, cookie);
export async function settlementOk(batchId: string) {
	const res = await createSettlement(batchId);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as JournalView;
}
export const createReversal = (reversalId: string, cookie = ctx.admin) =>
	post(`/payroll/payment-reversals/${reversalId}/accounting-journal`, cookie);

export const validateJ = (id: string, cookie = ctx.admin) =>
	post(`/payroll/accounting/journals/${id}/validate`, cookie);
export const postJ = (id: string, cookie = ctx.admin) =>
	post(`/payroll/accounting/journals/${id}/post`, cookie);
export const cancelJ = (id: string, cookie = ctx.admin) =>
	post(`/payroll/accounting/journals/${id}/cancel`, cookie);
export async function journalOf(id: string, cookie = ctx.admin) {
	const res = await get(`/payroll/accounting/journals/${id}`, cookie);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as JournalView;
}
export async function postedOk(id: string) {
	const v = await validateJ(id);
	expect(v.status, JSON.stringify(v.body)).toBe(200);
	const p = await postJ(id);
	expect(p.status, JSON.stringify(p.body)).toBe(200);
	return p.body.data as JournalView;
}

export const sumOf = (lines: LineView[], k: 'debit' | 'credit') =>
	lines.reduce((s, l) => s + Math.round(Number(l[k]) * 100), 0) / 100;
export const byCode = (lines: LineView[], code: string) =>
	lines.filter((l) => l.accountCode === code);

// ---------- export ----------
export const JOURNAL_COLUMNS = [
	'JOURNAL_NUMBER',
	'ACCOUNTING_DATE',
	'JOURNAL_TYPE',
	'LINE_NUMBER',
	'ACCOUNT_CODE',
	'ACCOUNT_NAME',
	'DESCRIPTION',
	'EMPLOYEE_CODE',
	'BRANCH_CODE',
	'DEPARTMENT_CODE',
	'DEBIT',
	'CREDIT',
	'CURRENCY',
	'SOURCE_REFERENCE'
].map((f) => ({ field: f, header: f }));

export async function accountingProfile(companyId: string, o: Record<string, unknown> = {}) {
	const res = await post('/payroll/accounting/export-profiles', ctx.admin, {
		companyId,
		code: `QA_GL_${uid()}`,
		name: 'QA GL CSV',
		format: 'CSV',
		delimiter: ',',
		includeHeader: true,
		encoding: 'UTF-8',
		dateFormat: 'YYYY-MM-DD',
		columns: JOURNAL_COLUMNS,
		...o
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; code: string; format: 'CSV' | 'XLSX' };
}

function binaryParser(
	res: NodeJS.ReadableStream & { setEncoding: (e: string) => void },
	cb: (err: Error | null, body: Buffer) => void
) {
	const chunks: Buffer[] = [];
	res.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
	res.on('end', () => cb(null, Buffer.concat(chunks)));
}
export async function exportJournal(journalId: string, profileId: string, cookie = ctx.admin) {
	const res: Response = await agent()
		.post(`/api/v1/payroll/accounting/journals/${journalId}/export`)
		.set('Cookie', cookie)
		.send({ accountingExportProfileId: profileId })
		.buffer(true)
		.parse(binaryParser as never);
	const bytes = res.body as Buffer;
	const json = () => JSON.parse(bytes.toString('utf8'));
	return { res, bytes, json };
}

/** every digit representation of an amount we must never find in audit metadata */
export const amountNeedles = (amount: string) => {
	const [int] = amount.split('.');
	return [amount, int!, int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')];
};

/** snapshot of every payroll / payment row the accounting must never modify */
export async function payrollFingerprint(runId: string) {
	const [run, results, items, statutory, payslips, batches, payItems] = await Promise.all([
		prisma.payrollRun.findUnique({ where: { id: runId } }),
		prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: runId },
			orderBy: { id: 'asc' }
		}),
		prisma.payrollResultItem.findMany({
			where: { result: { payrollRunId: runId } },
			orderBy: { id: 'asc' }
		}),
		prisma.payrollStatutoryResult.findMany({
			where: { result: { payrollRunId: runId } },
			orderBy: { id: 'asc' }
		}),
		prisma.payslip.findMany({ where: { payrollRunId: runId }, orderBy: { id: 'asc' } }),
		prisma.payrollPaymentBatch.findMany({ where: { payrollRunId: runId }, orderBy: { id: 'asc' } }),
		prisma.payrollPaymentItem.findMany({
			where: { batch: { payrollRunId: runId } },
			orderBy: { id: 'asc' }
		})
	]);
	return JSON.stringify({ run, results, items, statutory, payslips, batches, payItems });
}
