import { Prisma } from '@prisma/client';
import type { PaymentItemStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { idRef } from '../lib/idFormat.js';
import { idCol } from '../lib/sqlIds.js';
import { Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { moneyString, ZERO } from '../lib/money.js';
import { maskAccountNumber } from '../lib/sensitiveCrypto.js';
import { laosDateOf, parseDateOnly, todayInLaos } from '../lib/dates.js';
import {
	derivePaymentBatchStatus,
	instructionReferences,
	normalizeCode
} from '../lib/paymentStatus.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { createNotifications, NotificationType } from './notification.service.js';
import {
	ATTEMPT_SELECT,
	buildObligations,
	itemsWithLiveRetry,
	resolveObligations
} from './paymentObligation.service.js';
import { lockBatch, lockRun, paymentIssues, routingSnapshot } from './payrollPayment.service.js';
import type { RetryInput, ReverseInput } from '../validation/reconciliation.schema.js';

/**
 * PAYMENT REVERSAL + RETRY / REISSUE (Phase 15 §35-56). Downstream of payroll: nothing here reads or
 * recalculates payroll results for money — a retry copies the SOURCE ITEM's amount (the payment
 * obligation), never PayrollEmployeeResult.netPay, and never calls the payroll engine.
 *
 *  REVERSAL  PAID ──reverse──▶ REVERSED (+ one append-only PayrollPaymentReversal row). The item keeps
 *            its paidAt, paymentReference and snapshot; nothing about the payment is erased.
 *  RETRY     FAILED / REVERSED source ──▶ NEW item in a NEW RETRY batch (sequence = max + 1), routed
 *            with the employee's CURRENT payment profile, with a NEW instruction reference and
 *            sourcePaymentItemId = source. The retry batch then follows the normal Phase 14 lifecycle.
 *  DOUBLE-PAY PROTECTION: a source has at most one LIVE retry child (unique retrySourceLockId), the
 *            obligation must not already be PAID or have an attempt in flight, and all of it runs under
 *            the run + batch + source-item row locks.
 */

const ACTIVE: PaymentItemStatus[] = ['READY', 'BLOCKED', 'EXPORTED'];

// ============================================================================================
// reversal
// ============================================================================================

/** POST /payroll/payment-batches/:batchId/items/:itemId/reverse — PAID only; append-only record. */
export async function reverseItem(
	batchId: number,
	itemId: number,
	input: ReverseInput,
	actorUserId: number
) {
	try {
		await prisma.$transaction(async (tx) => {
			await lockBatch(tx, batchId);
			const batch = await tx.payrollPaymentBatch.findUnique({
				where: { id: batchId },
				include: { run: { select: { periodId: true } } }
			});
			if (!batch) throw Errors.notFound('ບໍ່ພົບຊຸດການຈ່າຍ');
			const item = await tx.payrollPaymentItem.findFirst({
				where: { id: itemId, paymentBatchId: batchId },
				include: { employee: { select: { userId: true } } }
			});
			if (!item) throw Errors.notFound('ບໍ່ພົບລາຍການຈ່າຍ');
			if (item.status === 'REVERSED') throw alreadyReversed();
			if (item.status !== 'PAID') {
				throw Errors.conflict(
					'PAYMENT_ITEM_NOT_REVERSIBLE',
					'ຍົກເລີກການຈ່າຍ (Reverse) ໄດ້ສະເພາະລາຍການທີ່ຈ່າຍແລ້ວ (PAID) ເທົ່ານັ້ນ',
					{ status: item.status }
				);
			}
			const now = serverNow();
			const effectiveDate = parseDateOnly(input.effectiveDate)!;
			if (effectiveDate.getTime() > todayInLaos(now).getTime()) {
				throw Errors.badRequest(
					'REVERSAL_DATE_IN_FUTURE',
					'ວັນທີມີຜົນຂອງການຍົກເລີກການຈ່າຍ ຕ້ອງບໍ່ເປັນວັນໃນອະນາຄົດ'
				);
			}
			if (item.paidAt && effectiveDate.getTime() < laosDateOf(item.paidAt).getTime()) {
				throw Errors.badRequest(
					'REVERSAL_BEFORE_PAYMENT',
					'ວັນທີມີຜົນຂອງການຍົກເລີກ ຕ້ອງບໍ່ກ່ອນວັນທີຈ່າຍ'
				);
			}
			// CAS: only a still-PAID item; paidAt / paymentReference / snapshot are deliberately untouched
			const cas = await tx.payrollPaymentItem.updateMany({
				where: { id: itemId, status: 'PAID' },
				data: { status: 'REVERSED' }
			});
			if (cas.count !== 1) throw alreadyReversed();
			const reversal = await tx.payrollPaymentReversal.create({
				data: {
					paymentItemId: itemId,
					paymentBatchId: batchId,
					companyId: batch.companyId,
					reason: input.reason,
					bankReference: input.bankReference ?? null,
					effectiveDate,
					reversedByUserId: actorUserId,
					reversedAt: now
				}
			});
			const all = await tx.payrollPaymentItem.findMany({
				where: { paymentBatchId: batchId },
				select: { status: true }
			});
			const batchStatus = derivePaymentBatchStatus(all);
			if (batchStatus !== batch.status) {
				await tx.payrollPaymentBatch.update({
					where: { id: batchId },
					data: { status: batchStatus }
				});
			}
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_PAYMENT_ITEM_REVERSED,
				entityType: AuditEntity.PAYROLL_PAYMENT_ITEM,
				entityId: itemId,
				companyId: batch.companyId,
				employeeId: item.employeeId,
				actorUserId,
				// identifiers / status only — never the amount, account, reason text or bank reference
				metadata: {
					batchId,
					runId: batch.payrollRunId,
					itemId,
					employeeId: item.employeeId,
					reversalId: reversal.id,
					previousStatus: 'PAID',
					status: 'REVERSED',
					batchStatus,
					effectiveDate: input.effectiveDate,
					hasBankReference: !!input.bankReference
				}
			});
			if (item.employee.userId) {
				const period = await tx.payrollPeriod.findUniqueOrThrow({
					where: { id: batch.run.periodId },
					select: { name: true }
				});
				await createNotifications(tx, [
					{
						userId: item.employee.userId,
						type: NotificationType.PAYROLL_PAYMENT_REVERSED,
						titleLao: `ສະຖານະການຈ່າຍເງິນເດືອນງວດ ${period.name} ຖືກຍົກເລີກການຈ່າຍ (reversed) — ກະລຸນາຕິດຕໍ່ HR ຖ້າຕ້ອງການຄວາມຊ່ວຍເຫຼືອ`,
						bodyLao: null,
						link: '/app/my-payments',
						metadata: { itemId, batchId },
						dedupeKey: `payroll-payment:${itemId}:reversed`
					}
				]);
			}
		});
	} catch (err) {
		// unique paymentItemId backstop (a concurrent reversal won)
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw alreadyReversed();
		}
		throw err;
	}
}

