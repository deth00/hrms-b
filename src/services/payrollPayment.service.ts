import { Prisma } from '@prisma/client';
import type {
	EmployeeBankAccount,
	EmployeePaymentProfile,
	PaymentItemStatus,
	PayrollPaymentItem
} from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { idRef } from '../lib/idFormat.js';
import { idCol } from '../lib/sqlIds.js';
import { Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { moneyString, ZERO } from '../lib/money.js';
import { canDecrypt, maskAccountNumber } from '../lib/sensitiveCrypto.js';
import {
	derivePaymentBatchStatus,
	instructionReferences,
	normalizeCode,
	POST_EXPORT_BATCH_STATUSES
} from '../lib/paymentStatus.js';
import {
	itemsWithLiveRetry,
	resolveObligations,
	type ObligationStatus
} from './paymentObligation.service.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { createNotifications, NotificationType } from './notification.service.js';
import type {
	BatchCreateInput,
	BatchListQuery,
	ItemConfirmInput
} from '../validation/payment.schema.js';

/**
 * PAYROLL PAYMENT BATCHES (Phase 14 §13-41).
 *
 *   Payroll FINALIZED ──create──▶ DRAFT ──validate (all READY)──▶ VALIDATED ──export──▶ EXPORTED
 *                                   │ ▲ rebuild (DRAFT only)            │                   │ confirm items
 *                                   └─┘                                  │                   ▼
 *                        cancel (DRAFT / VALIDATED) ──▶ CANCELLED ◀──────┘        PARTIALLY_PAID ──▶ PAID
 *
 *  - DOWNSTREAM OF PAYROLL ONLY. Amounts are the FINALIZED PayrollEmployeeResult.netPay. Nothing here
 *    calls the payroll engine or writes a payroll table (results, items, statutory rows, payslips or the
 *    approval snapshot) — payroll stays immutable; payment has its own lifecycle.
 *  - SNAPSHOT. Creation copies, per result: identity, payment method, bank details and the ENCRYPTED
 *    account number (ciphertext + IV + tag — never plaintext) plus the amount. A later bank-account
 *    change never alters an existing item; only an explicit DRAFT rebuild re-snapshots.
 *  - Validation checks the SNAPSHOT (including that the account number still decrypts).
 *  - Batch status after confirmations is DERIVED server-side from the items, never taken from the client.
 *  - PAID is final for confirmation; Phase 15 adds an explicit, append-only REVERSAL (paymentLifecycle).
 *    FAILED may later be confirmed PAID (paid by other means) — unless a retry of it is already live.
 *  - Phase 15: a run has ONE ORIGINAL batch (sequence 1) plus RETRY batches (sequence 2, 3 …) created
 *    by paymentLifecycle.service; they reuse this lifecycle (validate / export / confirm / cancel).
 *  - Audit / notifications never carry an amount or an account number.
 */
type Tx = Prisma.TransactionClient;

export const PAYMENT_ISSUES = [
	'MISSING_PAYMENT_PROFILE',
	'MISSING_BANK_ACCOUNT',
	'INACTIVE_BANK_ACCOUNT',
	'BANK_ACCOUNT_DECRYPTION_FAILED',
	'BANK_CURRENCY_MISMATCH',
	'MISSING_BANK_CODE',
	'MISSING_ACCOUNT_NAME',
	'ZERO_NET_PAY',
	'NEGATIVE_NET_PAY'
] as const;
export type PaymentIssue = (typeof PAYMENT_ISSUES)[number];

const norm = normalizeCode;

/** "PAY-{periodCode}" (normalized; never derived from employee data). */
export const batchNumberOf = (periodCode: string) => `PAY-${norm(periodCode) || 'PERIOD'}`;

export async function lockRun(tx: Tx, runId: number) {
	await tx.$queryRaw`SELECT ${idCol()} AS id FROM payroll_runs WHERE ${idCol()} = ${runId} FOR UPDATE`;
}
export async function lockBatch(tx: Tx, batchId: number) {
	await tx.$queryRaw`SELECT ${idCol()} AS id FROM payroll_payment_batches WHERE ${idCol()} = ${batchId} FOR UPDATE`;
}

// ============================================================================================
// snapshot + validation
// ============================================================================================

export type ProfileWithAccount = EmployeePaymentProfile & {
	bankAccount: EmployeeBankAccount | null;
};

interface ResultRow {
	id: number;
	employeeId: number;
	employeeCodeSnapshot: string;
	employeeNameSnapshot: string;
	netPay: Prisma.Decimal;
}

export type SnapshotFields = Pick<
	PayrollPaymentItem,
	| 'paymentMethod'
	| 'bankAccountId'
	| 'bankAccountStatusSnapshot'
	| 'bankCodeSnapshot'
	| 'bankNameSnapshot'
	| 'accountNameSnapshot'
	| 'accountNumberEncryptedSnapshot'
	| 'accountNumberIvSnapshot'
	| 'accountNumberAuthTagSnapshot'
	| 'encryptionKeyVersion'
	| 'bankCurrencySnapshot'
	| 'amount'
>;

/** The validation rules (§18-20, §52), evaluated on a SNAPSHOT — never on the live profile. */
export function paymentIssues(item: SnapshotFields, batchCurrency: string): PaymentIssue[] {
	const issues: PaymentIssue[] = [];
	const amount = new Prisma.Decimal(item.amount);
	if (amount.isZero()) issues.push('ZERO_NET_PAY');
	else if (amount.isNegative()) issues.push('NEGATIVE_NET_PAY');
	if (!item.paymentMethod) {
		issues.push('MISSING_PAYMENT_PROFILE');
		return issues;
	}
	if (item.paymentMethod === 'CASH') return issues; // no bank account needed
	if (!item.bankAccountId || !item.accountNumberEncryptedSnapshot) {
		issues.push('MISSING_BANK_ACCOUNT');
		return issues;
	}
	if (item.bankAccountStatusSnapshot !== 'ACTIVE') issues.push('INACTIVE_BANK_ACCOUNT');
	if (item.bankCurrencySnapshot !== batchCurrency) issues.push('BANK_CURRENCY_MISMATCH');
	if (!item.bankCodeSnapshot?.trim() || !item.bankNameSnapshot?.trim()) {
		issues.push('MISSING_BANK_CODE');
	}
	if (!item.accountNameSnapshot?.trim()) issues.push('MISSING_ACCOUNT_NAME');
	const decrypts = canDecrypt({
		ciphertext: item.accountNumberEncryptedSnapshot,
		iv: item.accountNumberIvSnapshot ?? '',
		authTag: item.accountNumberAuthTagSnapshot ?? '',
		keyVersion: item.encryptionKeyVersion ?? 1
	});
	if (!decrypts) issues.push('BANK_ACCOUNT_DECRYPTION_FAILED');
	return issues;
}

/**
 * The ROUTING part of a snapshot (method + bank details + encrypted number) from the employee's
 * CURRENT payment profile / primary account. Shared by original batches and Phase 15 retries.
 */
export function routingSnapshot(profile: ProfileWithAccount | undefined) {
	const active = profile && profile.status === 'ACTIVE' ? profile : null;
	const method = active?.paymentMethod ?? null;
	const account = method === 'BANK_TRANSFER' ? (active?.bankAccount ?? null) : null;
	return {
		paymentMethod: method,
		bankAccountId: account?.id ?? null,
		bankAccountStatusSnapshot: account?.status ?? null,
		bankCodeSnapshot: account?.bankCode ?? null,
		bankNameSnapshot: account?.bankName ?? null,
		bankBranchSnapshot: account?.branchName ?? null,
		accountNameSnapshot: account?.accountName ?? null,
		accountNumberEncryptedSnapshot: account?.accountNumberEncrypted ?? null,
		accountNumberIvSnapshot: account?.accountNumberIv ?? null,
		accountNumberAuthTagSnapshot: account?.accountNumberAuthTag ?? null,
		accountNumberLast4: account?.accountNumberLast4 ?? null,
		encryptionKeyVersion: account?.encryptionKeyVersion ?? null,
		bankCurrencySnapshot: account?.currencyCode ?? null
	};
}

/** One item snapshot per finalized result, from the CURRENT payment profile / primary account. */
function snapshotItem(
	batchId: number,
	batchNumber: string,
	currencyCode: string,
	r: ResultRow,
	profile: ProfileWithAccount | undefined,
	instructionReference: string
): Prisma.PayrollPaymentItemCreateManyInput {
	const fields = { ...routingSnapshot(profile), amount: r.netPay }; // EXACT finalized net pay
	const issues = paymentIssues(fields, currencyCode);
	return {
		paymentBatchId: batchId,
		payrollEmployeeResultId: r.id,
		employeeId: r.employeeId,
		employeeCodeSnapshot: r.employeeCodeSnapshot,
		employeeNameSnapshot: r.employeeNameSnapshot,
		...fields,
		currencyCode,
		transferReference: `${batchNumber}-${norm(r.employeeCodeSnapshot) || 'EMP'}`,
		// Phase 15 — immutable bank instruction id (the reconciliation matching key)
		instructionReference,
		status: issues.length > 0 ? 'BLOCKED' : 'READY',
		issuesJson: issues.length > 0 ? issues : Prisma.DbNull
	};
}

/** (Re)creates every item of a batch from the finalized results + current payment profiles. */
async function writeSnapshot(
	tx: Tx,
	batch: { id: number; batchNumber: string; currencyCode: string; payrollRunId: number }
) {
	const results = await tx.payrollEmployeeResult.findMany({
		where: { payrollRunId: batch.payrollRunId },
		select: {
			id: true,
			employeeId: true,
			employeeCodeSnapshot: true,
			employeeNameSnapshot: true,
			netPay: true
		},
		orderBy: { employeeCodeSnapshot: 'asc' }
	});
	const profiles = await tx.employeePaymentProfile.findMany({
		where: { employeeId: { in: results.map((r) => r.employeeId) } },
		include: { bankAccount: true }
	});
	const byEmployee = new Map(profiles.map((p) => [p.employeeId, p]));
	const refs = instructionReferences(
		batch.batchNumber,
		results.map((r) => r.employeeCodeSnapshot)
	);
	const data = results.map((r, i) =>
		snapshotItem(
			batch.id,
			batch.batchNumber,
			batch.currencyCode,
			r,
			byEmployee.get(r.employeeId),
			refs[i]!
		)
	);
	if (data.length > 0) await tx.payrollPaymentItem.createMany({ data });
	const total = results.reduce((s, r) => (r.netPay.greaterThan(0) ? s.plus(r.netPay) : s), ZERO);
	const blocked = data.filter((d) => d.status === 'BLOCKED').length;
	await tx.payrollPaymentBatch.update({
		where: { id: batch.id },
		data: { employeeCount: data.length, totalAmount: total }
	});
	return { employeeCount: data.length, ready: data.length - blocked, blocked };
}

// ============================================================================================
// presentation (account numbers ALWAYS masked; amounts only with payroll.view)
// ============================================================================================

const USER = { select: { id: true, displayName: true } } as const;
const BATCH_INCLUDE = {
	company: { select: { id: true, code: true, nameLao: true } },
	run: {
		select: {
			id: true,
			status: true,
			period: {
				select: {
					id: true,
					code: true,
					name: true,
					startDate: true,
					endDate: true,
					payDate: true,
					payrollMonth: true,
					cycleNumber: true
				}
			}
		}
	},
	createdBy: USER,
	validatedBy: USER,
	exportedBy: USER,
	confirmedBy: USER,
	cancelledBy: USER,
	// Phase 15 — lineage + the latest bank reconciliation of the batch
	parentBatch: { select: { id: true, batchNumber: true, sequenceNo: true, batchKind: true } },
	retryBatches: {
		select: { id: true, batchNumber: true, sequenceNo: true, status: true },
		orderBy: { sequenceNo: 'asc' }
	},
	reconciliations: {
		select: { id: true, status: true, importedAt: true },
		orderBy: [{ importedAt: 'desc' }, { id: 'desc' }],
		take: 1
	}
} satisfies Prisma.PayrollPaymentBatchInclude;
type BatchRow = Prisma.PayrollPaymentBatchGetPayload<{ include: typeof BATCH_INCLUDE }>;

const issuesOf = (item: { issuesJson: Prisma.JsonValue }) =>
	Array.isArray(item.issuesJson) ? (item.issuesJson as PaymentIssue[]) : [];

type ItemRow = PayrollPaymentItem & {
	reversal?: {
		id: number;
		reason: string;
		bankReference: string | null;
		effectiveDate: Date;
		reversedAt: Date;
		reversedBy: { id: number; displayName: string } | null;
	} | null;
};

interface ItemContext {
	/** live retry child of this item (if any) */
	retry?: { id: number; status: PaymentItemStatus; batchId: number };
	obligationStatus?: ObligationStatus;
	attemptNo?: number;
}

function presentItem(i: ItemRow, canSeeAmounts: boolean, ctx: ItemContext = {}) {
	return {
		id: i.id,
		employeeId: i.employeeId,
		employeeCode: i.employeeCodeSnapshot,
		employeeName: i.employeeNameSnapshot,
		paymentMethod: i.paymentMethod,
		bankCode: i.bankCodeSnapshot,
		bankName: i.bankNameSnapshot,
		bankBranch: i.bankBranchSnapshot,
		accountName: i.accountNameSnapshot,
		accountNumberMasked: maskAccountNumber(i.accountNumberLast4),
		bankCurrencyCode: i.bankCurrencySnapshot,
		currencyCode: i.currencyCode,
		amount: canSeeAmounts ? moneyString(i.amount) : null,
		transferReference: i.transferReference,
		status: i.status,
		issues: issuesOf(i),
		paymentReference: i.paymentReference,
		failureCode: i.failureCode,
		failureReason: i.failureReason,
		paidAt: i.paidAt,
		confirmedAt: i.confirmedAt,
		// Phase 15
		instructionReference: i.instructionReference,
		sourcePaymentItemId: i.sourcePaymentItemId,
		payrollEmployeeResultId: i.payrollEmployeeResultId,
		reconciledAt: i.reconciledAt,
		reconciliationImportId: i.reconciliationImportId,
		reversal: i.reversal
			? {
					id: i.reversal.id,
					reason: i.reversal.reason,
					bankReference: i.reversal.bankReference,
					effectiveDate: i.reversal.effectiveDate,
					reversedAt: i.reversal.reversedAt,
					reversedBy: i.reversal.reversedBy
				}
			: null,
		retryItem: ctx.retry ?? null,
		/** a FAILED / REVERSED item without a live retry may be re-issued */
		retryEligible: (i.status === 'FAILED' || i.status === 'REVERSED') && !ctx.retry,
		obligationStatus: ctx.obligationStatus ?? null,
		attemptNo: ctx.attemptNo ?? null
	};
}

function summaryOf(items: { status: PaymentItemStatus }[]) {
	const count = (s: PaymentItemStatus) => items.filter((i) => i.status === s).length;
	return {
		employees: items.length,
		ready: count('READY'),
		blocked: count('BLOCKED'),
		exported: count('EXPORTED'),
		paid: count('PAID'),
		failed: count('FAILED'),
		cancelled: count('CANCELLED'),
		reversed: count('REVERSED')
	};
}

function presentBatchHead(b: BatchRow, canSeeAmounts: boolean) {
	return {
		id: b.id,
		batchNumber: b.batchNumber,
		batchKind: b.batchKind,
		sequenceNo: b.sequenceNo,
		parentBatch: b.parentBatch,
		retryBatches: b.retryBatches,
		latestReconciliation: b.reconciliations[0] ?? null,
		status: b.status,
		currencyCode: b.currencyCode,
		paymentDate: b.paymentDate,
		employeeCount: b.employeeCount,
		totalAmount: canSeeAmounts ? moneyString(b.totalAmount) : null,
		notes: b.notes,
		company: b.company,
		run: { id: b.run.id, status: b.run.status },
		period: b.run.period,
		createdBy: b.createdBy,
		createdAt: b.createdAt,
		validatedAt: b.validatedAt,
		validatedBy: b.validatedBy,
		exportedAt: b.exportedAt,
		exportedBy: b.exportedBy,
		confirmedAt: b.confirmedAt,
		confirmedBy: b.confirmedBy,
		cancelledAt: b.cancelledAt,
		cancelledBy: b.cancelledBy
	};
}

/** Current settlement of each item's OBLIGATION (following retries), counted per status. */
function settlementOf(
	items: { payrollEmployeeResultId: number; status: PaymentItemStatus }[],
	obligations: Map<number, { status: ObligationStatus }>
) {
	const out = { paid: 0, inProgress: 0, failed: 0, reversed: 0, unpaid: 0 };
	for (const i of items) {
		if (i.status === 'CANCELLED') continue;
		const s = obligations.get(i.payrollEmployeeResultId)?.status ?? 'UNPAID';
		if (s === 'PAID') out.paid++;
		else if (s === 'IN_PROGRESS') out.inProgress++;
		else if (s === 'FAILED') out.failed++;
		else if (s === 'REVERSED') out.reversed++;
		else out.unpaid++;
	}
	return out;
}

export async function getBatch(id: number, canSeeAmounts: boolean) {
	const b = await prisma.payrollPaymentBatch.findUnique({
		where: { id },
		include: {
			...BATCH_INCLUDE,
			items: {
				orderBy: [{ employeeCodeSnapshot: 'asc' }, { id: 'asc' }],
				include: { reversal: { include: { reversedBy: USER } } }
			},
			exports: {
				orderBy: { createdAt: 'asc' },
				include: {
					profile: { select: { id: true, code: true, name: true } },
					createdBy: USER
				}
			}
		}
	});
	if (!b) throw Errors.notFound('ບໍ່ພົບຊຸດການຈ່າຍ');
	const [retries, obligations] = await Promise.all([
		itemsWithLiveRetry(
			prisma,
			b.items.map((i) => i.id)
		),
		resolveObligations(
			prisma,
			b.items.map((i) => i.payrollEmployeeResultId)
		)
	]);
	const bankItems = b.items.filter(
		(i) => i.paymentMethod === 'BANK_TRANSFER' && i.status !== 'CANCELLED'
	);
	return {
		...presentBatchHead(b, canSeeAmounts),
		summary: summaryOf(b.items),
		settlement: settlementOf(b.items, obligations),
		/** Phase 14 batches carry no instruction references → reconciliation matching is manual */
		legacyInstructionReferences:
			bankItems.length > 0 && bankItems.some((i) => !i.instructionReference),
		items: b.items.map((i) => {
			const ob = obligations.get(i.payrollEmployeeResultId);
			const idx = ob?.attempts.findIndex((a) => a.id === i.id) ?? -1;
			return presentItem(i, canSeeAmounts, {
				retry: retries.get(i.id),
				obligationStatus: ob?.status,
				attemptNo: idx >= 0 ? idx + 1 : undefined
			});
		}),
		exports: b.exports.map((e) => ({
			id: e.id,
			exportNumber: e.exportNumber,
			format: e.format,
			fileName: e.fileName,
			fileHash: e.fileHash,
			rowCount: e.rowCount,
			totalAmount: canSeeAmounts ? moneyString(e.totalAmount) : null,
			profile: e.profile,
			createdBy: e.createdBy,
			createdAt: e.createdAt
		}))
	};
}

export async function listBatches(query: BatchListQuery, canSeeAmounts: boolean) {
	const where: Prisma.PayrollPaymentBatchWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.batchKind ? { batchKind: query.batchKind } : {})
	};
	const [rows, total] = await Promise.all([
		prisma.payrollPaymentBatch.findMany({
			where,
			include: {
				...BATCH_INCLUDE,
				items: { select: { status: true, payrollEmployeeResultId: true } }
			},
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.payrollPaymentBatch.count({ where })
	]);
	const obligations = await resolveObligations(
		prisma,
		rows.flatMap((b) => b.items.map((i) => i.payrollEmployeeResultId))
	);
	return {
		items: rows.map((b) => ({
			...presentBatchHead(b, canSeeAmounts),
			summary: summaryOf(b.items),
			settlement: settlementOf(b.items, obligations)
		})),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

/** GET /payroll/runs/:id/payment-batch — the run's ORIGINAL batch (or null) + its retry batches. */
export async function getRunBatch(runId: number) {
	const run = await prisma.payrollRun.findUnique({
		where: { id: runId },
		select: {
			id: true,
			status: true,
			paymentBatches: {
				select: { id: true, sequenceNo: true },
				orderBy: { sequenceNo: 'asc' }
			}
		}
	});
	if (!run) throw Errors.notFound('ບໍ່ພົບຮອບເງິນເດືອນ');
	const original = run.paymentBatches.find((b) => b.sequenceNo === 1);
	if (!original) return { runStatus: run.status, batch: null, retries: [] };
	const all = await prisma.payrollPaymentBatch.findMany({
		where: { payrollRunId: runId },
		include: { ...BATCH_INCLUDE, items: { select: { status: true } } },
		orderBy: { sequenceNo: 'asc' }
	});
	const present = (b: (typeof all)[number]) => ({
		...presentBatchHead(b, false),
		summary: summaryOf(b.items)
	});
	return {
		runStatus: run.status,
		batch: present(all.find((b) => b.sequenceNo === 1)!),
		retries: all.filter((b) => b.sequenceNo > 1).map(present)
	};
}

// ============================================================================================
// lifecycle
// ============================================================================================

/**
 * POST /payroll/runs/:id/payment-batch — FINALIZED runs only; ONE ORIGINAL batch per run (sequence 1 —
 * the unique (payrollRunId, sequenceNo) is the backstop); never recalculates. Retries: paymentLifecycle.
 */
export async function createBatch(runId: number, input: BatchCreateInput, actorUserId: number) {
	let batchId = 0;
	try {
		await prisma.$transaction(
			async (tx) => {
				await lockRun(tx, runId);
				const run = await tx.payrollRun.findUnique({
					where: { id: runId },
					include: {
						period: { select: { id: true, code: true, payDate: true } },
						paymentBatches: { where: { sequenceNo: 1 }, select: { id: true } },
						_count: { select: { results: true } }
					}
				});
				if (!run) throw Errors.notFound('ບໍ່ພົບຮອບເງິນເດືອນ');
				if (run.status !== 'FINALIZED') {
					throw Errors.conflict(
						'PAYROLL_RUN_NOT_FINALIZED',
						'ສ້າງຊຸດການຈ່າຍໄດ້ສະເພາະຮອບເງິນເດືອນທີ່ຢືນຢັນ (Finalize) ແລ້ວ'
					);
				}
				if (run.paymentBatches.length > 0) throw alreadyExists();
				if (run._count.results === 0) {
					throw Errors.conflict('PAYROLL_RUN_EMPTY', 'ບໍ່ມີພະນັກງານໃນຮອບເງິນເດືອນນີ້');
				}
				let batchNumber = batchNumberOf(run.period.code);
				const taken = await tx.payrollPaymentBatch.findUnique({
					where: { companyId_batchNumber: { companyId: run.companyId, batchNumber } },
					select: { id: true }
				});
				if (taken) batchNumber = `${batchNumber}-${idRef(runId)}`;
				const batch = await tx.payrollPaymentBatch.create({
					data: {
						companyId: run.companyId,
						payrollRunId: runId,
						batchKind: 'ORIGINAL',
						sequenceNo: 1,
						batchNumber,
						status: 'DRAFT',
						currencyCode: run.currencyCode,
						paymentDate: input.paymentDate
							? new Date(`${input.paymentDate}T00:00:00Z`)
							: run.period.payDate,
						notes: input.notes ?? null,
						createdByUserId: actorUserId
					}
				});
				batchId = batch.id;
				const counts = await writeSnapshot(tx, batch);
				await writeAuditEvent(tx, {
					action: AuditAction.PAYROLL_PAYMENT_BATCH_CREATED,
					entityType: AuditEntity.PAYROLL_PAYMENT_BATCH,
					entityId: batch.id,
					companyId: run.companyId,
					actorUserId,
					metadata: {
						batchId: batch.id,
						runId,
						periodId: run.period.id,
						batchNumber,
						employeeCount: counts.employeeCount,
						readyCount: counts.ready,
						blockedCount: counts.blocked,
						status: 'DRAFT'
					}
				});
			},
			{ timeout: 60_000, maxWait: 15_000 }
		);
	} catch (err) {
		// unique (payrollRunId, sequenceNo=1) backstop: a concurrent request created the batch first
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw alreadyExists();
		}
		throw err;
	}
	return batchId;
}

const alreadyExists = () =>
	Errors.conflict(
		'PAYMENT_BATCH_ALREADY_EXISTS',
		'ຮອບເງິນເດືອນນີ້ມີຊຸດການຈ່າຍແລ້ວ (1 ຮອບ = 1 ຊຸດການຈ່າຍ)'
	);

async function loadLockedBatch(tx: Tx, id: number) {
	await lockBatch(tx, id);
	const batch = await tx.payrollPaymentBatch.findUnique({
		where: { id },
		include: { run: { select: { id: true, periodId: true } } }
	});
	if (!batch) throw Errors.notFound('ບໍ່ພົບຊຸດການຈ່າຍ');
	return batch;
}

const notDraft = (action: string) =>
	Errors.conflict(
		'PAYMENT_BATCH_NOT_DRAFT',
		`${action}ໄດ້ສະເພາະຊຸດການຈ່າຍທີ່ເປັນຮ່າງ (DRAFT) ເທົ່ານັ້ນ`
	);

/** POST /payroll/payment-batches/:id/validate — re-checks every item SNAPSHOT (incl. decryption). */
export async function validateBatch(id: number, actorUserId: number) {
	const outcome = await prisma.$transaction(
		async (tx) => {
			const batch = await loadLockedBatch(tx, id);
			if (batch.status !== 'DRAFT' && batch.status !== 'VALIDATED') throw notDraft('ກວດສອບ');
			const items = await tx.payrollPaymentItem.findMany({
				where: { paymentBatchId: id },
				orderBy: { employeeCodeSnapshot: 'asc' }
			});
			// idempotent: an already VALIDATED batch is reported as is (its snapshot cannot have changed)
			if (batch.status === 'VALIDATED') {
				return { readyCount: items.length, blockedCount: 0, issues: [] };
			}
			const issues: { itemId: number; employeeCode: string; codes: PaymentIssue[] }[] = [];
			for (const item of items) {
				const codes = paymentIssues(item, batch.currencyCode);
				const status: PaymentItemStatus = codes.length > 0 ? 'BLOCKED' : 'READY';
				if (codes.length > 0) {
					issues.push({ itemId: item.id, employeeCode: item.employeeCodeSnapshot, codes });
				}
				if (status !== item.status || JSON.stringify(codes) !== JSON.stringify(issuesOf(item))) {
					await tx.payrollPaymentItem.update({
						where: { id: item.id },
						data: { status, issuesJson: codes.length > 0 ? codes : Prisma.DbNull }
					});
				}
			}
			const blockedCount = issues.length;
			if (blockedCount === 0 && batch.status === 'DRAFT') {
				await tx.payrollPaymentBatch.update({
					where: { id },
					data: { status: 'VALIDATED', validatedAt: serverNow(), validatedByUserId: actorUserId }
				});
				await writeAuditEvent(tx, {
					action: AuditAction.PAYROLL_PAYMENT_BATCH_VALIDATED,
					entityType: AuditEntity.PAYROLL_PAYMENT_BATCH,
					entityId: id,
					companyId: batch.companyId,
					actorUserId,
					metadata: {
						batchId: id,
						runId: batch.payrollRunId,
						readyCount: items.length,
						status: 'VALIDATED'
					}
				});
			}
			return { readyCount: items.length - blockedCount, blockedCount, issues };
		},
		{ timeout: 60_000, maxWait: 15_000 }
	);
	return outcome;
}

/**
 * Phase 15 — RETRY batch rebuild: re-snapshot only the ROUTING (method / account) of each item from the
 * employee's CURRENT payment profile. Amount, source lineage and instruction reference never change
 * (a retry is never rebuilt from payroll results).
 */
async function refreshRetryRouting(tx: Tx, batch: { id: number; currencyCode: string }) {
	const items = await tx.payrollPaymentItem.findMany({ where: { paymentBatchId: batch.id } });
	const profiles = await tx.employeePaymentProfile.findMany({
		where: { employeeId: { in: items.map((i) => i.employeeId) } },
		include: { bankAccount: true }
	});
	const byEmployee = new Map(profiles.map((p) => [p.employeeId, p]));
	let blocked = 0;
	for (const item of items) {
		const routing = routingSnapshot(byEmployee.get(item.employeeId));
		const issues = paymentIssues({ ...routing, amount: item.amount }, batch.currencyCode);
		if (issues.length > 0) blocked++;
		await tx.payrollPaymentItem.update({
			where: { id: item.id },
			data: {
				...routing,
				status: issues.length > 0 ? 'BLOCKED' : 'READY',
				issuesJson: issues.length > 0 ? issues : Prisma.DbNull
			}
		});
	}
	return { employeeCount: items.length, ready: items.length - blocked, blocked };
}

/** POST /payroll/payment-batches/:id/rebuild — DRAFT only: re-snapshot the CURRENT payment profiles. */
export async function rebuildBatch(id: number, actorUserId: number) {
	await prisma.$transaction(
		async (tx) => {
			const batch = await loadLockedBatch(tx, id);
			if (batch.status !== 'DRAFT') throw notDraft('ສ້າງລາຍການໃໝ່');
			let counts: { employeeCount: number; ready: number; blocked: number };
			if (batch.batchKind === 'RETRY') {
				counts = await refreshRetryRouting(tx, batch);
			} else {
				await tx.payrollPaymentItem.deleteMany({ where: { paymentBatchId: id } });
				counts = await writeSnapshot(tx, batch);
			}
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_PAYMENT_BATCH_REBUILT,
				entityType: AuditEntity.PAYROLL_PAYMENT_BATCH,
				entityId: id,
				companyId: batch.companyId,
				actorUserId,
				metadata: {
					batchId: id,
					runId: batch.payrollRunId,
					employeeCount: counts.employeeCount,
					readyCount: counts.ready,
					blockedCount: counts.blocked,
					status: 'DRAFT'
				}
			});
		},
		{ timeout: 60_000, maxWait: 15_000 }
	);
}

