import { prisma } from '../config/prisma.js';

/**
 * Approved-leave lookup for ATTENDANCE. Kept tiny and dependency-free so attendance, corrections
 * and the daily-result service can all import it without cycles.
 *
 * Only APPROVED, full-day LeaveRequestDay rows count: PENDING / REJECTED / CANCELLED leave never
 * changes what attendance shows. (Daily-result precedence is documented in
 * attendanceDaily.service.ts: OFF_DAY > HOLIDAY > LEAVE > attendance record > ABSENT/PENDING.)
 */
export interface ApprovedLeaveInfo {
	requestId: number;
	leaveTypeId: number;
	leaveTypeCode: string;
	leaveTypeNameLao: string;
	isPaid: boolean;
	dayValue: number;
}

const SELECT = {
	employeeId: true,
	dayValue: true,
	leaveRequest: {
		select: {
			id: true,
			leaveType: { select: { id: true, code: true, nameLao: true, isPaid: true } }
		}
	}
} as const;

type LeaveDayRow = {
	employeeId: number;
	dayValue: { toNumber(): number };
	leaveRequest: {
		id: number;
		leaveType: { id: number; code: string; nameLao: string; isPaid: boolean };
	};
};

const toInfo = (row: LeaveDayRow): ApprovedLeaveInfo => ({
	requestId: row.leaveRequest.id,
	leaveTypeId: row.leaveRequest.leaveType.id,
	leaveTypeCode: row.leaveRequest.leaveType.code,
	leaveTypeNameLao: row.leaveRequest.leaveType.nameLao,
	isPaid: row.leaveRequest.leaveType.isPaid,
	dayValue: row.dayValue.toNumber()
});

export async function findApprovedLeaveDay(
	employeeId: number,
	date: Date
): Promise<ApprovedLeaveInfo | null> {
	const row = await prisma.leaveRequestDay.findFirst({
		where: { employeeId, leaveDate: date, leaveRequest: { status: 'APPROVED' } },
		select: SELECT
	});
	return row ? toInfo(row) : null;
}

export async function findApprovedLeaveDays(
	employeeIds: number[],
	date: Date
): Promise<Map<number, ApprovedLeaveInfo>> {
	if (employeeIds.length === 0) return new Map();
	const rows = await prisma.leaveRequestDay.findMany({
		where: {
			employeeId: { in: employeeIds },
			leaveDate: date,
			leaveRequest: { status: 'APPROVED' }
		},
		select: SELECT
	});
	return new Map(rows.map((r) => [r.employeeId, toInfo(r)]));
}
