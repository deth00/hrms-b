import { Prisma } from '@prisma/client';
import type { PayComponentType } from '@prisma/client';
import { addDays, dayOfWeekOf } from '../lib/dates.js';
import { calc, roundMoney } from '../lib/money.js';
import type { AssignmentSegment } from './employeeAssignmentResolver.js';

/**
 * PAYROLL PRORATION (Phase 12A) — pure functions, no I/O. The ONLY place segment boundaries and
 * proration formulas live; controllers / UI never repeat them.
 *
 * A payroll SEGMENT is a maximal date range inside the employee's covered days (employment ∩ period ∩
 * "belonged to the run's company") over which everything that affects pay is constant:
 *   company, branch (only when the schedule groups by branch), the base salary row, and the set of
 *   recurring pay-component rows.
 * A change of any of those starts a new segment. Days the employee spent in ANOTHER company are simply
 * not part of this company's segments (they belong to that company's run).
 *
 * Base salary is the amount for ONE FULL payroll period (this is how Phases 11 / 11.1 already pay it).
 *
 *   CALENDAR_DAYS:  segment pay = base × calendar days in segment ÷ calendar days in the PERIOD
 *   WORKING_DAYS :  segment pay = base × scheduled working days in segment ÷ scheduled working days in the PERIOD
 *
 * No 30-day / 26-day / 22-day month is assumed anywhere: both numbers are read from the real calendar
 * or the employee's schedule. Everything is 40-digit Decimal; amounts are rounded HALF_UP to 2 dp only
 * when a segment / line amount is produced (`roundMoney`).
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const t = (d: Date) => d.getTime();

export const dayCount = (from: Date, to: Date) => Math.round((t(to) - t(from)) / MS_PER_DAY) + 1;

export function eachDay(from: Date, to: Date): Date[] {
	const days: Date[] = [];
	for (let d = from; t(d) <= t(to); d = addDays(d, 1)) days.push(d);
	return days;
}

export interface CompRow {
	id: number;
	effectiveFrom: Date;
	effectiveTo: Date | null;
	baseSalary: Prisma.Decimal;
	currencyCode: string;
}
export interface RecurringRow {
	payComponentId: number;
	effectiveFrom: Date;
	effectiveTo: Date | null;
	amount: Prisma.Decimal;
	payComponent: {
		id: number;
		code: string;
		nameLao: string;
		nameEnglish: string | null;
		type: PayComponentType;
	};
}

export interface Slice {
	from: Date;
	to: Date;
	companyId: number;
	branchId: number | null;
	comp: CompRow | null;
	recurring: RecurringRow[];
}

const covers = (r: { effectiveFrom: Date; effectiveTo: Date | null }, d: Date) =>
	t(r.effectiveFrom) <= t(d) && (r.effectiveTo === null || t(r.effectiveTo) >= t(d));

/** Splits the covered range into slices at every boundary that changes pay (see file header). */
export function planSlices(input: {
	coverage: { from: Date; to: Date };
	timeline: readonly AssignmentSegment[];
	companyId: number;
	groupByBranch: boolean;
	comps: readonly CompRow[];
	recurring: readonly RecurringRow[];
}): Slice[] {
	const { coverage, timeline, companyId, groupByBranch, comps, recurring } = input;
	const cuts = new Set<number>();
	const addCut = (d: Date) => {
		if (t(d) > t(coverage.from) && t(d) <= t(coverage.to)) cuts.add(t(d));
	};
	const sortedTimeline = [...timeline].sort((a, b) => t(a.from) - t(b.from));
	sortedTimeline.forEach((seg, i) => {
		const prev = sortedTimeline[i - 1];
		if (
			prev &&
			(seg.companyId !== prev.companyId || (groupByBranch && seg.branchId !== prev.branchId))
		) {
			addCut(seg.from);
		}
	});
	for (const r of [...comps, ...recurring]) {
		addCut(r.effectiveFrom);
		if (r.effectiveTo) addCut(addDays(r.effectiveTo, 1));
	}
	const starts = [t(coverage.from), ...[...cuts].sort((a, b) => a - b)];
	const slices: Slice[] = [];
	starts.forEach((startMs, i) => {
		const from = new Date(startMs);
		const to = i + 1 < starts.length ? addDays(new Date(starts[i + 1]!), -1) : coverage.to;
		const place = sortedTimeline.find((s) => t(s.from) <= t(from) && t(from) <= t(s.to));
		if (!place || place.companyId !== companyId) return; // another company's days
		slices.push({
			from,
			to,
			companyId: place.companyId,
			branchId: place.branchId,
			comp: comps.find((c) => covers(c, from)) ?? null,
			recurring: recurring.filter((r) => covers(r, from))
		});
	});
	return slices;
}

