import { prisma } from '../../config/prisma.js';
import { serverNow } from '../../lib/clock.js';
import { addDays } from '../../lib/dates.js';
import type { AuthContext } from '../../types/express.js';
import type { DailyResult } from '../../validation/attendanceRules.schema.js';
import type { AttendanceReportQuery } from '../../validation/reporting.schema.js';
import { resolveDailyAttendance } from '../attendanceDaily.service.js';
import { resolveReportingContext, type ReportingContext } from './reportingScope.service.js';
import {
	REPORT_TIMEZONE,
	ReportErrors,
	UNASSIGNED_LABEL,
	eachDate,
	isoDate,
	parseGroupBy,
	personLabel,
	rate,
	resolveRange,
	type ReportGroup,
	groupKey,
	idsFromKeys
} from './reportingCommon.js';

/**
 * Phase 17A — ATTENDANCE analytics. NOTHING is re-classified here: every employee-day comes from
 * `resolveDailyAttendance` (attendanceDaily.service) — the same canonical daily result the Attendance
 * module and the payroll engine use (schedule resolver, holidays, approved leave, the record's cached
 * calculation, derived ABSENT / PENDING). Raw punches are never read by reporting.
 *
 * An employee is counted for a date only inside their employment dates [startDate, endDate] (the same
 * rule as the daily list), so nobody is ABSENT before they were hired or after they left.
 *
 * DEFINITIONS (per employee-day, from the canonical DailyResult):
 *   present     = PRESENT | LATE | EARLY_LEAVE | LATE_AND_EARLY | IN_PROGRESS | INCOMPLETE  (checked in)
 *   late        = LATE | LATE_AND_EARLY         (lateMinutes = the record's cached lateMinutes)
 *   earlyLeave  = EARLY_LEAVE | LATE_AND_EARLY  (earlyLeaveMinutes likewise)
 *   onLeave     = LEAVE                         (APPROVED full-day leave; wins over ABSENT / PENDING)
 *   absent      = ABSENT                        (a scheduled working day that has clearly ended)
 *   pending     = PENDING                       (scheduled today, shift not over, not checked in yet)
 *   scheduled   = present + onLeave + absent + pending
 *   not scheduled (never absent): OFF_DAY, HOLIDAY, NO_SCHEDULE — reported separately
 *   workedMinutes = the cached workedMinutes of present days
 *
 * ATTENDANCE RATE = present / (scheduled − onLeave), i.e. of the employees EXPECTED AT WORK, how many
 * checked in. Never divided by total headcount; `percent` is null when the denominator is 0.
 *
 * Grouping uses the employee's CURRENT branch / department (like the Attendance daily list).
 */
export const PRESENT_RESULTS: readonly DailyResult[] = [
	'PRESENT',
	'LATE',
	'EARLY_LEAVE',
	'LATE_AND_EARLY',
	'IN_PROGRESS',
	'INCOMPLETE'
];
const LATE_RESULTS: readonly DailyResult[] = ['LATE', 'LATE_AND_EARLY'];
const EARLY_RESULTS: readonly DailyResult[] = ['EARLY_LEAVE', 'LATE_AND_EARLY'];

/** Interactive range limit (canonical per-day resolution — see the implementation report §Performance). */
export const ATTENDANCE_MAX_DAYS = 93;
/**
 * Hard cap on employee-days resolved by one REPORT request. Measured on hr_db (Phase 17A MCP): the
 * canonical resolver costs ≈1.6 ms per employee-day when most days have no record (93 days × 660
 * employee-days ≈ 1.06 s), so 5,000 employee-days ≈ 8 s worst case — the interactive ceiling.
 */
export const ATTENDANCE_MAX_EMPLOYEE_DAYS = 5_000;

export interface AttendanceMetrics {
	scheduled: number;
	present: number;
	late: number;
	lateMinutes: number;
	earlyLeave: number;
	earlyLeaveMinutes: number;
	absent: number;
	onLeave: number;
	pending: number;
	incomplete: number;
	offDay: number;
	holiday: number;
	noSchedule: number;
	workedMinutes: number;
}

export const emptyAttendance = (): AttendanceMetrics => ({
	scheduled: 0,
	present: 0,
	late: 0,
	lateMinutes: 0,
	earlyLeave: 0,
	earlyLeaveMinutes: 0,
	absent: 0,
	onLeave: 0,
	pending: 0,
	incomplete: 0,
	offDay: 0,
	holiday: 0,
	noSchedule: 0,
	workedMinutes: 0
});

