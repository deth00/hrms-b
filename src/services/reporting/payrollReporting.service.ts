import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import type { AuthContext } from '../../types/express.js';
import type { PayrollReportQuery } from '../../validation/reporting.schema.js';
import { resolveCompanyContext } from './reportingScope.service.js';
import {
	ReportErrors,
	UNASSIGNED_KEY,
	UNASSIGNED_LABEL,
	isoDate,
	moneyText,
	parseGroupBy,
	type ReportGroup,
	groupKey,
	idsFromKeys
} from './reportingCommon.js';

/**
 * Phase 17A — PAYROLL analytics. Reads ONLY the stored, FINALIZED payroll snapshot:
 *   PayrollRun (status FINALIZED, payrollMonth snapshot) → PayrollEmployeeResult (totalEarnings,
 *   totalDeductions, netPay, branch / department SNAPSHOTS) → PayrollStatutoryResult (this cycle's
 *   pitCurrentCycle, employeeSsoCurrentCycle, employerSsoCurrentCycle).
 * Nothing is recalculated: no payroll engine call, no current salary / compensation / employee row is
 * read, so later salary or org changes can never move a historical report.
 *
 *   grossEarnings   = Σ totalEarnings        totalDeductions = Σ totalDeductions
 *   pit             = Σ pitCurrentCycle      (may include a negative credit — shown as stored)
 *   employeeSso     = Σ employeeSsoCurrentCycle     employerSso = Σ employerSsoCurrentCycle
 *   netPay          = Σ netPay
 *   employeeCount   = distinct employees (a two-cycle month has two results per employee)
 * Money is summed with Prisma.Decimal and returned as fixed-2 strings.
 *
 * Grouping / branch / department filters use the RESULT SNAPSHOTS (historical org at calculation time),
 * never today's employee assignment. A run whose payroll month is ambiguous (a manual period, NULL
 * payrollMonth) is not part of any month and is reported as `unassignedMonthRuns`.
 * Company is REQUIRED (one currency per company; currencies are never mixed).
 */
const ZERO = new Prisma.Decimal(0);
export const PAYROLL_GROUP_BY = ['none', 'run', 'branch', 'department'] as const;

interface Acc {
	employees: Set<number>;
	results: number;
	grossEarnings: Prisma.Decimal;
	totalDeductions: Prisma.Decimal;
	pit: Prisma.Decimal;
	employeeSso: Prisma.Decimal;
	employerSso: Prisma.Decimal;
	netPay: Prisma.Decimal;
	withoutStatutory: number;
}
const emptyAcc = (): Acc => ({
	employees: new Set(),
	results: 0,
	grossEarnings: ZERO,
	totalDeductions: ZERO,
	pit: ZERO,
	employeeSso: ZERO,
	employerSso: ZERO,
	netPay: ZERO,
	withoutStatutory: 0
});
const present = (a: Acc) => ({
	employeeCount: a.employees.size,
	resultCount: a.results,
	grossEarnings: moneyText(a.grossEarnings),
	totalDeductions: moneyText(a.totalDeductions),
	pit: moneyText(a.pit),
	employeeSso: moneyText(a.employeeSso),
	employerSso: moneyText(a.employerSso),
	netPay: moneyText(a.netPay),
	resultsWithoutStatutory: a.withoutStatutory
});

/** The latest payroll month with a FINALIZED run (optionally of one company). */
export async function latestFinalizedMonth(companyId?: number): Promise<string | null> {
	const run = await prisma.payrollRun.findFirst({
		where: {
			status: 'FINALIZED',
			payrollMonth: { not: null },
			...(companyId ? { companyId } : {})
		},
		orderBy: [{ payrollMonth: 'desc' }, { finalizedAt: 'desc' }],
		select: { payrollMonth: true }
	});
	return run?.payrollMonth ?? null;
}

/** The FINALIZED runs of a company's payroll month (optionally one schedule) — summary AND detail. */
export function finalizedRuns(
	companyId: number,
	payrollMonth: string | null,
	scheduleId: number | undefined
) {
	if (!payrollMonth) return Promise.resolve([]);
	return prisma.payrollRun.findMany({
		where: {
			companyId,
			status: 'FINALIZED',
			payrollMonth,
			...(scheduleId ? { payrollScheduleId: scheduleId } : {})
		},
		select: {
			id: true,
			cycleNumber: true,
			currencyCode: true,
			finalizedAt: true,
			payrollMonth: true,
			period: { select: { code: true, name: true, startDate: true, endDate: true } }
		},
		orderBy: [{ cycleNumber: 'asc' }, { finalizedAt: 'asc' }]
	});
}

