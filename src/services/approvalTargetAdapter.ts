import type { ApprovalTargetType, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { REVIEW_PERMISSION } from '../lib/approvalTargets.js';
import { finalizeLeaveApproval, finalizeLeaveRejection, getLeaveRequest } from './leave.service.js';
import {
	finalizeOvertimeApproval,
	finalizeOvertimeRejection,
	getOvertimeRequest
} from './overtime.service.js';
import {
	finalizeCorrectionApproval,
	finalizeCorrectionRejection,
	getCorrection
} from './attendanceCorrection.service.js';
import {
	finalizePayrollApproval,
	finalizePayrollRejection,
	payrollRunSummaries
} from './payrollApproval.service.js';

/**
 * The seam between the GENERIC approval engine and each domain. The engine knows only "a step was
 * approved / the last step was approved / someone rejected"; everything that HAPPENS — leave
 * balance validation, OT recalculation, correction overlays — lives in the domain finalizers
 * called here, inside the engine's transaction. The engine never edits domain tables directly.
 */
export interface TargetSummary {
	targetId: number;
	/** null for company-wide targets (PAYROLL_RUN) */
	employeeId: number | null;
	companyId: number;
	status: string;
	/** short display title (e.g. the leave type name) */
	title: string;
	/** structured fields the UI formats per target type */
	details: Record<string, unknown>;
}

interface TargetAdapter {
	reviewPermission: string;
	summaries(ids: number[]): Promise<Map<number, TargetSummary>>;
	finalizeApproval(
		tx: Prisma.TransactionClient,
		id: number,
		actorUserId: number,
		note?: string
	): Promise<void>;
	finalizeRejection(
		tx: Prisma.TransactionClient,
		id: number,
		actorUserId: number,
		note: string
	): Promise<void>;
	/** the rich domain review context (balances, warnings, preview …) */
	context(id: number, viewerUserId: number): Promise<unknown>;
}

const ALL = { all: true } as const;

const leaveAdapter: TargetAdapter = {
	reviewPermission: REVIEW_PERMISSION.LEAVE,
	async summaries(ids) {
		const rows = await prisma.leaveRequest.findMany({
			where: { id: { in: ids } },
			select: {
				id: true,
				status: true,
				employeeId: true,
				startDate: true,
				endDate: true,
				totalDays: true,
				reason: true,
				employee: { select: { companyId: true } },
				leaveType: { select: { code: true, nameLao: true, isPaid: true } }
			}
		});
		return new Map(
			rows.map((r) => [
				r.id,
				{
					targetId: r.id,
					employeeId: r.employeeId,
					companyId: r.employee.companyId,
					status: r.status,
					title: r.leaveType.nameLao,
					details: {
						leaveTypeCode: r.leaveType.code,
						leaveTypeName: r.leaveType.nameLao,
						isPaid: r.leaveType.isPaid,
						startDate: r.startDate,
						endDate: r.endDate,
						totalDays: r.totalDays.toNumber(),
						reason: r.reason
					}
				}
			])
		);
	},
	async finalizeApproval(tx, id, actorUserId, note) {
		await finalizeLeaveApproval(tx, id, actorUserId, note);
	},
	async finalizeRejection(tx, id, actorUserId, note) {
		await finalizeLeaveRejection(tx, id, actorUserId, note);
	},
	context: (id, viewerUserId) => getLeaveRequest(id, ALL, viewerUserId)
};

const overtimeAdapter: TargetAdapter = {
	reviewPermission: REVIEW_PERMISSION.OVERTIME,
	async summaries(ids) {
		const rows = await prisma.overtimeRequest.findMany({
			where: { id: { in: ids } },
			select: {
				id: true,
				status: true,
				employeeId: true,
				workDate: true,
				type: true,
				requestedStartAt: true,
				requestedEndAt: true,
				plannedMinutes: true,
				reason: true,
				employee: { select: { companyId: true } }
			}
		});
		return new Map(
			rows.map((r) => [
				r.id,
				{
					targetId: r.id,
					employeeId: r.employeeId,
					companyId: r.employee.companyId,
					status: r.status,
					title: r.type,
					details: {
						workDate: r.workDate,
						type: r.type,
						requestedStartAt: r.requestedStartAt,
						requestedEndAt: r.requestedEndAt,
						plannedMinutes: r.plannedMinutes,
						reason: r.reason
					}
				}
			])
		);
	},
	async finalizeApproval(tx, id, actorUserId, note) {
		await finalizeOvertimeApproval(tx, id, actorUserId, note);
	},
	async finalizeRejection(tx, id, actorUserId, note) {
		await finalizeOvertimeRejection(tx, id, actorUserId, note);
	},
	context: (id, viewerUserId) => getOvertimeRequest(id, ALL, viewerUserId)
};

const correctionAdapter: TargetAdapter = {
	reviewPermission: REVIEW_PERMISSION.ATTENDANCE_CORRECTION,
	async summaries(ids) {
		const rows = await prisma.attendanceCorrectionRequest.findMany({
			where: { id: { in: ids } },
			select: {
				id: true,
				status: true,
				employeeId: true,
				workDate: true,
				type: true,
				requestedCheckInAt: true,
				requestedCheckOutAt: true,
				reason: true,
				employee: { select: { companyId: true } }
			}
		});
		return new Map(
			rows.map((r) => [
				r.id,
				{
					targetId: r.id,
					employeeId: r.employeeId,
					companyId: r.employee.companyId,
					status: r.status,
					title: r.type,
					details: {
						workDate: r.workDate,
						type: r.type,
						requestedCheckInAt: r.requestedCheckInAt,
						requestedCheckOutAt: r.requestedCheckOutAt,
						reason: r.reason
					}
				}
			])
		);
	},
	async finalizeApproval(tx, id, actorUserId, note) {
		await finalizeCorrectionApproval(tx, id, actorUserId, note);
	},
	async finalizeRejection(tx, id, actorUserId, note) {
		await finalizeCorrectionRejection(tx, id, actorUserId, note);
	},
	context: (id, viewerUserId) => getCorrection(id, ALL, { userId: viewerUserId })
};

/**
 * Phase 13 — a whole payroll run. The summary is identification only (period, month, cycle, company,
 * submitter): the general Approvals screens NEVER carry payroll money. Reviewers open the payroll run page
 * (payroll-permission gated) to see the figures.
 */
const payrollRunAdapter: TargetAdapter = {
	reviewPermission: REVIEW_PERMISSION.PAYROLL_RUN,
	async summaries(ids) {
		const rows = await payrollRunSummaries(ids);
		return new Map(
			rows.map((r) => [
				r.id,
				{
					targetId: r.id,
					employeeId: null,
					companyId: r.companyId,
					status: r.approvalState,
					title: r.period.name,
					details: {
						periodCode: r.period.code,
						periodName: r.period.name,
						periodStart: r.period.startDate,
						periodEnd: r.period.endDate,
						payrollMonth: r.payrollMonth ?? r.period.payrollMonth,
						cycleNumber: r.cycleNumber,
						companyName: r.company.nameLao,
						submittedBy: r.submittedBy,
						submittedAt: r.submittedAt,
						runStatus: r.status
					}
				}
			])
		);
	},
	async finalizeApproval(tx, id, actorUserId) {
		await finalizePayrollApproval(tx, id, actorUserId);
	},
	async finalizeRejection(tx, id) {
		await finalizePayrollRejection(tx, id);
	},
	// no money in the generic detail: it only points at the authorized payroll run page
	context: async (id) => ({ runId: id, link: `/app/payroll/runs/${id}` })
};

const ADAPTERS: Record<ApprovalTargetType, TargetAdapter> = {
	LEAVE: leaveAdapter,
	OVERTIME: overtimeAdapter,
	ATTENDANCE_CORRECTION: correctionAdapter,
	PAYROLL_RUN: payrollRunAdapter
};

export const adapterFor = (type: ApprovalTargetType) => ADAPTERS[type];

export const getTargetSummary = async (type: ApprovalTargetType, id: number) =>
	(await ADAPTERS[type].summaries([id])).get(id) ?? null;
export const getTargetSummaries = (type: ApprovalTargetType, ids: number[]) =>
	ADAPTERS[type].summaries(ids);
export const finalizeApproval = (
	type: ApprovalTargetType,
	tx: Prisma.TransactionClient,
	id: number,
	actorUserId: number,
	note?: string
) => ADAPTERS[type].finalizeApproval(tx, id, actorUserId, note);
export const finalizeRejection = (
	type: ApprovalTargetType,
	tx: Prisma.TransactionClient,
	id: number,
	actorUserId: number,
	note: string
) => ADAPTERS[type].finalizeRejection(tx, id, actorUserId, note);
export const getTargetContext = (type: ApprovalTargetType, id: number, viewerUserId: number) =>
	ADAPTERS[type].context(id, viewerUserId);
