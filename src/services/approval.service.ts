import { Prisma } from '@prisma/client';
import type { ApprovalTargetType } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { isInScope, resolveEmployeeScope } from '../lib/employeeScope.js';
import {
	APPROVAL_TARGET_TYPES,
	REQUIRED_SCOPE_PERMISSIONS,
	REVIEW_PERMISSION,
	VIEW_PERMISSIONS
} from '../lib/approvalTargets.js';
import type { AuthContext } from '../types/express.js';
import {
	createApprovalInstance,
	getLatestApprovalInstance,
	userQualifiesAsApprover
} from './approvalInstance.service.js';
import {
	finalizeApproval,
	finalizeRejection,
	getTargetContext,
	getTargetSummaries,
	getTargetSummary
} from './approvalTargetAdapter.js';
import { onFinalApproved, onRejected, onReassigned, onStepAdvanced } from './approvalEvents.js';
import type { HistoryQuery, InboxQuery } from '../validation/approval.schema.js';

/**
 * The generic approval ENGINE — sequential steps, one PENDING step at a time.
 *
 *  - WHO may act:   a candidate of the CURRENT step (snapshotted at submission) who is still ACTIVE
 *                   and still holds the domain review permission. Data scope was verified when the
 *                   candidates were snapshotted; it is deliberately NOT re-evaluated per action, so a
 *                   later change of manager structure never silently swaps the approvers of a request
 *                   that is already in flight. (A user who lost the review permission is denied.)
 *  - WHAT happens:  intermediate approval advances to the next step and leaves the domain request
 *                   PENDING; the LAST approval and any rejection call the domain finalizer through the
 *                   target adapter INSIDE the same transaction. If the domain refuses (insufficient
 *                   balance, conflicts …) everything rolls back and the step stays PENDING.
 *  - Concurrency:   the step is claimed with a compare-and-set (`PENDING → APPROVED/REJECTED`); the
 *                   loser gets APPROVAL_STEP_ALREADY_ACTIONED and nothing advances twice.
 */
export interface Actor {
	userId: number;
	permissions: string[];
}

type Action = 'approve' | 'reject';

/** review permission + the target's required scope (payroll: employees.view_all) */
const holdsReviewScope = (permissions: string[], targetType: ApprovalTargetType) =>
	permissions.includes(REVIEW_PERMISSION[targetType]) &&
	REQUIRED_SCOPE_PERMISSIONS[targetType].every((p) => permissions.includes(p));

const STEP_INCLUDE = {
	orderBy: { stepOrder: 'asc' as const },
	include: {
		actedBy: { select: { id: true, displayName: true } },
		candidates: { select: { userId: true, assignedByUserId: true, createdAt: true } }
	}
} satisfies Prisma.ApprovalInstance$stepsArgs;

// ============================================================================================
// acting on an instance
// ============================================================================================

