import { Prisma } from '@prisma/client';
import { Errors } from '../../utils/AppError.js';
import { parseId } from '../../validation/common.schema.js';
import { addDays, formatDateOnly, todayInLaos } from '../../lib/dates.js';
import { serverNow } from '../../lib/clock.js';

/**
 * Phase 17A — shared reporting helpers. Reporting is READ ONLY: nothing under services/reporting
 * writes to the database, and none of it re-implements a domain rule (attendance / leave / OT /
 * payroll / payment / accounting logic is always the domain service's own).
 *
 * NUMERIC CONTRACT (every report response):
 *   money       — fixed-2 decimal STRING ("5552250.00"), summed with Prisma.Decimal (never a JS float)
 *   day values  — fixed-2 decimal STRING ("1.00"): leave days are DECIMAL(4,2) in the database
 *   durations   — integer MINUTES
 *   counts      — integers
 *   percentages — { numerator, denominator, percent } where percent is a fixed-2 decimal STRING
 *                 ("87.50") computed with Decimal (HALF_UP), or null when the denominator is 0
 */
export const REPORT_TIMEZONE = 'Asia/Vientiane';

export const ReportErrors = {
	groupByInvalid: (allowed: readonly string[]) =>
		Errors.badRequest('REPORT_GROUP_BY_INVALID', 'ການຈັດກຸ່ມລາຍງານບໍ່ຖືກຕ້ອງ', {
			allowed: [...allowed]
		}),
	rangeInvalid: (message: string) => Errors.badRequest('REPORT_DATE_RANGE_INVALID', message),
	rangeTooLarge: (details: Record<string, unknown>) =>
		Errors.badRequest(
			'REPORT_DATE_RANGE_TOO_LARGE',
			'ຊ່ວງວັນທີຂອງລາຍງານກວ້າງເກີນໄປ — ກະລຸນາເລືອກຊ່ວງທີ່ສັ້ນລົງ ຫຼື ກັ່ນຕອງເພີ່ມ',
			details
		),
	filterInvalid: (field: string) =>
		Errors.badRequest('REPORT_FILTER_INVALID', 'ຕົວກອງລາຍງານບໍ່ຖືກຕ້ອງ', { field }),
	filterRequired: (field: string) =>
		Errors.badRequest('REPORT_FILTER_REQUIRED', 'ກະລຸນາເລືອກບໍລິສັດສຳລັບລາຍງານນີ້', { field }),
	filterNotAllowed: (field: string) =>
		Errors.forbiddenWith(
			'REPORT_FILTER_NOT_ALLOWED',
			`ທ່ານບໍ່ມີສິດເບິ່ງລາຍງານຕາມຕົວກອງນີ້ (${field})`
		),
	historicalUnavailable: (code: string) =>
		Errors.badRequest(
			'REPORT_HISTORICAL_DATA_UNAVAILABLE',
			'ລະບົບຍັງບໍ່ມີຂໍ້ມູນປະຫວັດພຽງພໍສຳລັບວັນທີທີ່ເລືອກ — ສະແດງໄດ້ສະເພາະປັດຈຸບັນ',
			{ reason: code }
		)
};

/** Whitelists a groupBy value; anything else (incl. a column name / SQL) is REPORT_GROUP_BY_INVALID. */
export function parseGroupBy<T extends string>(
	value: string | undefined,
	allowed: readonly T[],
	fallback: T
): T {
	if (value === undefined || value === '') return fallback;
	if ((allowed as readonly string[]).includes(value)) return value as T;
	throw ReportErrors.groupByInvalid(allowed);
}

export const moneyText = (v: Prisma.Decimal) => v.toFixed(2);
export const dayText = (v: Prisma.Decimal) => v.toFixed(2);

export interface Rate {
	numerator: number;
	denominator: number;
	/** fixed-2 decimal string, null when denominator is 0 */
	percent: string | null;
}

export function rate(numerator: number, denominator: number): Rate {
	return {
		numerator,
		denominator,
		percent:
			denominator === 0
				? null
				: new Prisma.Decimal(numerator).times(100).dividedBy(denominator).toFixed(2)
	};
}

export const DAY_MS = 86_400_000;
export const daysBetweenInclusive = (from: Date, to: Date) =>
	Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;

export function eachDate(from: Date, to: Date): Date[] {
	const out: Date[] = [];
	for (let d = from; d.getTime() <= to.getTime(); d = addDays(d, 1)) out.push(d);
	return out;
}

/** The ONE "today" of reporting: the canonical Laos business date (same helper as attendance). */
export const reportToday = () => todayInLaos(serverNow());

const firstOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

/**
 * from / to (inclusive Laos calendar dates). Default: the current month up to today. `from > to` and
 * (when `allowFuture` is false) a `to` after today are REPORT_DATE_RANGE_INVALID; a span above
 * `maxDays` is REPORT_DATE_RANGE_TOO_LARGE.
 */
export function resolveRange(
	input: { from?: Date; to?: Date },
	opts: { maxDays: number; allowFuture: boolean }
): { from: Date; to: Date; days: number } {
	const today = reportToday();
	const to = input.to ?? today;
	const from = input.from ?? firstOfMonth(to);
	if (from.getTime() > to.getTime()) {
		throw ReportErrors.rangeInvalid('ວັນທີເລີ່ມຕ້ອງບໍ່ຫຼັງວັນທີສິ້ນສຸດ');
	}
	if (!opts.allowFuture && to.getTime() > today.getTime()) {
		throw ReportErrors.rangeInvalid('ບໍ່ສາມາດເລືອກວັນທີໃນອະນາຄົດໄດ້');
	}
	const days = daysBetweenInclusive(from, to);
	if (days > opts.maxDays) {
		throw ReportErrors.rangeTooLarge({ maxDays: opts.maxDays, requestedDays: days });
	}
	return { from, to, days };
}

export const isoDate = (d: Date | null) => (d ? formatDateOnly(d) : null);

export const personLabel = (e: {
	employeeCode: string;
	firstNameLao: string;
	lastNameLao: string;
}) => `${e.firstNameLao} ${e.lastNameLao}`.trim();

/** A group of a summary report — `metrics` differ per report, the envelope does not. */
export interface ReportGroup<M> {
	key: string;
	code: string | null;
	label: string;
	metrics: M;
}

export const UNASSIGNED_KEY = 'UNASSIGNED';
export const UNASSIGNED_LABEL = 'ບໍ່ໄດ້ກຳນົດ';

/**
 * Report group keys are STRINGS (an entity id, an enum value or UNASSIGNED_KEY). An entity id becomes
 * String(id); a missing one the UNASSIGNED key.
 */
export const groupKey = (id: number | null | undefined): string =>
	id === null || id === undefined ? UNASSIGNED_KEY : String(id);

/** The entity ids among group keys (UNASSIGNED / enum keys are dropped), parsed strictly. */
export const idsFromKeys = (keys: Iterable<string>): number[] =>
	[...keys].map((k) => parseId(k)).filter((n): n is number => n !== null);

/** Groups rows by a key; `make` builds the empty accumulator, `add` folds a row in. */
export function groupRows<R, M>(
	rows: R[],
	keyOf: (r: R) => string,
	make: () => M,
	add: (acc: M, r: R) => void
): Map<string, M> {
	const out = new Map<string, M>();
	for (const r of rows) {
		const k = keyOf(r);
		let acc = out.get(k);
		if (!acc) {
			acc = make();
			out.set(k, acc);
		}
		add(acc, r);
	}
	return out;
}
