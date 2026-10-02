import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { serverNow } from '../lib/clock.js';
import { todayInLaos } from '../lib/dates.js';
import { scheduledEndInstant } from '../lib/attendanceTime.js';
import { scopeToWhere, type EmployeeScope } from '../lib/employeeScope.js';
import { resolveScheduleContext } from './schedule.service.js';
import { findApprovedLeaveDays, type ApprovedLeaveInfo } from './leaveDay.service.js';
import { findApprovedOvertimeByEmployees, type OvertimeSummary } from './overtimeLookup.service.js';
import { RECORD_INCLUDE, presentMany } from './attendance.service.js';
import type { DailyQuery, DailyResult } from '../validation/attendanceRules.schema.js';

/**
 * Daily attendance RESULT for scheduled employees — including those with NO AttendanceRecord.
 *
 * Decision: the daily result is a service DTO, not a database enum. ABSENT/OFF_DAY/HOLIDAY/PENDING
 * describe the absence of a record and are derived from the schedule resolver on demand; no fake
 * punches or records are ever created for them.
 *
 * Employment dates are respected: an employee is only listed for a date inside
 * [startDate, endDate], so nobody is ABSENT before they started or after they left.
 *
 * PRECEDENCE (Phase 7 — approved leave). For one employee + date:
 *   1. OFF_DAY / HOLIDAY  — a leave request can never charge these (they are excluded when the
 *                            request is built), and they win if the schedule later changes;
 *   2. LEAVE              — an APPROVED full-day LeaveRequestDay (PENDING / REJECTED / CANCELLED
 *                            leave is ignored). It overrides an attendance record's result and
 *                            ABSENT / PENDING, but the record is NOT hidden or altered: when raw
 *                            attendance exists the row carries `attendanceConflict = true`;
 *   3. the AttendanceRecord's own result (PRESENT, LATE, ...);
 *   4. ABSENT / PENDING   — derived from the schedule when nothing else applies.
 * Phase 8 (overtime): a record created for approved off-day / holiday OT keeps the result OFF_DAY /
 * HOLIDAY (worked OT never turns the day into PRESENT) and every row carries `overtimeRequests`
 * (approved OT: planned / actual / eligible minutes) plus `overtimeEligibleMinutesTotal`.
 * LEAVE is a daily HR context, not a punch-derived state, so it is never stored on the record.
 */

const EMPLOYEE_SELECT = {
	id: true,
	employeeCode: true,
	firstNameLao: true,
	lastNameLao: true,
	firstNameEnglish: true,
	lastNameEnglish: true,
	employmentStatus: true,
	companyId: true,
	department: { select: { id: true, code: true, nameLao: true } },
	position: { select: { id: true, code: true, nameLao: true } }
} satisfies Prisma.EmployeeSelect;

const CHUNK = 25;
const RESULT_FILTER_CAP = 1000;

