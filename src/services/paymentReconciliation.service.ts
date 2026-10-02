import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
	PaymentReconciliationProfile,
	PaymentReconciliationRow,
	PayrollPaymentItem,
	ReconciliationMatchState,
	ReconciliationNormalizedStatus
} from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { idCol } from '../lib/sqlIds.js';
import { AppError, Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { moneyString } from '../lib/money.js';
import { maskAccountNumber } from '../lib/sensitiveCrypto.js';
import { parseDateOnly, todayInLaos } from '../lib/dates.js';
import { derivePaymentBatchStatus, POST_EXPORT_BATCH_STATUSES } from '../lib/paymentStatus.js';
import {
	excelSerialToDate,
	RECON_FIELDS,
	RECON_LIMITS,
	readReconciliationFile,
	ReconFileError,
	safeFileName,
	type RawCell,
	type RawRow,
	type ReconField
} from '../lib/reconciliationFile.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { itemsWithLiveRetry } from './paymentObligation.service.js';
import { lockBatch, notifyPaymentPaid } from './payrollPayment.service.js';
import type {
	ReconProfileCreateInput,
	ReconProfileUpdateInput,
	StatusMapping
} from '../validation/reconciliation.schema.js';

/**
 * BANK RECONCILIATION (Phase 15 §11-34). No bank API: HR uploads the bank's RESULT file for an exported
 * batch, reviews it, then APPLIES it.
 *
 *   upload ──▶ import (PENDING_REVIEW | READY) ──review: match / ignore──▶ READY ──apply──▶ APPLIED
 *                              └──────────────── cancel ─────────────────▶ CANCELLED
 *
 *  - The uploaded file is UNTRUSTED (see lib/reconciliationFile.ts). The raw file is NOT stored: only a
 *    safe file name, its SHA-256 and the normalized MAPPED fields of each row.
 *  - IDEMPOTENT: (batch, profile, file hash) is unique — the same file again returns the same import
 *    (no new rows, no new audit event, nothing re-applied).
 *  - IMPORT NEVER CHANGES A PAYMENT ITEM. Only Apply does, in one transaction under the batch + import
 *    row locks, with a compare-and-set on every item and on the import status.
 *  - AUTOMATIC matching is ONLY by exact instructionReference within the batch. Never by name, account
 *    number, amount or row order. Anything else is a reviewer's explicit MANUAL match (same batch,
 *    BANK_TRANSFER, compatible amount / currency) — the only route for Phase 14 (legacy) batches.
 *  - A bank result that contradicts a recorded PAID (FAILED / REVERSED) is a CONFLICT
 *    (REVERSAL_REQUIRED): PAID is never undone silently — the explicit Reversal flow must be used.
 *  - Batch status after Apply is derived from item statuses (derivePaymentBatchStatus).
 */
type Tx = Prisma.TransactionClient;

export const RECON_FIELD_LABEL: Record<ReconField, string> = {
	INSTRUCTION_REFERENCE: 'ເລກອ້າງອີງຄຳສັ່ງຈ່າຍ (Instruction Reference) — ໃຊ້ຈັບຄູ່ອັດຕະໂນມັດ',
	BANK_TRANSACTION_REFERENCE: 'ເລກອ້າງອີງທຸລະກຳຂອງທະນາຄານ (Bank Transaction Reference)',
	STATUS: 'ສະຖານະຈາກທະນາຄານ (Status)',
	AMOUNT: 'ຈຳນວນເງິນ (Amount)',
	CURRENCY: 'ສະກຸນເງິນ (Currency)',
	PAID_DATE: 'ວັນທີຈ່າຍ (Paid Date)',
	FAILURE_CODE: 'ລະຫັດຄວາມຜິດພາດ (Failure Code)',
	FAILURE_REASON: 'ເຫດຜົນ (Failure Reason)'
};

export const RECON_TEMPLATE = {
	code: 'GENERIC_RESULT_CSV',
	name: 'ຜົນການຈ່າຍ CSV ທົ່ວໄປ (Generic result CSV)',
	format: 'CSV' as const,
	delimiter: ',' as const,
	hasHeader: true,
	dateFormat: 'YYYY-MM-DD' as const,
	columns: [
		{ field: 'INSTRUCTION_REFERENCE' as const, column: 'Instruction Reference' },
		{ field: 'BANK_TRANSACTION_REFERENCE' as const, column: 'Bank Reference' },
		{ field: 'STATUS' as const, column: 'Status' },
		{ field: 'AMOUNT' as const, column: 'Amount' },
		{ field: 'CURRENCY' as const, column: 'Currency' },
		{ field: 'PAID_DATE' as const, column: 'Paid Date' },
		{ field: 'FAILURE_CODE' as const, column: 'Failure Code' },
		{ field: 'FAILURE_REASON' as const, column: 'Failure Reason' }
	],
	statusMapping: {
		PAID: ['SUCCESS', 'PAID', 'S', '00'],
		FAILED: ['FAILED', 'REJECTED', 'F'],
		REVERSED: ['REVERSED', 'RETURNED', 'REV']
	}
};

export function reconFieldCatalog() {
	return {
		fields: RECON_FIELDS.map((f) => ({
			field: f,
			label: RECON_FIELD_LABEL[f],
			required: f === 'INSTRUCTION_REFERENCE' || f === 'STATUS'
		})),
		template: RECON_TEMPLATE,
		limits: {
			maxBytes: RECON_LIMITS.maxBytes,
			maxRows: RECON_LIMITS.maxRows,
			formats: ['.csv', '.xlsx']
		}
	};
}

// ============================================================================================
// reconciliation profiles
// ============================================================================================

export interface ReconProfileConfig {
	code: string;
	name: string;
	format: 'CSV' | 'XLSX';
	delimiter: string | null;
	encoding: string | null;
	sheetName: string | null;
	hasHeader: boolean;
	dateFormat: string;
	columns: { field: ReconField; column: string }[];
	statusMapping: StatusMapping;
}

function configOf(p: PaymentReconciliationProfile): ReconProfileConfig {
	return {
		code: p.code,
		name: p.name,
		format: p.format,
		delimiter: p.delimiter,
		encoding: p.encoding,
		sheetName: p.sheetName,
		hasHeader: p.hasHeader,
		dateFormat: p.dateFormat ?? 'YYYY-MM-DD',
		columns: (p.columnMappingJson as unknown as ReconProfileConfig['columns']) ?? [],
		statusMapping: p.statusMappingJson as unknown as StatusMapping
	};
}

function presentProfile(p: PaymentReconciliationProfile) {
	return {
		id: p.id,
		companyId: p.companyId,
		...configOf(p),
		status: p.status,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt
	};
}

function normalizeProfile(input: ReconProfileUpdateInput) {
	const mapping: StatusMapping = {
		PAID: input.statusMapping.PAID.map((v) => v.trim()),
		FAILED: input.statusMapping.FAILED.map((v) => v.trim()),
		REVERSED: input.statusMapping.REVERSED.map((v) => v.trim())
	};
	return {
		name: input.name,
		format: input.format,
		delimiter: input.format === 'CSV' ? (input.delimiter ?? ',') : null,
		encoding: input.format === 'CSV' ? 'UTF-8' : null,
		sheetName: input.format === 'XLSX' ? (input.sheetName ?? null) : null,
		hasHeader: input.hasHeader,
		dateFormat: input.dateFormat,
		columnMappingJson: input.columns.map((c) => ({
			field: c.field,
			column: c.column.trim()
		})) as unknown as Prisma.InputJsonArray,
		statusMappingJson: mapping as unknown as Prisma.InputJsonObject,
		...(input.status ? { status: input.status } : {})
	};
}

export async function listProfiles(query: { companyId?: number; status?: 'ACTIVE' | 'INACTIVE' }) {
	const rows = await prisma.paymentReconciliationProfile.findMany({
		where: {
			...(query.companyId ? { companyId: query.companyId } : {}),
			...(query.status ? { status: query.status } : {})
		},
		orderBy: [{ status: 'asc' }, { code: 'asc' }]
	});
	return { items: rows.map(presentProfile) };
}

export async function getProfile(id: number) {
	const p = await prisma.paymentReconciliationProfile.findUnique({ where: { id } });
	if (!p) throw Errors.notFound('ບໍ່ພົບຮູບແບບຜົນການຈ່າຍ');
	return presentProfile(p);
}

export async function createProfile(input: ReconProfileCreateInput, actorUserId: number) {
	const company = await prisma.company.findUnique({
		where: { id: input.companyId },
		select: { id: true }
	});
	if (!company) throw Errors.badRequest('COMPANY_NOT_FOUND', 'ບໍ່ພົບບໍລິສັດ');
	try {
		const p = await prisma.$transaction(async (tx) => {
			const row = await tx.paymentReconciliationProfile.create({
				data: {
					companyId: input.companyId,
					code: input.code,
					...normalizeProfile(input),
					createdByUserId: actorUserId
				}
			});
			await writeAuditEvent(tx, {
				action: AuditAction.RECONCILIATION_PROFILE_CREATED,
				entityType: AuditEntity.PAYMENT_RECONCILIATION_PROFILE,
				entityId: row.id,
				companyId: row.companyId,
				actorUserId,
				metadata: {
					reconciliationProfileId: row.id,
					code: row.code,
					format: row.format,
					fields: input.columns.map((c) => c.field)
				}
			});
			return row;
		});
		return presentProfile(p);
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict('RECON_PROFILE_CODE_EXISTS', 'ລະຫັດນີ້ມີຢູ່ແລ້ວໃນບໍລິສັດນີ້');
		}
		throw err;
	}
}