/** POST /payroll/payment-batches/:id/cancel — DRAFT / VALIDATED only. Payroll + payslips untouched. */
export async function cancelBatch(id: number, actorUserId: number) {
	await prisma.$transaction(async (tx) => {
		const batch = await loadLockedBatch(tx, id);
		if (batch.status !== 'DRAFT' && batch.status !== 'VALIDATED') {
			throw Errors.conflict(
				'PAYMENT_BATCH_NOT_CANCELLABLE',
				'ຍົກເລີກໄດ້ສະເພາະຊຸດການຈ່າຍທີ່ເປັນຮ່າງ ຫຼື ກວດສອບແລ້ວ (ຍັງບໍ່ໄດ້ສົ່ງອອກໄຟລ໌)'
			);
		}
		// a cancelled retry releases its source (retrySourceLockId → NULL): it may be retried again
		await tx.payrollPaymentItem.updateMany({
			where: { paymentBatchId: id },
			data: { status: 'CANCELLED', retrySourceLockId: null }
		});
		await tx.payrollPaymentBatch.update({
			where: { id },
			data: { status: 'CANCELLED', cancelledAt: serverNow(), cancelledByUserId: actorUserId }
		});
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_PAYMENT_BATCH_CANCELLED,
			entityType: AuditEntity.PAYROLL_PAYMENT_BATCH,
			entityId: id,
			companyId: batch.companyId,
			actorUserId,
			metadata: {
				batchId: id,
				runId: batch.payrollRunId,
				previousStatus: batch.status,
				status: 'CANCELLED'
			}
		});
	});
}