export async function actOnInstance(
	instanceId: number,
	actor: Actor,
	action: Action,
	note: string | undefined
) {
	const instance = await prisma.approvalInstance.findUnique({
		where: { id: instanceId },
		include: { steps: STEP_INCLUDE, employee: { select: { userId: true } } }
	});
	if (!instance) throw Errors.notFound('ບໍ່ພົບຄຳຂໍອະນຸມັດ');
	if (instance.status !== 'PENDING') {
		throw Errors.conflict('APPROVAL_ALREADY_COMPLETED', 'ຄຳຂໍນີ້ສຳເລັດການພິຈາລະນາແລ້ວ');
	}
	// the acting user must STILL hold the domain review permission (+ the target's scope permissions —
	// payroll needs employees.view_all) — no role-name checks
	if (!holdsReviewScope(actor.permissions, instance.targetType)) throw Errors.forbidden();
	if (
		actor.userId === instance.requesterUserId ||
		(instance.employee && actor.userId === instance.employee.userId)
	) {
		throw Errors.forbiddenWith('CANNOT_APPROVE_OWN_REQUEST', 'ທ່ານບໍ່ສາມາດອະນຸມັດຄຳຂໍຂອງຕົນເອງໄດ້');
	}
	const current = instance.steps.find((s) => s.status === 'PENDING');
	if (!current) {
		throw Errors.conflict('APPROVAL_STEP_NOT_FOUND', 'ບໍ່ພົບຂັ້ນຕອນປັດຈຸບັນຂອງຄຳຂໍນີ້');
	}
	if (!current.candidates.some((c) => c.userId === actor.userId)) {
		const alreadyActed = instance.steps.some(
			(s) =>
				(s.status === 'APPROVED' || s.status === 'REJECTED') &&
				s.candidates.some((c) => c.userId === actor.userId)
		);
		// a candidate of a step that has just been actioned (e.g. lost a simultaneous click)
		if (alreadyActed) {
			throw Errors.conflict('APPROVAL_STEP_ALREADY_ACTIONED', 'ຂັ້ນຕອນນີ້ຖືກດຳເນີນການແລ້ວ');
		}
		throw Errors.forbiddenWith('NOT_CURRENT_APPROVER', 'ທ່ານບໍ່ແມ່ນຜູ້ອະນຸມັດຂອງຂັ້ນຕອນປັດຈຸບັນ');
	}
	const trimmed = note?.trim() || undefined;
	if (action === 'reject' && !trimmed) {
		throw Errors.badRequest('NOTE_REQUIRED', 'ກະລຸນາລະບຸເຫດຜົນທີ່ປະຕິເສດ');
	}
	const now = serverNow();
	const stepInfo = { stepOrder: current.stepOrder, totalSteps: instance.steps.length };

	await prisma.$transaction(
		async (tx) => {
			// Claim the step. Only one concurrent actor can flip PENDING → APPROVED/REJECTED.
			const claimed = await tx.approvalStepInstance.updateMany({
				where: { id: current.id, status: 'PENDING' },
				data: {
					status: action === 'approve' ? 'APPROVED' : 'REJECTED',
					actedByUserId: actor.userId,
					actedAt: now,
					actionNote: trimmed ?? null
				}
			});
			if (claimed.count === 0) {
				throw Errors.conflict('APPROVAL_STEP_ALREADY_ACTIONED', 'ຂັ້ນຕອນນີ້ຖືກດຳເນີນການແລ້ວ');
			}

			if (action === 'reject') {
				// domain rejection through the adapter — the engine never edits the domain table itself
				await finalizeRejection(instance.targetType, tx, instance.targetId, actor.userId, trimmed!);
				await tx.approvalStepInstance.updateMany({
					where: { approvalInstanceId: instance.id, status: 'WAITING' },
					data: { status: 'CANCELLED' }
				});
				await tx.approvalInstance.update({
					where: { id: instance.id },
					data: { status: 'REJECTED', completedAt: now, currentStepOrder: null }
				});
				await onRejected(tx, instance, actor.userId, stepInfo);
				return;
			}

			const next = instance.steps.find(
				(s) => s.stepOrder > current.stepOrder && s.status === 'WAITING'
			);
			if (next) {
				const opened = await tx.approvalStepInstance.updateMany({
					where: { id: next.id, status: 'WAITING' },
					data: { status: 'PENDING' }
				});
				if (opened.count === 0) {
					throw Errors.conflict('APPROVAL_STEP_ALREADY_ACTIONED', 'ຂັ້ນຕອນນີ້ຖືກດຳເນີນການແລ້ວ');
				}
				await tx.approvalInstance.update({
					where: { id: instance.id },
					data: { currentStepOrder: next.stepOrder }
				});
				await onStepAdvanced(tx, instance, actor.userId, {
					...stepInfo,
					nextStepOrder: next.stepOrder,
					nextCandidates: next.candidates.map((c) => c.userId)
				});
				return; // the domain request stays PENDING
			}

			// last step: the domain finalizer runs in THIS transaction; a refusal rolls everything back
			await finalizeApproval(instance.targetType, tx, instance.targetId, actor.userId, trimmed);
			await tx.approvalInstance.update({
				where: { id: instance.id },
				data: { status: 'APPROVED', completedAt: now, currentStepOrder: null }
			});
			await onFinalApproved(tx, instance, actor.userId, stepInfo);
		},
		{ timeout: 20_000, maxWait: 10_000 }
	);
	return instance.id;
}

/**
 * Compatibility entry for the legacy domain endpoints (`POST /leave/requests/:id/approve` …): they
 * are wrappers over the workflow — never a second approval system. A PENDING request that has no
 * instance yet (submitted before Phase 9 and not yet backfilled) gets one on demand.
 */
