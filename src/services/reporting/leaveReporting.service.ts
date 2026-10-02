import { Prisma, type LeaveRequestStatus } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { idRef } from '../../lib/idFormat.js';
import type { AuthContext } from '../../types/express.js';
import type { LeaveReportQuery } from '../../validation/reporting.schema.js';
import { computeBalances, yearEnd, yearStart } from '../leaveBalance.service.js';
import { resolveReportingContext } from './reportingScope.service.js';
import {
	REPORT_TIMEZONE,
	UNASSIGNED_LABEL,
	dayText,
	isoDate,
	parseGroupBy,
	personLabel,
	resolveRange,
	type ReportGroup,
	groupKey,
	idsFromKeys
} from './reportingCommon.js';

/**
 * Phase 17A — LEAVE analytics (read only, Leave domain data only).
 *
 *   requests / approved / pending / rejected / cancelled — LeaveRequests whose [startDate, endDate]
 *       OVERLAPS the range, counted by their CURRENT status
 *   approvedDays — Σ dayValue of the charged LeaveRequestDay rows of APPROVED requests whose leaveDate
 *       lies INSIDE the range (the schedule-derived working days; holidays / off-days were never charged).
 *       Requested days of pending / rejected / cancelled requests are NEVER counted as usage.
 *   balances (only with leave_balances.view) — the Leave module's own `computeBalances` per
 *       (employee, balance-type leave type, year): allocated = entitlement + carried forward + adjustments,
 *       used = approved days, reserved = pending days, available = allocated − used. Nothing is recalculated
 *       from policy here.
 * Day values are Decimal and travel as fixed-2 strings. Grouping uses the CURRENT branch / department.
 */
export const LEAVE_MAX_DAYS = 366;
export const LEAVE_GROUP_BY = ['none', 'leaveType', 'branch', 'department', 'employee'] as const;
type LeaveGroupBy = (typeof LEAVE_GROUP_BY)[number];

const D = Prisma.Decimal;
const ZERO = new D(0);

interface Acc {
	requests: number;
	approved: number;
	pending: number;
	rejected: number;
	cancelled: number;
	approvedDays: Prisma.Decimal;
}
const emptyAcc = (): Acc => ({
	requests: 0,
	approved: 0,
	pending: 0,
	rejected: 0,
	cancelled: 0,
	approvedDays: ZERO
});
const STATUS_FIELD: Record<LeaveRequestStatus, 'approved' | 'pending' | 'rejected' | 'cancelled'> =
	{
		APPROVED: 'approved',
		PENDING: 'pending',
		REJECTED: 'rejected',
		CANCELLED: 'cancelled'
	};
const present = (a: Acc) => ({ ...a, approvedDays: dayText(a.approvedDays) });

const EMP = {
	select: {
		id: true,
		employeeCode: true,
		firstNameLao: true,
		lastNameLao: true,
		branchId: true,
		departmentId: true
	}
} as const;

