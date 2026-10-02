import { shiftDurationMinutes } from './dates.js';
import { scheduledEndInstant, scheduledStartInstant } from './attendanceTime.js';

/**
 * PURE attendance formulas (no I/O) — the single place the numbers are defined. Everything works
 * on the record's schedule SNAPSHOT plus the EFFECTIVE punch times; raw punches are never inputs
 * that get modified. Bump CALCULATION_VERSION when a formula changes.
 */
export const CALCULATION_VERSION = 1;

export type CalculationStatus =
	'PRESENT' | 'LATE' | 'EARLY_LEAVE' | 'LATE_AND_EARLY' | 'INCOMPLETE';

export interface ScheduleSnapshot {
	workDate: Date;
	startTime: string | null;
	endTime: string | null;
	breakMinutes: number | null;
	crossesMidnight: boolean;
	lateGraceMinutes: number | null;
	earlyLeaveGraceMinutes: number | null;
}

export interface EffectiveTimes {
	checkInAt: Date | null;
	checkOutAt: Date | null;
	source: 'PUNCH' | 'CORRECTION';
}

export interface CalculationResult {
	scheduledWorkMinutes: number | null;
	workedMinutes: number | null;
	arrivalDelayMinutes: number | null;
	lateMinutes: number | null;
	earlyLeaveMinutes: number | null;
	calculationStatus: CalculationStatus;
}

/**
 * Raw vs effective: with an APPROVED correction overlay the overlay's values win (falling back to
 * the raw value for a side the correction did not touch); otherwise effective = raw.
 */
export function resolveEffectiveAttendanceTimes(
	raw: { firstCheckInAt: Date | null; lastCheckOutAt: Date | null },
	overlay: { effectiveCheckInAt: Date | null; effectiveCheckOutAt: Date | null } | null
): EffectiveTimes {
	if (!overlay) {
		return { checkInAt: raw.firstCheckInAt, checkOutAt: raw.lastCheckOutAt, source: 'PUNCH' };
	}
	return {
		checkInAt: overlay.effectiveCheckInAt ?? raw.firstCheckInAt,
		checkOutAt: overlay.effectiveCheckOutAt ?? raw.lastCheckOutAt,
		source: 'CORRECTION'
	};
}

const wholeMinutes = (ms: number) => Math.floor(ms / 60_000);

export function calculateAttendance(
	schedule: ScheduleSnapshot,
	effective: Pick<EffectiveTimes, 'checkInAt' | 'checkOutAt'>,
	policy: { deductScheduledBreak: boolean }
): CalculationResult {
	const breakMinutes = schedule.breakMinutes ?? 0;
	const hasTimes = schedule.startTime !== null && schedule.endTime !== null;

	// scheduled work = shift duration (overnight-aware) minus the scheduled break
	const scheduledWorkMinutes = hasTimes
		? Math.max(
				0,
				shiftDurationMinutes(schedule.startTime as string, schedule.endTime as string) -
					breakMinutes
			)
		: null;

	let arrivalDelayMinutes: number | null = null;
	let lateMinutes: number | null = null;
	if (hasTimes && effective.checkInAt) {
		const start = scheduledStartInstant(schedule.workDate, schedule.startTime as string);
		arrivalDelayMinutes = Math.max(
			0,
			wholeMinutes(effective.checkInAt.getTime() - start.getTime())
		);
		lateMinutes = Math.max(0, arrivalDelayMinutes - (schedule.lateGraceMinutes ?? 0));
	}

	let earlyLeaveMinutes: number | null = null;
	if (hasTimes && effective.checkOutAt) {
		const end = scheduledEndInstant(
			schedule.workDate,
			schedule.endTime as string,
			schedule.crossesMidnight
		);
		const early = Math.max(0, wholeMinutes(end.getTime() - effective.checkOutAt.getTime()));
		earlyLeaveMinutes = Math.max(0, early - (schedule.earlyLeaveGraceMinutes ?? 0));
	}

	let workedMinutes: number | null = null;
	if (effective.checkInAt && effective.checkOutAt) {
		const elapsed = Math.max(
			0,
			wholeMinutes(effective.checkOutAt.getTime() - effective.checkInAt.getTime())
		);
		// NOT capped at the scheduled minutes, and NOT converted into overtime (a later phase).
		workedMinutes = policy.deductScheduledBreak ? Math.max(0, elapsed - breakMinutes) : elapsed;
	}

	let calculationStatus: CalculationStatus;
	if (!effective.checkInAt || !effective.checkOutAt) calculationStatus = 'INCOMPLETE';
	else if ((lateMinutes ?? 0) > 0 && (earlyLeaveMinutes ?? 0) > 0)
		calculationStatus = 'LATE_AND_EARLY';
	else if ((lateMinutes ?? 0) > 0) calculationStatus = 'LATE';
	else if ((earlyLeaveMinutes ?? 0) > 0) calculationStatus = 'EARLY_LEAVE';
	else calculationStatus = 'PRESENT';

	return {
		scheduledWorkMinutes,
		workedMinutes,
		arrivalDelayMinutes,
		lateMinutes,
		earlyLeaveMinutes,
		calculationStatus
	};
}