/** Editing a profile never changes an existing import (each import froze its configuration). */
export async function updateProfile(
	id: number,
	input: ReconProfileUpdateInput,
	actorUserId: number
) {
	const p = await prisma.$transaction(async (tx) => {
		const before = await tx.paymentReconciliationProfile.findUnique({ where: { id } });
		if (!before) throw Errors.notFound('ບໍ່ພົບຮູບແບບຜົນການຈ່າຍ');
		const row = await tx.paymentReconciliationProfile.update({
			where: { id },
			data: normalizeProfile(input)
		});
		await writeAuditEvent(tx, {
			action: AuditAction.RECONCILIATION_PROFILE_UPDATED,
			entityType: AuditEntity.PAYMENT_RECONCILIATION_PROFILE,
			entityId: id,
			companyId: row.companyId,
			actorUserId,
			metadata: {
				reconciliationProfileId: id,
				code: row.code,
				format: row.format,
				status: row.status,
				fields: input.columns.map((c) => c.field)
			}
		});
		return row;
	});
	return presentProfile(p);
}

// ============================================================================================
// row normalization (only mapped, allowed fields — everything else was never read)
// ============================================================================================

/** issues found while READING a row: the row stays INVALID (it can only be ignored) */
const PARSE_ISSUES = new Set([
	'MISSING_STATUS',
	'UNKNOWN_EXTERNAL_STATUS',
	'INVALID_AMOUNT',
	'INVALID_CURRENCY',
	'INVALID_PAID_DATE',
	'PAID_DATE_IN_FUTURE',
	'VALUE_TOO_LONG',
	'CELL_ERROR'
]);

interface NormalizedRow {
	rowNumber: number;
	instructionReference: string | null;
	bankTransactionReference: string | null;
	externalStatus: string;
	normalizedStatus: ReconciliationNormalizedStatus;
	amount: Prisma.Decimal | null;
	currencyCode: string | null;
	paidDate: Date | null;
	failureCode: string | null;
	failureReason: string | null;
	parseIssue: string | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g;

function textOf(cell: RawCell | undefined): string | null {
	if (cell === null || cell === undefined) return null;
	if (typeof cell === 'object') return null;
	const s = (typeof cell === 'number' ? String(cell) : cell).replace(CONTROL, ' ').trim();
	return s === '' ? null : s;
}

function parseAmount(cell: RawCell | undefined): Prisma.Decimal | null | 'INVALID' {
	if (cell === null || cell === undefined) return null;
	if (typeof cell === 'object') return 'INVALID';
	let s = typeof cell === 'number' ? String(cell) : cell.trim().replace(/\s+/g, '');
	if (s === '') return null;
	if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
	if (!/^-?\d+(\.\d+)?$/.test(s) && typeof cell !== 'number') return 'INVALID';
	try {
		const d = new Prisma.Decimal(s);
		if (!d.isFinite() || d.decimalPlaces() > 2 || d.abs().greaterThan('9999999999999999.99')) {
			return 'INVALID';
		}
		return d;
	} catch {
		return 'INVALID';
	}
}

function parseDateCell(cell: RawCell | undefined, fmt: string): Date | null | 'INVALID' {
	if (cell === null || cell === undefined) return null;
	if (typeof cell === 'object') return 'INVALID';
	if (typeof cell === 'number') return excelSerialToDate(cell) ?? 'INVALID';
	const s = cell.trim();
	if (s === '') return null;
	const iso = (y: string, m: string, d: string) => parseDateOnly(`${y}-${m}-${d}`) ?? 'INVALID';
	let m: RegExpExecArray | null;
	switch (fmt) {
		case 'DD/MM/YYYY':
			if ((m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s))) return iso(m[3]!, m[2]!, m[1]!);
			break;
		case 'DD-MM-YYYY':
			if ((m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s))) return iso(m[3]!, m[2]!, m[1]!);
			break;
		case 'MM/DD/YYYY':
			if ((m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s))) return iso(m[3]!, m[1]!, m[2]!);
			break;
		case 'YYYYMMDD':
			if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return iso(m[1]!, m[2]!, m[3]!);
			break;
	}
	// ISO YYYY-MM-DD is always accepted
	return parseDateOnly(s) ?? 'INVALID';
}

