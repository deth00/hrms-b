import type { OvertimeRequestStatus, OvertimeType } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { idRef } from '../../lib/idFormat.js';
import { serverNow } from '../../lib/clock.js';
import type { AuthContext } from '../../types/express.js';
import type { OvertimeReportQuery } from '../../validation/reporting.schema.js';
import { presentOvertimeFigures } from '../overtimeCalculation.service.js';
import { resolveReportingContext } from './reportingScope.service.js';
import {
	REPORT_TIMEZONE,
	UNASSIGNED_KEY,
	UNASSIGNED_LABEL,
	isoDate,
	parseGroupBy,
	personLabel,
	resolveRange,
	type ReportGroup,
	groupKey,
	idsFromKeys
} from './reportingCommon.js';

/**
 * Phase 17A — OVERTIME analytics (read only, OT domain data only).
 *
 *   requests / approved / pending / rejected / cancelled — OvertimeRequests whose WORK DATE is in range
 *   eligibleMinutes — Σ of the OT domain's own eligible minutes (`presentOvertimeFigures`: the overlap of
 *       effective attendance with the APPROVED window, recalculated after corrections) for APPROVED requests.
 *       Never derived from raw punches; rejected / cancelled / pending requests contribute 0.
 *   approvedPlannedMinutes — Σ plannedMinutes of APPROVED requests (what was approved, before attendance)
 *   awaitingAttendance — APPROVED requests whose eligible minutes are not known yet (no attendance)
 * Durations are integer minutes. Grouping uses the CURRENT branch / department.
 */
export const OVERTIME_MAX_DAYS = 366;
export const OVERTIME_GROUP_BY = ['none', 'type', 'branch', 'department', 'employee'] as const;

interface Acc {
	requests: number;
	approved: number;
	pending: number;
	rejected: number;
	cancelled: number;
	eligibleMinutes: number;
	approvedPlannedMinutes: number;
	awaitingAttendance: number;
}
const emptyAcc = (): Acc => ({
	requests: 0,
	approved: 0,
	pending: 0,
	rejected: 0,
	cancelled: 0,
	eligibleMinutes: 0,
	approvedPlannedMinutes: 0,
	awaitingAttendance: 0
});
const STATUS_FIELD: Record<
	OvertimeRequestStatus,
	'approved' | 'pending' | 'rejected' | 'cancelled'
> = {
	APPROVED: 'approved',
	PENDING: 'pending',
	REJECTED: 'rejected',
	CANCELLED: 'cancelled'
};
export const OVERTIME_TYPE_LABEL: Record<OvertimeType, string> = {
	BEFORE_SHIFT: 'OT ກ່ອນກະ',
	AFTER_SHIFT: 'OT ຫຼັງກະ',
	OFF_DAY: 'ເຮັດວຽກມື້ພັກ',
	HOLIDAY: 'ເຮັດວຽກວັນພັກ'
};

function add(
	acc: Acc,
	r: { status: OvertimeRequestStatus; plannedMinutes: number },
	eligible: number | null
) {
	acc.requests++;
	acc[STATUS_FIELD[r.status]]++;
	if (r.status === 'APPROVED') {
		acc.approvedPlannedMinutes += r.plannedMinutes;
		if (eligible === null) acc.awaitingAttendance++;
		else acc.eligibleMinutes += eligible;
	}
}

