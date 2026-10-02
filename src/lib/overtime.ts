import { addDays } from './dates.js';
import { laosInstant } from './attendanceTime.js';

/**
 * PURE overtime rules (no I/O). Phase 8 answers "was OT approved / how much was requested / how
 * many approved minutes were actually worked" — never money: no rates, multipliers or rounding.
 * All comparisons use real instants (never "HH:mm" strings) so overnight shifts work.
 */
export const OVERTIME_CALCULATION_VERSION = 1;

export type OvertimeType = 'BEFORE_SHIFT' | 'AFTER_SHIFT' | 'OFF_DAY' | 'HOLIDAY';
export type OvertimeCalculationStatus =
	'PENDING_ATTENDANCE' | 'INCOMPLETE_ATTENDANCE' | 'CALCULATED';

export const MINUTE_MS = 60_000;
export const MAX_REQUEST_MS = 24 * 60 * MINUTE_MS;

export interface Interval {
	start: Date;
	end: Date;
}

export const minutesBetween = (start: Date, end: Date) =>
	Math.floor((end.getTime() - start.getTime()) / MINUTE_MS);

/** Whole minutes two intervals share (0 when they do not overlap). */
export function overlapMinutes(a: Interval, b: Interval): number {
	const start = Math.max(a.start.getTime(), b.start.getTime());
	const end = Math.min(a.end.getTime(), b.end.getTime());
	return end > start ? Math.floor((end - start) / MINUTE_MS) : 0;
}

export const intervalsOverlap = (a: Interval, b: Interval) =>
	a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();

export type DerivedType =
	{ ok: true; type: OvertimeType } | { ok: false; code: string; message: string };

/**
 * Which kind of OT is this window? Decided from the schedule, never from the client:
 *   holiday (wins over off-day) → HOLIDAY; not a working day → OFF_DAY;
 *   working day: ends at/before the regular start → BEFORE_SHIFT, starts at/after the regular end
 *   → AFTER_SHIFT, anything touching regular hours → OT_OVERLAPS_REGULAR_HOURS.
 * The window must also sit on the work date: an off-day / holiday / before-shift OT must START on
 * the work date; an after-shift OT may start up to the end of the following calendar day (an
 * overnight shift's morning tail, or work past midnight).
 */
export function deriveOvertimeType(input: {
	workDate: Date;
	isWorkingDay: boolean;
	isHoliday: boolean;
	regular: Interval | null;
	window: Interval;
}): DerivedType {
	const { workDate, isWorkingDay, isHoliday, regular, window } = input;
	const dayStart = laosInstant(workDate, '00:00');
	const nextDayStart = laosInstant(addDays(workDate, 1), '00:00');
	const dayAfterNext = laosInstant(addDays(workDate, 2), '00:00');
	const outOfRange = {
		ok: false as const,
		code: 'OT_TIME_OUT_OF_RANGE',
		message: 'ເວລາ OT ຕ້ອງເລີ່ມໃນວັນທີ່ເຮັດວຽກທີ່ເລືອກ'
	};
	const startsOnWorkDate =
		window.start.getTime() >= dayStart.getTime() && window.start.getTime() < nextDayStart.getTime();

	if (isHoliday) return startsOnWorkDate ? { ok: true, type: 'HOLIDAY' } : outOfRange;
	if (!isWorkingDay || !regular)
		return startsOnWorkDate ? { ok: true, type: 'OFF_DAY' } : outOfRange;

	if (intervalsOverlap(window, regular)) {
		return {
			ok: false,
			code: 'OT_OVERLAPS_REGULAR_HOURS',
			message: 'ເວລາ OT ທັບຊ້ອນກັບເວລາເຮັດວຽກປົກກະຕິ'
		};
	}
	if (window.end.getTime() <= regular.start.getTime()) {
		return startsOnWorkDate ? { ok: true, type: 'BEFORE_SHIFT' } : outOfRange;
	}
	// starts at/after the regular end
	return window.start.getTime() < dayAfterNext.getTime()
		? { ok: true, type: 'AFTER_SHIFT' }
		: outOfRange;
}

export interface OvertimeCalculation {
	calculationStatus: OvertimeCalculationStatus;
	actualMinutes: number | null;
	eligibleMinutes: number | null;
}

/**
 * Actual OT = the overlap of the EFFECTIVE attendance interval with the APPROVED window — never
 * more than the approved window (checking out late does not create extra OT) and never any time
 * outside it (regular hours before an after-shift window are not OT). Exact minutes; no rounding.
 *
 * Deterministic status rules (derivable on read — no cron):
 *   no attendance at all        → PENDING_ATTENDANCE until the window has ended, then CALCULATED 0/0
 *   attendance but in/out gap   → INCOMPLETE_ATTENDANCE (no fabricated minutes)
 *   both effective times exist  → CALCULATED with the overlap
 */
export function calculateOvertime(input: {
	window: Interval;
	effective: { checkInAt: Date | null; checkOutAt: Date | null } | null;
	now: Date;
}): OvertimeCalculation {
	const { window, effective, now } = input;
	const hasIn = !!effective?.checkInAt;
	const hasOut = !!effective?.checkOutAt;

	if (!hasIn && !hasOut) {
		return now.getTime() >= window.end.getTime()
			? { calculationStatus: 'CALCULATED', actualMinutes: 0, eligibleMinutes: 0 }
			: { calculationStatus: 'PENDING_ATTENDANCE', actualMinutes: null, eligibleMinutes: null };
	}
	if (!hasIn || !hasOut) {
		return {
			calculationStatus: 'INCOMPLETE_ATTENDANCE',
			actualMinutes: null,
			eligibleMinutes: null
		};
	}
	const minutes = overlapMinutes(
		{ start: effective!.checkInAt as Date, end: effective!.checkOutAt as Date },
		window
	);
	return { calculationStatus: 'CALCULATED', actualMinutes: minutes, eligibleMinutes: minutes };
}
