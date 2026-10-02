import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { addDays, formatDateOnly, todayInLaos } from '../lib/dates.js';
import { resolveDailyAttendance } from './attendanceDaily.service.js';
import {
	addDay,
	attendanceRate,
	dayFigures,
	emptyAttendance
} from './reporting/attendanceReporting.service.js';
import type { SelfCalendarQuery } from '../validation/attendance.schema.js';

/**
 * Employee portal — the signed-in employee's OWN month, day by day (read only, `attendance.self`).
 *
 * Nothing is re-classified here: every day comes from the canonical `resolveDailyAttendance` (the same
 * resolver the Attendance module, the reports and payroll use), and the month totals use the reporting
 * `addDay` rule, so "present / late / absent / leave" mean exactly what they mean everywhere else.
 * Future days of the month are resolved too — they carry the scheduled shift (the work schedule view)
 * and resolve to PENDING / OFF_DAY / HOLIDAY / LEAVE, never ABSENT. Days outside the employment dates
 * are returned as `employed: false` without a result. The employee is always taken from the session.
 */
export async function getMyCalendar(userId: number, query: SelfCalendarQuery) {
	const employee = await prisma.employee.findUnique({
		where: { userId },
		select: { id: true, startDate: true, endDate: true }
	});
	if (!employee) {
		throw Errors.forbiddenWith('NO_LINKED_EMPLOYEE', 'ບັນຊີນີ້ຍັງບໍ່ໄດ້ເຊື່ອມກັບພະນັກງານ');
	}

	const now = serverNow();
	const today = todayInLaos(now);
	const month = query.month ?? formatDateOnly(today).slice(0, 7);
	const first = new Date(`${month}-01T00:00:00.000Z`);
	const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));

	const totals = emptyAttendance();
	let overtimeEligibleMinutes = 0;
	const days = [];
	for (let date = first; date.getTime() < next.getTime(); date = addDays(date, 1)) {
		const employed =
			employee.startDate.getTime() <= date.getTime() &&
			(!employee.endDate || employee.endDate.getTime() >= date.getTime());
		if (!employed) {
			days.push({ date: formatDateOnly(date), employed: false as const });
			continue;
		}
		const [row] = await resolveDailyAttendance([{ id: employee.id }], date, now);
		if (!row) continue;
		addDay(totals, row);
		overtimeEligibleMinutes += row.overtimeEligibleMinutesTotal;
		const figures = dayFigures(row);
		days.push({
			date: formatDateOnly(date),
			employed: true as const,
			result: row.result,
			shift: row.schedule,
			holiday: row.holiday,
			leave: row.leave
				? { leaveTypeNameLao: row.leave.leaveTypeNameLao, dayValue: row.leave.dayValue }
				: null,
			checkInAt: row.attendance?.effectiveCheckInAt ?? null,
			checkOutAt: row.attendance?.effectiveCheckOutAt ?? null,
			isCorrected: row.attendance?.isCorrected ?? false,
			workedMinutes: figures.workedMinutes,
			lateMinutes: figures.lateMinutes,
			earlyLeaveMinutes: figures.earlyLeaveMinutes,
			overtimeEligibleMinutes: row.overtimeEligibleMinutesTotal
		});
	}

	return {
		month,
		today: formatDateOnly(today),
		totals: {
			scheduled: totals.scheduled,
			present: totals.present,
			late: totals.late,
			lateMinutes: totals.lateMinutes,
			earlyLeave: totals.earlyLeave,
			absent: totals.absent,
			onLeave: totals.onLeave,
			pending: totals.pending,
			incomplete: totals.incomplete,
			offDay: totals.offDay,
			holiday: totals.holiday,
			noSchedule: totals.noSchedule,
			workedMinutes: totals.workedMinutes,
			overtimeEligibleMinutes,
			attendanceRate: attendanceRate(totals)
		},
		days
	};
}