/** GET /reports/leave/summary */
export async function getLeaveSummary(auth: AuthContext, query: LeaveReportQuery) {
	const range = resolveRange(query, { maxDays: LEAVE_MAX_DAYS, allowFuture: true });
	const groupBy = parseGroupBy(query.groupBy, LEAVE_GROUP_BY, 'leaveType');
	const ctx = await resolveReportingContext(auth, query);
	const typeFilter = query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {};

	const [requests, days] = await Promise.all([
		prisma.leaveRequest.findMany({
			where: {
				employee: ctx.employeeWhere,
				...typeFilter,
				startDate: { lte: range.to },
				endDate: { gte: range.from }
			},
			select: { status: true, leaveTypeId: true, employee: EMP }
		}),
		prisma.leaveRequestDay.findMany({
			where: {
				employee: ctx.employeeWhere,
				leaveDate: { gte: range.from, lte: range.to },
				leaveRequest: { status: 'APPROVED', ...typeFilter }
			},
			select: { dayValue: true, leaveRequest: { select: { leaveTypeId: true } }, employee: EMP }
		})
	]);

	type Emp = (typeof requests)[number]['employee'];
	const keyOf = (leaveTypeId: number, e: Emp): string =>
		groupBy === 'leaveType'
			? groupKey(leaveTypeId)
			: groupBy === 'branch'
				? groupKey(e.branchId)
				: groupBy === 'department'
					? groupKey(e.departmentId)
					: groupKey(e.id);

	const totals = emptyAcc();
	const groups = new Map<string, Acc>();
	const bucket = (k: string) => {
		let g = groups.get(k);
		if (!g) groups.set(k, (g = emptyAcc()));
		return g;
	};
	const employees = new Map<string, Emp>();
	for (const r of requests) {
		totals.requests++;
		totals[STATUS_FIELD[r.status]]++;
		employees.set(String(r.employee.id), r.employee);
		if (groupBy !== 'none') {
			const g = bucket(keyOf(r.leaveTypeId, r.employee));
			g.requests++;
			g[STATUS_FIELD[r.status]]++;
		}
	}
	for (const d of days) {
		totals.approvedDays = totals.approvedDays.plus(d.dayValue);
		employees.set(String(d.employee.id), d.employee);
		if (groupBy !== 'none') {
			const g = bucket(keyOf(d.leaveRequest.leaveTypeId, d.employee));
			g.approvedDays = g.approvedDays.plus(d.dayValue);
		}
	}

	const labels = await labelsFor(groupBy, [...groups.keys()], employees);
	const out: ReportGroup<ReturnType<typeof present>>[] = [...groups.entries()]
		.map(([key, acc]) => ({
			key,
			code: labels.get(key)?.code ?? null,
			label: labels.get(key)?.label ?? UNASSIGNED_LABEL,
			metrics: present(acc)
		}))
		.sort((a, b) => b.metrics.requests - a.metrics.requests || a.label.localeCompare(b.label));

	const balanceYear = range.to.getUTCFullYear();
	const balances = auth.permissions.includes('leave_balances.view')
		? await balanceTotals(ctx.employeeWhere, balanceYear, query.leaveTypeId)
		: null;

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
			leaveTypeId: query.leaveTypeId ?? null,
			groupBy,
			scope: ctx.scope.all ? 'ALL' : 'TEAM'
		},
		totals: present(totals),
		groups: out,
		balances
	};
}

async function labelsFor(
	groupBy: LeaveGroupBy,
	keys: string[],
	employees: Map<string, { employeeCode: string; firstNameLao: string; lastNameLao: string }>
) {
	const select = { id: true, code: true, nameLao: true } as const;
	const where = { id: { in: idsFromKeys(keys) } };
	if (groupBy === 'employee') {
		return new Map(
			[...employees.entries()].map(([id, e]) => [
				id,
				{ code: e.employeeCode, label: personLabel(e) }
			])
		);
	}
	const rows =
		groupBy === 'leaveType'
			? await prisma.leaveType.findMany({ where, select })
			: groupBy === 'branch'
				? await prisma.branch.findMany({ where, select })
				: groupBy === 'department'
					? await prisma.department.findMany({ where, select })
					: [];
	return new Map(rows.map((r) => [String(r.id), { code: r.code, label: r.nameLao }]));
}

/**
 * Balance totals per leave type for the employees in scope employed during `year`, over the leave
 * types of their company that track a balance. Reuses the Leave module's `computeBalances`.
 */
