import type { OvertimeRequest, OvertimeRequestStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { addDays, laosDateOf } from '../lib/dates.js';
import { getOvertimePolicy } from './overtimePolicy.service.js';
import { presentOvertimeFigures } from './overtimeCalculation.service.js';

/**
 * Small, dependency-light OT lookups for ATTENDANCE (check-in planner, daily result, detail) so
 * attendance never has to import the whole request workflow.
 */
type Db = typeof prisma | Prisma.TransactionClient;

export interface OvertimeSummary {
	requestId: number;
	type: OvertimeRequest['type'];
	status: OvertimeRequestStatus;
	workDate: Date;
	requestedStartAt: Date;
	requestedEndAt: Date;
	plannedMinutes: number;
	actualMinutes: number | null;
	eligibleMinutes: number | null;
	calculationStatus: string | null;
}

export function summarizeOvertime(row: OvertimeRequest, now: Date): OvertimeSummary {
	const figures = presentOvertimeFigures(row, now);
	return {
		requestId: row.id,
		type: row.type,
		status: row.status,
		workDate: row.workDate,
		requestedStartAt: row.requestedStartAt,
		requestedEndAt: row.requestedEndAt,
		plannedMinutes: row.plannedMinutes,
		actualMinutes: figures.actualMinutes,
		eligibleMinutes: figures.eligibleMinutes,
		calculationStatus: figures.calculationStatus
	};
}

/** APPROVED OT requests for many employees on one work date (daily attendance). */
export async function findApprovedOvertimeByEmployees(
	employeeIds: number[],
	workDate: Date,
	now: Date
): Promise<Map<number, OvertimeSummary[]>> {
	const map = new Map<number, OvertimeSummary[]>();
	if (employeeIds.length === 0) return map;
	const rows = await prisma.overtimeRequest.findMany({
		where: { employeeId: { in: employeeIds }, workDate, status: 'APPROVED' },
		orderBy: { requestedStartAt: 'asc' }
	});
	for (const r of rows) {
		const list = map.get(r.employeeId) ?? [];
		list.push(summarizeOvertime(r, now));
		map.set(r.employeeId, list);
	}
	return map;
}

export function findApprovedOvertimeForDate(employeeId: number, workDate: Date, db: Db = prisma) {
	return db.overtimeRequest.findMany({
		where: { employeeId, workDate, status: 'APPROVED' },
		orderBy: { requestedStartAt: 'asc' }
	});
}

/**
 * Approved OT the employee may check in for RIGHT NOW: work date today or yesterday (an OT past
 * midnight keeps its work date) and `now` inside [start - checkInEarlyMinutes, end).
 */
export async function findCheckInOvertime(employee: { id: number; companyId: number }, now: Date) {
	const today = laosDateOf(now);
	const policy = await getOvertimePolicy(employee.companyId);
	const rows = await prisma.overtimeRequest.findMany({
		where: {
			employeeId: employee.id,
			status: 'APPROVED',
			workDate: { in: [addDays(today, -1), today] }
		},
		orderBy: { requestedStartAt: 'asc' }
	});
	const early = policy.checkInEarlyMinutes * 60_000;
	return {
		policy,
		windows: rows.filter(
			(r) =>
				now.getTime() >= r.requestedStartAt.getTime() - early &&
				now.getTime() < r.requestedEndAt.getTime()
		)
	};
}

/** Own PENDING / APPROVED requests for the given work dates (dashboard + attendance card). */
export async function listActiveOvertimeForDates(employeeId: number, dates: Date[], now: Date) {
	const rows = await prisma.overtimeRequest.findMany({
		where: { employeeId, workDate: { in: dates }, status: { in: ['PENDING', 'APPROVED'] } },
		orderBy: { requestedStartAt: 'asc' }
	});
	return rows.map((r) => summarizeOvertime(r, now));
}

/** Dates (of `dates`) on which the employee has an active (PENDING / APPROVED) OT request. */
export async function findActiveOvertimeDates(
	employeeId: number,
	dates: Date[],
	db: Db = prisma
): Promise<Date[]> {
	if (dates.length === 0) return [];
	const rows = await db.overtimeRequest.findMany({
		where: { employeeId, workDate: { in: dates }, status: { in: ['PENDING', 'APPROVED'] } },
		select: { workDate: true },
		orderBy: { workDate: 'asc' }
	});
	return [...new Set(rows.map((r) => r.workDate.getTime()))].map((t) => new Date(t));
}