type DailyRow = Awaited<ReturnType<typeof resolveDailyAttendance>>[number];

/**
 * The minutes one employee-day contributes — the ONE rule shared by the summary (addDay) and the
 * Phase 17B detail rows / exports, so summary totals always equal the sum of the detail rows:
 * worked minutes of present days; late / early minutes only on late / early results.
 */
export function dayFigures(row: Pick<DailyRow, 'result' | 'attendance'>) {
	const present = PRESENT_RESULTS.includes(row.result);
	const calc = row.attendance?.calculation;
	return {
		workedMinutes: present ? (calc?.workedMinutes ?? 0) : 0,
		lateMinutes: present && LATE_RESULTS.includes(row.result) ? (calc?.lateMinutes ?? 0) : 0,
		earlyLeaveMinutes:
			present && EARLY_RESULTS.includes(row.result) ? (calc?.earlyLeaveMinutes ?? 0) : 0
	};
}

export function addDay(m: AttendanceMetrics, row: Pick<DailyRow, 'result' | 'attendance'>) {
	const result = row.result;
	if (PRESENT_RESULTS.includes(result)) {
		const f = dayFigures(row);
		m.scheduled++;
		m.present++;
		m.workedMinutes += f.workedMinutes;
		if (result === 'INCOMPLETE') m.incomplete++;
		if (LATE_RESULTS.includes(result)) {
			m.late++;
			m.lateMinutes += f.lateMinutes;
		}
		if (EARLY_RESULTS.includes(result)) {
			m.earlyLeave++;
			m.earlyLeaveMinutes += f.earlyLeaveMinutes;
		}
		return;
	}
	switch (result) {
		case 'LEAVE':
			m.scheduled++;
			m.onLeave++;
			return;
		case 'ABSENT':
			m.scheduled++;
			m.absent++;
			return;
		case 'PENDING':
			m.scheduled++;
			m.pending++;
			return;
		case 'OFF_DAY':
			m.offDay++;
			return;
		case 'HOLIDAY':
			m.holiday++;
			return;
		default:
			m.noSchedule++;
	}
}

export const attendanceRate = (m: AttendanceMetrics) => rate(m.present, m.scheduled - m.onLeave);

const EMPLOYEE_SELECT = {
	id: true,
	employeeCode: true,
	firstNameLao: true,
	lastNameLao: true,
	branchId: true,
	departmentId: true,
	startDate: true,
	endDate: true
} as const;
type RangeEmployee = {
	id: number;
	employeeCode: string;
	firstNameLao: string;
	lastNameLao: string;
	branchId: number | null;
	departmentId: number | null;
	startDate: Date;
	endDate: Date | null;
};

const employedOn = (e: RangeEmployee, d: Date) =>
	e.startDate.getTime() <= d.getTime() && (!e.endDate || e.endDate.getTime() >= d.getTime());

/** Employees in scope employed at any point of [from, to] — ONE query for the whole range. */
async function employeesForRange(ctx: ReportingContext, from: Date, to: Date) {
	return prisma.employee.findMany({
		where: {
			AND: [
				ctx.employeeWhere,
				{ startDate: { lte: to } },
				{ OR: [{ endDate: null }, { endDate: { gte: from } }] }
			]
		},
		select: EMPLOYEE_SELECT,
		orderBy: { employeeCode: 'asc' }
	});
}

/**
 * Resolves every employee-day of the range through the canonical daily resolver (one date at a time:
 * the resolver is batched per date). Returns the rows per date, employees employed that date only.
 */
async function resolveRangeDays(employees: RangeEmployee[], dates: Date[], enforceCap = true) {
	const employeeDays = dates.reduce(
		(n, d) => n + employees.filter((e) => employedOn(e, d)).length,
		0
	);
	if (enforceCap && employeeDays > ATTENDANCE_MAX_EMPLOYEE_DAYS) {
		throw ReportErrors.rangeTooLarge({
			maxEmployeeDays: ATTENDANCE_MAX_EMPLOYEE_DAYS,
			requestedEmployeeDays: employeeDays
		});
	}
	const now = serverNow();
	const out: { date: Date; rows: DailyRow[] }[] = [];
	for (const date of dates) {
		const onDate = employees.filter((e) => employedOn(e, date));
		out.push({ date, rows: await resolveDailyAttendance(onDate, date, now) });
	}
	return { days: out, employeeDays };
}

