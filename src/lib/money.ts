import { Prisma } from '@prisma/client';
import { z } from 'zod';

/**
 * MONEY HELPERS (Phase 11). Every monetary value is a Prisma.Decimal (DB: DECIMAL(18,2)) — never a JS
 * float. Arithmetic uses Decimal only, and payroll APIs SERIALIZE amounts as fixed-2 STRINGS
 * ("5000000.00"): a JSON number would go through IEEE-754 doubles on the client and could silently lose
 * precision. Clients must treat these strings as opaque decimals (the UI only formats them for display).
 */
export const Money = Prisma.Decimal;
export type MoneyValue = Prisma.Decimal;

export const ZERO = new Prisma.Decimal(0);
const MAX_MONEY = new Prisma.Decimal('9999999999999999.99'); // DECIMAL(18,2)

/** "5000000.00" — the canonical API/DB text form. */
export const moneyString = (value: Prisma.Decimal | string | number): string =>
	new Prisma.Decimal(value).toFixed(2);

export const sumMoney = (values: Iterable<Prisma.Decimal>): Prisma.Decimal => {
	let total = new Prisma.Decimal(0);
	for (const v of values) total = total.plus(v);
	return total;
};

/** Serialises an optional Decimal column. */
export const moneyOrNull = (value: Prisma.Decimal | null | undefined): string | null =>
	value === null || value === undefined ? null : moneyString(value);

const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})?$/;

/**
 * Request money field: a plain decimal string or number with at most 2 fraction digits and no sign or
 * exponent ("5000000", "5000000.50", 5000000). Output is a Decimal. `min` / positivity are enforced by
 * the caller-specific wrappers below.
 */
function rawMoney() {
	return z.union([z.string(), z.number()]).transform((v, ctx) => {
		const text = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v.trim();
		if (!MONEY_PATTERN.test(text)) {
			ctx.addIssue({
				code: 'custom',
				message: 'ຈຳນວນເງິນບໍ່ຖືກຕ້ອງ (ຕົວເລກບວກ, ສູງສຸດ 2 ຕຳແໜ່ງທົດສະນິຍົມ)'
			});
			return z.NEVER;
		}
		const d = new Prisma.Decimal(text);
		if (d.greaterThan(MAX_MONEY)) {
			ctx.addIssue({ code: 'custom', message: 'ຈຳນວນເງິນໃຫຍ່ເກີນໄປ' });
			return z.NEVER;
		}
		return d;
	});
}

/** Strictly positive amount (component amounts, base salary, adjustments). Negatives are rejected. */
export const positiveMoneyField = () =>
	rawMoney().refine((d) => d.greaterThan(0), 'ຈຳນວນເງິນຕ້ອງຫຼາຍກວ່າ 0');

/**
 * PAYROLL CALCULATION PRECISION (Phase 12A). Intermediate arithmetic (proration factors, daily and
 * minute rates, OT rates) runs on a 40-significant-digit Decimal so nothing is truncated on the way;
 * results are rounded HALF_UP to 2 decimal places ONLY when a monetary line item / segment amount is
 * created (`roundMoney`), and totals are sums of those already-rounded lines so a breakdown always
 * reconciles to the cent. No JS floating-point arithmetic is ever involved.
 */
export const Calc = Prisma.Decimal.clone({ precision: 40, rounding: Prisma.Decimal.ROUND_HALF_UP });
export type CalcValue = InstanceType<typeof Calc>;

export const calc = (value: Prisma.Decimal | string | number | CalcValue): CalcValue =>
	new Calc(typeof value === 'number' ? String(value) : value.toString());

/** 2-dp HALF_UP rounding of an intermediate value, returned as a storable Prisma.Decimal. */
export const roundMoney = (value: Prisma.Decimal | CalcValue): Prisma.Decimal =>
	new Prisma.Decimal(calc(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2));