async function balanceTotals(
	employeeWhere: Prisma.EmployeeWhereInput,
	year: number,
	leaveTypeId: number | undefined
) {
	const employees = await prisma.employee.findMany({
		where: {
			AND: [
				employeeWhere,
				{ startDate: { lte: yearEnd(year) } },
				{ OR: [{ endDate: null }, { endDate: { gte: yearStart(year) } }] }
			]
		},
		select: { id: true, companyId: true }
	});
	const types = await prisma.leaveType.findMany({
		where: {
			companyId: { in: [...new Set(employees.map((e) => e.companyId))] },
			requiresBalance: true,
			...(leaveTypeId ? { id: leaveTypeId } : {})
		},
		select: { id: true, code: true, nameLao: true, companyId: true },
		orderBy: { code: 'asc' }
	});
	const pairs = employees.flatMap((e) =>
		types
			.filter((t) => t.companyId === e.companyId)
			.map((t) => ({ employeeId: e.id, leaveTypeId: t.id, year }))
	);
	const calc = await computeBalances(pairs);
	const byType = new Map(
		types.map((t) => [
			t.id,
			{ allocated: ZERO, used: ZERO, reserved: ZERO, available: ZERO, employees: 0 }
		])
	);
	for (const b of calc.values()) {
		const t = byType.get(b.leaveTypeId);
		if (!t) continue;
		t.allocated = t.allocated.plus(b.base);
		t.used = t.used.plus(b.used);
		t.reserved = t.reserved.plus(b.pending);
		t.available = t.available.plus(b.available);
		t.employees++;
	}
	return {
		year,
		items: types.map((t) => {
			const v = byType.get(t.id)!;
			return {
				leaveTypeId: t.id,
				code: t.code,
				label: t.nameLao,
				employees: v.employees,
				allocated: dayText(v.allocated),
				used: dayText(v.used),
				reserved: dayText(v.reserved),
				available: dayText(v.available)
			};
		})
	};
}

// ============================================================================================
// Phase 17B — DETAIL: one row per leave request (the summary's population)
// ============================================================================================

export interface LeaveDetailFilters {
	companyId?: number;
	branchId?: number;
	departmentId?: number;
	employeeId?: number;
	leaveTypeId?: number;
	from?: Date;
	to?: Date;
	status?: LeaveRequestStatus;
}

/**
 * Requests overlapping the range (same where-clause as the summary). approvedDays = Σ dayValue of the
 * request's charged days INSIDE the range, and only for APPROVED requests — so Σ approvedDays over the
 * rows equals the summary. The free-text reason and review notes are never selected.
 */
export async function leaveDetailRows(
	auth: AuthContext,
	q: LeaveDetailFilters,
	guard: (count: number) => void
) {
	const range = resolveRange(q, { maxDays: LEAVE_MAX_DAYS, allowFuture: true });
	const ctx = await resolveReportingContext(auth, q);
	const where: Prisma.LeaveRequestWhereInput = {
		employee: ctx.employeeWhere,
		...(q.leaveTypeId ? { leaveTypeId: q.leaveTypeId } : {}),
		...(q.status ? { status: q.status } : {}),
		startDate: { lte: range.to },
		endDate: { gte: range.from }
	};
	guard(await prisma.leaveRequest.count({ where }));
	const name = { select: { nameLao: true } } as const;
	const requests = await prisma.leaveRequest.findMany({
		where,
		select: {
			id: true,
			status: true,
			startDate: true,
			endDate: true,
			totalDays: true,
			createdAt: true,
			leaveType: { select: { code: true, nameLao: true } },
			employee: {
				select: {
					employeeCode: true,
					firstNameLao: true,
					lastNameLao: true,
					branch: name,
					department: name
				}
			},
			days: {
				where: { leaveDate: { gte: range.from, lte: range.to } },
				select: { dayValue: true }
			}
		}
	});
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
			leaveTypeId: q.leaveTypeId ?? null,
			status: q.status ?? null,
			scope: ctx.scope.all ? 'ALL' : 'TEAM'
		},
		rows: requests.map((r) => ({
			requestRef: `LV-${idRef(r.id)}`,
			employeeCode: r.employee.employeeCode,
			employeeName: personLabel(r.employee),
			branch: r.employee.branch?.nameLao ?? null,
			department: r.employee.department?.nameLao ?? null,
			leaveType: r.leaveType.nameLao,
			startDate: isoDate(r.startDate),
			endDate: isoDate(r.endDate),
			requestedDays: dayText(r.totalDays),
			approvedDays: dayText(
				r.status === 'APPROVED' ? r.days.reduce((s, d) => s.plus(d.dayValue), ZERO) : ZERO
			),
			status: r.status as string,
			submittedAt: r.createdAt.toISOString()
		}))
	};
}
