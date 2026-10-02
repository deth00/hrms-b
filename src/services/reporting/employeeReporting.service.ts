import type { EmploymentStatus } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import type { AuthContext } from '../../types/express.js';
import type { EmployeeReportQuery } from '../../validation/reporting.schema.js';
import { resolveReportingContext, type ReportingContext } from './reportingScope.service.js';
import {
	REPORT_TIMEZONE,
	ReportErrors,
	UNASSIGNED_KEY,
	UNASSIGNED_LABEL,
	isoDate,
	parseGroupBy,
	reportToday,
	type ReportGroup,
	groupKey,
	idsFromKeys
} from './reportingCommon.js';

/**
 * Phase 17A — EMPLOYEE headcount (CURRENT only).
 *
 * Definitions (employmentStatus is the canonical status; RESIGNED / TERMINATED = "ended", the same rule
 * the Employee module uses):
 *   headcount (total) = employees in scope whose status is NOT ended
 *   active            = ACTIVE + PROBATION                 (working)
 *   inactive          = ON_LEAVE + SUSPENDED               (still employed, not working)
 *   probation         = PROBATION                          (subset of active)
 *   separated         = RESIGNED + TERMINATED              (NOT part of headcount)
 *
 * HISTORICAL_HEADCOUNT_NOT_AVAILABLE: employment STATUS has no history table (only the current value),
 * so an "as of" headcount for a past date cannot be reconstructed truthfully. `asOf` is accepted only for
 * today; anything else is REPORT_HISTORICAL_DATA_UNAVAILABLE. Grouping uses the CURRENT assignment.
 */
const ACTIVE: EmploymentStatus[] = ['ACTIVE', 'PROBATION'];
const INACTIVE: EmploymentStatus[] = ['ON_LEAVE', 'SUSPENDED'];
const ENDED: EmploymentStatus[] = ['RESIGNED', 'TERMINATED'];
export const EMPLOYMENT_STATUSES: EmploymentStatus[] = [...ACTIVE, ...INACTIVE, ...ENDED];

export interface HeadcountMetrics {
	total: number;
	active: number;
	inactive: number;
	probation: number;
	separated: number;
}

const emptyHeadcount = (): HeadcountMetrics => ({
	total: 0,
	active: 0,
	inactive: 0,
	probation: 0,
	separated: 0
});

function addStatus(m: HeadcountMetrics, status: EmploymentStatus, n: number) {
	if (ENDED.includes(status)) {
		m.separated += n;
		return;
	}
	m.total += n;
	if (ACTIVE.includes(status)) m.active += n;
	if (INACTIVE.includes(status)) m.inactive += n;
	if (status === 'PROBATION') m.probation += n;
}

/** Totals + a per-status breakdown for the employees in the context (one groupBy query). */
export async function headcount(ctx: ReportingContext) {
	const rows = await prisma.employee.groupBy({
		by: ['employmentStatus'],
		where: ctx.employeeWhere,
		_count: { _all: true }
	});
	const totals = emptyHeadcount();
	const byStatus = Object.fromEntries(EMPLOYMENT_STATUSES.map((s) => [s, 0])) as Record<
		EmploymentStatus,
		number
	>;
	for (const r of rows) {
		addStatus(totals, r.employmentStatus, r._count._all);
		byStatus[r.employmentStatus] = r._count._all;
	}
	return { ...totals, byStatus };
}

export const EMPLOYEE_GROUP_BY = ['company', 'branch', 'department', 'employmentType'] as const;
export type EmployeeGroupBy = (typeof EMPLOYEE_GROUP_BY)[number];

const FIELD: Record<
	EmployeeGroupBy,
	'companyId' | 'branchId' | 'departmentId' | 'employmentTypeId'
> = {
	company: 'companyId',
	branch: 'branchId',
	department: 'departmentId',
	employmentType: 'employmentTypeId'
};

async function labelsFor(dim: EmployeeGroupBy, keys: string[]) {
	const where = { id: { in: idsFromKeys(keys) } };
	const select = { id: true, code: true, nameLao: true } as const;
	const rows =
		dim === 'company'
			? await prisma.company.findMany({ where, select })
			: dim === 'branch'
				? await prisma.branch.findMany({ where, select })
				: dim === 'department'
					? await prisma.department.findMany({ where, select })
					: await prisma.employmentType.findMany({ where, select });
	return new Map(rows.map((r) => [String(r.id), r]));
}