/** Batches whose remaining EXPORTED / FAILED items can still be confirmed by hand. */
export const CONFIRMABLE_BATCH_STATUSES = ['EXPORTED', 'PARTIALLY_PAID', 'PARTIALLY_REVERSED'];

/**
 * POST /payroll/payment-batches/:batchId/items/:itemId/confirm — MANUAL confirmation (no bank API).
 * Only EXPORTED / PARTIALLY_PAID (/ PARTIALLY_REVERSED) batches. EXPORTED → PAID | FAILED; FAILED →
 * PAID (unless a retry of it is live — that would pay twice); PAID is final (Phase 15: reverse it).
 * The batch row lock serializes confirmations; the item update is additionally a CAS on its status.
 * The batch status is derived centrally (derivePaymentBatchStatus).
 */
export async function confirmItem(
	batchId: number,
	itemId: number,
	input: ItemConfirmInput,
	actorUserId: number
) {
	await prisma.$transaction(async (tx) => {
		const batch = await loadLockedBatch(tx, batchId);
		if (!CONFIRMABLE_BATCH_STATUSES.includes(batch.status)) {
			throw Errors.conflict(
				'PAYMENT_BATCH_NOT_EXPORTED',
				'ບັນທຶກຜົນການຈ່າຍໄດ້ສະເພາະຊຸດການຈ່າຍທີ່ສົ່ງອອກໄຟລ໌ແລ້ວ'
			);
		}
		const item = await tx.payrollPaymentItem.findFirst({
			where: { id: itemId, paymentBatchId: batchId },
			include: { employee: { select: { userId: true } } }
		});
		if (!item) throw Errors.notFound('ບໍ່ພົບລາຍການຈ່າຍ');
		if (item.status === 'PAID') {
			throw Errors.conflict(
				'PAYMENT_ITEM_ALREADY_FINAL',
				'ລາຍການນີ້ຖືກບັນທຶກວ່າຈ່າຍແລ້ວ — ປ່ຽນແປງບໍ່ໄດ້'
			);
		}
		const allowed: PaymentItemStatus[] =
			input.status === 'PAID' ? ['EXPORTED', 'FAILED'] : ['EXPORTED'];
		if (!allowed.includes(item.status)) {
			throw Errors.conflict(
				'PAYMENT_ITEM_NOT_CONFIRMABLE',
				item.status === 'FAILED'
					? 'ລາຍການນີ້ຖືກບັນທຶກວ່າລົ້ມເຫຼວແລ້ວ'
					: 'ລາຍການນີ້ບໍ່ຢູ່ໃນສະຖານະທີ່ບັນທຶກຜົນການຈ່າຍໄດ້'
			);
		}
		// Phase 15 double-pay guard: a FAILED item that already has a live retry is settled THERE
		if (item.status === 'FAILED' && input.status === 'PAID') {
			const child = await tx.payrollPaymentItem.findFirst({
				where: { retrySourceLockId: item.id },
				select: { id: true }
			});
			if (child) {
				throw Errors.conflict(
					'PAYMENT_RETRY_EXISTS',
					'ລາຍການນີ້ມີການຈ່າຍຄືນ (Retry) ແລ້ວ — ບັນທຶກຜົນຢູ່ທີ່ຊຸດການຈ່າຍຄືນ ເພື່ອບໍ່ໃຫ້ຈ່າຍຊ້ຳ'
				);
			}
		}
		const now = serverNow();
		let data: Prisma.PayrollPaymentItemUncheckedUpdateManyInput;
		if (input.status === 'PAID') {
			const paidAt = input.paidAt ? new Date(input.paidAt) : now;
			if (paidAt.getTime() > now.getTime() + 86_400_000) {
				throw Errors.badRequest('PAID_AT_IN_FUTURE', 'ວັນທີຈ່າຍຕ້ອງບໍ່ເປັນວັນໃນອະນາຄົດ');
			}
			data = {
				status: 'PAID',
				paymentReference: input.paymentReference ?? null,
				paidAt,
				confirmedAt: now,
				confirmedByUserId: actorUserId
			};
		} else {
			data = {
				status: 'FAILED',
				failureCode: input.failureCode,
				failureReason: input.failureReason,
				confirmedAt: now,
				confirmedByUserId: actorUserId
			};
		}
		// CAS: only if the item is still in the status we checked
		const cas = await tx.payrollPaymentItem.updateMany({
			where: { id: itemId, status: item.status },
			data
		});
		if (cas.count !== 1) {
			throw Errors.conflict(
				'PAYMENT_ITEM_ALREADY_FINAL',
				'ລາຍການນີ້ຖືກປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດໃໝ່'
			);
		}
		const all = await tx.payrollPaymentItem.findMany({
			where: { paymentBatchId: batchId },
			select: { status: true }
		});
		const status = derivePaymentBatchStatus(all);
		if (status !== batch.status) {
			await tx.payrollPaymentBatch.update({
				where: { id: batchId },
				data: {
					status,
					...(status === 'PAID' ? { confirmedAt: now, confirmedByUserId: actorUserId } : {})
				}
			});
		}
		await writeAuditEvent(tx, {
			action:
				input.status === 'PAID'
					? AuditAction.PAYROLL_PAYMENT_ITEM_PAID
					: AuditAction.PAYROLL_PAYMENT_ITEM_FAILED,
			entityType: AuditEntity.PAYROLL_PAYMENT_ITEM,
			entityId: itemId,
			companyId: batch.companyId,
			employeeId: item.employeeId,
			actorUserId,
			// ids / status / bank code / last4 only — never the amount or the account number
			metadata: {
				batchId,
				runId: batch.payrollRunId,
				itemId,
				employeeId: item.employeeId,
				status: input.status,
				previousStatus: item.status,
				batchStatus: status,
				bankCode: item.bankCodeSnapshot,
				last4: item.accountNumberLast4,
				...(input.status === 'FAILED' ? { failureCode: input.failureCode } : {})
			}
		});
		if (input.status === 'PAID' && item.employee.userId) {
			await notifyPaymentPaid(tx, {
				userId: item.employee.userId,
				periodId: batch.run.periodId,
				itemId,
				batchId
			});
		}
	});
}

