/**
 * PAYROLL CYCLE CALENDAR MATH (Phase 11.1 / Phase 12A.1) — pure, no I/O. The ONE place that turns
 * (paymentsPerMonth, splitDay, year, month) into concrete cycle date ranges. Used by:
 *   - payrollSchedule.service.ts (period generation: planPeriods)
 *   - payrollMonthContext.service.ts (Phase 12A.1 cycle allocation)
 * so the "28-day February split" edge case has exactly one implementation.
 */
export interface CycleRange {
	cycleNumber: number;
	start: Date;
	end: Date;
}

/**
 * The cycle date ranges a MONTHLY schedule defines for one calendar month.
 *   ONE payment/month              -> one range, the whole month.
 *   TWO payments/month, split valid -> [1..splitDay], [splitDay+1..lastDay].
 *   TWO payments/month, split >= lastDay (only 28 in a 28-day February) -> ONE range (no empty/inverted
 *   second cycle): the month is a single period that cycle.
 */
export function monthCycleRanges(
	paymentsPerMonth: 'ONE' | 'TWO',
	splitDay: number | null | undefined,
	year: number,
	month: number // 1-12
): CycleRange[] {
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month = last day
	const split = splitDay ?? 15;
	const ranges: [number, number][] =
		paymentsPerMonth === 'TWO' && split < lastDay
			? [
					[1, split],
					[split + 1, lastDay]
				]
			: [[1, lastDay]];
	return ranges.map(([fromDay, toDay], idx) => ({
		cycleNumber: idx + 1,
		start: new Date(Date.UTC(year, month - 1, fromDay)),
		end: new Date(Date.UTC(year, month - 1, toDay))
	}));
}

/** "2026-10" -> { year: 2026, month: 10 }. Caller guarantees a valid YYYY-MM string. */
export function parsePayrollMonth(payrollMonth: string): { year: number; month: number } {
	return { year: Number(payrollMonth.slice(0, 4)), month: Number(payrollMonth.slice(5, 7)) };
}

/** "2026" + "10" -> "2026-10" */
export function formatPayrollMonth(year: number, month: number): string {
	return `${year}-${String(month).padStart(2, '0')}`;
}