export interface TrendPoint {
	date: string;
	scheduled: number;
	present: number;
	late: number;
	absent: number;
	onLeave: number;
	pending: number;
}

const trendPoint = (date: Date, m: AttendanceMetrics): TrendPoint => ({
	date: isoDate(date) as string,
	scheduled: m.scheduled,
	present: m.present,
	late: m.late,
	absent: m.absent,
	onLeave: m.onLeave,
	pending: m.pending
});

/**
 * Dashboard: the selected date's metrics + a 7-day trend ending on it (one resolver pass). The dashboard
 * never fails because of scope size: when 7 days would exceed the employee-day cap, only the selected
 * date is resolved and `trendLimited` is true (the trend then holds that one day).
 */
export async function attendanceSnapshot(ctx: ReportingContext, date: Date) {
	const weekStart = addDays(date, -6);
	const employees = await employeesForRange(ctx, weekStart, date);
	const trendLimited = employees.length * 7 > ATTENDANCE_MAX_EMPLOYEE_DAYS;
	const from = trendLimited ? date : weekStart;
	const { days } = await resolveRangeDays(employees, eachDate(from, date), !trendLimited);
	const trend: TrendPoint[] = [];
	let today = emptyAttendance();
	for (const { date: d, rows } of days) {
		const m = emptyAttendance();
		for (const r of rows) addDay(m, r);
		trend.push(trendPoint(d, m));
		if (d.getTime() === date.getTime()) today = m;
	}
	return { metrics: today, attendanceRate: attendanceRate(today), trend, trendLimited };
}

export const ATTENDANCE_GROUP_BY = ['none', 'branch', 'department', 'employee'] as const;
type AttendanceGroupBy = (typeof ATTENDANCE_GROUP_BY)[number];

async function groupLabels(groupBy: AttendanceGroupBy, keys: string[], employees: RangeEmployee[]) {
	const ids = idsFromKeys(keys);
	const select = { id: true, code: true, nameLao: true } as const;
	if (groupBy === 'branch') {
		const rows = await prisma.branch.findMany({ where: { id: { in: ids } }, select });
		return new Map(rows.map((r) => [String(r.id), { code: r.code, label: r.nameLao }]));
	}
	if (groupBy === 'department') {
		const rows = await prisma.department.findMany({ where: { id: { in: ids } }, select });
		return new Map(rows.map((r) => [String(r.id), { code: r.code, label: r.nameLao }]));
	}
	return new Map(
		employees.map((e) => [String(e.id), { code: e.employeeCode, label: personLabel(e) }])
	);
}

/** GET /reports/attendance/summary */
export async function getAttendanceSummary(auth: AuthContext, query: AttendanceReportQuery) {
	const range = resolveRange(query, { maxDays: ATTENDANCE_MAX_DAYS, allowFuture: false });
	const groupBy = parseGroupBy(query.groupBy, ATTENDANCE_GROUP_BY, 'department');
	const ctx = await resolveReportingContext(auth, query);
	const employees = await employeesForRange(ctx, range.from, range.to);
	const byId = new Map(employees.map((e) => [e.id, e]));
	const { days, employeeDays } = await resolveRangeDays(employees, eachDate(range.from, range.to));

	const keyOf = (employeeId: number): string => {
		const e = byId.get(employeeId);
		if (groupBy === 'employee') return groupKey(employeeId);
		if (groupBy === 'branch') return groupKey(e?.branchId);
		return groupKey(e?.departmentId);
	};

	const totals = emptyAttendance();
	const byGroup = new Map<string, AttendanceMetrics>();
	const trend: TrendPoint[] = [];
	for (const { date, rows } of days) {
		const m = emptyAttendance();
		for (const r of rows) {
			addDay(m, r);
			addDay(totals, r);
			if (groupBy !== 'none') {
				const k = keyOf(r.employee.id);
				const g = byGroup.get(k) ?? emptyAttendance();
				addDay(g, r);
				byGroup.set(k, g);
			}
		}
		trend.push(trendPoint(date, m));
	}

	const labels =
		groupBy === 'none' ? new Map() : await groupLabels(groupBy, [...byGroup.keys()], employees);
	const groups: ReportGroup<AttendanceMetrics & { attendanceRate: ReturnType<typeof rate> }>[] = [
		...byGroup.entries()
	]
		.map(([key, metrics]) => ({
			key,
			code: labels.get(key)?.code ?? null,
			label: labels.get(key)?.label ?? UNASSIGNED_LABEL,
			metrics: { ...metrics, attendanceRate: attendanceRate(metrics) }
		}))
		.sort((a, b) => (a.code ?? '~').localeCompare(b.code ?? '~'));

	return {
		generatedAt: new Date(),
		context: {
			from: isoDate(range.from),
			to: isoDate(range.to),
			days: range.days,
			timezone: REPORT_TIMEZONE,
			companyId: ctx.filter.companyId ?? null,
			branchId: ctx.filter.branchId ?? null,
			departmentId: ctx.filter.departmentId ?? null,
			employeeId: ctx.filter.employeeId ?? null,
			groupBy,
			scope: ctx.scope.all ? 'ALL' : 'TEAM',
			employees: employees.length,
			employeeDays
		},
		totals: { ...totals, attendanceRate: attendanceRate(totals) },
		groups,
		trend
	};
}