/** Current headcount per org dimension. The dimension is a WHITELISTED Prisma field — never client text. */
export async function distribution(
	ctx: ReportingContext,
	dim: EmployeeGroupBy
): Promise<ReportGroup<HeadcountMetrics>[]> {
	const field = FIELD[dim];
	const rows = await prisma.employee.groupBy({
		by: [field, 'employmentStatus'],
		where: ctx.employeeWhere,
		_count: { _all: true }
	});
	const acc = new Map<string, HeadcountMetrics>();
	for (const r of rows) {
		const key = groupKey(r[field] as number | null);
		const m = acc.get(key) ?? emptyHeadcount();
		addStatus(m, r.employmentStatus, r._count._all);
		acc.set(key, m);
	}
	const labels = await labelsFor(
		dim,
		[...acc.keys()].filter((k) => k !== UNASSIGNED_KEY)
	);
	return [...acc.entries()]
		.map(([key, metrics]) => {
			const l = labels.get(key);
			return {
				key,
				code: l?.code ?? null,
				label: l?.nameLao ?? UNASSIGNED_LABEL,
				metrics
			};
		})
		.filter((g) => g.metrics.total > 0 || g.metrics.separated > 0)
		.sort((a, b) => b.metrics.total - a.metrics.total || a.label.localeCompare(b.label));
}

/** GET /reports/employees/summary */
export async function getEmployeeSummary(auth: AuthContext, query: EmployeeReportQuery) {
	const today = reportToday();
	if (query.asOf && query.asOf.getTime() !== today.getTime()) {
		throw ReportErrors.historicalUnavailable('HISTORICAL_HEADCOUNT_NOT_AVAILABLE');
	}
	const groupBy = parseGroupBy(query.groupBy, EMPLOYEE_GROUP_BY, 'department');
	const ctx = await resolveReportingContext(auth, query);
	const [totals, groups] = await Promise.all([headcount(ctx), distribution(ctx, groupBy)]);
	return {
		generatedAt: new Date(),
		context: {
			asOf: isoDate(today),
			historical: false,
			timezone: REPORT_TIMEZONE,
			companyId: ctx.filter.companyId ?? null,
			branchId: ctx.filter.branchId ?? null,
			departmentId: ctx.filter.departmentId ?? null,
			groupBy,
			scope: ctx.scope.all ? 'ALL' : 'TEAM'
		},
		totals,
		groups
	};
}

// ============================================================================================
// Phase 17B — DETAIL: one row per employee
// ============================================================================================

/** CURRENT = the headcount population (not ended — the summary's `total`); ALL = every status. */
export const EMPLOYEE_STATUS_FILTERS = ['CURRENT', 'ALL', ...EMPLOYMENT_STATUSES] as const;
export type EmployeeStatusFilter = (typeof EMPLOYEE_STATUS_FILTERS)[number];

export interface EmployeeDetailFilters {
	companyId?: number;
	branchId?: number;
	departmentId?: number;
	status?: EmployeeStatusFilter;
}

/**
 * HR report fields only — never national id / passport / address / personal phone or e-mail, bank data,
 * statutory numbers or compensation. The CURRENT assignment is shown (like the summary). An ACTIVE
 * employee with a future start date IS part of the headcount (Phase 17A definition, unchanged here);
 * `startDate` is a column so a reader can see it.
 */
export async function employeeDetailRows(
	auth: AuthContext,
	q: EmployeeDetailFilters,
	guard: (count: number) => void
) {
	const ctx = await resolveReportingContext(auth, q);
	const status = q.status ?? 'CURRENT';
	const where = {
		AND: [
			ctx.employeeWhere,
			status === 'ALL'
				? {}
				: status === 'CURRENT'
					? { employmentStatus: { notIn: ENDED } }
					: { employmentStatus: status }
		]
	};
	guard(await prisma.employee.count({ where }));
	const name = { select: { nameLao: true } } as const;
	const rows = await prisma.employee.findMany({
		where,
		select: {
			employeeCode: true,
			firstNameLao: true,
			lastNameLao: true,
			employmentStatus: true,
			startDate: true,
			endDate: true,
			employmentType: name,
			branch: name,
			department: name,
			division: name,
			unit: name,
			position: name
		}
	});
	return {
		context: {
			asOf: isoDate(reportToday()),
			timezone: REPORT_TIMEZONE,
			companyId: ctx.filter.companyId ?? null,
			branchId: ctx.filter.branchId ?? null,
			departmentId: ctx.filter.departmentId ?? null,
			status,
			scope: ctx.scope.all ? 'ALL' : 'TEAM'
		},
		rows: rows.map((e) => ({
			employeeCode: e.employeeCode,
			fullName: `${e.firstNameLao} ${e.lastNameLao}`.trim(),
			employmentStatus: e.employmentStatus as string,
			employmentType: e.employmentType?.nameLao ?? null,
			branch: e.branch?.nameLao ?? null,
			department: e.department?.nameLao ?? null,
			division: e.division?.nameLao ?? null,
			unit: e.unit?.nameLao ?? null,
			position: e.position?.nameLao ?? null,
			startDate: isoDate(e.startDate),
			endDate: isoDate(e.endDate)
		}))
	};
}