export async function actOnTarget(
	targetType: ApprovalTargetType,
	targetId: number,
	actor: Actor,
	action: Action,
	note: string | undefined,
	/** the domain's own "already reviewed" code, kept so existing clients see the same error */
	alreadyReviewedCode: string
) {
	const alreadyDone = () => Errors.conflict(alreadyReviewedCode, 'ຄຳຂໍນີ້ຖືກພິຈາລະນາແລ້ວ');
	const latest = await getLatestApprovalInstance(prisma, targetType, targetId);
	if (latest && latest.status !== 'PENDING') throw alreadyDone();
	let instanceId = latest?.id;
	if (!instanceId) {
		const created = await backfillTarget(targetType, targetId);
		if (!created) throw alreadyDone();
		instanceId = created.id;
	}
	return actOnInstance(instanceId, actor, action, note);
}

// ============================================================================================
// legacy PENDING requests → instances (idempotent)
// ============================================================================================

async function requestFacts(targetType: ApprovalTargetType, targetId: number) {
	const summary = await getTargetSummary(targetType, targetId);
	if (!summary || summary.status !== 'PENDING') return null;
	const requesterUserId =
		targetType === 'LEAVE'
			? (
					await prisma.leaveRequest.findUnique({
						where: { id: targetId },
						select: { requestedByUserId: true }
					})
				)?.requestedByUserId
			: targetType === 'OVERTIME'
				? (
						await prisma.overtimeRequest.findUnique({
							where: { id: targetId },
							select: { requestedByUserId: true }
						})
					)?.requestedByUserId
				: (
						await prisma.attendanceCorrectionRequest.findUnique({
							where: { id: targetId },
							select: { requestedByUserId: true }
						})
					)?.requestedByUserId;
	return requesterUserId ? { summary, requesterUserId } : null;
}

/** Creates the instance for ONE pending target (null when it is not pending or already has one). */
export async function backfillTarget(targetType: ApprovalTargetType, targetId: number) {
	const facts = await requestFacts(targetType, targetId);
	if (!facts) return null;
	try {
		return await prisma.$transaction((tx) =>
			createApprovalInstance(
				tx,
				{
					targetType,
					targetId,
					companyId: facts.summary.companyId,
					employeeId: facts.summary.employeeId,
					requesterUserId: facts.requesterUserId
				},
				{ audit: false }
			)
		);
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			return getLatestApprovalInstance(prisma, targetType, targetId);
		}
		throw err;
	}
}

/**
 * Support command (`npm run approval:backfill`): every PENDING Leave / OT / Attendance Correction
 * without an instance gets one from its company's CURRENT active workflow. Completed
 * (APPROVED / REJECTED / CANCELLED) legacy requests are left alone — no invented history.
 */
export async function backfillPendingApprovals() {
	const result = {
		created: 0,
		alreadyHad: 0,
		failed: [] as { targetType: string; targetId: number; code: string }[]
	};
	const pending: { targetType: ApprovalTargetType; ids: number[] }[] = [
		{
			targetType: 'LEAVE',
			ids: (
				await prisma.leaveRequest.findMany({ where: { status: 'PENDING' }, select: { id: true } })
			).map((r) => r.id)
		},
		{
			targetType: 'OVERTIME',
			ids: (
				await prisma.overtimeRequest.findMany({
					where: { status: 'PENDING' },
					select: { id: true }
				})
			).map((r) => r.id)
		},
		{
			targetType: 'ATTENDANCE_CORRECTION',
			ids: (
				await prisma.attendanceCorrectionRequest.findMany({
					where: { status: 'PENDING' },
					select: { id: true }
				})
			).map((r) => r.id)
		}
	];
	for (const { targetType, ids } of pending) {
		const have = new Set(
			(
				await prisma.approvalInstance.findMany({
					where: { targetType, targetId: { in: ids } },
					select: { targetId: true }
				})
			).map((r) => r.targetId)
		);
		for (const id of ids) {
			if (have.has(id)) {
				result.alreadyHad++;
				continue;
			}
			try {
				if (await backfillTarget(targetType, id)) result.created++;
			} catch (err) {
				result.failed.push({
					targetType,
					targetId: id,
					code: (err as { code?: string }).code ?? 'ERROR'
				});
			}
		}
	}
	return result;
}

// ============================================================================================
// presentation
// ============================================================================================

const EMPLOYEE_SELECT = {
	id: true,
	employeeCode: true,
	firstNameLao: true,
	lastNameLao: true,
	firstNameEnglish: true,
	lastNameEnglish: true,
	companyId: true,
	department: { select: { id: true, code: true, nameLao: true } },
	position: { select: { id: true, code: true, nameLao: true } }
} satisfies Prisma.EmployeeSelect;