const alreadyReversed = () =>
	Errors.conflict('PAYMENT_ALREADY_REVERSED', 'ລາຍການນີ້ຖືກຍົກເລີກການຈ່າຍ (Reversed) ແລ້ວ');

// ============================================================================================
// retry / reissue
// ============================================================================================

const retryExists = () =>
	Errors.conflict(
		'PAYMENT_RETRY_ALREADY_EXISTS',
		'ລາຍການນີ້ຖືກສ້າງການຈ່າຍຄືນ (Retry) ແລ້ວ — ໃຊ້ລາຍການຈ່າຍຄືນລ່າສຸດແທນ'
	);
const retryInProgress = () =>
	Errors.conflict(
		'PAYMENT_RETRY_IN_PROGRESS',
		'ມີການຈ່າຍຄືນທີ່ກຳລັງດຳເນີນການຢູ່ແລ້ວ — ລໍຖ້າຜົນກ່ອນ ຈຶ່ງສ້າງໃໝ່'
	);

/**
 * POST /payroll/payment-batches/:id/retry — re-issue FAILED / REVERSED items of this batch as a NEW
 * RETRY batch. Returns the new batch id.
 */
export async function createRetryBatch(batchId: number, input: RetryInput, actorUserId: number) {
	let newBatchId = 0;
	try {
		await prisma.$transaction(
			async (tx) => {
				// LOCKS FIRST, with locking reads only (InnoDB takes the read snapshot at the first NON-locking
				// read, so every read below sees committed concurrent retries). Lock order: batch → run
				// (serializes the run's sequence numbers) → source items.
				const head = await tx.$queryRaw<{ payroll_run_id: number }[]>`
					SELECT ${idCol('payroll_run_id')} AS payroll_run_id FROM payroll_payment_batches WHERE ${idCol()} = ${batchId} FOR UPDATE`;
				if (head.length === 0) throw Errors.notFound('ບໍ່ພົບຊຸດການຈ່າຍ');
				await lockRun(tx, head[0]!.payroll_run_id);
				const ids = input.sourceItemIds;
				await tx.$queryRaw`SELECT ${idCol()} AS id FROM payroll_payment_items WHERE ${idCol()} IN (${Prisma.join(ids)}) FOR UPDATE`;
				const batch = await tx.payrollPaymentBatch.findUniqueOrThrow({ where: { id: batchId } });
				const sources = await tx.payrollPaymentItem.findMany({
					where: { id: { in: ids }, paymentBatchId: batchId },
					orderBy: { employeeCodeSnapshot: 'asc' }
				});
				if (sources.length !== ids.length) {
					throw Errors.notFound('ບໍ່ພົບລາຍການຈ່າຍບາງລາຍການໃນຊຸດການຈ່າຍນີ້');
				}
				for (const s of sources) {
					if (s.status !== 'FAILED' && s.status !== 'REVERSED') {
						throw Errors.conflict(
							'PAYMENT_RETRY_NOT_ELIGIBLE',
							`ຈ່າຍຄືນໄດ້ສະເພາະລາຍການທີ່ຈ່າຍບໍ່ສຳເລັດ ຫຼື ຖືກຍົກເລີກການຈ່າຍ (${s.employeeCodeSnapshot})`,
							{ itemId: s.id, status: s.status }
						);
					}
				}
				// the obligation must not be paid / in flight elsewhere, and this source must be its
				// LATEST attempt (an older attempt already has a descendant)
				const obligations = await resolveObligations(
					tx,
					sources.map((s) => s.payrollEmployeeResultId)
				);
				const children = await itemsWithLiveRetry(tx, ids);
				for (const s of sources) {
					const ob = obligations.get(s.payrollEmployeeResultId);
					if (ob?.latest && ACTIVE.includes(ob.latest.status)) throw retryInProgress();
					if (ob?.status === 'PAID') {
						throw Errors.conflict(
							'PAYMENT_OBLIGATION_ALREADY_PAID',
							`ການຈ່າຍຂອງ ${s.employeeCodeSnapshot} ຈ່າຍສຳເລັດແລ້ວ (ຈາກການຈ່າຍຄືນ) — ບໍ່ຕ້ອງຈ່າຍອີກ`
						);
					}
					if (children.has(s.id) || (ob?.latest && ob.latest.id !== s.id)) throw retryExists();
				}

				const agg = await tx.payrollPaymentBatch.aggregate({
					where: { payrollRunId: batch.payrollRunId },
					_max: { sequenceNo: true }
				});
				const sequenceNo = (agg._max.sequenceNo ?? 1) + 1;
				const original = await tx.payrollPaymentBatch.findFirst({
					where: { payrollRunId: batch.payrollRunId, sequenceNo: 1 },
					select: { batchNumber: true }
				});
				let batchNumber = `${original?.batchNumber ?? batch.batchNumber}-R${sequenceNo - 1}`;
				const taken = await tx.payrollPaymentBatch.findUnique({
					where: { companyId_batchNumber: { companyId: batch.companyId, batchNumber } },
					select: { id: true }
				});
				if (taken) batchNumber = `${batchNumber}-${idRef(batch.payrollRunId)}`;
				const now = serverNow();
				const retry = await tx.payrollPaymentBatch.create({
					data: {
						companyId: batch.companyId,
						payrollRunId: batch.payrollRunId,
						batchKind: 'RETRY',
						sequenceNo,
						parentBatchId: batchId,
						batchNumber,
						status: 'DRAFT',
						currencyCode: batch.currencyCode,
						paymentDate: input.paymentDate ? parseDateOnly(input.paymentDate)! : todayInLaos(now),
						notes: input.notes ?? null,
						createdByUserId: actorUserId
					}
				});
				newBatchId = retry.id;

				// routing from the CURRENT payment profile (new account / switched to CASH …);
				// the AMOUNT is the source obligation's — never re-read from payroll
				const profiles = await tx.employeePaymentProfile.findMany({
					where: { employeeId: { in: sources.map((s) => s.employeeId) } },
					include: { bankAccount: true }
				});
				const byEmployee = new Map(profiles.map((p) => [p.employeeId, p]));
				const refs = instructionReferences(
					batchNumber,
					sources.map((s) => s.employeeCodeSnapshot)
				);
				const data: Prisma.PayrollPaymentItemCreateManyInput[] = sources.map((s, i) => {
					const routing = routingSnapshot(byEmployee.get(s.employeeId));
					const issues = paymentIssues({ ...routing, amount: s.amount }, batch.currencyCode);
					return {
						paymentBatchId: retry.id,
						payrollEmployeeResultId: s.payrollEmployeeResultId,
						employeeId: s.employeeId,
						employeeCodeSnapshot: s.employeeCodeSnapshot,
						employeeNameSnapshot: s.employeeNameSnapshot,
						...routing,
						currencyCode: s.currencyCode,
						amount: s.amount,
						transferReference: `${batchNumber}-${normalizeCode(s.employeeCodeSnapshot) || 'EMP'}`,
						instructionReference: refs[i]!,
						sourcePaymentItemId: s.id,
						retrySourceLockId: s.id,
						status: issues.length > 0 ? 'BLOCKED' : 'READY',
						issuesJson: issues.length > 0 ? issues : Prisma.DbNull
					};
				});
				await tx.payrollPaymentItem.createMany({ data });
				const total = sources.reduce(
					(sum, s) => (s.amount.greaterThan(0) ? sum.plus(s.amount) : sum),
					ZERO
				);
				await tx.payrollPaymentBatch.update({
					where: { id: retry.id },
					data: { employeeCount: sources.length, totalAmount: total }
				});
				const blocked = data.filter((d) => d.status === 'BLOCKED').length;
				await writeAuditEvent(tx, {
					action: AuditAction.PAYROLL_PAYMENT_RETRY_BATCH_CREATED,
					entityType: AuditEntity.PAYROLL_PAYMENT_BATCH,
					entityId: retry.id,
					companyId: batch.companyId,
					actorUserId,
					metadata: {
						batchId: retry.id,
						parentBatchId: batchId,
						runId: batch.payrollRunId,
						batchNumber,
						sequenceNo,
						itemCount: sources.length,
						sourceItemIds: ids,
						readyCount: sources.length - blocked,
						blockedCount: blocked,
						status: 'DRAFT'
					}
				});
			},
			{ timeout: 60_000, maxWait: 15_000 }
		);
	} catch (err) {
		// unique retrySourceLockId / (run, sequence) backstop: a concurrent retry won
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw retryExists();
		}
		throw err;
	}
	return newBatchId;
}