/** GET /reports/overtime/summary */
export async function getOvertimeSummary(auth: AuthContext, query: OvertimeReportQuery) {
	const range = resolveRange(query, { maxDays: OVERTIME_MAX_DAYS, allowFuture: true });
	const groupBy = parseGroupBy(query.groupBy, OVERTIME_GROUP_BY, 'department');
	const ctx = await resolveReportingContext(auth, query);
	const rows = await prisma.overtimeRequest.findMany({
		where: { employee: ctx.employeeWhere, workDate: { gte: range.from, lte: range.to } },
		select: {
			status: true,
			type: true,
			plannedMinutes: true,
			requestedStartAt: true,
			requestedEndAt: true,
			actualMinutes: true,
			eligibleMinutes: true,
			calculationStatus: true,
			employee: {
				select: {
					id: true,
					employeeCode: true,
					firstNameLao: true,
					lastNameLao: true,
					branchId: true,
					departmentId: true
				}
			}
		}
	});
	const now = serverNow();
	const totals = emptyAcc();
	const groups = new Map<string, Acc>();
	const employees = new Map<string, (typeof rows)[number]['employee']>();
	for (const r of rows) {
		const eligible = presentOvertimeFigures(r, now).eligibleMinutes;
		add(totals, r, eligible);
		if (groupBy === 'none') continue;
		employees.set(String(r.employee.id), r.employee);
		const key =
			groupBy === 'type'
				? r.type
				: groupBy === 'branch'
					? groupKey(r.employee.branchId)
					: groupBy === 'department'
						? groupKey(r.employee.departmentId)
						: groupKey(r.employee.id);
		let g = groups.get(key);
		if (!g) groups.set(key, (g = emptyAcc()));
		add(g, r, eligible);
	}

	const ids = [...groups.keys()].filter((k) => k !== UNASSIGNED_KEY);
	const select = { id: true, code: true, nameLao: true } as const;
	const labels = new Map<string, { code: string | null; label: string }>();
	if (groupBy === 'type') {
		for (const k of ids) labels.set(k, { code: k, label: OVERTIME_TYPE_LABEL[k as OvertimeType] });
	} else if (groupBy === 'employee') {
		for (const [id, e] of employees)
			labels.set(id, { code: e.employeeCode, label: personLabel(e) });
	} else if (groupBy !== 'none') {
		const org =
			groupBy === 'branch'
				? await prisma.branch.findMany({ where: { id: { in: idsFromKeys(ids) } }, select })
				: await prisma.department.findMany({ where: { id: { in: idsFromKeys(ids) } }, select });
		for (const o of org) labels.set(String(o.id), { code: o.code, label: o.nameLao });
	}
	const out: ReportGroup<Acc>[] = [...groups.entries()]
		.map(([key, metrics]) => ({
			key,
			code: labels.get(key)?.code ?? null,
			label: labels.get(key)?.label ?? UNASSIGNED_LABEL,
			metrics
		}))
		.sort(
			(a, b) =>
				b.metrics.eligibleMinutes - a.metrics.eligibleMinutes ||
				b.metrics.requests - a.metrics.requests
		);

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
			scope: ctx.scope.all ? 'ALL' : 'TEAM'
		},
		totals,
		groups: out
	};
}

// ============================================================================================
// Phase 17B — DETAIL: one row per OT request (the summary's population)
// ============================================================================================

export interface OvertimeDetailFilters {
	companyId?: number;
	branchId?: number;
	departmentId?: number;
	employeeId?: number;
	from?: Date;
	to?: Date;
	status?: OvertimeRequestStatus;
}

/**
 * Requests whose work date is in range (same where-clause as the summary). eligibleMinutes comes from the
 * OT domain (`presentOvertimeFigures`) for APPROVED requests only (null otherwise) — never from punches.
 * The free-text reason and review notes are never selected.
 */
export async function overtimeDetailRows(
	auth: AuthContext,
	q: OvertimeDetailFilters,
	guard: (count: number) => void
) {
	const range = resolveRange(q, { maxDays: OVERTIME_MAX_DAYS, allowFuture: true });
	const ctx = await resolveReportingContext(auth, q);
	const where = {
		employee: ctx.employeeWhere,
		workDate: { gte: range.from, lte: range.to },
		...(q.status ? { status: q.status } : {})
	};
	guard(await prisma.overtimeRequest.count({ where }));
	const name = { select: { nameLao: true } } as const;
	const rows = await prisma.overtimeRequest.findMany({
		where,
		select: {
			id: true,
			status: true,
			type: true,
			workDate: true,
			plannedMinutes: true,
			requestedStartAt: true,
			requestedEndAt: true,
			actualMinutes: true,
			eligibleMinutes: true,
			calculationStatus: true,
			createdAt: true,
			employee: {
				select: {
					employeeCode: true,
					firstNameLao: true,
					lastNameLao: true,
					branch: name,
					department: name
				}
			}
		}
	});
	const now = serverNow();
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
		rows: rows.map((r) => ({
			requestRef: `OT-${idRef(r.id)}`,
			employeeCode: r.employee.employeeCode,
			employeeName: personLabel(r.employee),
			branch: r.employee.branch?.nameLao ?? null,
			department: r.employee.department?.nameLao ?? null,
			workDate: isoDate(r.workDate),
			type: r.type as string,
			plannedMinutes: r.plannedMinutes,
			eligibleMinutes:
				r.status === 'APPROVED' ? presentOvertimeFigures(r, now).eligibleMinutes : null,
			status: r.status as string,
			submittedAt: r.createdAt.toISOString()
		}))
	};
}
