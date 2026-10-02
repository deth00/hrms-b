import { Prisma } from '@prisma/client';
import { calc, roundMoney, type CalcValue } from '../lib/money.js';

/**
 * PROGRESSIVE MONTHLY PIT (Phase 12B §23). Pure function — no DB, no company/legal knowledge. The
 * brackets themselves are DATABASE CONFIGURATION (PayrollPitBracket, resolved by
 * payrollStatutoryRule.service.ts); this file only implements "apply a progressive bracket table to a
 * base", so a bracket edit is a new rule version, never a code change.
 *
 * All arithmetic is Decimal (via `calc`, the 40-significant-digit clone) until the very end, where the
 * total is HALF_UP-rounded to 2dp exactly once (the statutory rounding policy, §53) — per-bracket
 * contributions in `breakdown` are informational (rounded for display) and are NOT summed to produce
 * `totalPit`; `totalPit` is the exact bracket-weighted total, then rounded.
 */
export interface PitBracketInput {
	order: number;
	lowerBound: Prisma.Decimal;
	upperBound: Prisma.Decimal | null;
	rate: Prisma.Decimal;
}

export interface PitBracketContribution {
	order: number;
	lowerBound: string;
	upperBound: string | null;
	rate: string;
	/** the slice of `base` that fell in this bracket (0 when the base never reached it) */
	amountInBracket: string;
	/** tax contributed by this bracket, HALF_UP 2dp for display */
	tax: string;
}

export interface ProgressivePitResult {
	taxableBase: Prisma.Decimal;
	totalPit: Prisma.Decimal;
	breakdown: PitBracketContribution[];
}

/**
 * Applies an ordered, continuous, non-overlapping bracket table to `base` (a monthly, or
 * month-to-date, PIT taxable base — never a raw salary). A negative or zero base pays no tax and
 * every bracket shows a zero contribution. Brackets MUST already be validated (see
 * `validatePitBrackets` below) — this function does not re-validate, it trusts its caller.
 */
export function calculateProgressivePit(
	base: Prisma.Decimal | CalcValue,
	brackets: readonly PitBracketInput[]
): ProgressivePitResult {
	const taxableBase = calc(base).isNegative() ? calc(0) : calc(base);
	const sorted = [...brackets].sort((a, b) => a.order - b.order);
	let total = calc(0);
	const breakdown: PitBracketContribution[] = [];
	for (const b of sorted) {
		const lower = calc(b.lowerBound);
		const upper = b.upperBound === null ? null : calc(b.upperBound);
		const amountInBracket = taxableBase.lessThanOrEqualTo(lower)
			? calc(0)
			: (upper === null ? taxableBase : CalcMin(taxableBase, upper)).minus(lower);
		const clamped = amountInBracket.isNegative() ? calc(0) : amountInBracket;
		const tax = clamped.times(calc(b.rate));
		total = total.plus(tax);
		breakdown.push({
			order: b.order,
			lowerBound: b.lowerBound.toFixed(2),
			upperBound: b.upperBound === null ? null : b.upperBound.toFixed(2),
			rate: b.rate.toFixed(4),
			amountInBracket: roundMoney(clamped).toFixed(2),
			tax: roundMoney(tax).toFixed(2)
		});
	}
	return {
		taxableBase: new Prisma.Decimal(taxableBase.toFixed(2)),
		totalPit: roundMoney(total),
		breakdown
	};
}

function CalcMin(a: CalcValue, b: CalcValue): CalcValue {
	return a.lessThan(b) ? a : b;
}

/**
 * Structural validation (§5): ordered by `order` from 1, non-overlapping, continuous (each bracket's
 * lowerBound equals the previous upperBound), the first lowerBound is 0, and only the LAST bracket may
 * have a NULL (open-ended) upperBound. Returns a Lao error message, or null when the table is valid.
 */
export function validatePitBrackets(brackets: readonly PitBracketInput[]): string | null {
	if (brackets.length === 0) return 'ຕ້ອງມີຢ່າງນ້ອຍໜຶ່ງຂັ້ນອັດຕາພາສີ';
	const sorted = [...brackets].sort((a, b) => a.order - b.order);
	for (let i = 0; i < sorted.length; i++) {
		if (sorted[i]!.order !== i + 1) return 'ລຳດັບຂັ້ນອັດຕາພາສີຕ້ອງຕໍ່ເນື່ອງ ເລີ່ມຈາກ 1';
	}
	if (!sorted[0]!.lowerBound.equals(0)) return 'ຂັ້ນທຳອິດຕ້ອງເລີ່ມຈາກ 0';
	for (let i = 0; i < sorted.length; i++) {
		const b = sorted[i]!;
		const isLast = i === sorted.length - 1;
		if (!isLast && b.upperBound === null) {
			return 'ມີແຕ່ຂັ້ນສຸດທ້າຍເທົ່ານັ້ນທີ່ບໍ່ມີເພດານ (ບໍ່ຈຳກັດ)';
		}
		if (b.upperBound !== null && b.upperBound.lessThanOrEqualTo(b.lowerBound)) {
			return 'ເພດານຂອງແຕ່ລະຂັ້ນຕ້ອງຫຼາຍກວ່າພື້ນ';
		}
		if (i > 0) {
			const prev = sorted[i - 1]!;
			if (prev.upperBound === null || !prev.upperBound.equals(b.lowerBound)) {
				return 'ຂັ້ນອັດຕາພາສີຕ້ອງຕໍ່ເນື່ອງກັນ (ບໍ່ຊ້ອນກັນ ແລະ ບໍ່ມີຊ່ອງຫວ່າງ)';
			}
		}
	}
	return null;
}