// ============================================================================================
// lineage
// ============================================================================================

/** GET /payroll/payment-items/:id/lineage — every attempt of the item's obligation (masked). */
export async function getItemLineage(itemId: number, canSeeAmounts: boolean) {
	const item = await prisma.payrollPaymentItem.findUnique({
		where: { id: itemId },
		select: {
			id: true,
			payrollEmployeeResultId: true,
			employeeCodeSnapshot: true,
			employeeNameSnapshot: true
		}
	});
	if (!item) throw Errors.notFound('ບໍ່ພົບລາຍການຈ່າຍ');
	const rows = await prisma.payrollPaymentItem.findMany({
		where: { payrollEmployeeResultId: item.payrollEmployeeResultId },
		select: {
			...ATTEMPT_SELECT,
			batch: {
				select: {
					id: true,
					batchNumber: true,
					batchKind: true,
					sequenceNo: true,
					status: true,
					paymentDate: true
				}
			},
			bankNameSnapshot: true,
			accountNumberLast4: true,
			instructionReference: true,
			paidAt: true,
			paymentReference: true,
			failureCode: true,
			amount: true,
			currencyCode: true,
			reversal: { select: { effectiveDate: true, reversedAt: true } }
		}
	});
	const ob = buildObligations(rows).get(item.payrollEmployeeResultId);
	const chain = ob?.attempts ?? [];
	const present = (r: (typeof rows)[number], attemptNo: number | null) => ({
		itemId: r.id,
		attemptNo,
		batch: r.batch,
		status: r.status,
		paymentMethod: r.paymentMethod,
		bankName: r.paymentMethod === 'BANK_TRANSFER' ? r.bankNameSnapshot : null,
		accountNumberMasked:
			r.paymentMethod === 'BANK_TRANSFER' ? maskAccountNumber(r.accountNumberLast4) : null,
		instructionReference: r.instructionReference,
		paidAt: r.paidAt,
		paymentReference: r.paymentReference,
		failureCode: r.failureCode,
		currencyCode: r.currencyCode,
		amount: canSeeAmounts ? moneyString(r.amount) : null,
		reversal: r.reversal,
		sourcePaymentItemId: r.sourcePaymentItemId
	});
	return {
		currentItemId: item.id,
		employeeCode: item.employeeCodeSnapshot,
		employeeName: item.employeeNameSnapshot,
		obligationStatus: ob?.status ?? 'UNPAID',
		attempts: chain.map((r, i) => present(r, i + 1)),
		/** attempts that were cancelled before export (not part of the live chain) */
		cancelledAttempts: rows.filter((r) => r.status === 'CANCELLED').map((r) => present(r, null))
	};
}