/** Results of those runs, filtered by the HISTORICAL branch / department snapshot ids. */
export const snapshotResultWhere = (
	runs: { id: number }[],
	filter: { branchId?: number; departmentId?: number }
): Prisma.PayrollEmployeeResultWhereInput => ({
	payrollRunId: { in: runs.map((r) => r.id) },
	...(filter.branchId ? { branchIdSnapshot: filter.branchId } : {}),
	...(filter.departmentId ? { departmentIdSnapshot: filter.departmentId } : {})
});

/** GET /reports/payroll/summary */
export async function getPayrollSummary(auth: AuthContext, query: PayrollReportQuery) {
	const groupBy = parseGroupBy(query.groupBy, PAYROLL_GROUP_BY, 'department');
	// branch / department ids must exist and belong to the company (they filter the SNAPSHOT ids)
	const ctx = await resolveCompanyContext(auth, {
		companyId: query.companyId,
		branchId: query.branchId,
		departmentId: query.departmentId
	});
	const companyId = ctx.companyId;
	if (query.scheduleId) {
		const schedule = await prisma.payrollSchedule.findFirst({
			where: { id: query.scheduleId, companyId },
			select: { id: true }
		});
		if (!schedule) throw ReportErrors.filterInvalid('scheduleId');
	}

	const [availableMonths, unassignedMonthRuns, settings] = await Promise.all([
		prisma.payrollRun.findMany({
			where: { companyId, status: 'FINALIZED', payrollMonth: { not: null } },
			distinct: ['payrollMonth'],
			orderBy: { payrollMonth: 'desc' },
			select: { payrollMonth: true },
			take: 36
		}),
		prisma.payrollRun.count({ where: { companyId, status: 'FINALIZED', payrollMonth: null } }),
		prisma.payrollSettings.findUnique({ where: { companyId }, select: { currencyCode: true } })
	]);
	const payrollMonth = query.payrollMonth ?? availableMonths[0]?.payrollMonth ?? null;

	const runs = await finalizedRuns(companyId, payrollMonth, query.scheduleId);

	const results = runs.length
		? await prisma.payrollEmployeeResult.findMany({
				where: snapshotResultWhere(runs, ctx.filter),
				select: {
					payrollRunId: true,
					employeeId: true,
					branchIdSnapshot: true,
					branchNameSnapshot: true,
					departmentIdSnapshot: true,
					departmentNameSnapshot: true,
					totalEarnings: true,
					totalDeductions: true,
					netPay: true,
					statutoryResult: {
						select: {
							pitCurrentCycle: true,
							employeeSsoCurrentCycle: true,
							employerSsoCurrentCycle: true
						}
					}
				}
			})
		: [];

	const runLabel = new Map(runs.map((r) => [String(r.id), r]));
	const snapshotLabel = new Map<string, string>();
	const keyOf = (r: (typeof results)[number]): string => {
		if (groupBy === 'run') return groupKey(r.payrollRunId);
		if (groupBy === 'branch') {
			const k = groupKey(r.branchIdSnapshot);
			if (r.branchIdSnapshot && r.branchNameSnapshot) snapshotLabel.set(k, r.branchNameSnapshot);
			return k;
		}
		const k = groupKey(r.departmentIdSnapshot);
		if (r.departmentIdSnapshot && r.departmentNameSnapshot) {
			snapshotLabel.set(k, r.departmentNameSnapshot);
		}
		return k;
	};

	const add = (a: Acc, r: (typeof results)[number]) => {
		a.employees.add(r.employeeId);
		a.results++;
		a.grossEarnings = a.grossEarnings.plus(r.totalEarnings);
		a.totalDeductions = a.totalDeductions.plus(r.totalDeductions);
		a.netPay = a.netPay.plus(r.netPay);
		if (r.statutoryResult) {
			a.pit = a.pit.plus(r.statutoryResult.pitCurrentCycle);
			a.employeeSso = a.employeeSso.plus(r.statutoryResult.employeeSsoCurrentCycle);
			a.employerSso = a.employerSso.plus(r.statutoryResult.employerSsoCurrentCycle);
		} else a.withoutStatutory++;
	};

	const totals = emptyAcc();
	const byGroup = new Map<string, Acc>();
	const byRun = new Map<number, Acc>();
	for (const r of results) {
		add(totals, r);
		let run = byRun.get(r.payrollRunId);
		if (!run) byRun.set(r.payrollRunId, (run = emptyAcc()));
		add(run, r);
		if (groupBy === 'none') continue;
		const k = keyOf(r);
		let g = byGroup.get(k);
		if (!g) byGroup.set(k, (g = emptyAcc()));
		add(g, r);
	}

	// codes of the SNAPSHOT ids (id → code lookup only; the label is the snapshot name)
	const orgIds = idsFromKeys(byGroup.keys());
	const codes =
		groupBy === 'branch'
			? await prisma.branch.findMany({
					where: { id: { in: orgIds } },
					select: { id: true, code: true }
				})
			: groupBy === 'department'
				? await prisma.department.findMany({
						where: { id: { in: orgIds } },
						select: { id: true, code: true }
					})
				: [];
	const codeOf = new Map(codes.map((c) => [String(c.id), c.code]));

	const groups: ReportGroup<ReturnType<typeof present>>[] = [...byGroup.entries()]
		.map(([key, acc]) => {
			const run = groupBy === 'run' ? runLabel.get(key) : undefined;
			return {
				key,
				code: run ? run.period.code : (codeOf.get(key) ?? null),
				label: run
					? run.period.name
					: key === UNASSIGNED_KEY
						? UNASSIGNED_LABEL
						: (snapshotLabel.get(key) ?? key),
				metrics: present(acc)
			};
		})
		.sort((a, b) => (a.code ?? '~').localeCompare(b.code ?? '~'));

	return {
		generatedAt: new Date(),
		context: {
			companyId,
			payrollMonth,
			scheduleId: query.scheduleId ?? null,
			branchId: ctx.filter.branchId ?? null,
			departmentId: ctx.filter.departmentId ?? null,
			groupBy,
			currencyCode: runs[0]?.currencyCode ?? settings?.currencyCode ?? null,
			source: 'FINALIZED_PAYROLL_SNAPSHOT',
			availableMonths: availableMonths.map((m) => m.payrollMonth as string),
			unassignedMonthRuns
		},
		totals: present(totals),
		groups,
		runs: runs.map((r) => ({
			id: r.id,
			periodCode: r.period.code,
			periodName: r.period.name,
			periodStart: isoDate(r.period.startDate),
			periodEnd: isoDate(r.period.endDate),
			cycleNumber: r.cycleNumber,
			finalizedAt: r.finalizedAt,
			employeeCount: byRun.get(r.id)?.employees.size ?? 0
		}))
	};
}