// ============================================================================================
// Phase 17B — DETAIL: one row per employee-day (the SAME resolution, guard and figures as above)
// ============================================================================================

export interface AttendanceDetailFilters {
	companyId?: number;
	branchId?: number;
	departmentId?: number;
	employeeId?: number;
	from?: Date;
	to?: Date;
	status?: DailyResult;
}

/**
 * Every employee-day of the filtered range through `resolveRangeDays` (same 93-day / 5,000 employee-day
 * guard as the summary), so the detail rows ARE the summary's population. `guard(n)` receives the
 * employee-day count BEFORE any resolution (export row limits). Raw punches, GPS, device data and
 * correction notes are never selected — times are the EFFECTIVE check-in / check-out.
 */
export async function attendanceDetailRows(
	auth: AuthContext,
	q: AttendanceDetailFilters,
	guard: (count: number) => void
) {
	const range = resolveRange(q, { maxDays: ATTENDANCE_MAX_DAYS, allowFuture: false });
	const ctx = await resolveReportingContext(auth, q);
	const employees = await employeesForRange(ctx, range.from, range.to);
	const dates = eachDate(range.from, range.to);
	guard(dates.reduce((n, d) => n + employees.filter((e) => employedOn(e, d)).length, 0));
	const { days } = await resolveRangeDays(employees, dates);
	const byId = new Map(employees.map((e) => [e.id, e]));
	const [branches, departments] = await Promise.all([
		prisma.branch.findMany({
			where: {
				id: { in: [...new Set(employees.flatMap((e) => (e.branchId ? [e.branchId] : [])))] }
			},
			select: { id: true, nameLao: true }
		}),
		prisma.department.findMany({
			where: {
				id: { in: [...new Set(employees.flatMap((e) => (e.departmentId ? [e.departmentId] : [])))] }
			},
			select: { id: true, nameLao: true }
		})
	]);
	const branchName = new Map(branches.map((b) => [b.id, b.nameLao]));
	const deptName = new Map(departments.map((d) => [d.id, d.nameLao]));
	const rows = days.flatMap(({ date, rows: dayRows }) =>
		dayRows
			.filter((r) => !q.status || r.result === q.status)
			.map((r) => {
				const e = byId.get(r.employee.id)!;
				const f = dayFigures(r);
				return {
					date: isoDate(date),
					employeeCode: e.employeeCode,
					employeeName: personLabel(e),
					branch: e.branchId ? (branchName.get(e.branchId) ?? null) : null,
					department: e.departmentId ? (deptName.get(e.departmentId) ?? null) : null,
					shift: r.schedule?.shiftCode ?? null,
					status: r.result as string,
					checkInAt: r.attendance?.effectiveCheckInAt?.toISOString() ?? null,
					checkOutAt: r.attendance?.effectiveCheckOutAt?.toISOString() ?? null,
					lateMinutes: f.lateMinutes,
					earlyLeaveMinutes: f.earlyLeaveMinutes,
					workedMinutes: f.workedMinutes
				};
			})
	);
	return {
		context: {
			from: isoDate(range.from),
			to: isoDate(range.to),
			days: range.days,
			timezone: REPORT_TIMEZONE,
			companyId: ctx.filter.companyId ?? null,
			branchId: ctx.filter.branchId ?? null,
			departmentId: ctx.filter.departmentId ?? null,
			employeeId: ctx.filter.employeeId ?? null,
			status: q.status ?? null,
			scope: ctx.scope.all ? 'ALL' : 'TEAM'
		},
		rows
	};
}
