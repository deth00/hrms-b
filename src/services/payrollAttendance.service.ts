import type { PayrollItemSource } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { formatDateOnly } from '../lib/dates.js';
import { calc, roundMoney, type CalcValue } from '../lib/money.js';
import type { DailyResult } from '../validation/attendanceRules.schema.js';
import { resolveDailyAttendance } from './attendanceDaily.service.js';
import type { OvertimeSummary } from './overtimeLookup.service.js';
import type { RuleSnapshot } from './payrollRules.service.js';
import { eachDay } from './payrollProration.service.js';

/**
 * PAYROLL ← ATTENDANCE / LEAVE (Phase 12A).
 *
 * `resolveDailyPayrollContexts` is the ONE daily payroll resolver. For an employee + date it reuses
 * `resolveDailyAttendance` (the existing daily-result service: schedule, working day, holiday, approved
 * leave, attendance record with late / early / worked minutes, approved OT with Phase 8 eligible minutes)
 * — no attendance, leave or OT rule is re-implemented here. Historical company / branch and employment
 * eligibility are resolved by the segment planner (payrollProration) from the assignment history.
 *
 * DEDUCTION MODEL — no double counting. Proration removes only days that are not the employee's to be
 * paid (before hire, after termination, another company). Everything below is a SEPARATE line on top of
 * the prorated salary, and one day is exactly one of ABSENT / LEAVE (paid or unpaid) / present, so a day
 * can never be deducted twice:
 *
 *   day rate           = segment base salary ÷ period units      (units = the SAME denominator proration uses:
 *                        calendar days of the period, or scheduled working days of the period)
 *   unpaid leave       = day rate × approved LeaveRequestDay.dayValue           (leave type isPaid = false)
 *   absence            = day rate × 1                                            (derived ABSENT only)
 *   late / early leave = day rate × min(minutes, dailyMinutes) ÷ dailyMinutes   (late first, then early, the
 *                        two together capped at one day's minutes)
 *   dailyMinutes       = the day's scheduled paid minutes (SCHEDULED_DAILY_MINUTES) or the rule's
 *                        standardDailyMinutes (STANDARD_DAILY_MINUTES) — never a hard-coded number.
 * Paid leave, HOLIDAY, OFF_DAY, PENDING and NO_SCHEDULE days create no deduction. Amounts are summed
 * exact and rounded HALF_UP to 2 dp once per line.
 */
export interface DayContext {
	date: Date;
	result: DailyResult;
	leave: {
		requestId: number;
		leaveTypeCode: string;
		leaveTypeNameLao: string;
		isPaid: boolean;
		dayValue: number;
	} | null;
	lateMinutes: number;
	earlyLeaveMinutes: number;
	scheduledWorkMinutes: number | null;
	overtime: OvertimeSummary[];
}

export const dayKey = (employeeId: number, date: Date) => `${employeeId}|${formatDateOnly(date)}`;

/** employee → the dates it must be resolved for; returns every context keyed by `dayKey`. */
export async function resolveDailyPayrollContexts(
	datesByEmployee: ReadonlyMap<number, readonly Date[]>,
	now: Date
): Promise<Map<string, DayContext>> {
	const byDate = new Map<number, { date: Date; ids: number[] }>();
	for (const [employeeId, dates] of datesByEmployee) {
		for (const d of dates) {
			const entry = byDate.get(d.getTime()) ?? { date: d, ids: [] };
			entry.ids.push(employeeId);
			byDate.set(d.getTime(), entry);
		}
	}
	const out = new Map<string, DayContext>();
	for (const { date, ids } of byDate.values()) {
		const rows = await resolveDailyAttendance(
			ids.map((id) => ({ id })),
			date,
			now
		);
		for (const row of rows) {
			const calculation = row.attendance?.calculation;
			out.set(dayKey(row.employee.id, date), {
				date,
				result: row.result,
				leave: row.leave
					? {
							requestId: row.leave.requestId,
							leaveTypeCode: row.leave.leaveTypeCode,
							leaveTypeNameLao: row.leave.leaveTypeNameLao,
							isPaid: row.leave.isPaid,
							dayValue: row.leave.dayValue
						}
					: null,
				lateMinutes: calculation?.lateMinutes ?? 0,
				earlyLeaveMinutes: calculation?.earlyLeaveMinutes ?? 0,
				scheduledWorkMinutes: calculation?.scheduledWorkMinutes ?? null,
				overtime: row.overtimeRequests
			});
		}
	}
	return out;
}

export interface DeductionLine {
	source: PayrollItemSource;
	code: string;
	nameLao: string;
	nameEnglish: string;
	amount: Prisma.Decimal;
	details: Record<string, unknown>;
}

export interface AttendanceSummary {
	coveredDays: number;
	presentDays: number;
	absentDays: number;
	lateMinutes: number;
	earlyLeaveMinutes: number;
	holidayDays: number;
	offDays: number;
	pendingDays: number;
	noScheduleDays: number;
}
export interface LeaveSummary {
	paidDays: string;
	unpaidDays: string;
	byType: { code: string; nameLao: string; isPaid: boolean; days: string }[];
}

const WORKED = new Set<DailyResult>([
	'PRESENT',
	'LATE',
	'EARLY_LEAVE',
	'LATE_AND_EARLY',
	'INCOMPLETE',
	'IN_PROGRESS'
]);

export interface PricedRange {
	from: Date;
	to: Date;
	/** exact value of ONE unit (day) of this range's base salary */
	dayRate: CalcValue;
}