/**
 * Dashboard payroll widget — OPERATIONAL counts only (no amount). The "ready" states mirror the run
 * service's finalize guards (CALCULATED; WORKFLOW runs need an APPROVED attempt) — finalize itself still
 * re-validates everything.
 */
export async function payrollOperational(companyId?: number) {
	const where = companyId ? { companyId } : {};
	const [groups, latestPeriod, month] = await Promise.all([
		prisma.payrollRun.groupBy({
			by: ['status', 'approvalModeSnapshot', 'approvalState'],
			where,
			_count: { _all: true }
		}),
		prisma.payrollPeriod.findFirst({
			where,
			orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
			select: {
				id: true,
				code: true,
				name: true,
				startDate: true,
				endDate: true,
				payrollMonth: true,
				run: { select: { id: true, status: true, approvalState: true } }
			}
		}),
		latestFinalizedMonth(companyId)
	]);
	const counts = {
		draft: 0,
		needsCalculation: 0,
		needsSubmission: 0,
		awaitingApproval: 0,
		readyToFinalize: 0,
		finalized: 0
	};
	for (const g of groups) {
		const n = g._count._all;
		if (g.status === 'DRAFT') {
			counts.draft += n;
			counts.needsCalculation += n;
		} else if (g.status === 'FINALIZED') counts.finalized += n;
		else if (g.approvalModeSnapshot === 'DIRECT' || g.approvalState === 'APPROVED') {
			counts.readyToFinalize += n;
		} else if (g.approvalState === 'PENDING') counts.awaitingApproval += n;
		else counts.needsSubmission += n;
	}
	const finalizedEmployees = month
		? (
				await prisma.payrollEmployeeResult.groupBy({
					by: ['employeeId'],
					where: { run: { ...where, status: 'FINALIZED', payrollMonth: month } }
				})
			).length
		: 0;
	return {
		latestPeriod: latestPeriod
			? {
					id: latestPeriod.id,
					code: latestPeriod.code,
					name: latestPeriod.name,
					startDate: isoDate(latestPeriod.startDate),
					endDate: isoDate(latestPeriod.endDate),
					payrollMonth: latestPeriod.payrollMonth,
					runId: latestPeriod.run?.id ?? null,
					runStatus: latestPeriod.run?.status ?? null,
					approvalState: latestPeriod.run?.approvalState ?? null
				}
			: null,
		runs: counts,
		latestFinalizedMonth: month,
		finalizedEmployees
	};
}