/** trim + case-insensitive EXACT match (never a substring) */
function mapStatus(external: string, mapping: StatusMapping): ReconciliationNormalizedStatus {
	const key = external.trim().toUpperCase();
	for (const s of ['PAID', 'FAILED', 'REVERSED'] as const) {
		if (mapping[s].some((v) => v.trim().toUpperCase() === key)) return s;
	}
	return 'UNKNOWN';
}

export function normalizeRow(raw: RawRow, cfg: ReconProfileConfig, today: Date): NormalizedRow {
	const v = raw.values;
	let issue: string | null = null;
	const flag = (code: string) => {
		issue ??= code;
	};
	if (Object.values(v).some((c) => c !== null && typeof c === 'object')) flag('CELL_ERROR');
	const limited = (s: string | null, max: number) => {
		if (s && s.length > max) {
			flag('VALUE_TOO_LONG');
			return s.slice(0, max);
		}
		return s;
	};
	const externalStatus = limited(textOf(v.STATUS), 50) ?? '';
	let normalizedStatus: ReconciliationNormalizedStatus = 'UNKNOWN';
	if (!externalStatus) flag('MISSING_STATUS');
	else {
		normalizedStatus = mapStatus(externalStatus, cfg.statusMapping);
		if (normalizedStatus === 'UNKNOWN') flag('UNKNOWN_EXTERNAL_STATUS');
	}
	const amount = parseAmount(v.AMOUNT);
	if (amount === 'INVALID') flag('INVALID_AMOUNT');
	let currencyCode = textOf(v.CURRENCY)?.toUpperCase() ?? null;
	if (currencyCode && !/^[A-Z]{3}$/.test(currencyCode)) {
		flag('INVALID_CURRENCY');
		currencyCode = currencyCode.slice(0, 3);
	}
	let paidDate = parseDateCell(v.PAID_DATE, cfg.dateFormat);
	if (paidDate === 'INVALID') {
		flag('INVALID_PAID_DATE');
		paidDate = null;
	} else if (paidDate && paidDate.getTime() > today.getTime()) {
		flag('PAID_DATE_IN_FUTURE');
	}
	return {
		rowNumber: raw.rowNumber,
		instructionReference: limited(textOf(v.INSTRUCTION_REFERENCE), 120),
		bankTransactionReference: limited(textOf(v.BANK_TRANSACTION_REFERENCE), 100),
		externalStatus,
		normalizedStatus,
		amount: amount === 'INVALID' ? null : amount,
		currencyCode,
		paidDate,
		failureCode: limited(textOf(v.FAILURE_CODE), 50),
		failureReason: limited(textOf(v.FAILURE_REASON), 500),
		parseIssue: issue
	};
}

// ============================================================================================
// evaluation: auto match, compatibility, duplicates → row states + import status
// ============================================================================================

type Outcome = 'PAID' | 'FAILED' | 'NO_CHANGE';
type Compat = { ok: true; action: Outcome } | { ok: false; issue: string };

const eqText = (a: string | null, b: string | null) =>
	!a || !b || a.trim().toUpperCase() === b.trim().toUpperCase();

/** What the bank said vs what is recorded for the item (§28-31). */
function compat(
	row: Pick<PaymentReconciliationRow, 'normalizedStatus' | 'bankTransactionReference'>,
	item: Pick<PayrollPaymentItem, 'status' | 'paymentReference'>,
	hasLiveRetry: boolean
): Compat {
	const s = item.status;
	switch (row.normalizedStatus) {
		case 'PAID':
			if (s === 'EXPORTED') return { ok: true, action: 'PAID' };
			if (s === 'FAILED') {
				// a live retry means the payment is being made THERE — paying this one too pays twice
				return hasLiveRetry ? { ok: false, issue: 'RETRY_EXISTS' } : { ok: true, action: 'PAID' };
			}
			if (s === 'PAID') {
				return eqText(row.bankTransactionReference, item.paymentReference)
					? { ok: true, action: 'NO_CHANGE' }
					: { ok: false, issue: 'ALREADY_PAID_DIFFERENT_REFERENCE' };
			}
			if (s === 'REVERSED') return { ok: false, issue: 'ITEM_REVERSED' };
			return { ok: false, issue: 'ITEM_NOT_RECONCILABLE' };
		case 'FAILED':
		case 'REVERSED':
			if (s === 'EXPORTED') return { ok: true, action: 'FAILED' };
			if (s === 'PAID') return { ok: false, issue: 'REVERSAL_REQUIRED' };
			if (s === 'FAILED' || s === 'REVERSED') return { ok: true, action: 'NO_CHANGE' };
			return { ok: false, issue: 'ITEM_NOT_RECONCILABLE' };
		default:
			return { ok: false, issue: 'UNKNOWN_EXTERNAL_STATUS' };
	}
}

interface Evaluated {
	matchState: ReconciliationMatchState;
	matchedPaymentItemId: number | null;
	matchMethod: string | null;
	issueCode: string | null;
}

const OPEN = ['PENDING_REVIEW', 'READY'] as const;

/**
 * Re-evaluates every row of an OPEN import against the CURRENT batch items and persists the result
 * (rows + counts + READY / PENDING_REVIEW). Pure bookkeeping — never touches a payment item.
 */
