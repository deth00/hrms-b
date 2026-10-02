import type { PaymentItemStatus } from '@prisma/client';

/**
 * PAYMENT STATUS RULES (Phase 14 + Phase 15) — the ONE place that derives a payment batch's status
 * from its items, and that builds payment instruction references. Callers never compute these.
 */

/** Batch statuses whose items are past export (confirmation / reconciliation / reversal territory). */
export const POST_EXPORT_BATCH_STATUSES = [
	'EXPORTED',
	'PARTIALLY_PAID',
	'PAID',
	'PARTIALLY_REVERSED',
	'REVERSED'
] as const;
export type PostExportBatchStatus = (typeof POST_EXPORT_BATCH_STATUSES)[number];

/**
 * Derives a batch's status from its item statuses (never from the client or an imported file).
 *
 *   every live item PAID                              → PAID
 *   every live item REVERSED                          → REVERSED
 *   only PAID + REVERSED left (at least one of each)  → PARTIALLY_REVERSED
 *   something unresolved (EXPORTED / FAILED) left:
 *     at least one PAID                               → PARTIALLY_PAID   (Phase 14 behaviour)
 *     no PAID but at least one REVERSED               → PARTIALLY_REVERSED
 *     otherwise                                       → EXPORTED         (e.g. only FAILED items)
 *
 * CANCELLED items are ignored. Only used for batches that have been exported.
 */
export function derivePaymentBatchStatus(
	items: { status: PaymentItemStatus }[]
): PostExportBatchStatus {
	const live = items.filter((i) => i.status !== 'CANCELLED');
	const count = (s: PaymentItemStatus) => live.filter((i) => i.status === s).length;
	const paid = count('PAID');
	const reversed = count('REVERSED');
	const n = live.length;
	if (n > 0 && paid === n) return 'PAID';
	if (n > 0 && reversed === n) return 'REVERSED';
	if (reversed > 0 && paid + reversed === n) return 'PARTIALLY_REVERSED';
	if (paid > 0) return 'PARTIALLY_PAID';
	if (reversed > 0) return 'PARTIALLY_REVERSED';
	return 'EXPORTED';
}

/** Upper-case ASCII, runs of anything else → "-", trimmed. Never derived from anything but codes. */
export const normalizeCode = (s: string) =>
	s
		.normalize('NFKD')
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

const INSTRUCTION_MAX = 120;

/**
 * Immutable bank instruction references for NEW items: PI-{batchNumber}-{employeeCode}, ASCII-safe,
 * unique within the batch (two codes that normalize alike get -2, -3 …). The DB unique
 * (paymentBatchId, instructionReference) is the backstop.
 */
export function instructionReferences(batchNumber: string, employeeCodes: string[]): string[] {
	const used = new Set<string>();
	return employeeCodes.map((code) => {
		const base = `PI-${normalizeCode(batchNumber) || 'PAY'}-${normalizeCode(code) || 'EMP'}`;
		let ref = base.slice(0, INSTRUCTION_MAX);
		for (let n = 2; used.has(ref); n++) {
			const suffix = `-${n}`;
			ref = `${base.slice(0, INSTRUCTION_MAX - suffix.length)}${suffix}`;
		}
		used.add(ref);
		return ref;
	});
}
