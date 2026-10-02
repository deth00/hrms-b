import { Prisma } from '@prisma/client';
import type { MonthlyAllocationMethod, PaymentsPerMonth } from '@prisma/client';
import type { prisma } from '../config/prisma.js';
import { calc, roundMoney, type CalcValue } from '../lib/money.js';
import { dayCount } from './payrollProration.service.js';
import { monthCycleRanges, parsePayrollMonth } from '../lib/payrollCycles.js';

/**
 * PAYROLL MONTH / CYCLE ALLOCATION (Phase 12A.1) — the STATUTORY-MONTH FOUNDATION.
 *
 * For a MONTHLY schedule paying `paymentsPerMonth` times a month, `EmployeeCompensation.baseSalary` and
 * `EmployeeRecurringPayComponent.amount` mean the MONTHLY amount — never "amount per payroll cycle".
 * Before Phase 12A's employee/period segmentation-and-proration runs, EVERY monthly amount must first
 * be reduced to its CYCLE share:
 *
 *   MONTHLY AMOUNT  →  CYCLE ALLOCATION (this file)  →  segment proration  →  attendance/leave  →  OT
 *
 * This module is the ONE place that resolves "which payroll month / cycle is this period, and what
 * fraction of the month does this cycle represent" — PIT and Social Security (Phase 12B) must reuse it,
 * never re-derive it.
 */
type Db = Prisma.TransactionClient | typeof prisma;

export interface CycleRangeInfo {
	cycleNumber: number;
	start: Date;
	end: Date;
}

export interface MonthAllocationContext {
	/** null only for a manual period with no derivable payroll-month identity */
	payrollMonth: string | null;
	paymentsPerMonth: PaymentsPerMonth;
	cycleNumber: number;
	/** 1 for ONE/month or a manual period; 2 for a TWO/month schedule (the schema supports no more today) */
	totalCycles: number;
	isLastCycle: boolean;
	allocationMethod: MonthlyAllocationMethod | null;
	/** TWO/month with monthlyAllocationMethod still unconfigured (§5) — every employee BLOCKS */
	blocked: boolean;
	thisRange: CycleRangeInfo | null;
	/** the OTHER cycle(s) of the same payroll month (one entry for a TWO/month schedule) */
	otherRanges: CycleRangeInfo[];
	/** this cycle's CALENDAR_DAYS-basis share of the month — always computable, no employee data needed */
	calendarFactor: CalcValue;
	/** the (single) other cycle's CALENDAR_DAYS-basis share — null when totalCycles === 1 */
	otherCalendarFactor: CalcValue | null;
}

const ONE_CYCLE_CONTEXT = (payrollMonth: string | null): MonthAllocationContext => ({
	payrollMonth,
	paymentsPerMonth: 'ONE',
	cycleNumber: 1,
	totalCycles: 1,
	isLastCycle: true,
	allocationMethod: null,
	blocked: false,
	thisRange: null,
	otherRanges: [],
	calendarFactor: calc(1),
	otherCalendarFactor: null
});

/**
 * Pure (no DB): resolves the full cycle-allocation context for one PayrollPeriod of one PayrollSchedule.
 * A manual period (no schedule) or a ONE/month schedule is always the trivial "whole month" context —
 * `scaledAmount` below then returns amounts completely unchanged, so ONE/month payroll is bit-for-bit
 * what it was before this phase.
 */
export function resolvePayrollMonthContext(input: {
	schedule: {
		paymentsPerMonth: PaymentsPerMonth;
		splitDay: number | null;
		monthlyAllocationMethod: MonthlyAllocationMethod | null;
	} | null;
	period: { payrollMonth: string | null; cycleNumber: number | null };
}): MonthAllocationContext {
	const { schedule, period } = input;
	if (!schedule || schedule.paymentsPerMonth === 'ONE' || !period.payrollMonth) {
		return ONE_CYCLE_CONTEXT(period.payrollMonth);
	}
	const { year, month } = parsePayrollMonth(period.payrollMonth);
	const ranges = monthCycleRanges('TWO', schedule.splitDay, year, month);
	if (ranges.length === 1) {
		// the split day left no second cycle this month (28-day February edge, §21.4 of the schedule
		// spec) — this month behaves exactly like a ONE/month schedule
		return ONE_CYCLE_CONTEXT(period.payrollMonth);
	}
	const cycleNumber = period.cycleNumber ?? 1;
	const thisRange = ranges.find((r) => r.cycleNumber === cycleNumber) ?? ranges[0]!;
	const others = ranges.filter((r) => r.cycleNumber !== thisRange.cycleNumber);
	const monthUnits = ranges.reduce((n, r) => n + dayCount(r.start, r.end), 0);
	const calendarFactor = calc(dayCount(thisRange.start, thisRange.end)).div(monthUnits);
	const otherCalendarFactor = others[0]
		? calc(dayCount(others[0].start, others[0].end)).div(monthUnits)
		: null;
	const lastCycleNumber = ranges[ranges.length - 1]!.cycleNumber;
	return {
		payrollMonth: period.payrollMonth,
		paymentsPerMonth: 'TWO',
		cycleNumber: thisRange.cycleNumber,
		totalCycles: ranges.length,
		isLastCycle: thisRange.cycleNumber === lastCycleNumber,
		allocationMethod: schedule.monthlyAllocationMethod,
		blocked: schedule.monthlyAllocationMethod === null,
		thisRange,
		otherRanges: others,
		calendarFactor,
		otherCalendarFactor
	};
}

