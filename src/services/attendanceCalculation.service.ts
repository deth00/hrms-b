import { prisma } from '../config/prisma.js';
import { serverNow } from '../lib/clock.js';
import {
	CALCULATION_VERSION,
	calculateAttendance,
	resolveEffectiveAttendanceTimes,
	type CalculationResult,
	type EffectiveTimes,
	type ScheduleSnapshot
} from '../lib/attendanceCalculation.js';
import { getPolicy, type Db } from './attendancePolicy.service.js';
import { recalculateOvertimeForEmployeeDate } from './overtimeCalculation.service.js';

/**
 * The ONLY place that turns an AttendanceRecord (its schedule SNAPSHOT + raw punches + the latest
 * approved correction overlay) into cached effective/calculated fields. Controllers, reports and
 * the frontend never re-implement these formulas.
 *
 * Recalculation is triggered by: check-in, check-out, and correction approval (each also
 * recalculates approved overtime for that employee/date). It is NOT triggered
 * by Shift/WorkLocation master-data edits (the record uses its own snapshot) nor by policy edits
 * (those apply to future recalculations only).
 */
export function snapshotOf(record: {
	workDate: Date;
	scheduledStartTime: string | null;
	scheduledEndTime: string | null;
	scheduledBreakMinutes: number | null;
	scheduledCrossesMidnight: boolean;
	scheduledLateGraceMinutes: number | null;
	scheduledEarlyLeaveGraceMinutes: number | null;
}): ScheduleSnapshot {
	return {
		workDate: record.workDate,
		startTime: record.scheduledStartTime,
		endTime: record.scheduledEndTime,
		breakMinutes: record.scheduledBreakMinutes,
		crossesMidnight: record.scheduledCrossesMidnight,
		lateGraceMinutes: record.scheduledLateGraceMinutes,
		earlyLeaveGraceMinutes: record.scheduledEarlyLeaveGraceMinutes
	};
}

/** The latest APPROVED correction overlay for a record (applications exist only for approved requests). */
export function latestOverlay(recordId: number, db: Db = prisma) {
	return db.attendanceCorrectionApplication.findFirst({
		where: { attendanceRecordId: recordId },
		orderBy: { appliedAt: 'desc' },
		select: { effectiveCheckInAt: true, effectiveCheckOutAt: true }
	});
}

export async function recalculateAttendanceRecord(recordId: number, db: Db = prisma) {
	const record = await db.attendanceRecord.findUniqueOrThrow({
		where: { id: recordId },
		include: { employee: { select: { companyId: true } } }
	});
	const overlay = await latestOverlay(recordId, db);
	const policy = await getPolicy(record.employee.companyId, db);
	const effective = resolveEffectiveAttendanceTimes(record, overlay);
	const calc = calculateAttendance(snapshotOf(record), effective, policy);

	const updated = await db.attendanceRecord.update({
		where: { id: recordId },
		data: {
			effectiveCheckInAt: effective.checkInAt,
			effectiveCheckOutAt: effective.checkOutAt,
			isCorrected: effective.source === 'CORRECTION',
			...calc,
			calculatedAt: serverNow(),
			calculationVersion: CALCULATION_VERSION
		}
	});
	// Approved OT for this employee/date is derived from the SAME effective times, so it is
	// recalculated on every attendance recalculation (check-in, check-out, correction approval).
	await recalculateOvertimeForEmployeeDate(record.employeeId, record.workDate, db);
	return updated;
}

/** What the numbers WOULD be for a snapshot + effective times — used for correction previews. */
export function previewCalculation(
	schedule: ScheduleSnapshot,
	effective: Pick<EffectiveTimes, 'checkInAt' | 'checkOutAt'>,
	policy: { deductScheduledBreak: boolean }
): CalculationResult & { effectiveCheckInAt: Date | null; effectiveCheckOutAt: Date | null } {
	return {
		...calculateAttendance(schedule, effective, policy),
		effectiveCheckInAt: effective.checkInAt,
		effectiveCheckOutAt: effective.checkOutAt
	};
}