async function evaluateImport(tx: Tx, importId: number) {
	const imp = await tx.paymentReconciliationImport.findUniqueOrThrow({ where: { id: importId } });
	const rows = await tx.paymentReconciliationRow.findMany({
		where: { reconciliationImportId: importId },
		orderBy: { rowNumber: 'asc' }
	});
	if (!(OPEN as readonly string[]).includes(imp.status)) return { imp, rows };
	const items = await tx.payrollPaymentItem.findMany({
		where: { paymentBatchId: imp.paymentBatchId }
	});
	const retries = await itemsWithLiveRetry(
		tx,
		items.map((i) => i.id)
	);
	const byId = new Map(items.map((i) => [i.id, i]));
	const byRef = new Map(
		items.filter((i) => i.instructionReference).map((i) => [i.instructionReference!, i])
	);

	const next = new Map<number, Evaluated>();
	for (const row of rows) {
		if (row.matchState === 'IGNORED') continue;
		if (row.matchState === 'INVALID' && row.issueCode && PARSE_ISSUES.has(row.issueCode)) continue;
		let item: PayrollPaymentItem | undefined;
		let method: 'AUTO' | 'MANUAL' | null = null;
		let unmatchedIssue: string | null = null;
		if (row.matchMethod === 'MANUAL' && row.matchedPaymentItemId) {
			item = byId.get(row.matchedPaymentItemId);
			method = 'MANUAL';
		} else if (row.instructionReference) {
			const hit = byRef.get(row.instructionReference);
			// exact, case-sensitive instruction reference ONLY — and never onto a CASH item
			if (hit && hit.paymentMethod === 'BANK_TRANSFER') {
				item = hit;
				method = 'AUTO';
			} else if (hit) unmatchedIssue = 'ITEM_NOT_BANK_TRANSFER';
		}
		if (!item) {
			next.set(row.id, {
				matchState: 'UNMATCHED',
				matchedPaymentItemId: null,
				matchMethod: null,
				issueCode:
					unmatchedIssue ??
					(row.instructionReference
						? 'INSTRUCTION_REFERENCE_NOT_FOUND'
						: 'MISSING_INSTRUCTION_REFERENCE')
			});
			continue;
		}
		const base = { matchedPaymentItemId: item.id, matchMethod: method };
		let issue: string | null = null;
		if (item.paymentBatchId !== imp.paymentBatchId) issue = 'WRONG_BATCH';
		else if (item.paymentMethod !== 'BANK_TRANSFER') issue = 'ITEM_NOT_BANK_TRANSFER';
		else if (row.amount && !row.amount.equals(item.amount)) issue = 'AMOUNT_MISMATCH';
		else if (row.currencyCode && row.currencyCode !== item.currencyCode)
			issue = 'CURRENCY_MISMATCH';
		else {
			const c = compat(row, item, retries.has(item.id));
			if (!c.ok) issue = c.issue;
		}
		next.set(row.id, { ...base, matchState: issue ? 'CONFLICT' : 'MATCHED', issueCode: issue });
	}

	// two (or more) rows resolving to the SAME item: identical rows → the extra ones are duplicates of
	// the first; different results for one instruction → all conflict (the reviewer must decide)
	const groups = new Map<number, PaymentReconciliationRow[]>();
	for (const row of rows) {
		const ev = next.get(row.id);
		if (!ev?.matchedPaymentItemId) continue;
		const list = groups.get(ev.matchedPaymentItemId) ?? [];
		list.push(row);
		groups.set(ev.matchedPaymentItemId, list);
	}
	const signature = (r: PaymentReconciliationRow) =>
		JSON.stringify([
			r.normalizedStatus,
			r.bankTransactionReference,
			r.amount?.toFixed(2) ?? null,
			r.currencyCode,
			r.paidDate?.toISOString() ?? null,
			r.failureCode
		]);
	for (const list of groups.values()) {
		if (list.length < 2) continue;
		const identical = new Set(list.map(signature)).size === 1;
		list.forEach((r, i) => {
			const ev = next.get(r.id)!;
			if (identical && i === 0) return;
			next.set(r.id, {
				...ev,
				matchState: 'CONFLICT',
				issueCode: identical ? 'DUPLICATE_BANK_RESULT_ROW' : 'DUPLICATE_INSTRUCTION_REFERENCE'
			});
		});
	}

	for (const row of rows) {
		const ev = next.get(row.id);
		if (!ev) continue;
		if (
			ev.matchState !== row.matchState ||
			ev.issueCode !== row.issueCode ||
			ev.matchedPaymentItemId !== row.matchedPaymentItemId ||
			ev.matchMethod !== row.matchMethod
		) {
			await tx.paymentReconciliationRow.update({ where: { id: row.id }, data: ev });
			Object.assign(row, ev);
		}
	}
	const count = (s: ReconciliationMatchState) => rows.filter((r) => r.matchState === s).length;
	const counts = {
		rowCount: rows.length,
		matchedCount: count('MATCHED'),
		unmatchedCount: count('UNMATCHED'),
		conflictCount: count('CONFLICT'),
		invalidCount: count('INVALID'),
		ignoredCount: count('IGNORED')
	};
	const ready =
		rows.length > 0 &&
		counts.unmatchedCount === 0 &&
		counts.conflictCount === 0 &&
		counts.invalidCount === 0;
	const updated = await tx.paymentReconciliationImport.update({
		where: { id: importId },
		data: { ...counts, status: ready ? 'READY' : 'PENDING_REVIEW' }
	});
	return { imp: updated, rows };
}

// ============================================================================================
// import (upload) — preview / review first; never changes a payment item
// ============================================================================================

export class UploadedFile {
	constructor(
		public readonly originalName: string,
		public readonly bytes: Buffer
	) {}
}

function fileError(err: ReconFileError): AppError {
	return new AppError(
		err.code === 'FILE_TOO_LARGE' ? 413 : 400,
		err.code,
		err.message,
		err.details
	);
}

const notExported = () =>
	Errors.conflict(
		'RECONCILIATION_BATCH_NOT_EXPORTED',
		'ນຳເຂົ້າຜົນຈາກທະນາຄານໄດ້ສະເພາະຊຸດການຈ່າຍທີ່ສົ່ງອອກໄຟລ໌ແລ້ວ'
	);

/**
 * POST /payroll/payment-batches/:id/reconciliations/import. Returns the import id and whether it was
 * an idempotent repeat of an identical file.
 */