/** How many of a step's candidates can STILL act (ACTIVE and holding the review permission). */
async function eligibleCandidateCount(
	targetType: ApprovalTargetType,
	candidateIds: number[]
): Promise<number> {
	if (candidateIds.length === 0) return 0;
	return prisma.user.count({
		where: {
			id: { in: candidateIds },
			status: 'ACTIVE',
			AND: [REVIEW_PERMISSION[targetType], ...REQUIRED_SCOPE_PERMISSIONS[targetType]].map(
				(code) => ({
					roles: { some: { role: { permissions: { some: { permission: { code } } } } } }
				})
			)
		}
	});
}

/** workflow administrators may open ANY request; `view` only lets an already-permitted viewer see the candidate list */
const isWorkflowAdmin = (auth: AuthContext) =>
	auth.permissions.includes('approval_workflows.manage');
const canSeeCandidates = (auth: AuthContext) =>
	isWorkflowAdmin(auth) || auth.permissions.includes('approval_workflows.view');

export async function getApprovalDetail(id: number, auth: AuthContext) {
	const instance = await prisma.approvalInstance.findUnique({
		where: { id },
		include: {
			steps: STEP_INCLUDE,
			workflow: { select: { id: true, nameLao: true, nameEnglish: true, version: true } },
			employee: { select: { ...EMPLOYEE_SELECT, userId: true } },
			requester: { select: { id: true, displayName: true } }
		}
	});
	if (!instance) throw Errors.notFound('ບໍ່ພົບຄຳຂໍອະນຸມັດ');

	const userId = auth.user.id;
	const isRequester =
		instance.requesterUserId === userId ||
		(!!instance.employee && instance.employee.userId === userId);
	const isCandidate = instance.steps.some((s) => s.candidates.some((c) => c.userId === userId));
	const acted = instance.steps.some((s) => s.actedByUserId === userId);
	const isAdmin = isWorkflowAdmin(auth);
	let viaScope = false;
	if (!isRequester && !isCandidate && !acted && !isAdmin) {
		const hasView =
			VIEW_PERMISSIONS[instance.targetType].some((p) => auth.permissions.includes(p)) &&
			REQUIRED_SCOPE_PERMISSIONS[instance.targetType].every((p) => auth.permissions.includes(p));
		if (hasView) {
			// company-wide targets (payroll) have no employee: the required scope permission IS the scope
			viaScope = instance.employeeId
				? isInScope(await resolveEmployeeScope(auth), instance.employeeId)
				: true;
		}
		if (!viaScope) throw Errors.forbidden();
	}

	const current = instance.steps.find((s) => s.status === 'PENDING') ?? null;
	const summary = await getTargetSummary(instance.targetType, instance.targetId);
	const reviewer = isCandidate || acted || isAdmin || viaScope;
	const canAct =
		instance.status === 'PENDING' &&
		!!current &&
		!isRequester &&
		holdsReviewScope(auth.permissions, instance.targetType) &&
		current.candidates.some((c) => c.userId === userId);

	const currentEligible = current
		? await eligibleCandidateCount(
				instance.targetType,
				current.candidates.map((c) => c.userId)
			)
		: 0;
	const candidateUsers =
		current && canSeeCandidates(auth)
			? await prisma.user.findMany({
					where: { id: { in: current.candidates.map((c) => c.userId) } },
					select: { id: true, displayName: true, username: true, status: true }
				})
			: [];

	let employee = null;
	if (instance.employee) {
		const { userId: _employeeUserId, ...rest } = instance.employee;
		void _employeeUserId;
		employee = rest;
	}
	return {
		id: instance.id,
		targetType: instance.targetType,
		targetId: instance.targetId,
		attemptNo: instance.attemptNo,
		status: instance.status,
		currentStepOrder: instance.currentStepOrder,
		submittedAt: instance.submittedAt,
		completedAt: instance.completedAt,
		workflow: instance.workflow
			? { ...instance.workflow, versionUsed: instance.workflowVersion }
			: {
					id: null,
					nameLao: null,
					nameEnglish: null,
					version: null,
					versionUsed: instance.workflowVersion
				},
		employee,
		requester: instance.requester,
		summary,
		steps: instance.steps.map((s) => ({
			stepOrder: s.stepOrder,
			nameLao: s.nameLao,
			nameEnglish: s.nameEnglish,
			approverType: s.approverType,
			managerLevel: s.managerLevel,
			status: s.status,
			actedBy: s.actedBy,
			actedAt: s.actedAt,
			actionNote: s.actionNote
		})),
		currentStep: current
			? {
					stepOrder: current.stepOrder,
					nameLao: current.nameLao,
					// no active eligible approver left → blocked (never skipped automatically)
					blocked: currentEligible === 0,
					blockedCode: currentEligible === 0 ? 'APPROVAL_STEP_BLOCKED' : null,
					candidates: candidateUsers.map((u) => ({
						userId: u.id,
						displayName: u.displayName,
						username: u.username,
						active: u.status === 'ACTIVE'
					}))
				}
			: null,
		canAct,
		isRequester,
		// the rich domain review context is for reviewers only (the requester gets the progress + summary)
		context: reviewer
			? await getTargetContext(instance.targetType, instance.targetId, userId)
			: null
	};
}

