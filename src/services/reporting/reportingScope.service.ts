import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import {
	VIEW_ALL_PERMISSION,
	resolveEmployeeScope,
	scopeToWhere,
	type EmployeeScope
} from '../../lib/employeeScope.js';
import type { AuthContext } from '../../types/express.js';
import { ReportErrors } from './reportingCommon.js';

/**
 * Phase 17A — WHO may see WHICH report, and over WHICH employees.
 *
 * PERMISSIONS. `reports.view` opens the Report Center but NEVER grants data on its own: each report also
 * needs the existing domain permission(s). The sensitive (money) reports additionally need the
 * company-wide employee scope `employees.view_all` — exactly like the payroll / payment / accounting
 * modules themselves (requirePayrollAccess), so a manager can never reach salary, payment or journal
 * figures through reporting.
 *
 * DATA SCOPE. Employee-based reports reuse `resolveEmployeeScope` (the Phase 3 data scope): ALL for
 * `employees.view_all`, otherwise the user's own record + their manager tree. There is no reporting
 * bypass: every employee-based query is AND-ed with `scopeToWhere(scope)`.
 *
 * COMPANY ISOLATION / FILTERS. Users are not bound to a company in this system; what a user may see is
 * decided by the scope above. A company / branch / department / employee filter is therefore verified
 * against the scope before it is used:
 *   - company-wide scope: the id must exist (and branch / department must belong to the chosen company)
 *     → otherwise 400 REPORT_FILTER_INVALID;
 *   - restricted scope: the id must be one of the companies / branches / departments / employees of the
 *     employees in scope → otherwise 403 REPORT_FILTER_NOT_ALLOWED (unknown ids get the same 403, so a
 *     manager cannot probe which ids exist).
 * A validated filter is AND-ed into the employee where-clause, so a filter can only ever NARROW the scope.
 */
export const REPORTS_PERMISSION = 'reports.view';

export const REPORT_DOMAINS = [
	'employees',
	'attendance',
	'leave',
	'overtime',
	'payroll',
	'payments',
	'accounting'
] as const;
export type ReportDomain = (typeof REPORT_DOMAINS)[number];

/** Domain permissions required ON TOP OF reports.view (all of them). */
export const REPORT_DOMAIN_PERMISSIONS: Record<ReportDomain, string[]> = {
	employees: ['employees.view'],
	attendance: ['attendance.view'],
	leave: ['leave.view'],
	overtime: ['overtime.view'],
	payroll: ['payroll.view', VIEW_ALL_PERMISSION],
	payments: ['payroll.payment.view', VIEW_ALL_PERMISSION],
	accounting: ['payroll.accounting.view', VIEW_ALL_PERMISSION]
};

/** Dashboard widgets use the SAME domain gates (without reports.view — the dashboard is dashboard.view). */
export const holdsDomain = (permissions: string[], domain: ReportDomain) =>
	REPORT_DOMAIN_PERMISSIONS[domain].every((p) => permissions.includes(p));

export const canViewReport = (permissions: string[], domain: ReportDomain) =>
	permissions.includes(REPORTS_PERMISSION) && holdsDomain(permissions, domain);

export const accessibleReports = (permissions: string[]) =>
	REPORT_DOMAINS.filter((d) => canViewReport(permissions, d));

export interface OrgFilter {
	companyId?: number;
	branchId?: number;
	departmentId?: number;
	employeeId?: number;
}

export interface ReportingContext {
	scope: EmployeeScope;
	filter: OrgFilter;
	/** scope AND validated filters (CURRENT assignment of the employee) */
	employeeWhere: Prisma.EmployeeWhereInput;
}

interface ScopeFootprint {
	companyIds: Set<number>;
	branchIds: Set<number>;
	departmentIds: Set<number>;
	employeeIds: Set<number>;
}

async function footprintOf(scope: EmployeeScope): Promise<ScopeFootprint> {
	const ids = scope.all ? [] : scope.employeeIds;
	const rows = ids.length
		? await prisma.employee.findMany({
				where: { id: { in: ids } },
				select: { id: true, companyId: true, branchId: true, departmentId: true }
			})
		: [];
	return {
		companyIds: new Set(rows.map((r) => r.companyId)),
		branchIds: new Set(rows.flatMap((r) => (r.branchId ? [r.branchId] : []))),
		departmentIds: new Set(rows.flatMap((r) => (r.departmentId ? [r.departmentId] : []))),
		employeeIds: new Set(rows.map((r) => r.id))
	};
}

