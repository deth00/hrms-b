import type { PaymentBatchKind, PaymentItemStatus, PaymentMethod, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';

/**
 * SETTLEMENT RESOLVER (Phase 15 §55). A payment OBLIGATION is one finalized PayrollEmployeeResult;
 * it can have several payment ATTEMPTS over time (the original item, then retry items), linked by
 * sourcePaymentItemId. Every attempt is preserved — nothing is overwritten.
 *
 *   Original (FAILED) → Retry #1 (PAID → REVERSED) → Retry #2 (PAID)
 *
 * The obligation's status is the status of its LATEST live attempt (the end of the chain):
 *   no live attempt              → UNPAID      (e.g. the only batch was cancelled before export)
 *   READY / BLOCKED / EXPORTED   → IN_PROGRESS (a batch is being prepared / waiting for the bank)
 *   PAID                         → PAID
 *   FAILED                       → FAILED
 *   REVERSED                     → REVERSED
 * A CANCELLED attempt is not live (a cancelled retry batch frees its source for a new retry).
 * The chain is linear: a source has at most ONE live child (unique retrySourceLockId backstop).
 */
export type ObligationStatus = 'UNPAID' | 'IN_PROGRESS' | 'PAID' | 'REVERSED' | 'FAILED';

type Db = Prisma.TransactionClient | typeof prisma;

export interface AttemptRow {
	id: number;
	payrollEmployeeResultId: number;
	sourcePaymentItemId: number | null;
	status: PaymentItemStatus;
	paymentMethod: PaymentMethod | null;
	batch: { id: number; batchNumber: string; batchKind: PaymentBatchKind; sequenceNo: number };
}

export interface Obligation<A extends AttemptRow = AttemptRow> {
	resultId: number;
	status: ObligationStatus;
	/** live attempts in order: original first, latest last */
	attempts: A[];
	latest: A | null;
}

export function statusOfAttempt(status: PaymentItemStatus | undefined): ObligationStatus {
	switch (status) {
		case 'PAID':
			return 'PAID';
		case 'FAILED':
			return 'FAILED';
		case 'REVERSED':
			return 'REVERSED';
		case 'READY':
		case 'BLOCKED':
		case 'EXPORTED':
			return 'IN_PROGRESS';
		default:
			return 'UNPAID';
	}
}

/** Pure: builds each obligation's attempt chain from ALL items of the given results. */
export function buildObligations<A extends AttemptRow>(items: A[]): Map<number, Obligation<A>> {
	const byResult = new Map<number, A[]>();
	for (const i of items) {
		const list = byResult.get(i.payrollEmployeeResultId) ?? [];
		list.push(i);
		byResult.set(i.payrollEmployeeResultId, list);
	}
	const out = new Map<number, Obligation<A>>();
	for (const [resultId, list] of byResult) {
		const live = list.filter((i) => i.status !== 'CANCELLED');
		const childOf = new Map<number, A>();
		for (const i of live) if (i.sourcePaymentItemId) childOf.set(i.sourcePaymentItemId, i);
		// the root: the live attempt that replaces nothing (the ORIGINAL batch's item)
		const root = live
			.filter((i) => !i.sourcePaymentItemId)
			.sort((a, b) => a.batch.sequenceNo - b.batch.sequenceNo)[0];
		const attempts: A[] = [];
		const seen = new Set<number>();
		for (let cur = root; cur && !seen.has(cur.id); cur = childOf.get(cur.id)) {
			seen.add(cur.id);
			attempts.push(cur);
		}
		const latest = attempts[attempts.length - 1] ?? null;
		out.set(resultId, { resultId, attempts, latest, status: statusOfAttempt(latest?.status) });
	}
	return out;
}

export const ATTEMPT_SELECT = {
	id: true,
	payrollEmployeeResultId: true,
	sourcePaymentItemId: true,
	status: true,
	paymentMethod: true,
	batch: { select: { id: true, batchNumber: true, batchKind: true, sequenceNo: true } }
} satisfies Prisma.PayrollPaymentItemSelect;

/** Obligations of several finalized results at once (one query). */
export async function resolveObligations(db: Db, resultIds: number[]) {
	if (resultIds.length === 0) return new Map<number, Obligation>();
	const items = await db.payrollPaymentItem.findMany({
		where: { payrollEmployeeResultId: { in: [...new Set(resultIds)] } },
		select: ATTEMPT_SELECT
	});
	return buildObligations(items);
}

/** §55 — the settlement status of ONE obligation, following the payment lineage. */
export async function resolvePaymentObligationStatus(
	payrollEmployeeResultId: number,
	db: Db = prisma
): Promise<ObligationStatus> {
	const map = await resolveObligations(db, [payrollEmployeeResultId]);
	return map.get(payrollEmployeeResultId)?.status ?? 'UNPAID';
}

/** Ids of items (among `itemIds`) that have a LIVE (not cancelled) retry child. */
export async function itemsWithLiveRetry(
	db: Db,
	itemIds: number[]
): Promise<Map<number, { id: number; status: PaymentItemStatus; batchId: number }>> {
	if (itemIds.length === 0) return new Map();
	const children = await db.payrollPaymentItem.findMany({
		where: { retrySourceLockId: { in: itemIds } },
		select: { id: true, status: true, retrySourceLockId: true, paymentBatchId: true }
	});
	return new Map(
		children.map((c) => [
			c.retrySourceLockId!,
			{ id: c.id, status: c.status, batchId: c.paymentBatchId }
		])
	);
}