export function computeAttendanceDeductions(input: {
	ranges: readonly PricedRange[];
	contextOf: (date: Date) => DayContext | undefined;
	rule: RuleSnapshot;
}): { lines: DeductionLine[]; attendance: AttendanceSummary; leave: LeaveSummary } {
	const { ranges, contextOf, rule } = input;
	const zero = () => calc(0);
	let unpaidAmount = zero();
	let absentAmount = zero();
	let lateAmount = zero();
	let earlyAmount = zero();
	const unpaidDates: string[] = [];
	const absentDates: string[] = [];
	const lateDates: string[] = [];
	const earlyDates: string[] = [];
	let unpaidDayTotal = zero();
	let paidDayTotal = zero();
	const leaveTypes = new Map<string, { nameLao: string; isPaid: boolean; days: CalcValue }>();
	const summary: AttendanceSummary = {
		coveredDays: 0,
		presentDays: 0,
		absentDays: 0,
		lateMinutes: 0,
		earlyLeaveMinutes: 0,
		holidayDays: 0,
		offDays: 0,
		pendingDays: 0,
		noScheduleDays: 0
	};
	let lateMinutesDeducted = 0;
	let earlyMinutesDeducted = 0;

	for (const range of ranges) {
		for (const date of eachDay(range.from, range.to)) {
			const ctx = contextOf(date);
			summary.coveredDays += 1;
			if (!ctx) continue;
			const iso = formatDateOnly(date);
			switch (ctx.result) {
				case 'LEAVE': {
					if (!ctx.leave) break;
					const days = calc(String(ctx.leave.dayValue));
					const t = leaveTypes.get(ctx.leave.leaveTypeCode) ?? {
						nameLao: ctx.leave.leaveTypeNameLao,
						isPaid: ctx.leave.isPaid,
						days: zero()
					};
					t.days = t.days.plus(days);
					leaveTypes.set(ctx.leave.leaveTypeCode, t);
					if (ctx.leave.isPaid) {
						paidDayTotal = paidDayTotal.plus(days); // paid leave is a normal payable day
					} else {
						unpaidDayTotal = unpaidDayTotal.plus(days);
						if (rule.unpaidLeaveDeductionEnabled) {
							unpaidAmount = unpaidAmount.plus(range.dayRate.times(days));
							unpaidDates.push(iso);
						}
					}
					break;
				}
				case 'ABSENT':
					summary.absentDays += 1;
					if (rule.absenceDeductionEnabled) {
						absentAmount = absentAmount.plus(range.dayRate);
						absentDates.push(iso);
					}
					break;
				case 'HOLIDAY':
					summary.holidayDays += 1;
					break;
				case 'OFF_DAY':
					summary.offDays += 1;
					break;
				case 'PENDING':
					summary.pendingDays += 1;
					break;
				case 'NO_SCHEDULE':
					summary.noScheduleDays += 1;
					break;
				default: {
					if (!WORKED.has(ctx.result)) break;
					summary.presentDays += 1;
					summary.lateMinutes += ctx.lateMinutes;
					summary.earlyLeaveMinutes += ctx.earlyLeaveMinutes;
					const dailyMinutes =
						rule.minuteDeductionBasis === 'STANDARD_DAILY_MINUTES'
							? rule.standardDailyMinutes
							: ctx.scheduledWorkMinutes;
					if (!dailyMinutes || dailyMinutes <= 0) break;
					const late = rule.lateDeductionEnabled ? Math.min(ctx.lateMinutes, dailyMinutes) : 0;
					// late and early leave together can never cost more than one day
					const early = rule.earlyLeaveDeductionEnabled
						? Math.min(ctx.earlyLeaveMinutes, dailyMinutes - late)
						: 0;
					if (late > 0) {
						lateAmount = lateAmount.plus(range.dayRate.times(late).div(dailyMinutes));
						lateMinutesDeducted += late;
						lateDates.push(iso);
					}
					if (early > 0) {
						earlyAmount = earlyAmount.plus(range.dayRate.times(early).div(dailyMinutes));
						earlyMinutesDeducted += early;
						earlyDates.push(iso);
					}
				}
			}
		}
	}

	const lines: DeductionLine[] = [];
	const push = (
		source: PayrollItemSource,
		code: string,
		nameLao: string,
		nameEnglish: string,
		amount: CalcValue,
		details: Record<string, unknown>
	) => {
		const rounded = roundMoney(amount);
		if (rounded.greaterThan(0))
			lines.push({ source, code, nameLao, nameEnglish, amount: rounded, details });
	};
	push('UNPAID_LEAVE', 'UNPAID_LEAVE', 'ຫັກລາພັກບໍ່ໄດ້ຮັບເງິນເດືອນ', 'Unpaid Leave', unpaidAmount, {
		days: unpaidDayTotal.toString(),
		dates: unpaidDates
	});
	push('ATTENDANCE_DEDUCTION', 'ABSENCE', 'ຫັກຂາດວຽກ', 'Absence', absentAmount, {
		days: absentDates.length,
		dates: absentDates
	});
	push('LATE_DEDUCTION', 'LATE', 'ຫັກມາຊ້າ', 'Late', lateAmount, {
		minutes: lateMinutesDeducted,
		dates: lateDates
	});
	push('EARLY_LEAVE_DEDUCTION', 'EARLY_LEAVE', 'ຫັກອອກກ່ອນເວລາ', 'Early Leave', earlyAmount, {
		minutes: earlyMinutesDeducted,
		dates: earlyDates
	});

	return {
		lines,
		attendance: summary,
		leave: {
			paidDays: paidDayTotal.toString(),
			unpaidDays: unpaidDayTotal.toString(),
			byType: [...leaveTypes].map(([code, v]) => ({
				code,
				nameLao: v.nameLao,
				isPaid: v.isPaid,
				days: v.days.toString()
			}))
		}
	};
}