async function validateCompanyWide(filter: OrgFilter): Promise<void> {
	const [company, branch, department, employee] = await Promise.all([
		filter.companyId
			? prisma.company.findUnique({ where: { id: filter.companyId }, select: { id: true } })
			: null,
		filter.branchId
			? prisma.branch.findUnique({ where: { id: filter.branchId }, select: { companyId: true } })
			: null,
		filter.departmentId
			? prisma.department.findUnique({
					where: { id: filter.departmentId },
					select: { companyId: true }
				})
			: null,
		filter.employeeId
			? prisma.employee.findUnique({ where: { id: filter.employeeId }, select: { id: true } })
			: null
	]);
	if (filter.companyId && !company) throw ReportErrors.filterInvalid('companyId');
	if (filter.branchId) {
		if (!branch) throw ReportErrors.filterInvalid('branchId');
		if (filter.companyId && branch.companyId !== filter.companyId) {
			throw ReportErrors.filterInvalid('branchId');
		}
	}
	if (filter.departmentId) {
		if (!department) throw ReportErrors.filterInvalid('departmentId');
		if (filter.companyId && department.companyId !== filter.companyId) {
			throw ReportErrors.filterInvalid('departmentId');
		}
		if (branch && department.companyId !== branch.companyId) {
			throw ReportErrors.filterInvalid('departmentId');
		}
	}
	if (filter.employeeId && !employee) throw ReportErrors.filterInvalid('employeeId');
}

function validateRestricted(filter: OrgFilter, fp: ScopeFootprint): void {
	if (filter.companyId && !fp.companyIds.has(filter.companyId)) {
		throw ReportErrors.filterNotAllowed('companyId');
	}
	if (filter.branchId && !fp.branchIds.has(filter.branchId)) {
		throw ReportErrors.filterNotAllowed('branchId');
	}
	if (filter.departmentId && !fp.departmentIds.has(filter.departmentId)) {
		throw ReportErrors.filterNotAllowed('departmentId');
	}
	if (filter.employeeId && !fp.employeeIds.has(filter.employeeId)) {
		throw ReportErrors.filterNotAllowed('employeeId');
	}
}

/** Resolves the caller's data scope and validates the org filter against it. */
export async function resolveReportingContext(
	auth: AuthContext,
	input: OrgFilter
): Promise<ReportingContext> {
	const filter: OrgFilter = {
		...(input.companyId ? { companyId: input.companyId } : {}),
		...(input.branchId ? { branchId: input.branchId } : {}),
		...(input.departmentId ? { departmentId: input.departmentId } : {}),
		...(input.employeeId ? { employeeId: input.employeeId } : {})
	};
	const scope = await resolveEmployeeScope(auth);
	if (scope.all) await validateCompanyWide(filter);
	else validateRestricted(filter, await footprintOf(scope));
	return {
		scope,
		filter,
		employeeWhere: {
			AND: [
				scopeToWhere(scope),
				filter.companyId ? { companyId: filter.companyId } : {},
				filter.branchId ? { branchId: filter.branchId } : {},
				filter.departmentId ? { departmentId: filter.departmentId } : {},
				filter.employeeId ? { id: filter.employeeId } : {}
			]
		}
	};
}

/** Company-wide (money) reports: companyId is REQUIRED (one currency per company — never mixed). */
export async function resolveCompanyContext(
	auth: AuthContext,
	input: OrgFilter
): Promise<ReportingContext & { companyId: number }> {
	if (!input.companyId) throw ReportErrors.filterRequired('companyId');
	return { ...(await resolveReportingContext(auth, input)), companyId: input.companyId };
}

const ORG_SELECT = { id: true, code: true, nameLao: true, status: true } as const;

/**
 * GET /reports/filter-options — ONLY the companies / branches / departments the caller may filter by
 * (company-wide scope: all of them; restricted scope: those of the employees in scope), plus the report
 * domains the caller may open.
 */
export async function reportFilterOptions(auth: AuthContext) {
	const scope = await resolveEmployeeScope(auth);
	const fp = scope.all ? null : await footprintOf(scope);
	const byIds = (ids: Set<number> | undefined) => (ids ? { id: { in: [...ids] } } : {});
	const [companies, branches, departments] = await Promise.all([
		prisma.company.findMany({
			where: byIds(fp?.companyIds),
			select: ORG_SELECT,
			orderBy: { code: 'asc' }
		}),
		prisma.branch.findMany({
			where: byIds(fp?.branchIds),
			select: { ...ORG_SELECT, companyId: true },
			orderBy: { code: 'asc' }
		}),
		prisma.department.findMany({
			where: byIds(fp?.departmentIds),
			select: { ...ORG_SELECT, companyId: true, branchId: true },
			orderBy: { code: 'asc' }
		})
	]);
	return {
		scope: scope.all ? ('ALL' as const) : ('TEAM' as const),
		reports: accessibleReports(auth.permissions),
		companies,
		branches,
		departments
	};
}