// ============================================================================================
// inbox / history
// ============================================================================================

const pageOf = (total: number, page: number, pageSize: number) => ({
	page,
	pageSize,
	total,
	totalPages: Math.max(1, Math.ceil(total / pageSize))
});

const searchWhere = (search?: string): Prisma.EmployeeWhereInput =>
	search
		? {
				OR: [
					{ employeeCode: { contains: search } },
					{ firstNameLao: { contains: search } },
					{ lastNameLao: { contains: search } },
					{ firstNameEnglish: { contains: search } },
					{ lastNameEnglish: { contains: search } }
				]
			}
		: {};

async function attachSummaries<T extends { targetType: ApprovalTargetType; targetId: number }>(
	rows: T[]
) {
	const byType = new Map<ApprovalTargetType, number[]>();
	for (const r of rows) byType.set(r.targetType, [...(byType.get(r.targetType) ?? []), r.targetId]);
	const summaries = new Map<string, Awaited<ReturnType<typeof getTargetSummary>>>();
	for (const [type, ids] of byType) {
		for (const [id, s] of await getTargetSummaries(type, ids)) summaries.set(`${type}:${id}`, s);
	}
	return rows.map((r) => ({
		...r,
		summary: summaries.get(`${r.targetType}:${r.targetId}`) ?? null
	}));
}