// ============================================================================================
// Phase 17B — DETAIL: one row per FINALIZED employee result (the summary's population)
// ============================================================================================

export interface PayrollDetailFilters {
	companyId?: number;
	branchId?: number;
	departmentId?: number;
	payrollMonth?: string;
	scheduleId?: number;
}

/**
 * The stored FINALIZED snapshot only: codes / names / branch / department are the result SNAPSHOTS and
 * every amount is the stored value (this cycle's PIT / SSO). No current employee, salary, statutory
 * profile (TIN / SSN) or bank data is read. Σ of the rows equals the summary totals.
 */
export async function payrollDetailRows(
	auth: AuthContext,
	q: PayrollDetailFilters,
	guard: (count: number) => void
) {
	const ctx = await resolveCompanyContext(auth, q);
	if (q.scheduleId) {
		const schedule = await prisma.payrollSchedule.findFirst({
			where: { id: q.scheduleId, companyId: ctx.companyId },
			select: { id: true }
		});
		if (!schedule) throw ReportErrors.filterInvalid('scheduleId');
	}
	const payrollMonth = q.payrollMonth ?? (await latestFinalizedMonth(ctx.companyId));
	const runs = await finalizedRuns(ctx.companyId, payrollMonth, q.scheduleId);
	const where = snapshotResultWhere(runs, ctx.filter);
	guard(runs.length ? await prisma.payrollEmployeeResult.count({ where }) : 0);
	const results = runs.length
		? await prisma.payrollEmployeeResult.findMany({
				where,
				select: {
					payrollRunId: true,
					employeeCodeSnapshot: true,
					employeeNameSnapshot: true,
					branchNameSnapshot: true,
					departmentNameSnapshot: true,
					currencyCode: true,
					totalEarnings: true,
					totalDeductions: true,
					netPay: true,
					statutoryResult: {
						select: {
							pitCurrentCycle: true,
							employeeSsoCurrentCycle: true,
							employerSsoCurrentCycle: true
						}
					}
				}
			})
		: [];
	const runOf = new Map(runs.map((r) => [r.id, r]));
	return {
		context: {
			companyId: ctx.companyId,
			payrollMonth,
			scheduleId: q.scheduleId ?? null,
			branchId: ctx.filter.branchId ?? null,
			departmentId: ctx.filter.departmentId ?? null,
			currencyCode: runs[0]?.currencyCode ?? null,
			source: 'FINALIZED_PAYROLL_SNAPSHOT'
		},
		rows: results.map((r) => {
			const run = runOf.get(r.payrollRunId)!;
			const s = r.statutoryResult;
			return {
				payrollMonth: run.payrollMonth,
				periodCode: run.period.code,
				runNumber: run.cycleNumber ?? 1,
				employeeCode: r.employeeCodeSnapshot,
				employeeName: r.employeeNameSnapshot,
				branch: r.branchNameSnapshot,
				department: r.departmentNameSnapshot,
				grossEarnings: moneyText(r.totalEarnings),
				totalDeductions: moneyText(r.totalDeductions),
				pit: moneyText(s?.pitCurrentCycle ?? ZERO),
				employeeSso: moneyText(s?.employeeSsoCurrentCycle ?? ZERO),
				employerSso: moneyText(s?.employerSsoCurrentCycle ?? ZERO),
				netPay: moneyText(r.netPay),
				currencyCode: r.currencyCode
			};
		})
	};
}