export async function resolveDailyAttendance<E extends { id: number }>(
	employees: E[],
	date: Date,
	now: Date
) {
	if (employees.length === 0) return [];
	const leaveByEmployee = await findApprovedLeaveDays(
		employees.map((e) => e.id),
		date
	);
	const overtimeByEmployee = await findApprovedOvertimeByEmployees(
		employees.map((e) => e.id),
		date,
		now
	);
	const records = await prisma.attendanceRecord.findMany({
		where: { employeeId: { in: employees.map((e) => e.id) }, workDate: date },
		include: RECORD_INCLUDE
	});
	const presented = await presentMany(records, now);
	const byEmployee = new Map(presented.map((p) => [p.employeeId, p]));

	const rows: {
		employee: E;
		workDate: Date;
		result: DailyResult;
		schedule: {
			shiftCode: string | null;
			shiftName: string | null;
			startTime: string | null;
			endTime: string | null;
			crossesMidnight: boolean;
		} | null;
		holiday: { id: number; nameLao: string } | null;
		attendance: (typeof presented)[number] | null;
		leave: ApprovedLeaveInfo | null;
		attendanceConflict: boolean;
		overtimeRequests: OvertimeSummary[];
		overtimeEligibleMinutesTotal: number;
	}[] = [];

	for (let i = 0; i < employees.length; i += CHUNK) {
		const chunk = employees.slice(i, i + CHUNK);
		const computed = await Promise.all(
			chunk.map(async (employee) => {
				const attendance = byEmployee.get(employee.id) ?? null;
				const leave = leaveByEmployee.get(employee.id) ?? null;
				const overtimeRequests = overtimeByEmployee.get(employee.id) ?? [];
				const overtimeEligibleMinutesTotal = overtimeRequests.reduce(
					(sum, o) => sum + (o.eligibleMinutes ?? 0),
					0
				);
				if (attendance) {
					return {
						employee,
						workDate: date,
						result: (leave
							? 'LEAVE'
							: attendance.isHoliday
								? 'HOLIDAY'
								: !attendance.isWorkingDay
									? 'OFF_DAY'
									: attendance.result) as DailyResult,
						overtimeRequests,
						overtimeEligibleMinutesTotal,
						leave,
						attendanceConflict: leave !== null,
						schedule: {
							shiftCode: attendance.scheduled.shift?.code ?? null,
							shiftName: attendance.scheduled.shift?.nameLao ?? null,
							startTime: attendance.scheduled.startTime,
							endTime: attendance.scheduled.endTime,
							crossesMidnight: attendance.scheduled.crossesMidnight
						},
						holiday: null,
						attendance
					};
				}

				const ctx = await resolveScheduleContext(employee.id, date);
				const schedule = ctx.shift
					? {
							shiftCode: ctx.shift.code,
							shiftName: ctx.shift.nameLao,
							startTime: ctx.expected?.startTime ?? ctx.shift.startTime,
							endTime: ctx.expected?.endTime ?? ctx.shift.endTime,
							crossesMidnight: ctx.shift.crossesMidnight
						}
					: null;

				let result: DailyResult;
				if (!ctx.hasSchedule || !ctx.shift || ctx.companyMismatch) result = 'NO_SCHEDULE';
				else if (!ctx.isWorkingDay) result = 'OFF_DAY';
				else if (ctx.isHoliday) result = 'HOLIDAY';
				else if (ctx.expected) {
					const end = scheduledEndInstant(date, ctx.expected.endTime, ctx.expected.crossesMidnight);
					// only "clearly ended" scheduled days can be ABSENT; today's open shift stays PENDING
					result = now.getTime() > end.getTime() ? 'ABSENT' : 'PENDING';
				} else result = 'OFF_DAY';
				// approved leave only replaces what would otherwise be ABSENT / PENDING
				if (leave && (result === 'ABSENT' || result === 'PENDING')) result = 'LEAVE';

				return {
					employee,
					workDate: date,
					result,
					schedule,
					holiday: ctx.holiday,
					attendance: null,
					leave: result === 'LEAVE' ? leave : null,
					attendanceConflict: false,
					overtimeRequests,
					overtimeEligibleMinutesTotal
				};
			})
		);
		rows.push(...computed);
	}
	return rows;
}

export async function listDailyAttendance(query: DailyQuery, scope: EmployeeScope) {
	const now = serverNow();
	const date = query.date ?? todayInLaos(now);
	const search = query.search;

	const where: Prisma.EmployeeWhereInput = {
		AND: [
			scopeToWhere(scope),
			// employed on the requested date
			{ startDate: { lte: date } },
			{ OR: [{ endDate: null }, { endDate: { gte: date } }] },
			query.employeeId ? { id: query.employeeId } : {},
			query.companyId ? { companyId: query.companyId } : {},
			query.branchId ? { branchId: query.branchId } : {},
			query.departmentId ? { departmentId: query.departmentId } : {},
			search
				? {
						OR: [
							{ employeeCode: { contains: search } },
							{ firstNameLao: { contains: search } },
							{ lastNameLao: { contains: search } },
							{ firstNameEnglish: { contains: search } },
							{ lastNameEnglish: { contains: search } }
						]
					}
				: {}
		]
	};

	if (!query.result) {
		const [employees, total] = await Promise.all([
			prisma.employee.findMany({
				where,
				select: EMPLOYEE_SELECT,
				orderBy: { employeeCode: 'asc' },
				skip: (query.page - 1) * query.pageSize,
				take: query.pageSize
			}),
			prisma.employee.count({ where })
		]);
		return {
			date,
			items: await resolveDailyAttendance(employees, date, now),
			page: query.page,
			pageSize: query.pageSize,
			total,
			totalPages: Math.max(1, Math.ceil(total / query.pageSize))
		};
	}

	// A result filter needs every employee's derived result first, then pagination.
	const all = await prisma.employee.findMany({
		where,
		select: EMPLOYEE_SELECT,
		orderBy: { employeeCode: 'asc' },
		take: RESULT_FILTER_CAP
	});
	const matching = (await resolveDailyAttendance(all, date, now)).filter(
		(r) => r.result === query.result
	);
	const start = (query.page - 1) * query.pageSize;
	return {
		date,
		items: matching.slice(start, start + query.pageSize),
		page: query.page,
		pageSize: query.pageSize,
		total: matching.length,
		totalPages: Math.max(1, Math.ceil(matching.length / query.pageSize))
	};
}