/** "Waiting for me": PENDING instances whose CURRENT step lists the user as a candidate. */
export async function listInbox(actor: Actor, query: InboxQuery) {
	const allowed = APPROVAL_TARGET_TYPES.filter((t) => holdsReviewScope(actor.permissions, t));
	const types = query.targetType ? allowed.filter((t) => t === query.targetType) : allowed;
	if (types.length === 0) return { items: [], ...pageOf(0, query.page, query.pageSize) };

	const where: Prisma.ApprovalInstanceWhereInput = {
		status: 'PENDING',
		targetType: { in: types },
		...(query.companyId ? { companyId: query.companyId } : {}),
		// the search matches employees; company-wide targets (payroll) only appear without a search
		...(query.search ? { employee: searchWhere(query.search) } : {}),
		steps: { some: { status: 'PENDING', candidates: { some: { userId: actor.userId } } } }
	};
	const [rows, total] = await Promise.all([
		prisma.approvalInstance.findMany({
			where,
			include: {
				steps: {
					orderBy: { stepOrder: 'asc' },
					select: { stepOrder: true, nameLao: true, status: true, actedAt: true }
				},
				employee: { select: EMPLOYEE_SELECT },
				workflow: { select: { nameLao: true } }
			},
			orderBy: { submittedAt: 'asc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.approvalInstance.count({ where })
	]);
	const now = serverNow().getTime();
	const items = rows.map((r) => {
		const current = r.steps.find((s) => s.status === 'PENDING');
		const previous = current
			? r.steps.filter((s) => s.stepOrder < current.stepOrder).pop()
			: undefined;
		const since = previous?.actedAt ?? r.submittedAt;
		return {
			id: r.id,
			targetType: r.targetType,
			targetId: r.targetId,
			attemptNo: r.attemptNo,
			status: r.status,
			employee: r.employee,
			workflowName: r.workflow?.nameLao ?? null,
			currentStep: current ? { stepOrder: current.stepOrder, nameLao: current.nameLao } : null,
			totalSteps: r.steps.length,
			submittedAt: r.submittedAt,
			waitingSince: since,
			waitingMinutes: Math.max(0, Math.floor((now - since.getTime()) / 60_000))
		};
	});
	return { items: await attachSummaries(items), ...pageOf(total, query.page, query.pageSize) };
}

/** Instances where the user previously acted (approved or rejected a step). */
export async function listHistory(actor: Actor, query: HistoryQuery) {
	const stepWhere: Prisma.ApprovalStepInstanceWhereInput = {
		actedByUserId: actor.userId,
		status: query.action ? query.action : { in: ['APPROVED', 'REJECTED'] },
		...(query.from || query.to
			? {
					actedAt: {
						...(query.from ? { gte: query.from } : {}),
						...(query.to ? { lt: new Date(query.to.getTime() + 86_400_000) } : {})
					}
				}
			: {})
	};
	const where: Prisma.ApprovalInstanceWhereInput = {
		...(query.targetType ? { targetType: query.targetType } : {}),
		steps: { some: stepWhere }
	};
	const [rows, total] = await Promise.all([
		prisma.approvalInstance.findMany({
			where,
			include: {
				steps: {
					orderBy: { stepOrder: 'asc' },
					select: {
						stepOrder: true,
						nameLao: true,
						status: true,
						actedByUserId: true,
						actedAt: true,
						actionNote: true
					}
				},
				employee: { select: EMPLOYEE_SELECT }
			},
			orderBy: { updatedAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.approvalInstance.count({ where })
	]);
	const items = rows.map((r) => {
		const mine = r.steps.filter((s) => s.actedByUserId === actor.userId).pop();
		return {
			id: r.id,
			targetType: r.targetType,
			targetId: r.targetId,
			attemptNo: r.attemptNo,
			status: r.status,
			employee: r.employee,
			currentStepOrder: r.currentStepOrder,
			totalSteps: r.steps.length,
			myAction: mine
				? {
						stepOrder: mine.stepOrder,
						stepName: mine.nameLao,
						action: mine.status,
						actedAt: mine.actedAt,
						note: mine.actionNote
					}
				: null
		};
	});
	return { items: await attachSummaries(items), ...pageOf(total, query.page, query.pageSize) };
}

// ============================================================================================
// admin: reassignment of a BLOCKED / stuck current step
// ============================================================================================

/**
 * Adds a candidate to the CURRENT step (audit-friendly: nobody is removed, `assignedByUserId`
 * records who did it). The new user must be ACTIVE, hold the domain review permission, be in scope
 * of the employee and not be the requester.
 */
export async function reassignCurrentStep(id: number, adminUserId: number, userId: number) {
	const instance = await prisma.approvalInstance.findUnique({
		where: { id },
		include: { steps: { where: { status: 'PENDING' }, include: { candidates: true } } }
	});
	if (!instance) throw Errors.notFound('ບໍ່ພົບຄຳຂໍອະນຸມັດ');
	const step = instance.steps[0];
	if (instance.status !== 'PENDING' || !step) {
		throw Errors.conflict('APPROVAL_ALREADY_COMPLETED', 'ຄຳຂໍນີ້ສຳເລັດການພິຈາລະນາແລ້ວ');
	}
	const ok = await userQualifiesAsApprover(
		prisma,
		instance.targetType,
		instance.employeeId,
		instance.requesterUserId,
		userId
	);
	if (!ok) {
		throw Errors.badRequest(
			'INVALID_APPROVER',
			'ຜູ້ໃຊ້ນີ້ບໍ່ມີສິດອະນຸມັດ, ບໍ່ຢູ່ໃນຂອບເຂດຂໍ້ມູນຂອງພະນັກງານ ຫຼື ເປັນຜູ້ຍື່ນຄຳຂໍເອງ'
		);
	}
	if (step.candidates.some((c) => c.userId === userId)) {
		throw Errors.conflict('ALREADY_CANDIDATE', 'ຜູ້ໃຊ້ນີ້ເປັນຜູ້ອະນຸມັດຂອງຂັ້ນຕອນນີ້ແລ້ວ');
	}
	await prisma.$transaction(async (tx) => {
		await tx.approvalStepCandidate.create({
			data: { approvalStepInstanceId: step.id, userId, assignedByUserId: adminUserId }
		});
		await onReassigned(
			tx,
			instance,
			adminUserId,
			{
				stepOrder: step.stepOrder,
				totalSteps: await tx.approvalStepInstance.count({ where: { approvalInstanceId: id } })
			},
			userId
		);
	});
	return instance.id;
}
