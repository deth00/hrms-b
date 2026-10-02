import type { ApprovalTargetType, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { formatDateOnly } from '../lib/dates.js';
import {
	AuditAction,
	AuditEntity,
	writeAuditEvent,
	type AuditActionCode,
	type AuditEntityType
} from './audit.service.js';
import {
	createNotifications,
	NotificationType,
	type NewNotification
} from './notification.service.js';

/**
 * Audit + notification side effects of the approval engine. Everything here takes the engine's own
 * transaction client, so the events/notifications commit (or roll back) together with the state
 * transition that caused them. It is the ONE place that knows the audit action codes and the Lao
 * notification wording; the engine only says "this happened".
 *
 * Privacy: audit metadata carries ids / dates / totals / status only; notification bodies never
 * contain leave reasons, medical details, correction reasons or rejection notes.
 */
type Db = Prisma.TransactionClient | typeof prisma;

interface TargetMeta {
	entity: AuditEntityType;
	requested: AuditActionCode;
	stepApproved: AuditActionCode;
	approved: AuditActionCode;
	rejected: AuditActionCode;
	cancelled: AuditActionCode;
	labelLao: string;
	/** the REQUESTER's own page (never an admin-only screen) */
	requesterLink: (targetId: number) => string;
	/** where an APPROVER is sent (default: the generic approval detail) */
	approverLink?: (instanceId: number, targetId: number) => string;
}

const TARGETS: Record<ApprovalTargetType, TargetMeta> = {
	LEAVE: {
		entity: AuditEntity.LEAVE_REQUEST,
		requested: AuditAction.LEAVE_REQUESTED,
		stepApproved: AuditAction.LEAVE_STEP_APPROVED,
		approved: AuditAction.LEAVE_APPROVED,
		rejected: AuditAction.LEAVE_REJECTED,
		cancelled: AuditAction.LEAVE_CANCELLED,
		labelLao: 'ການລາ',
		requesterLink: (id) => `/app/my-leave?focus=${id}`
	},
	OVERTIME: {
		entity: AuditEntity.OVERTIME_REQUEST,
		requested: AuditAction.OVERTIME_REQUESTED,
		stepApproved: AuditAction.OVERTIME_STEP_APPROVED,
		approved: AuditAction.OVERTIME_APPROVED,
		rejected: AuditAction.OVERTIME_REJECTED,
		cancelled: AuditAction.OVERTIME_CANCELLED,
		labelLao: 'ການເຮັດ OT',
		requesterLink: (id) => `/app/my-overtime?focus=${id}`
	},
	ATTENDANCE_CORRECTION: {
		entity: AuditEntity.ATTENDANCE_CORRECTION,
		requested: AuditAction.ATTENDANCE_CORRECTION_REQUESTED,
		stepApproved: AuditAction.ATTENDANCE_STEP_APPROVED,
		approved: AuditAction.ATTENDANCE_APPROVED,
		rejected: AuditAction.ATTENDANCE_REJECTED,
		cancelled: AuditAction.ATTENDANCE_CANCELLED,
		labelLao: 'ການແກ້ໄຂເວລາເຂົ້າ-ອອກວຽກ',
		requesterLink: (id) => `/app/my-attendance?focus=${id}`
	},
	// Phase 13 — requester and approvers both work on the (payroll-permission-gated) run page
	PAYROLL_RUN: {
		entity: AuditEntity.PAYROLL_RUN,
		requested: AuditAction.PAYROLL_RUN_SUBMITTED,
		stepApproved: AuditAction.PAYROLL_RUN_STEP_APPROVED,
		approved: AuditAction.PAYROLL_RUN_APPROVED,
		rejected: AuditAction.PAYROLL_RUN_REJECTED,
		cancelled: AuditAction.PAYROLL_RUN_APPROVAL_CANCELLED,
		labelLao: 'ຮອບເງິນເດືອນ',
		requesterLink: (id) => `/app/payroll/runs/${id}`,
		approverLink: (_instanceId, id) => `/app/payroll/runs/${id}`
	}
};

/** The subset of an ApprovalInstance the events need. */
export interface InstanceFacts {
	id: number;
	targetType: ApprovalTargetType;
	targetId: number;
	companyId: number;
	employeeId: number | null;
	requesterUserId: number;
	workflowId?: number | null;
	workflowVersion: number | null;
	attemptNo?: number;
}

/** Safe, non-textual facts about the target (ids / dates / totals) — read with the caller's client. */
async function targetFacts(db: Db, type: ApprovalTargetType, id: number) {
	switch (type) {
		case 'LEAVE': {
			const r = await db.leaveRequest.findUnique({
				where: { id },
				select: {
					startDate: true,
					endDate: true,
					totalDays: true,
					leaveType: { select: { code: true } }
				}
			});
			return r
				? {
						leaveTypeCode: r.leaveType.code,
						startDate: formatDateOnly(r.startDate),
						endDate: formatDateOnly(r.endDate),
						totalDays: r.totalDays.toNumber()
					}
				: {};
		}
		case 'OVERTIME': {
			const r = await db.overtimeRequest.findUnique({
				where: { id },
				select: { workDate: true, type: true, plannedMinutes: true }
			});
			return r
				? {
						workDate: formatDateOnly(r.workDate),
						overtimeType: r.type,
						plannedMinutes: r.plannedMinutes
					}
				: {};
		}
		case 'ATTENDANCE_CORRECTION': {
			const r = await db.attendanceCorrectionRequest.findUnique({
				where: { id },
				select: { workDate: true, type: true }
			});
			return r ? { workDate: formatDateOnly(r.workDate), correctionType: r.type } : {};
		}
		case 'PAYROLL_RUN': {
			// identifiers / versions only — NEVER gross, net, salary, PIT or SSO amounts
			const r = await db.payrollRun.findUnique({
				where: { id },
				select: { periodId: true, payrollMonth: true, cycleNumber: true, calculationVersion: true }
			});
			return r
				? {
						runId: id,
						periodId: r.periodId,
						payrollMonth: r.payrollMonth,
						cycleNumber: r.cycleNumber,
						calculationVersion: r.calculationVersion
					}
				: {};
		}
	}
}

const approvalMeta = (i: InstanceFacts, extra: Record<string, unknown> = {}) => ({
	approvalInstanceId: i.id,
	targetType: i.targetType,
	targetId: i.targetId,
	workflowVersion: i.workflowVersion,
	...(i.attemptNo !== undefined && (i.attemptNo !== 1 || i.targetType === 'PAYROLL_RUN')
		? { attemptNo: i.attemptNo }
		: {}),
	...extra
});

const approverLink = (i: { id: number; targetType: ApprovalTargetType; targetId: number }) =>
	TARGETS[i.targetType].approverLink?.(i.id, i.targetId) ?? `/app/approvals/${i.id}`;

/** Payroll notifications name the PERIOD only ("ຮອບເງິນເດືອນ {period}") — never an amount. */
async function payrollPeriodName(db: Db, runId: number) {
	const r = await db.payrollRun.findUnique({
		where: { id: runId },
		select: { period: { select: { name: true } } }
	});
	return r?.period.name ?? '';
}

async function employeeNameLao(db: Db, employeeId: number | null) {
	if (!employeeId) return '';
	const e = await db.employee.findUnique({
		where: { id: employeeId },
		select: { firstNameLao: true, lastNameLao: true }
	});
	return e ? `${e.firstNameLao} ${e.lastNameLao}`.trim() : '';
}

/** "Your action is required" for a set of candidates of ONE step (deduped per instance/step/user). */
async function actionRequired(
	db: Db,
	i: InstanceFacts,
	stepOrder: number,
	candidateUserIds: number[]
) {
	const meta = TARGETS[i.targetType];
	const payroll = i.targetType === 'PAYROLL_RUN';
	const name = payroll
		? await payrollPeriodName(db, i.targetId)
		: await employeeNameLao(db, i.employeeId);
	const attempt = payroll && i.attemptNo && i.attemptNo > 1 ? ` · ຄັ້ງທີ ${i.attemptNo}` : '';
	const notes: NewNotification[] = candidateUserIds.map((userId) => ({
		userId,
		type: NotificationType.APPROVAL_ACTION_REQUIRED,
		titleLao: payroll
			? `ຮອບເງິນເດືອນ ${name} ລໍຖ້າການອະນຸມັດ`
			: `ມີຄຳຂໍ${meta.labelLao}ລໍຖ້າການອະນຸມັດ`,
		bodyLao: payroll
			? `ຂັ້ນຕອນທີ ${stepOrder}${attempt}`
			: name
				? `ຄຳຂໍຂອງ ${name} — ຂັ້ນຕອນທີ ${stepOrder}`
				: `ຂັ້ນຕອນທີ ${stepOrder}`,
		link: approverLink(i),
		metadata: {
			approvalInstanceId: i.id,
			targetType: i.targetType,
			targetId: i.targetId,
			stepOrder
		},
		dedupeKey: `approval:${i.id}:step:${stepOrder}:candidate:${userId}`
	}));
	await createNotifications(db, notes);
}

// ============================================================================================
// lifecycle hooks (called by the engine inside its transaction)
// ============================================================================================

/** Submission. Only the candidates of the FIRST step are notified — later steps are still WAITING. */
export async function onInstanceCreated(
	db: Db,
	i: InstanceFacts,
	info: {
		totalSteps: number;
		firstStepOrder: number;
		firstStepCandidates: number[];
		audit: boolean;
	}
) {
	const meta = TARGETS[i.targetType];
	// a legacy backfill (audit: false) neither invents a "requested" event nor notifies anyone
	if (!info.audit) return;
	await writeAuditEvent(db, {
		action: meta.requested,
		actorUserId: i.requesterUserId,
		entityType: meta.entity,
		entityId: i.targetId,
		companyId: i.companyId,
		employeeId: i.employeeId,
		metadata: approvalMeta(i, {
			workflowId: i.workflowId ?? null,
			totalSteps: info.totalSteps,
			...(await targetFacts(db, i.targetType, i.targetId))
		})
	});
	await actionRequired(db, i, info.firstStepOrder, info.firstStepCandidates);
}

interface StepInfo {
	stepOrder: number;
	totalSteps: number;
}

async function stepAudit(
	db: Db,
	i: InstanceFacts,
	action: AuditActionCode,
	step: StepInfo,
	actorUserId: number,
	extra: Record<string, unknown> = {}
) {
	await writeAuditEvent(db, {
		action,
		actorUserId,
		entityType: AuditEntity.APPROVAL_INSTANCE,
		entityId: i.id,
		companyId: i.companyId,
		employeeId: i.employeeId,
		metadata: approvalMeta(i, { stepOrder: step.stepOrder, totalSteps: step.totalSteps, ...extra })
	});
}

/** An intermediate approval: the NEXT step opens and only ITS candidates are notified. */
export async function onStepAdvanced(
	db: Db,
	i: InstanceFacts,
	actorUserId: number,
	step: StepInfo & { nextStepOrder: number; nextCandidates: number[] }
) {
	const meta = TARGETS[i.targetType];
	await stepAudit(db, i, AuditAction.APPROVAL_STEP_APPROVED, step, actorUserId, {
		nextStepOrder: step.nextStepOrder
	});
	await writeAuditEvent(db, {
		action: meta.stepApproved,
		entityType: meta.entity,
		entityId: i.targetId,
		companyId: i.companyId,
		employeeId: i.employeeId,
		actorUserId,
		metadata: approvalMeta(i, { stepOrder: step.stepOrder, nextStepOrder: step.nextStepOrder })
	});
	await actionRequired(db, i, step.nextStepOrder, step.nextCandidates);
}

/** The LAST approval: the requester is told once. */
export async function onFinalApproved(
	db: Db,
	i: InstanceFacts,
	actorUserId: number,
	step: StepInfo
) {
	const meta = TARGETS[i.targetType];
	await stepAudit(db, i, AuditAction.APPROVAL_STEP_APPROVED, step, actorUserId, { final: true });
	await writeAuditEvent(db, {
		action: meta.approved,
		entityType: meta.entity,
		entityId: i.targetId,
		companyId: i.companyId,
		employeeId: i.employeeId,
		actorUserId,
		metadata: approvalMeta(i, {
			finalStepOrder: step.stepOrder,
			totalSteps: step.totalSteps,
			...(await targetFacts(db, i.targetType, i.targetId))
		})
	});
	await createNotifications(db, [
		{
			userId: i.requesterUserId,
			type: NotificationType.REQUEST_APPROVED,
			titleLao:
				i.targetType === 'PAYROLL_RUN'
					? `ຮອບເງິນເດືອນ ${await payrollPeriodName(db, i.targetId)} ໄດ້ຮັບການອະນຸມັດ`
					: `ຄຳຂໍ${meta.labelLao}ຂອງທ່ານໄດ້ຮັບການອະນຸມັດ`,
			bodyLao: null,
			link: meta.requesterLink(i.targetId),
			metadata: { approvalInstanceId: i.id, targetType: i.targetType, targetId: i.targetId },
			dedupeKey: `final:${i.id}:approved:${i.requesterUserId}`
		}
	]);
}

/** Any rejection ends the workflow; the requester is told, the rejection NOTE is not copied. */
export async function onRejected(db: Db, i: InstanceFacts, actorUserId: number, step: StepInfo) {
	const meta = TARGETS[i.targetType];
	await stepAudit(db, i, AuditAction.APPROVAL_STEP_REJECTED, step, actorUserId);
	await writeAuditEvent(db, {
		action: meta.rejected,
		entityType: meta.entity,
		entityId: i.targetId,
		companyId: i.companyId,
		employeeId: i.employeeId,
		actorUserId,
		metadata: approvalMeta(i, {
			rejectedAtStepOrder: step.stepOrder,
			totalSteps: step.totalSteps,
			...(await targetFacts(db, i.targetType, i.targetId))
		})
	});
	await createNotifications(db, [
		{
			userId: i.requesterUserId,
			type: NotificationType.REQUEST_REJECTED,
			titleLao:
				i.targetType === 'PAYROLL_RUN'
					? `ຮອບເງິນເດືອນ ${await payrollPeriodName(db, i.targetId)} ຖືກປະຕິເສດ`
					: `ຄຳຂໍ${meta.labelLao}ຂອງທ່ານຖືກປະຕິເສດ`,
			bodyLao: null,
			link: meta.requesterLink(i.targetId),
			metadata: { approvalInstanceId: i.id, targetType: i.targetType, targetId: i.targetId },
			dedupeKey: `final:${i.id}:rejected:${i.requesterUserId}`
		}
	]);
}

/**
 * Requester cancelled a PENDING request: the audit event is always written; the candidates of the
 * CURRENT step (not the WAITING ones, who were never told) are informed.
 */
export async function onCancelled(
	db: Db,
	type: ApprovalTargetType,
	targetId: number,
	instance: (InstanceFacts & { currentStepOrder: number | null }) | null,
	currentCandidates: number[],
	/** Phase 13 — an authorized payroll manager may cancel someone else's payroll submission */
	actorUserId?: number
) {
	const meta = TARGETS[type];
	await writeAuditEvent(db, {
		action: meta.cancelled,
		actorUserId: actorUserId ?? instance?.requesterUserId,
		entityType: meta.entity,
		entityId: targetId,
		companyId: instance?.companyId ?? null,
		employeeId: instance?.employeeId ?? null,
		metadata: instance
			? approvalMeta(instance, { cancelledAtStepOrder: instance.currentStepOrder })
			: { targetType: type, targetId }
	});
	if (!instance) return;
	const payroll = type === 'PAYROLL_RUN';
	const name = payroll ? '' : await employeeNameLao(db, instance.employeeId);
	const periodName = payroll ? await payrollPeriodName(db, targetId) : '';
	await createNotifications(
		db,
		currentCandidates
			.filter((userId) => userId !== instance.requesterUserId && userId !== actorUserId)
			.map((userId) => ({
				userId,
				type: NotificationType.REQUEST_CANCELLED,
				titleLao: payroll
					? `ການສົ່ງອະນຸມັດຮອບເງິນເດືອນ ${periodName} ຖືກຍົກເລີກ`
					: `ຄຳຂໍ${meta.labelLao}ຖືກຍົກເລີກ`,
				bodyLao: name ? `ຜູ້ຍື່ນ: ${name}` : null,
				link: approverLink(instance),
				metadata: { approvalInstanceId: instance.id, targetType: type, targetId },
				dedupeKey: `cancelled:${instance.id}:candidate:${userId}`
			}))
	);
}

/** Admin added a candidate to the current step: audit it and tell the newly assigned user. */
export async function onReassigned(
	db: Db,
	i: InstanceFacts,
	adminUserId: number,
	step: StepInfo,
	newUserId: number
) {
	await stepAudit(db, i, AuditAction.APPROVAL_STEP_REASSIGNED, step, adminUserId, {
		assignedUserId: newUserId
	});
	const meta = TARGETS[i.targetType];
	const name =
		i.targetType === 'PAYROLL_RUN'
			? await payrollPeriodName(db, i.targetId)
			: await employeeNameLao(db, i.employeeId);
	await createNotifications(db, [
		{
			userId: newUserId,
			type: NotificationType.APPROVAL_STEP_REASSIGNED,
			titleLao: `ທ່ານຖືກມອບໝາຍໃຫ້ອະນຸມັດ${meta.labelLao}`,
			bodyLao: name
				? `ຄຳຂໍຂອງ ${name} — ຂັ້ນຕອນທີ ${step.stepOrder}`
				: `ຂັ້ນຕອນທີ ${step.stepOrder}`,
			link: approverLink(i),
			metadata: {
				approvalInstanceId: i.id,
				targetType: i.targetType,
				targetId: i.targetId,
				stepOrder: step.stepOrder,
				assignedByUserId: adminUserId
			},
			dedupeKey: `reassigned:${i.id}:step:${step.stepOrder}:candidate:${newUserId}`
		}
	]);
}
