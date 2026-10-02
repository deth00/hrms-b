import { expect } from 'vitest';
import type { Response } from 'supertest';
import { agent } from './helpers.js';
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
	put,
	uid
} from './phase13Fixture.js';

/**
 * Shared fixtures for the Phase 14 suites (bank accounts, payment batches, bank export, privacy).
 * Builds on the Phase 13 fixture (ctx.admin = SUPER_ADMIN cookie, DIRECT companies, manual periods).
 */
export { ctx, get, post, put, uid, employee };

/** a distinctive QA account number with a leading zero — never a real account */
export const ACCT = '001234567890';

export const bankBody = (o: Record<string, unknown> = {}) => ({
	bankCode: 'QABANK',
	bankName: 'QA Bank',
	branchName: 'ສາຂາທົດສອບ',
	accountName: 'QA Account Holder',
	accountNumber: ACCT,
	currencyCode: 'LAK',
	...o
});

export async function setBank(employeeId: string, bank: Record<string, unknown> = {}) {
	const res = await put(`/employees/${employeeId}/payment-profile`, ctx.admin, {
		paymentMethod: 'BANK_TRANSFER',
		bankAccount: bankBody(bank)
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as PaymentProfileView;
}
export async function setMethod(employeeId: string, paymentMethod: 'BANK_TRANSFER' | 'CASH') {
	const res = await put(`/employees/${employeeId}/payment-profile`, ctx.admin, { paymentMethod });
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as PaymentProfileView;
}

export interface AccountView {
	id: string;
	bankCode: string;
	accountNumberMasked: string;
	accountNumberLast4: string;
	currencyCode: string;
	isPrimary: boolean;
	status: 'ACTIVE' | 'INACTIVE';
}
export interface PaymentProfileView {
	exists: boolean;
	paymentMethod: 'BANK_TRANSFER' | 'CASH' | null;
	primaryAccount: AccountView | null;
	accounts: AccountView[];
}

/** DIRECT company, N employees with salaries, FINALIZED manual run (payslips issued). */
export async function finalizedWorld(
	o: {
		employees?: number;
		salary?: string;
		userIds?: (string | null)[];
		beforeFinalize?: (w: {
			companyId: string;
			emps: { id: string }[];
			runId: string;
		}) => Promise<void>;
	} = {}
) {
	const companyId = await newCompany();
	const emps = [];
	for (let i = 0; i < (o.employees ?? 1); i++) {
		emps.push(
			await employee(companyId, {
				salary: o.salary ?? '5000000',
				userId: o.userIds?.[i] ?? null
			})
		);
	}
	const period = await manualPeriod(companyId);
	const run = await newRun(companyId, period.id);
	await calc(run.id);
	if (o.beforeFinalize) await o.beforeFinalize({ companyId, emps, runId: run.id });
	const fin = await finalize(run.id);
	expect(fin.status, JSON.stringify(fin.body)).toBe(200);
	return { companyId, emps, period, runId: run.id };
}

export interface ItemView {
	id: string;
	employeeId: string;
	employeeCode: string;
	paymentMethod: 'BANK_TRANSFER' | 'CASH' | null;
	bankCode: string | null;
	accountNumberMasked: string | null;
	amount: string | null;
	status: string;
	issues: string[];
	paymentReference: string | null;
	failureCode: string | null;
	failureReason: string | null;
	paidAt: string | null;
	transferReference: string;
}
export interface BatchView {
	id: string;
	batchNumber: string;
	status: string;
	currencyCode: string;
	totalAmount: string | null;
	employeeCount: number;
	summary: { employees: number; ready: number; blocked: number; paid: number; failed: number };
	items: ItemView[];
	exports: { id: string; fileHash: string; rowCount: number; profile: { id: string } }[];
}

export const createBatch = (
	runId: string,
	cookie = ctx.admin,
	body: Record<string, unknown> = {}
) => post(`/payroll/runs/${runId}/payment-batch`, cookie, body);
export async function batchOk(runId: string) {
	const res = await createBatch(runId);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as BatchView;
}
export async function batchOf(id: string, cookie = ctx.admin) {
	const res = await get(`/payroll/payment-batches/${id}`, cookie);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as BatchView;
}
export const validate = (id: string, cookie = ctx.admin) =>
	post(`/payroll/payment-batches/${id}/validate`, cookie);
export async function validateOk(id: string) {
	const res = await validate(id);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as {
		readyCount: number;
		blockedCount: number;
		issues: { itemId: string; codes: string[] }[];
		batch: BatchView;
	};
}
export const rebuild = (id: string, cookie = ctx.admin) =>
	post(`/payroll/payment-batches/${id}/rebuild`, cookie);
export const cancel = (id: string, cookie = ctx.admin) =>
	post(`/payroll/payment-batches/${id}/cancel`, cookie);
export const confirm = (
	batchId: string,
	itemId: string,
	body: Record<string, unknown>,
	cookie = ctx.admin
) => post(`/payroll/payment-batches/${batchId}/items/${itemId}/confirm`, cookie, body);

// ---------- export profiles + downloads ----------
export const GENERIC_COLUMNS = [
	{ field: 'EMPLOYEE_CODE', header: 'Employee Code' },
	{ field: 'EMPLOYEE_NAME', header: 'Employee Name' },
	{ field: 'BANK_CODE', header: 'Bank Code' },
	{ field: 'ACCOUNT_NAME', header: 'Account Name' },
	{ field: 'ACCOUNT_NUMBER', header: 'Account Number' },
	{ field: 'AMOUNT', header: 'Amount' },
	{ field: 'CURRENCY', header: 'Currency' }
];
export async function exportProfile(
	companyId: string,
	o: Record<string, unknown> = {}
): Promise<{ id: string; code: string; format: string }> {
	const res = await post('/bank-export-profiles', ctx.admin, {
		companyId,
		code: `QA_${uid()}`,
		name: 'QA generic CSV',
		format: 'CSV',
		delimiter: ',',
		includeHeader: true,
		encoding: 'UTF-8',
		dateFormat: 'YYYY-MM-DD',
		columns: GENERIC_COLUMNS,
		...o
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data;
}

/** collect the raw bytes of any response (CSV / XLSX / JSON error) */
function binaryParser(
	res: NodeJS.ReadableStream & { setEncoding: (e: string) => void },
	cb: (err: Error | null, body: Buffer) => void
) {
	const chunks: Buffer[] = [];
	res.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
	res.on('end', () => cb(null, Buffer.concat(chunks)));
}
export async function exportFile(batchId: string, profileId: string, cookie = ctx.admin) {
	const res: Response = await agent()
		.post(`/api/v1/payroll/payment-batches/${batchId}/export`)
		.set('Cookie', cookie)
		.send({ bankExportProfileId: profileId })
		.buffer(true)
		.parse(binaryParser as never);
	const bytes = res.body as Buffer;
	const json = () => JSON.parse(bytes.toString('utf8'));
	return { res, bytes, json };
}

/** A finalized world with every employee paid by bank transfer, batch VALIDATED. */
export async function validatedWorld(o: { employees?: number; userIds?: (string | null)[] } = {}) {
	const w = await finalizedWorld(o);
	for (const e of w.emps) await setBank(e.id);
	const batch = await batchOk(w.runId);
	const v = await validateOk(batch.id);
	expect(v.batch.status).toBe('VALIDATED');
	return { ...w, batch: v.batch };
}

/** …and exported with a generic CSV profile. */
export async function exportedWorld(o: { employees?: number; userIds?: (string | null)[] } = {}) {
	const w = await validatedWorld(o);
	const profile = await exportProfile(w.companyId);
	const ex = await exportFile(w.batch.id, profile.id);
	expect(ex.res.status, ex.bytes.toString()).toBe(200);
	return { ...w, profile, batch: await batchOf(w.batch.id) };
}