// ---------------------------------------------------------------------------------------------
// working-day calendar (from the employee's schedule assignments — the weekly pattern only)
// ---------------------------------------------------------------------------------------------

export interface ScheduleWindow {
	effectiveFrom: Date;
	effectiveTo: Date | null;
	/** DayOfWeek names on which the shift is a working day */
	workingDays: ReadonlySet<string>;
}

export function makeCalendar(windows: readonly ScheduleWindow[]) {
	const sorted = [...windows].sort((a, b) => t(a.effectiveFrom) - t(b.effectiveFrom));
	const covering = (d: Date) => sorted.find((w) => covers(w, d)) ?? null;
	/** the real assignment when there is one, else the nearest one — ONLY used to size the period */
	const pattern = (d: Date) => {
		const real = covering(d);
		if (real) return real;
		if (sorted.length === 0) return null;
		const earlier = sorted.filter((w) => t(w.effectiveFrom) <= t(d));
		return earlier.length ? earlier[earlier.length - 1]! : sorted[0]!;
	};
	return {
		isEmpty: sorted.length === 0,
		/** is there a real assignment on that day (not the extended pattern)? */
		hasAssignment: (d: Date) => covering(d) !== null,
		isWorkingDay: (d: Date) => pattern(d)?.workingDays.has(dayOfWeekOf(d)) ?? false
	};
}
export type Calendar = ReturnType<typeof makeCalendar>;

// ---------------------------------------------------------------------------------------------
// proration
// ---------------------------------------------------------------------------------------------

export type ProrationMethodName = 'CALENDAR_DAYS' | 'WORKING_DAYS';

export interface ProratedRecurring {
	row: RecurringRow;
	prorated: Prisma.Decimal;
}
export interface ProratedSegment {
	slice: Slice & { comp: CompRow };
	periodUnits: number;
	payableUnits: number;
	/** payable ÷ period, 10 decimal places (display / snapshot only — money uses the exact ratio) */
	factor: Prisma.Decimal;
	baseSalary: Prisma.Decimal;
	proratedBase: Prisma.Decimal;
	recurring: ProratedRecurring[];
}

export function unitsIn(
	method: ProrationMethodName,
	from: Date,
	to: Date,
	calendar: Calendar | null
): number {
	if (method === 'CALENDAR_DAYS') return dayCount(from, to);
	return eachDay(from, to).filter((d) => calendar?.isWorkingDay(d)).length;
}

/** base × payable ÷ period, exact until the final HALF_UP rounding to 2 dp. */
export const prorate = (amount: Prisma.Decimal, payable: number, period: number) =>
	roundMoney(calc(amount).times(payable).div(period));

/** the exact per-unit value of a base amount (a day rate): base ÷ period units */
export const unitRate = (amount: Prisma.Decimal, periodUnits: number) =>
	calc(amount).div(periodUnits);

export function prorateSlices(input: {
	slices: readonly (Slice & { comp: CompRow })[];
	method: ProrationMethodName;
	period: { from: Date; to: Date };
	calendar: Calendar | null;
}): { periodUnits: number; segments: ProratedSegment[] } {
	const { slices, method, period, calendar } = input;
	const periodUnits = unitsIn(method, period.from, period.to, calendar);
	const segments = slices.map((slice): ProratedSegment => {
		const payableUnits = unitsIn(method, slice.from, slice.to, calendar);
		return {
			slice,
			periodUnits,
			payableUnits,
			factor: new Prisma.Decimal(
				periodUnits > 0 ? calc(payableUnits).div(periodUnits).toDecimalPlaces(10).toFixed(10) : '0'
			),
			baseSalary: slice.comp.baseSalary,
			proratedBase:
				periodUnits > 0
					? prorate(slice.comp.baseSalary, payableUnits, periodUnits)
					: roundMoney(calc(0)),
			recurring: slice.recurring.map((row) => ({
				row,
				prorated:
					periodUnits > 0 ? prorate(row.amount, payableUnits, periodUnits) : roundMoney(calc(0))
			}))
		};
	});
	return { periodUnits, segments };
}
