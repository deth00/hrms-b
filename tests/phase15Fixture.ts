import { expect } from 'vitest';
import * as XLSX from 'xlsx';
import { agent, userWithPermissions } from './helpers.js';
import { todayInLaos, formatDateOnly } from '../src/lib/dates.js';
import {
	batchOf,
	ctx,
	exportFile,
	exportProfile,
	GENERIC_COLUMNS,
	get,
	post,
	put,
	uid,
	validatedWorld,
	type BatchView,
	type ItemView
} from './phase14Fixture.js';

/**
 * Shared fixtures for the Phase 15 suites (reconciliation, reversal, retry, lineage, privacy).
 * Builds on the Phase 14 fixture (ctx.admin = SUPER_ADMIN cookie: every permission incl. payroll.view).
 */
export { ctx, get, post, put, uid, batchOf, exportFile, exportProfile, GENERIC_COLUMNS };
export type { BatchView };

export interface Item15 extends ItemView {
	payrollEmployeeResultId: string;
	instructionReference: string | null;
	sourcePaymentItemId: string | null;
	retryEligible: boolean;
	retryItem: { id: string; status: string; batchId: string } | null;
	obligationStatus: string | null;
	attemptNo: number | null;
	currencyCode: string;
	reversal: {
		reason: string;
		bankReference: string | null;
		effectiveDate: string;
		reversedAt: string;
	} | null;
}
export interface Batch15 extends Omit<BatchView, 'items'> {
	batchKind: 'ORIGINAL' | 'RETRY';
	sequenceNo: number;
	parentBatch: { id: string; batchNumber: string } | null;
	legacyInstructionReferences: boolean;
	items: Item15[];
}
export const batch15 = async (id: string, cookie = ctx.admin) =>
	(await batchOf(id, cookie)) as unknown as Batch15;

export const today = () => formatDateOnly(todayInLaos(new Date()));

/** a Phase 15 bank export profile: generic columns + INSTRUCTION_REFERENCE */
export const V15_COLUMNS = [
	...GENERIC_COLUMNS,
	{ field: 'INSTRUCTION_REFERENCE', header: 'Instruction Reference' }
];

/** VALIDATED + exported with a Phase 15 profile (INSTRUCTION_REFERENCE column). */
export async function exported15(o: { employees?: number; userIds?: (string | null)[] } = {}) {
	const w = await validatedWorld(o);
	const profile = await exportProfile(w.companyId, { columns: V15_COLUMNS });
	const ex = await exportFile(w.batch.id, profile.id);
	expect(ex.res.status, ex.bytes.toString()).toBe(200);
	return { ...w, profile, batch: await batch15(w.batch.id) };
}

// ---------- reconciliation profiles ----------
export const RESULT_COLUMNS = [
	{ field: 'INSTRUCTION_REFERENCE', column: 'Instruction Reference' },
	{ field: 'BANK_TRANSACTION_REFERENCE', column: 'Bank Reference' },
	{ field: 'STATUS', column: 'Status' },
	{ field: 'AMOUNT', column: 'Amount' },
	{ field: 'CURRENCY', column: 'Currency' },
	{ field: 'PAID_DATE', column: 'Paid Date' },
	{ field: 'FAILURE_CODE', column: 'Failure Code' },
	{ field: 'FAILURE_REASON', column: 'Failure Reason' }
];
export const STATUS_MAPPING = {
	PAID: ['SUCCESS', 'PAID', 'S', '00'],
	FAILED: ['FAILED', 'REJECTED', 'F'],
	REVERSED: ['REVERSED', 'RETURNED', 'REV']
};
export const reconProfileBody = (companyId: string, o: Record<string, unknown> = {}) => ({
	companyId,
	code: `QA_R_${uid()}`,
	name: 'QA result CSV',
	format: 'CSV',
	delimiter: ',',
	hasHeader: true,
	dateFormat: 'YYYY-MM-DD',
	columns: RESULT_COLUMNS,
	statusMapping: STATUS_MAPPING,
	...o
});
export async function reconProfile(companyId: string, o: Record<string, unknown> = {}) {
	const res = await post(
		'/payment-reconciliation-profiles',
		ctx.admin,
		reconProfileBody(companyId, o)
	);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; code: string; format: 'CSV' | 'XLSX' };
}