/**
 * The employee's PAID notification (period only — no amount, no account, no bank reference).
 * dedupeKey per ITEM: manual confirmation and bank reconciliation of the same item notify once;
 * a retry is a different item (a different payment) and notifies on its own PAID.
 */
export async function notifyPaymentPaid(
	tx: Tx,
	p: { userId: number; periodId: number; itemId: number; batchId: number }
) {
	const period = await tx.payrollPeriod.findUniqueOrThrow({
		where: { id: p.periodId },
		select: { name: true }
	});
	await createNotifications(tx, [
		{
			userId: p.userId,
			type: NotificationType.PAYROLL_PAYMENT_PAID,
			titleLao: `ການຈ່າຍເງິນເດືອນງວດ ${period.name} ໄດ້ຖືກບັນທຶກວ່າຈ່າຍແລ້ວ`,
			bodyLao: null,
			link: '/app/my-payments',
			metadata: { itemId: p.itemId, batchId: p.batchId },
			dedupeKey: `payroll-payment:${p.itemId}:paid`
		}
	]);
}

// ============================================================================================
// self-service (payroll_payment.view_self) — the employee comes from the SESSION
// ============================================================================================

/**
 * GET /payroll-payments/me — own payment history once a batch has been exported (a DRAFT / VALIDATED /
 * CANCELLED batch is internal preparation). No amount, no full account, nothing batch-wide.
 *
 * Phase 15: `obligations` groups the ATTEMPTS of each payroll result (original → retry #1 → …) with the
 * current settlement status. A reversal shows its effective date only — never the internal reason or
 * the bank's reversal reference. `items` (flat, Phase 14 shape) is kept for compatibility.
 */
