import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { serverNow } from '../lib/clock.js';
import {
	OVERTIME_CALCULATION_VERSION,
	calculateOvertime,
	type OvertimeCalculationStatus
} from '../lib/overtime.js';

type Db = typeof prisma | Prisma.TransactionClient;

/**
 * The ONE place actual OT minutes are computed and cached. Formulas live in lib/overtime.ts.
 *
 * Inputs: an APPROVED request (its window) + the attendance record's EFFECTIVE times (raw punches,
 * overlaid by any approved correction — which `recalculateAttendanceRecord` has already resolved).
 * Nothing here touches AttendancePunch or the raw check-in/out columns.
 *
 * Triggers: every `recalculateAttendanceRecord` (check-in, check-out, correction approval) and OT
 * approval. That is what makes "an approved correction changes the checkout → OT updates" automatic.
 */
export async function recalculateOvertimeForEmployeeDate(
	employeeId: number,
	workDate: Date,
	db: Db = prisma
) {
	const requests = await db.overtimeRequest.findMany({
		where: { employeeId, workDate, status: 'APPROVED' }
	});
	if (requests.length === 0) return [];

	const record = await db.attendanceRecord.findUnique({
		where: { employeeId_workDate: { employeeId, workDate } },
		select: {
			firstCheckInAt: true,
			lastCheckOutAt: true,
			effectiveCheckInAt: true,
			effectiveCheckOutAt: true
		}
	});
	const effective = record
		? {
				checkInAt: record.effectiveCheckInAt ?? record.firstCheckInAt,
				checkOutAt: record.effectiveCheckOutAt ?? record.lastCheckOutAt
			}
		: null;
	const now = serverNow();

	const updated = [];
	for (const r of requests) {
		const calc = calculateOvertime({
			window: { start: r.requestedStartAt, end: r.requestedEndAt },
			effective,
			now
		});
		updated.push(
			await db.overtimeRequest.update({
				where: { id: r.id },
				data: { ...calc, calculatedAt: now, calculationVersion: OVERTIME_CALCULATION_VERSION }
			})
		);
	}
	return updated;
}

/**
 * What to show for a request's numbers. Stored values are used, except that an APPROVED request
 * still "waiting for attendance" whose window has now ended resolves to 0 / 0 on read (no cron).
 */
export function presentOvertimeFigures(
	row: {
		status: string;
		requestedStartAt: Date;
		requestedEndAt: Date;
		actualMinutes: number | null;
		eligibleMinutes: number | null;
		calculationStatus: OvertimeCalculationStatus;
	},
	now: Date
): {
	calculationStatus: OvertimeCalculationStatus | null;
	actualMinutes: number | null;
	eligibleMinutes: number | null;
} {
	if (row.status !== 'APPROVED') {
		return { calculationStatus: null, actualMinutes: null, eligibleMinutes: null };
	}
	if (row.calculationStatus === 'PENDING_ATTENDANCE') {
		return calculateOvertime({
			window: { start: row.requestedStartAt, end: row.requestedEndAt },
			effective: null,
			now
		});
	}
	return {
		calculationStatus: row.calculationStatus,
		actualMinutes: row.actualMinutes,
		eligibleMinutes: row.eligibleMinutes
	};
}