// ---------- result files ----------
export interface ResultRow {
	ref?: string | null;
	bankRef?: string | null;
	status: string;
	amount?: string | null;
	currency?: string | null;
	paidDate?: string | null;
	failureCode?: string | null;
	failureReason?: string | null;
	extra?: Record<string, string>;
}
const HEADERS = RESULT_COLUMNS.map((c) => c.column);
const cellsOf = (r: ResultRow) => [
	r.ref ?? '',
	r.bankRef ?? '',
	r.status,
	r.amount ?? '',
	r.currency ?? '',
	r.paidDate ?? '',
	r.failureCode ?? '',
	r.failureReason ?? ''
];
const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function resultCsv(rows: ResultRow[], extraHeaders: string[] = []) {
	const lines = [[...HEADERS, ...extraHeaders].map(q).join(',')];
	for (const r of rows) {
		lines.push([...cellsOf(r), ...extraHeaders.map((h) => r.extra?.[h] ?? '')].map(q).join(','));
	}
	return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

export function resultXlsx(
	rows: ResultRow[],
	o: { formulaAt?: { row: number; col: number } } = {}
) {
	const aoa = [HEADERS, ...rows.map(cellsOf)];
	const ws = XLSX.utils.aoa_to_sheet(aoa);
	if (o.formulaAt) {
		const addr = XLSX.utils.encode_cell({ r: o.formulaAt.row, c: o.formulaAt.col });
		ws[addr] = { t: 's', v: 'SUCCESS', f: '"SUC"&"CESS"' };
	}
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, ws, 'Results');
	return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** a row the bank reports for an item (exact instruction reference, amount, currency) */
export const bankRow = (item: Item15, status: string, o: Partial<ResultRow> = {}): ResultRow => ({
	ref: item.instructionReference,
	bankRef: status === 'SUCCESS' ? `BANK-${uid()}` : null,
	status,
	amount: item.amount,
	currency: item.currencyCode,
	paidDate: status === 'SUCCESS' ? today() : null,
	failureCode: status === 'FAILED' ? 'AC04' : null,
	failureReason: status === 'FAILED' ? 'QA: account closed' : null,
	...o
});

export function upload(
	batchId: string,
	profileId: string,
	file: { name: string; bytes: Buffer },
	cookie = ctx.admin
) {
	return agent()
		.post(`/api/v1/payroll/payment-batches/${batchId}/reconciliations/import`)
		.set('Cookie', cookie)
		.field('reconciliationProfileId', profileId)
		.attach('file', file.bytes, { filename: file.name, contentType: 'application/octet-stream' });
}

export interface ImportRow {
	id: string;
	rowNumber: number;
	instructionReference: string | null;
	matchState: string;
	matchMethod: string | null;
	issueCode: string | null;
	applyOutcome: string | null;
	matchedItem: { id: string; accountNumberMasked: string | null } | null;
	ignoredReason: string | null;
}
export interface ImportView {
	id: string;
	status: string;
	fileHash: string;
	fileName: string;
	rowCount: number;
	matchedCount: number;
	unmatchedCount: number;
	conflictCount: number;
	invalidCount: number;
	ignoredCount: number;
	legacyBatch: boolean;
	rows: ImportRow[];
	candidates: { id: string; accountNumberMasked: string | null; amount: string | null }[];
}
export async function uploadOk(
	batchId: string,
	profileId: string,
	file: { name: string; bytes: Buffer }
) {
	const res = await upload(batchId, profileId, file);
	expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
	return res.body.data.import as ImportView;
}
export const importOf = async (id: string, cookie = ctx.admin) => {
	const res = await get(`/payroll/reconciliations/${id}`, cookie);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as ImportView;
};
export const matchRow = (
	importId: string,
	rowId: string,
	paymentItemId: string,
	cookie = ctx.admin
) => post(`/payroll/reconciliations/${importId}/rows/${rowId}/match`, cookie, { paymentItemId });
export const ignoreRow = (importId: string, rowId: string, reason: string, cookie = ctx.admin) =>
	post(`/payroll/reconciliations/${importId}/rows/${rowId}/ignore`, cookie, { reason });
export const apply = (importId: string, cookie = ctx.admin) =>
	post(`/payroll/reconciliations/${importId}/apply`, cookie);
export const cancelImport = (importId: string, cookie = ctx.admin) =>
	post(`/payroll/reconciliations/${importId}/cancel`, cookie);

// ---------- reversal / retry ----------
export const reverse = (
	batchId: string,
	itemId: string,
	body: Record<string, unknown> = {},
	cookie = ctx.admin
) =>
	post(`/payroll/payment-batches/${batchId}/items/${itemId}/reverse`, cookie, {
		reason: 'QA: bank returned the transfer',
		bankReference: 'QA-REV-001',
		effectiveDate: today(),
		...body
	});
export const retry = (batchId: string, sourceItemIds: string[], cookie = ctx.admin, body = {}) =>
	post(`/payroll/payment-batches/${batchId}/retry`, cookie, { sourceItemIds, ...body });
export async function retryOk(batchId: string, sourceItemIds: string[]) {
	const res = await retry(batchId, sourceItemIds);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as Batch15;
}
export const confirmPaid = (batchId: string, itemId: string, reference = `QA-${uid()}`) =>
	post(`/payroll/payment-batches/${batchId}/items/${itemId}/confirm`, ctx.admin, {
		status: 'PAID',
		paymentReference: reference,
		paidAt: `${today()}T05:00:00.000Z`
	});
export const confirmFailed = (batchId: string, itemId: string) =>
	post(`/payroll/payment-batches/${batchId}/items/${itemId}/confirm`, ctx.admin, {
		status: 'FAILED',
		failureCode: 'QA_FAIL',
		failureReason: 'QA: rejected by bank'
	});

/** validate + export a (retry) batch with a Phase 15 profile */
export async function validateAndExport(batchId: string, profileId: string) {
	const v = await post(`/payroll/payment-batches/${batchId}/validate`, ctx.admin);
	expect(v.status, JSON.stringify(v.body)).toBe(200);
	expect(v.body.data.batch.status).toBe('VALIDATED');
	const ex = await exportFile(batchId, profileId);
	expect(ex.res.status, ex.bytes.toString()).toBe(200);
	return ex;
}

export async function viewOnlyUser() {
	return userWithPermissions(['payroll.payment.view', 'employees.view_all']);
}