export async function importFile(
	batchId: number,
	profileId: number,
	file: UploadedFile,
	actorUserId: number
): Promise<{ importId: number; duplicate: boolean }> {
	const batch = await prisma.payrollPaymentBatch.findUnique({ where: { id: batchId } });
	if (!batch) throw Errors.notFound('ບໍ່ພົບຊຸດການຈ່າຍ');
	if (!(POST_EXPORT_BATCH_STATUSES as readonly string[]).includes(batch.status))
		throw notExported();
	const profile = await prisma.paymentReconciliationProfile.findUnique({
		where: { id: profileId }
	});
	// another company's profile is indistinguishable from a missing one
	if (!profile || profile.companyId !== batch.companyId) {
		throw Errors.notFound('ບໍ່ພົບຮູບແບບຜົນການຈ່າຍ');
	}
	if (profile.status !== 'ACTIVE') {
		throw Errors.conflict('RECON_PROFILE_INACTIVE', 'ຮູບແບບຜົນການຈ່າຍນີ້ຖືກປິດການໃຊ້ງານແລ້ວ');
	}
	const fileHash = createHash('sha256').update(file.bytes).digest('hex');
	const key = {
		paymentBatchId_reconciliationProfileId_fileHash: {
			paymentBatchId: batchId,
			reconciliationProfileId: profileId,
			fileHash
		}
	};
	// IDEMPOTENT: the same file for the same batch + profile is the existing import
	const existing = await prisma.paymentReconciliationImport.findUnique({ where: key });
	if (existing) return { importId: existing.id, duplicate: true };

	const cfg = configOf(profile);
	let raw: RawRow[];
	try {
		raw = readReconciliationFile(file.bytes, file.originalName, cfg);
	} catch (err) {
		if (err instanceof ReconFileError) throw fileError(err);
		throw err;
	}
	const today = todayInLaos(serverNow());
	const normalized = raw.map((r) => normalizeRow(r, cfg, today));
	const fileName = safeFileName(file.originalName);

	try {
		const importId = await prisma.$transaction(
			async (tx) => {
				const imp = await tx.paymentReconciliationImport.create({
					data: {
						companyId: batch.companyId,
						paymentBatchId: batchId,
						reconciliationProfileId: profileId,
						fileName,
						fileHash,
						format: cfg.format,
						profileSnapshotJson: cfg as unknown as Prisma.InputJsonObject,
						status: 'PENDING_REVIEW',
						importedByUserId: actorUserId
					}
				});
				await tx.paymentReconciliationRow.createMany({
					data: normalized.map((n) => ({
						reconciliationImportId: imp.id,
						rowNumber: n.rowNumber,
						instructionReference: n.instructionReference,
						bankTransactionReference: n.bankTransactionReference,
						externalStatus: n.externalStatus,
						normalizedStatus: n.normalizedStatus,
						amount: n.amount,
						currencyCode: n.currencyCode,
						paidDate: n.paidDate,
						failureCode: n.failureCode,
						failureReason: n.failureReason,
						matchState: n.parseIssue ? 'INVALID' : 'UNMATCHED',
						issueCode: n.parseIssue
					}))
				});
				const { imp: evaluated } = await evaluateImport(tx, imp.id);
				await writeAuditEvent(tx, {
					action: AuditAction.PAYROLL_PAYMENT_RECONCILIATION_IMPORTED,
					entityType: AuditEntity.PAYMENT_RECONCILIATION_IMPORT,
					entityId: imp.id,
					companyId: batch.companyId,
					actorUserId,
					metadata: {
						importId: imp.id,
						batchId,
						profileId,
						fileHash,
						format: cfg.format,
						rowCount: evaluated.rowCount,
						matchedCount: evaluated.matchedCount,
						unmatchedCount: evaluated.unmatchedCount,
						conflictCount: evaluated.conflictCount,
						invalidCount: evaluated.invalidCount,
						status: evaluated.status
					}
				});
				return imp.id;
			},
			{ timeout: 60_000, maxWait: 15_000 }
		);
		return { importId, duplicate: false };
	} catch (err) {
		// a concurrent upload of the same file created the import first → it IS this import
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			const again = await prisma.paymentReconciliationImport.findUnique({ where: key });
			if (again) return { importId: again.id, duplicate: true };
		}
		throw err;
	}
}

// ============================================================================================
// read
// ============================================================================================

const USER = { select: { id: true, displayName: true } } as const;

function presentImportHead(
	imp: Prisma.PaymentReconciliationImportGetPayload<{
		include: {
			profile: { select: { id: true; code: true; name: true } };
			importedBy: typeof USER;
			appliedBy: typeof USER;
			cancelledBy: typeof USER;
		};
	}>
) {
	return {
		id: imp.id,
		paymentBatchId: imp.paymentBatchId,
		fileName: imp.fileName,
		fileHash: imp.fileHash,
		format: imp.format,
		status: imp.status,
		rowCount: imp.rowCount,
		matchedCount: imp.matchedCount,
		unmatchedCount: imp.unmatchedCount,
		conflictCount: imp.conflictCount,
		invalidCount: imp.invalidCount,
		ignoredCount: imp.ignoredCount,
		profile: imp.profile,
		importedBy: imp.importedBy,
		importedAt: imp.importedAt,
		appliedBy: imp.appliedBy,
		appliedAt: imp.appliedAt,
		cancelledBy: imp.cancelledBy,
		cancelledAt: imp.cancelledAt
	};
}

const HEAD_INCLUDE = {
	profile: { select: { id: true, code: true, name: true } },
	importedBy: USER,
	appliedBy: USER,
	cancelledBy: USER
} as const;

/** GET /payroll/payment-batches/:id/reconciliations — the batch's import history. */
export async function listBatchImports(batchId: number) {
	const batch = await prisma.payrollPaymentBatch.findUnique({
		where: { id: batchId },
		select: { id: true }
	});
	if (!batch) throw Errors.notFound('ບໍ່ພົບຊຸດການຈ່າຍ');
	const rows = await prisma.paymentReconciliationImport.findMany({
		where: { paymentBatchId: batchId },
		include: HEAD_INCLUDE,
		orderBy: [{ importedAt: 'desc' }, { id: 'desc' }]
	});
	return { items: rows.map(presentImportHead) };
}

