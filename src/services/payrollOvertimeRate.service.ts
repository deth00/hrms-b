import { Prisma } from '@prisma/client';
import { calc, type CalcValue } from '../lib/money.js';

/**
 * PHASE 12A.2 — OT RATE BASIS CORRECTION.
 *
 * Phase 12A.1 made `EmployeeCompensation.baseSalary` an unambiguously MONTHLY amount and inserted a
 * cycle-allocation step before Phase 12A's normal-salary segmentation/proration:
 *
 *   MONTHLY SALARY ──cycle allocation──▶ cycleBaseSalary ──segment proration──▶ paid base salary
 *
 * The OT minute rate must NEVER branch from `cycleBaseSalary` (or any further-prorated segment amount)
 * — payroll PAYMENT FREQUENCY must not change an employee's OT rate. It branches from the MONTHLY
 * salary directly, on a second, independent path:
 *
 *   MONTHLY SALARY ──÷ monthlyDivisorDays ÷ standardDailyMinutes──▶ minute rate ──× minutes × multiplier──▶ OT amount
 *
 * `monthlyDivisorDays` and `standardDailyMinutes` stay MONTHLY, unconditionally — a TWO/month schedule
 * never means "divide the divisor by 2" (§3–4). This file is the ONE place both numbers meet; neither
 * payrollCalculationV2.ts nor payrollOvertime.service.ts re-derive the minute rate on their own.
 */

export interface MonthlyCompensationRow {
	id: number;
	effectiveFrom: Date;
	effectiveTo: Date | null;
	baseSalary: Prisma.Decimal;
}

const t = (d: Date) => d.getTime();
const covers = (r: { effectiveFrom: Date; effectiveTo: Date | null }, d: Date) =>
	t(r.effectiveFrom) <= t(d) && (r.effectiveTo === null || t(r.effectiveTo) >= t(d));

/**
 * The MONTHLY (never cycle-scaled) compensation row effective on `date` — typically an OT request's
 * `workDate`. `rows` must be the employee's raw, UNSCALED compensation history (the same rows Phase
 * 12A.1 scales for normal-salary purposes; here they are read before any scaling). Historical company /
 * assignment correctness is inherited from the caller, which already resolves `rows` through the same
 * EmployeeAssignmentHistory-aware segmentation Phase 11.1 / 12A use for everything else — this function
 * only ever picks by date among rows the caller has already scoped to the right employee.
 */
export function monthlyCompensationAt(
	rows: readonly MonthlyCompensationRow[],
	date: Date
): MonthlyCompensationRow | null {
	return rows.find((r) => covers(r, date)) ?? null;
}

export interface OvertimeRuleFacts {
	multiplier: Prisma.Decimal | string;
	monthlyDivisorDays: number | null;
	standardDailyMinutes: number | null;
}

export interface OvertimeRateBasis {
	monthlyBaseSalary: Prisma.Decimal;
	monthlyDivisorDays: number;
	standardDailyMinutes: number;
	minuteRate: CalcValue;
	multiplier: Prisma.Decimal;
}

/**
 * THE central OT rate resolver. `monthlyBaseSalary` must already be the MONTHLY amount effective on the
 * OT work date (see `monthlyCompensationAt`) — never a cycle-allocated or segment-prorated figure.
 * Returns `null` when the rate cannot be computed (no monthly compensation for that date, or the rule
 * is missing its divisor / daily minutes) — the caller turns that into OT_COMPENSATION_RULE_INCOMPLETE,
 * never guessing a number.
 */
export function resolveOvertimeRateBasis(
	monthlyBaseSalary: Prisma.Decimal | null,
	rule: OvertimeRuleFacts
): OvertimeRateBasis | null {
	if (!monthlyBaseSalary || !rule.monthlyDivisorDays || !rule.standardDailyMinutes) return null;
	const minuteRate = calc(monthlyBaseSalary)
		.div(rule.monthlyDivisorDays)
		.div(rule.standardDailyMinutes);
	return {
		monthlyBaseSalary,
		monthlyDivisorDays: rule.monthlyDivisorDays,
		standardDailyMinutes: rule.standardDailyMinutes,
		minuteRate,
		multiplier: new Prisma.Decimal(rule.multiplier)
	};
}
