import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { addDays } from '../lib/dates.js';

/**
 * HISTORICAL ASSIGNMENT RESOLVER — the ONE place that answers "where did this employee belong on
 * date D?" from EmployeeAssignmentHistory (never from the current Employee snapshot alone).
 *
 * History rows are HALF-OPEN: a row covers `effectiveFrom <= D < effectiveTo` (a transfer sets the
 * old row's effectiveTo to the new row's effectiveFrom), `effectiveTo = NULL` is the open row.
 *
 * Fallbacks (documented, used so pre-history / directly-inserted employees keep working):
 *   - a date BEFORE the first row uses the first row (employment starts with the first placement);
 *   - an employee with NO history rows at all uses the current Employee placement for every date.
 *
 * Payroll uses `buildTimeline` / `segmentsWithin` for whole periods, so eligibility, company / branch
 * change detection and snapshots all share this date logic (payrollCalculation.ts has none of its own).
 */
type Db = Prisma.TransactionClient | typeof prisma;

export interface AssignmentPlacement {
	companyId: number;
	branchId: number | null;
	departmentId: number | null;
	divisionId: number | null;
	unitId: number | null;
	positionId: number | null;
}

export interface HistoryRow extends AssignmentPlacement {
	effectiveFrom: Date;
	effectiveTo: Date | null;
}

/** an inclusive slice of a period during which the placement is constant */
export interface AssignmentSegment extends AssignmentPlacement {
	from: Date;
	to: Date;
}

const t = (d: Date) => d.getTime();
const FAR_PAST = new Date(Date.UTC(1900, 0, 1));
const FAR_FUTURE = new Date(Date.UTC(9999, 11, 31));

const placementOf = (r: AssignmentPlacement): AssignmentPlacement => ({
	companyId: r.companyId,
	branchId: r.branchId,
	departmentId: r.departmentId,
	divisionId: r.divisionId,
	unitId: r.unitId,
	positionId: r.positionId
});

/** Sorted rows -> inclusive [from, to] segments with the first row extended to the past. */
export function buildTimeline(
	rows: readonly HistoryRow[],
	current: AssignmentPlacement
): AssignmentSegment[] {
	if (rows.length === 0) return [{ ...placementOf(current), from: FAR_PAST, to: FAR_FUTURE }];
	const sorted = [...rows].sort((a, b) => t(a.effectiveFrom) - t(b.effectiveFrom));
	return sorted.map((r, i) => ({
		...placementOf(r),
		from: i === 0 ? FAR_PAST : r.effectiveFrom,
		// half-open history: the last day the row covers is the day BEFORE effectiveTo
		to: r.effectiveTo ? addDays(r.effectiveTo, -1) : FAR_FUTURE
	}));
}

/** the placement on ONE date (null only if the rows leave a gap — never for well-formed history) */
export function placementAt(
	rows: readonly HistoryRow[],
	current: AssignmentPlacement,
	date: Date
): AssignmentPlacement {
	const seg = buildTimeline(rows, current).find((s) => t(s.from) <= t(date) && t(date) <= t(s.to));
	// a gap can only come from hand-edited history; the nearest earlier row is the best evidence
	return seg ? placementOf(seg) : placementOf(rows.length ? rows[rows.length - 1]! : current);
}

/** the constant-placement slices that fall inside [from, to] (inclusive) */
export function segmentsWithin(
	rows: readonly HistoryRow[],
	current: AssignmentPlacement,
	from: Date,
	to: Date
): AssignmentSegment[] {
	return buildTimeline(rows, current)
		.filter((s) => t(s.from) <= t(to) && t(s.to) >= t(from))
		.map((s) => ({
			...s,
			from: t(s.from) < t(from) ? from : s.from,
			to: t(s.to) > t(to) ? to : s.to
		}));
}

const distinct = <T>(values: T[]) => [...new Set(values)];
export const companiesIn = (segs: readonly AssignmentSegment[]) =>
	distinct(segs.map((s) => s.companyId));
export const branchesIn = (segs: readonly AssignmentSegment[]) =>
	distinct(segs.map((s) => s.branchId));

const ROW_SELECT = {
	companyId: true,
	branchId: true,
	departmentId: true,
	divisionId: true,
	unitId: true,
	positionId: true,
	effectiveFrom: true,
	effectiveTo: true
} satisfies Prisma.EmployeeAssignmentHistorySelect;

/** Bulk history load for several employees (one query). */
export async function loadHistoryFor(db: Db, employeeIds: number[]) {
	const map = new Map<number, HistoryRow[]>();
	if (employeeIds.length === 0) return map;
	const rows = await db.employeeAssignmentHistory.findMany({
		where: { employeeId: { in: employeeIds } },
		select: { employeeId: true, ...ROW_SELECT },
		orderBy: { effectiveFrom: 'asc' }
	});
	for (const { employeeId, ...row } of rows)
		map.set(employeeId, [...(map.get(employeeId) ?? []), row]);
	return map;
}

export interface ResolvedAssignment extends AssignmentPlacement {
	source: 'HISTORY' | 'CURRENT';
	company: { id: number; code: string; nameLao: string } | null;
	branch: { id: number; code: string; nameLao: string } | null;
	department: { id: number; code: string; nameLao: string } | null;
	division: { id: number; code: string; nameLao: string } | null;
	unit: { id: number; code: string; nameLao: string } | null;
	position: { id: number; code: string; nameLao: string } | null;
}

/** Company / branch / department / division / unit / position of an employee on a date. */
export async function resolveEmployeeAssignmentAtDate(
	db: Db,
	employeeId: number,
	date: Date
): Promise<ResolvedAssignment | null> {
	const employee = await db.employee.findUnique({
		where: { id: employeeId },
		select: {
			companyId: true,
			branchId: true,
			departmentId: true,
			divisionId: true,
			unitId: true,
			positionId: true
		}
	});
	if (!employee) return null;
	const rows = (await loadHistoryFor(db, [employeeId])).get(employeeId) ?? [];
	const at = placementAt(rows, employee, date);
	const brief = { select: { id: true, code: true, nameLao: true } } as const;
	const [company, branch, department, division, unit, position] = await Promise.all([
		db.company.findUnique({ where: { id: at.companyId }, ...brief }),
		at.branchId ? db.branch.findUnique({ where: { id: at.branchId }, ...brief }) : null,
		at.departmentId ? db.department.findUnique({ where: { id: at.departmentId }, ...brief }) : null,
		at.divisionId ? db.division.findUnique({ where: { id: at.divisionId }, ...brief }) : null,
		at.unitId ? db.unit.findUnique({ where: { id: at.unitId }, ...brief }) : null,
		at.positionId ? db.position.findUnique({ where: { id: at.positionId }, ...brief }) : null
	]);
	return {
		...at,
		source: rows.length ? 'HISTORY' : 'CURRENT',
		company,
		branch,
		department,
		division,
		unit,
		position
	};
}

/** Convenience for callers that only need the company. */
export async function resolveEmployeeCompanyAtDate(db: Db, employeeId: number, date: Date) {
	return (await resolveEmployeeAssignmentAtDate(db, employeeId, date))?.companyId ?? null;
}