/**
 * The (thisCycle, otherCycle) allocation factor pair. `workingUnits`, when given, overrides the
 * CALENDAR_DAYS basis with employee-specific WORKING_DAYS units (only meaningful for
 * `allocationMethod === 'PERIOD_UNITS'` under a PayrollRuleSet whose prorationMethod is WORKING_DAYS —
 * resolved by the v2 engine, which already builds the employee's working-day calendar).
 */
export function cycleAllocationFactors(
	ctx: MonthAllocationContext,
	workingUnits?: { thisCycle: number; otherCycle: number }
): { thisFactor: CalcValue; otherFactor: CalcValue } {
	if (ctx.totalCycles <= 1) return { thisFactor: calc(1), otherFactor: calc(0) };
	if (ctx.allocationMethod === 'EQUAL_SPLIT') {
		const f = calc(1).div(ctx.totalCycles);
		return { thisFactor: f, otherFactor: f };
	}
	// PERIOD_UNITS
	if (workingUnits && workingUnits.thisCycle + workingUnits.otherCycle > 0) {
		const total = workingUnits.thisCycle + workingUnits.otherCycle;
		return {
			thisFactor: calc(workingUnits.thisCycle).div(total),
			otherFactor: calc(workingUnits.otherCycle).div(total)
		};
	}
	return { thisFactor: ctx.calendarFactor, otherFactor: ctx.otherCalendarFactor ?? calc(0) };
}

/** Does this effective-dated row ALSO cover the other cycle's full date range at the same amount? */
export function rowSpansOtherCycle(
	row: { effectiveFrom: Date; effectiveTo: Date | null },
	ctx: MonthAllocationContext
): boolean {
	if (ctx.otherRanges.length === 0) return false;
	const t = (d: Date) => d.getTime();
	return ctx.otherRanges.every(
		(r) =>
			t(row.effectiveFrom) <= t(r.start) &&
			(row.effectiveTo === null || t(row.effectiveTo) >= t(r.end))
	);
}

/**
 * MONTHLY AMOUNT -> CYCLE ALLOCATION. `X` is a monthly compensation / recurring-component amount.
 * Deterministic residual handling (§12): the LAST cycle of a row that spans BOTH cycles at the same
 * value gets `X - round(X * otherFactor)` instead of its own independently-rounded share, so the two
 * cycles' allocations always sum to exactly `X` for a complete, unchanged month. A row that does NOT
 * span the other cycle (a new hire, or a salary/component change landing exactly on the cycle
 * boundary) is scaled independently — there is nothing to reconcile against (§15).
 * ONE/month (or a manual period) returns `X` completely unchanged.
 */
export function scaledAmount(
	X: Prisma.Decimal,
	ctx: MonthAllocationContext,
	factors: { thisFactor: CalcValue; otherFactor: CalcValue },
	spansOtherCycle: boolean
): Prisma.Decimal {
	if (ctx.totalCycles <= 1) return X;
	if (spansOtherCycle && ctx.isLastCycle) {
		return X.minus(roundMoney(calc(X).times(factors.otherFactor)));
	}
	return new Prisma.Decimal(calc(X).times(factors.thisFactor).toFixed(10));
}

// ============================================================================================
// §19 — prior finalized cycle resolver (foundation for Phase 12B PIT / SSO monthly accumulation)
// ============================================================================================

export interface PriorPayrollCycle {
	runId: number;
	periodId: number;
	cycleNumber: number;
	finalizedAt: Date | null;
	results: {
		employeeId: number;
		totalEarnings: Prisma.Decimal;
		totalDeductions: Prisma.Decimal;
		netPay: Prisma.Decimal;
	}[];
}

/**
 * Returns the FINALIZED runs of earlier cycles of the SAME company + schedule + payroll month
 * (cycleNumber strictly less than `cycleNumber`), ordered by cycle. Read-only context — no PIT / SSO
 * calculation happens here (deferred to Phase 12B); `employeeId` narrows the returned results.
 */
export async function getPriorFinalizedPayrollCycles(
	db: Db,
	companyId: number,
	payrollScheduleId: number,
	payrollMonth: string,
	cycleNumber: number,
	employeeId?: number
): Promise<PriorPayrollCycle[]> {
	const runs = await db.payrollRun.findMany({
		where: {
			companyId,
			payrollScheduleId,
			payrollMonth,
			cycleNumber: { lt: cycleNumber },
			status: 'FINALIZED'
		},
		orderBy: { cycleNumber: 'asc' },
		include: {
			results: {
				where: employeeId ? { employeeId } : undefined,
				select: { employeeId: true, totalEarnings: true, totalDeductions: true, netPay: true }
			}
		}
	});
	return runs.map((r) => ({
		runId: r.id,
		periodId: r.periodId,
		cycleNumber: r.cycleNumber ?? 1,
		finalizedAt: r.finalizedAt,
		results: r.results
	}));
}