/**
 * GET /payroll/reconciliations/:id — an import for review: rows, matched employees, candidates for a
 * manual match (MASKED accounts; amounts only with payroll.view). An open import is re-evaluated first
 * (e.g. after an explicit reversal resolved a REVERSAL_REQUIRED conflict).
 */
export async function getImport(id: number, canSeeAmounts: boolean) {
	const found = await prisma.paymentReconciliationImport.findUnique({
		where: { id },
		select: { id: true, status: true }
	});
	if (!found) throw Errors.notFound('ບໍ່ພົບການນຳເຂົ້າຜົນຈາກທະນາຄານ');
	if ((OPEN as readonly string[]).includes(found.status)) {
		await prisma.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT ${idCol()} AS id FROM payment_reconciliation_imports WHERE ${idCol()} = ${id} FOR UPDATE`;
			await evaluateImport(tx, id);
		});
	}
	const imp = await prisma.paymentReconciliationImport.findUniqueOrThrow({
		where: { id },
		include: {
			...HEAD_INCLUDE,
			batch: {
				select: {
					id: true,
					batchNumber: true,
					batchKind: true,
					sequenceNo: true,
					status: true,
					currencyCode: true,
					company: { select: { id: true, nameLao: true } },
					run: { select: { period: { select: { name: true } } } }
				}
			},
			rows: {
				orderBy: { rowNumber: 'asc' },
				include: { ignoredBy: USER, matchedBy: USER }
			}
		}
	});
	const items = await prisma.payrollPaymentItem.findMany({
		where: { paymentBatchId: imp.paymentBatchId },
		orderBy: [{ employeeCodeSnapshot: 'asc' }, { id: 'asc' }]
	});
	const byId = new Map(items.map((i) => [i.id, i]));
	const bankItems = items.filter(
		(i) => i.paymentMethod === 'BANK_TRANSFER' && i.status !== 'CANCELLED'
	);
	const matchedRowOf = new Map<number, number>();
	for (const r of imp.rows) {
		if (r.matchedPaymentItemId && r.matchState !== 'IGNORED') {
			matchedRowOf.set(r.matchedPaymentItemId, r.rowNumber);
		}
	}
	const itemBrief = (i: PayrollPaymentItem) => ({
		id: i.id,
		employeeCode: i.employeeCodeSnapshot,
		employeeName: i.employeeNameSnapshot,
		paymentMethod: i.paymentMethod,
		bankName: i.bankNameSnapshot,
		accountNumberMasked: maskAccountNumber(i.accountNumberLast4),
		status: i.status,
		instructionReference: i.instructionReference,
		currencyCode: i.currencyCode,
		amount: canSeeAmounts ? moneyString(i.amount) : null
	});
	return {
		...presentImportHead(imp),
		batch: {
			id: imp.batch.id,
			batchNumber: imp.batch.batchNumber,
			batchKind: imp.batch.batchKind,
			sequenceNo: imp.batch.sequenceNo,
			status: imp.batch.status,
			currencyCode: imp.batch.currencyCode,
			company: imp.batch.company,
			periodName: imp.batch.run.period.name
		},
		legacyBatch: bankItems.length > 0 && bankItems.some((i) => !i.instructionReference),
		rows: imp.rows.map((r) => {
			const item = r.matchedPaymentItemId ? byId.get(r.matchedPaymentItemId) : undefined;
			return {
				id: r.id,
				rowNumber: r.rowNumber,
				instructionReference: r.instructionReference,
				bankTransactionReference: r.bankTransactionReference,
				externalStatus: r.externalStatus,
				normalizedStatus: r.normalizedStatus,
				amount: canSeeAmounts && r.amount ? moneyString(r.amount) : null,
				hasAmount: r.amount !== null,
				currencyCode: r.currencyCode,
				paidDate: r.paidDate,
				failureCode: r.failureCode,
				failureReason: r.failureReason,
				matchState: r.matchState,
				matchMethod: r.matchMethod,
				issueCode: r.issueCode,
				ignoredReason: r.ignoredReason,
				ignoredBy: r.ignoredBy,
				ignoredAt: r.ignoredAt,
				matchedBy: r.matchedBy,
				matchedAt: r.matchedAt,
				applyOutcome: r.applyOutcome,
				matchedItem: item ? itemBrief(item) : null
			};
		}),
		candidates: bankItems.map((i) => ({
			...itemBrief(i),
			matchedByRowNumber: matchedRowOf.get(i.id) ?? null
		}))
	};
}

// ============================================================================================
// review actions
// ============================================================================================

async function lockOpenImport(tx: Tx, importId: number) {
	await tx.$queryRaw`SELECT ${idCol()} AS id FROM payment_reconciliation_imports WHERE ${idCol()} = ${importId} FOR UPDATE`;
	const imp = await tx.paymentReconciliationImport.findUnique({ where: { id: importId } });
	if (!imp) throw Errors.notFound('ບໍ່ພົບການນຳເຂົ້າຜົນຈາກທະນາຄານ');
	if (imp.status === 'APPLIED') {
		throw Errors.conflict('RECONCILIATION_ALREADY_APPLIED', 'ການນຳເຂົ້ານີ້ຖືກນຳໃຊ້ (Apply) ແລ້ວ');
	}
	if (imp.status === 'CANCELLED') {
		throw Errors.conflict('RECONCILIATION_CANCELLED', 'ການນຳເຂົ້ານີ້ຖືກຍົກເລີກແລ້ວ');
	}
	return imp;
}

async function loadRow(tx: Tx, importId: number, rowId: number) {
	const row = await tx.paymentReconciliationRow.findFirst({
		where: { id: rowId, reconciliationImportId: importId }
	});
	if (!row) throw Errors.notFound('ບໍ່ພົບແຖວຂໍ້ມູນ');
	return row;
}

/**
 * POST /payroll/reconciliations/:importId/rows/:rowId/match — a reviewer's explicit match. Still
 * enforced: same batch, BANK_TRANSFER, compatible amount / currency, item not matched by another row.
 */
export async function matchRow(
	importId: number,
	rowId: number,
	paymentItemId: number,
	actorUserId: number
) {
	await prisma.$transaction(async (tx) => {
		const imp = await lockOpenImport(tx, importId);
		const row = await loadRow(tx, importId, rowId);
		if (row.matchState === 'IGNORED') {
			throw Errors.conflict('RECONCILIATION_ROW_IGNORED', 'ແຖວນີ້ຖືກລະເວັ້ນ (Ignored) ແລ້ວ');
		}
		if (row.matchState === 'INVALID') {
			throw Errors.conflict(
				'RECONCILIATION_ROW_INVALID',
				'ແຖວນີ້ຂໍ້ມູນບໍ່ຖືກຕ້ອງ — ຈັບຄູ່ບໍ່ໄດ້ (ລະເວັ້ນ ຫຼື ແກ້ໄຟລ໌ແລ້ວນຳເຂົ້າໃໝ່)'
			);
		}
		const item = await tx.payrollPaymentItem.findUnique({ where: { id: paymentItemId } });
		if (!item || item.paymentBatchId !== imp.paymentBatchId) {
			throw Errors.conflict(
				'PAYMENT_ITEM_NOT_IN_BATCH',
				'ລາຍການຈ່າຍນີ້ບໍ່ຢູ່ໃນຊຸດການຈ່າຍຂອງການນຳເຂົ້ານີ້'
			);
		}
		if (item.paymentMethod !== 'BANK_TRANSFER' || item.status === 'CANCELLED') {
			throw Errors.conflict(
				'ITEM_NOT_BANK_TRANSFER',
				'ຈັບຄູ່ໄດ້ສະເພາະລາຍການໂອນຜ່ານທະນາຄານ (ບໍ່ແມ່ນເງິນສົດ)'
			);
		}
		if (row.amount && !row.amount.equals(item.amount)) {
			throw Errors.conflict('AMOUNT_MISMATCH', 'ຈຳນວນເງິນໃນໄຟລ໌ບໍ່ກົງກັບລາຍການຈ່າຍນີ້');
		}
		if (row.currencyCode && row.currencyCode !== item.currencyCode) {
			throw Errors.conflict('CURRENCY_MISMATCH', 'ສະກຸນເງິນໃນໄຟລ໌ບໍ່ກົງກັບລາຍການຈ່າຍນີ້');
		}
		const taken = await tx.paymentReconciliationRow.findFirst({
			where: {
				reconciliationImportId: importId,
				matchedPaymentItemId: paymentItemId,
				id: { not: rowId },
				matchState: { not: 'IGNORED' }
			},
			select: { rowNumber: true }
		});
		if (taken) {
			throw Errors.conflict(
				'ITEM_ALREADY_MATCHED',
				`ລາຍການຈ່າຍນີ້ຖືກຈັບຄູ່ກັບແຖວ ${taken.rowNumber} ແລ້ວ`
			);
		}
		const now = serverNow();
		await tx.paymentReconciliationRow.update({
			where: { id: rowId },
			data: {
				matchedPaymentItemId: paymentItemId,
				matchMethod: 'MANUAL',
				matchedByUserId: actorUserId,
				matchedAt: now
			}
		});
		const { rows } = await evaluateImport(tx, importId);
		const after = rows.find((r) => r.id === rowId)!;
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_PAYMENT_RECONCILIATION_ROW_MATCHED,
			entityType: AuditEntity.PAYMENT_RECONCILIATION_IMPORT,
			entityId: importId,
			companyId: imp.companyId,
			actorUserId,
			metadata: {
				importId,
				batchId: imp.paymentBatchId,
				rowId,
				rowNumber: row.rowNumber,
				itemId: paymentItemId,
				matchMethod: 'MANUAL',
				matchState: after.matchState,
				issueCode: after.issueCode
			}
		});
	});
}

/** POST /payroll/reconciliations/:importId/rows/:rowId/ignore — reason required; the row is kept. */
export async function ignoreRow(
	importId: number,
	rowId: number,
	reason: string,
	actorUserId: number
) {
	await prisma.$transaction(async (tx) => {
		const imp = await lockOpenImport(tx, importId);
		const row = await loadRow(tx, importId, rowId);
		if (row.matchState === 'IGNORED') return; // idempotent
		await tx.paymentReconciliationRow.update({
			where: { id: rowId },
			data: {
				matchState: 'IGNORED',
				ignoredReason: reason,
				ignoredByUserId: actorUserId,
				ignoredAt: serverNow()
			}
		});
		await evaluateImport(tx, importId);
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_PAYMENT_RECONCILIATION_ROW_IGNORED,
			entityType: AuditEntity.PAYMENT_RECONCILIATION_IMPORT,
			entityId: importId,
			companyId: imp.companyId,
			actorUserId,
			// no free text (the reason stays on the row, visible to reviewers only)
			metadata: {
				importId,
				batchId: imp.paymentBatchId,
				rowId,
				rowNumber: row.rowNumber,
				previousState: row.matchState,
				previousIssueCode: row.issueCode
			}
		});
	});
}

/** POST /payroll/reconciliations/:id/cancel — an open import is closed without changing anything. */
export async function cancelImport(importId: number, actorUserId: number) {
	await prisma.$transaction(async (tx) => {
		const imp = await lockOpenImport(tx, importId);
		await tx.paymentReconciliationImport.update({
			where: { id: importId },
			data: { status: 'CANCELLED', cancelledAt: serverNow(), cancelledByUserId: actorUserId }
		});
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_PAYMENT_RECONCILIATION_CANCELLED,
			entityType: AuditEntity.PAYMENT_RECONCILIATION_IMPORT,
			entityId: importId,
			companyId: imp.companyId,
			actorUserId,
			metadata: {
				importId,
				batchId: imp.paymentBatchId,
				profileId: imp.reconciliationProfileId,
				fileHash: imp.fileHash,
				previousStatus: imp.status,
				status: 'CANCELLED'
			}
		});
	});
}

// ============================================================================================
// apply
// ============================================================================================

/** bank "paid date" (a calendar date) → noon Laos time, the same convention as manual confirmation */
const paidAtOf = (d: Date | null, now: Date) =>
	d ? new Date(`${d.toISOString().slice(0, 10)}T05:00:00.000Z`) : now;

/**
 * POST /payroll/reconciliations/:id/apply — READY imports only. Under the batch + import row locks it
 * re-evaluates every row against the CURRENT items (so nothing changed underneath), then applies each
 * MATCHED row with a compare-and-set on the item. Idempotent: an APPLIED import is returned as is.
 */
export async function applyImport(importId: number, actorUserId: number) {
	return prisma.$transaction(
		async (tx) => {
			// LOCKS FIRST, with locking reads only: InnoDB (REPEATABLE READ) takes the transaction's read
			// snapshot at the first NON-locking read — taking it after the locks means every read below
			// sees what a concurrent Apply / confirmation committed. Lock order: import → batch (the only
			// code path that holds both).
			const head = await tx.$queryRaw<{ payment_batch_id: number }[]>`
				SELECT ${idCol('payment_batch_id')} AS payment_batch_id FROM payment_reconciliation_imports WHERE ${idCol()} = ${importId} FOR UPDATE`;
			if (head.length === 0) throw Errors.notFound('ບໍ່ພົບການນຳເຂົ້າຜົນຈາກທະນາຄານ');
			await lockBatch(tx, head[0]!.payment_batch_id);
			const imp = await tx.paymentReconciliationImport.findUniqueOrThrow({
				where: { id: importId }
			});
			if (imp.status === 'APPLIED')
				return { alreadyApplied: true, paid: 0, failed: 0, noChange: 0 };
			if (imp.status === 'CANCELLED') {
				throw Errors.conflict('RECONCILIATION_CANCELLED', 'ການນຳເຂົ້ານີ້ຖືກຍົກເລີກແລ້ວ');
			}
			const batch = await tx.payrollPaymentBatch.findUniqueOrThrow({
				where: { id: imp.paymentBatchId },
				include: { run: { select: { periodId: true } } }
			});
			if (!(POST_EXPORT_BATCH_STATUSES as readonly string[]).includes(batch.status)) {
				throw notExported();
			}
			const { imp: evaluated, rows } = await evaluateImport(tx, importId);
			if (evaluated.status !== 'READY') {
				throw Errors.conflict(
					'RECONCILIATION_NOT_READY',
					'ຍັງມີແຖວທີ່ຕ້ອງກວດສອບ (ບໍ່ພົບຄູ່ / ຂັດແຍ່ງ / ບໍ່ຖືກຕ້ອງ) — ນຳໃຊ້ບໍ່ໄດ້',
					{
						unmatchedCount: evaluated.unmatchedCount,
						conflictCount: evaluated.conflictCount,
						invalidCount: evaluated.invalidCount
					}
				);
			}
			const items = await tx.payrollPaymentItem.findMany({
				where: { paymentBatchId: imp.paymentBatchId },
				include: { employee: { select: { userId: true } } }
			});
			const byId = new Map(items.map((i) => [i.id, i]));
			const retries = await itemsWithLiveRetry(
				tx,
				items.map((i) => i.id)
			);
			const now = serverNow();
			const tally = { paid: 0, failed: 0, noChange: 0 };
			for (const row of rows) {
				if (row.matchState !== 'MATCHED' || !row.matchedPaymentItemId) continue;
				const item = byId.get(row.matchedPaymentItemId)!;
				const c = compat(row, item, retries.has(item.id));
				if (!c.ok)
					throw Errors.conflict('RECONCILIATION_NOT_READY', 'ຂໍ້ມູນປ່ຽນແປງ — ກະລຸນາໂຫຼດໃໝ່');
				const reconciled = {
					reconciledAt: now,
					reconciledByUserId: actorUserId,
					reconciliationImportId: importId,
					confirmedAt: now,
					confirmedByUserId: actorUserId
				};
				if (c.action === 'PAID') {
					const cas = await tx.payrollPaymentItem.updateMany({
						where: { id: item.id, status: item.status },
						data: {
							status: 'PAID',
							paymentReference: row.bankTransactionReference ?? item.paymentReference,
							paidAt: paidAtOf(row.paidDate, now),
							...reconciled
						}
					});
					if (cas.count !== 1) throw changedUnderneath();
					tally.paid++;
					if (item.employee.userId) {
						await notifyPaymentPaid(tx, {
							userId: item.employee.userId,
							periodId: batch.run.periodId,
							itemId: item.id,
							batchId: batch.id
						});
					}
				} else if (c.action === 'FAILED') {
					const cas = await tx.payrollPaymentItem.updateMany({
						where: { id: item.id, status: item.status },
						data: {
							status: 'FAILED',
							failureCode:
								row.failureCode ??
								(row.normalizedStatus === 'REVERSED' ? 'BANK_REVERSED' : 'BANK_FAILED'),
							failureReason: row.failureReason ?? 'ທະນາຄານແຈ້ງວ່າການໂອນບໍ່ສຳເລັດ',
							...reconciled
						}
					});
					if (cas.count !== 1) throw changedUnderneath();
					tally.failed++;
				} else tally.noChange++;
				await tx.paymentReconciliationRow.update({
					where: { id: row.id },
					data: { applyOutcome: c.action }
				});
			}
			const all = await tx.payrollPaymentItem.findMany({
				where: { paymentBatchId: batch.id },
				select: { status: true }
			});
			const batchStatus = derivePaymentBatchStatus(all);
			if (batchStatus !== batch.status) {
				await tx.payrollPaymentBatch.update({
					where: { id: batch.id },
					data: {
						status: batchStatus,
						...(batchStatus === 'PAID' ? { confirmedAt: now, confirmedByUserId: actorUserId } : {})
					}
				});
			}
			const cas = await tx.paymentReconciliationImport.updateMany({
				where: { id: importId, status: 'READY' },
				data: { status: 'APPLIED', appliedAt: now, appliedByUserId: actorUserId }
			});
			if (cas.count !== 1) throw changedUnderneath();
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_PAYMENT_RECONCILIATION_APPLIED,
				entityType: AuditEntity.PAYMENT_RECONCILIATION_IMPORT,
				entityId: importId,
				companyId: imp.companyId,
				actorUserId,
				metadata: {
					importId,
					batchId: batch.id,
					profileId: imp.reconciliationProfileId,
					fileHash: imp.fileHash,
					rowCount: evaluated.rowCount,
					matchedCount: evaluated.matchedCount,
					ignoredCount: evaluated.ignoredCount,
					paidCount: tally.paid,
					failedCount: tally.failed,
					noChangeCount: tally.noChange,
					status: 'APPLIED',
					batchStatus
				}
			});
			return { alreadyApplied: false, ...tally };
		},
		{ timeout: 60_000, maxWait: 15_000 }
	);
}

const changedUnderneath = () =>
	Errors.conflict('RECONCILIATION_CONFLICT', 'ລາຍການຈ່າຍຖືກປ່ຽນແປງພ້ອມກັນ — ກະລຸນາໂຫຼດໃໝ່');