export async function listMyPayments(userId: number) {
	const employee = await prisma.employee.findUnique({ where: { userId }, select: { id: true } });
	// unchanged Phase 14 contract for an unlinked account (the client treats obligations as optional)
	if (!employee) return { linkedEmployee: false, items: [] };
	const rows = await prisma.payrollPaymentItem.findMany({
		where: {
			employeeId: employee.id,
			status: { in: ['EXPORTED', 'PAID', 'FAILED', 'REVERSED'] },
			batch: { status: { in: [...POST_EXPORT_BATCH_STATUSES] } }
		},
		include: {
			reversal: { select: { effectiveDate: true } },
			batch: {
				select: {
					id: true,
					batchKind: true,
					sequenceNo: true,
					paymentDate: true,
					run: {
						select: {
							period: {
								select: { code: true, name: true, payrollMonth: true, cycleNumber: true }
							}
						}
					}
				}
			}
		},
		orderBy: [{ batch: { paymentDate: 'desc' } }, { id: 'desc' }]
	});
	const obligations = await resolveObligations(
		prisma,
		rows.map((r) => r.payrollEmployeeResultId)
	);
	const present = (r: (typeof rows)[number]) => ({
		id: r.id,
		periodCode: r.batch.run.period.code,
		periodName: r.batch.run.period.name,
		payrollMonth: r.batch.run.period.payrollMonth,
		cycleNumber: r.batch.run.period.cycleNumber,
		paymentDate: r.batch.paymentDate,
		currencyCode: r.currencyCode,
		paymentMethod: r.paymentMethod,
		status: r.status,
		paidAt: r.paidAt,
		bankName: r.paymentMethod === 'BANK_TRANSFER' ? r.bankNameSnapshot : null,
		accountNumberMasked:
			r.paymentMethod === 'BANK_TRANSFER' ? maskAccountNumber(r.accountNumberLast4) : null,
		paymentReference: r.status === 'PAID' ? r.paymentReference : null,
		// Phase 15 — attempt facts (employee-safe only)
		batchKind: r.batch.batchKind,
		isRetry: r.sourcePaymentItemId !== null,
		reversedOn: r.status === 'REVERSED' ? (r.reversal?.effectiveDate ?? null) : null
	});
	const groups = new Map<number, (typeof rows)[number][]>();
	for (const r of rows) {
		const list = groups.get(r.payrollEmployeeResultId) ?? [];
		list.push(r);
		groups.set(r.payrollEmployeeResultId, list);
	}
	return {
		linkedEmployee: true,
		items: rows.map(present),
		obligations: [...groups.entries()].map(([resultId, list]) => {
			const ob = obligations.get(resultId);
			const order = new Map(ob?.attempts.map((a, i) => [a.id, i]) ?? []);
			const attempts = [...list].sort(
				(a, b) => (order.get(a.id) ?? a.batch.sequenceNo) - (order.get(b.id) ?? b.batch.sequenceNo)
			);
			const first = attempts[0]!;
			return {
				resultId,
				periodCode: first.batch.run.period.code,
				periodName: first.batch.run.period.name,
				payrollMonth: first.batch.run.period.payrollMonth,
				cycleNumber: first.batch.run.period.cycleNumber,
				currencyCode: first.currencyCode,
				settlementStatus: ob?.status ?? 'UNPAID',
				attempts: attempts.map((a, i) => ({ ...present(a), attemptNo: i + 1 }))
			};
		})
	};
}
