import { Prisma } from '@prisma/client';
import type { ApprovalApproverType, ApprovalTargetType } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import {
	DEFAULT_WORKFLOW,
	REQUIRED_SCOPE_PERMISSIONS,
	REVIEW_PERMISSION,
	isEmployeeTarget
} from '../lib/approvalTargets.js';
import { onCancelled, onInstanceCreated } from './approvalEvents.js';

/**
 * Approval INSTANCES: creation (with step + candidate snapshots), cancellation, candidate
 * resolution. Kept free of any domain import so Leave / OT / Attendance Correction services can
 * call it from inside their own submission / cancellation transactions without import cycles.
 *
 * The engine decides WHO approves and in WHAT ORDER. It never touches balances, OT figures or
 * correction overlays — those stay in the domain services (see approvalTargetAdapter).
 */
export type Db = Prisma.TransactionClient | typeof prisma;

const VIEW_ALL_PERMISSION = 'employees.view_all';
const MAX_TREE_DEPTH = 50;

const holdsPermission = (code: string) => ({
	roles: { some: { role: { permissions: { some: { permission: { code } } } } } }
});

// ============================================================================================
// default workflows
// ============================================================================================

/**
 * Idempotent: gives a company its three default one-step workflows (PERMISSION = the domain review
 * permission), which reproduces the pre-Phase-9 single-review behaviour. A target type that already
 * has ANY workflow for the company is left alone (a deliberately deactivated one stays deactivated).
 */
export async function ensureDefaultWorkflows(companyId: number, db: Db = prisma) {
	const created: string[] = [];
	for (const targetType of Object.keys(DEFAULT_WORKFLOW) as ApprovalTargetType[]) {
		const existing = await db.approvalWorkflow.count({ where: { companyId, targetType } });
		if (existing > 0) continue;
		const def = DEFAULT_WORKFLOW[targetType]!;
		try {
			await db.approvalWorkflow.create({
				data: {
					companyId,
					targetType,
					code: def.code,
					nameLao: def.nameLao,
					nameEnglish: def.nameEnglish,
					version: 1,
					status: 'ACTIVE',
					activeKey: `${companyId}:${targetType}`,
					steps: {
						create: [
							{
								stepOrder: 1,
								nameLao: def.stepNameLao,
								nameEnglish: def.stepNameEnglish,
								approverType: 'PERMISSION',
								permissionCode: REVIEW_PERMISSION[targetType]
							}
						]
					}
				}
			});
			created.push(targetType);
		} catch (err) {
			// a concurrent request created it first
			if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
		}
	}
	return created;
}

// ============================================================================================
// candidate resolution
// ============================================================================================

interface ResolveContext {
	targetType: ApprovalTargetType;
	/** null for a company-wide target (PAYROLL_RUN) */
	employee: { id: number; companyId: number; userId: number | null } | null;
	requesterUserId: number;
	/** managers above the employee: chain[0] = direct manager (level 1), chain[1] = level 2, … */
	chain: { employeeId: number; userId: number | null }[];
	/** ACTIVE users who hold the domain review permission, are in scope and are not the requester */
	base: Set<number>;
}

/** Users that are ACTIVE and hold ALL of the given permission codes. */
const holdsAll = (codes: string[]) => ({ AND: codes.map((code) => holdsPermission(code)) });

async function buildResolveContext(
	db: Db,
	targetType: ApprovalTargetType,
	employeeId: number | null,
	requesterUserId: number
): Promise<ResolveContext> {
	if (!isEmployeeTarget(targetType) || !employeeId) {
		// Phase 13 — a company-wide target (payroll run): no employee, no manager chain. Candidates are
		// the ACTIVE users holding the review permission AND the target's required scope permissions
		// (payroll.approve + employees.view_all). The requester is ALWAYS excluded.
		const holders = await db.user.findMany({
			where: {
				status: 'ACTIVE',
				...holdsAll([REVIEW_PERMISSION[targetType], ...REQUIRED_SCOPE_PERMISSIONS[targetType]])
			},
			select: { id: true }
		});
		const base = new Set(holders.map((u) => u.id).filter((id) => id !== requesterUserId));
		return { targetType, employee: null, requesterUserId, chain: [], base };
	}
	const employee = await db.employee.findUniqueOrThrow({
		where: { id: employeeId },
		select: { id: true, companyId: true, userId: true, managerEmployeeId: true }
	});
	const chain: ResolveContext['chain'] = [];
	const seen = new Set<number>([employee.id]);
	let next = employee.managerEmployeeId;
	for (let depth = 0; depth < MAX_TREE_DEPTH && next && !seen.has(next); depth++) {
		seen.add(next);
		const manager = await db.employee.findUnique({
			where: { id: next },
			select: { id: true, userId: true, managerEmployeeId: true }
		});
		if (!manager) break;
		chain.push({ employeeId: manager.id, userId: manager.userId });
		next = manager.managerEmployeeId;
	}

	// Employee DATA SCOPE (Phase 3): employees.view_all → everyone; otherwise a user sees the
	// employees below their own record — i.e. the target employee must be themselves or below them.
	const scopeEmployeeIds = new Set([employee.id, ...chain.map((c) => c.employeeId)]);
	const [holders, viewAll] = await Promise.all([
		db.user.findMany({
			where: { status: 'ACTIVE', ...holdsPermission(REVIEW_PERMISSION[targetType]) },
			select: { id: true, employee: { select: { id: true } } }
		}),
		db.user.findMany({
			where: { status: 'ACTIVE', ...holdsPermission(VIEW_ALL_PERMISSION) },
			select: { id: true }
		})
	]);
	const viewAllIds = new Set(viewAll.map((u) => u.id));
	const base = new Set<number>();
	for (const u of holders) {
		if (u.id === requesterUserId || u.id === employee.userId) continue; // requester never approves
		const inScope = viewAllIds.has(u.id) || (u.employee && scopeEmployeeIds.has(u.employee.id));
		if (inScope) base.add(u.id);
	}
	return { targetType, employee, requesterUserId, chain, base };
}

export interface StepConfig {
	approverType: ApprovalApproverType;
	managerLevel: number | null;
	roleId: number | null;
	userId: number | null;
	permissionCode: string | null;
}

async function resolveStepCandidates(
	db: Db,
	step: StepConfig,
	ctx: ResolveContext
): Promise<number[]> {
	switch (step.approverType) {
		case 'MANAGER': {
			// no manager tree for company-wide targets (payroll): a MANAGER step resolves to nobody
			if (!ctx.employee) return [];
			const manager = ctx.chain[(step.managerLevel ?? 1) - 1];
			// a manager with no linked ACTIVE user (or lacking the review permission / scope) cannot approve
			return manager?.userId && ctx.base.has(manager.userId) ? [manager.userId] : [];
		}
		case 'ROLE': {
			if (!step.roleId || ctx.base.size === 0) return [];
			const rows = await db.userRole.findMany({
				where: { roleId: step.roleId, userId: { in: [...ctx.base] } },
				select: { userId: true }
			});
			return rows.map((r) => r.userId);
		}
		case 'USER':
			return step.userId && ctx.base.has(step.userId) ? [step.userId] : [];
		case 'PERMISSION': {
			if (!step.permissionCode || ctx.base.size === 0) return [];
			if (step.permissionCode === REVIEW_PERMISSION[ctx.targetType]) return [...ctx.base];
			const rows = await db.user.findMany({
				where: { id: { in: [...ctx.base] }, ...holdsPermission(step.permissionCode) },
				select: { id: true }
			});
			return rows.map((r) => r.id);
		}
	}
}

/** Can this ONE user act as an approver for the employee's request right now (used by reassignment)? */
export async function userQualifiesAsApprover(
	db: Db,
	targetType: ApprovalTargetType,
	employeeId: number | null,
	requesterUserId: number,
	userId: number
) {
	const ctx = await buildResolveContext(db, targetType, employeeId, requesterUserId);
	return ctx.base.has(userId);
}

/** Dry run for the "this request will go through …" preview: nothing is created. */
export async function previewApprovalSteps(
	db: Db,
	input: {
		companyId: number;
		targetType: ApprovalTargetType;
		employeeId: number;
		requesterUserId: number;
	}
) {
	await ensureDefaultWorkflows(input.companyId, db);
	const workflow = await db.approvalWorkflow.findFirst({
		where: { companyId: input.companyId, targetType: input.targetType, status: 'ACTIVE' },
		include: { steps: { orderBy: { stepOrder: 'asc' } } }
	});
	if (!workflow) return { workflow: null, steps: [] };
	const ctx = await buildResolveContext(
		db,
		input.targetType,
		input.employeeId,
		input.requesterUserId
	);
	const steps = [];
	for (const step of workflow.steps) {
		const candidates = await resolveStepCandidates(db, step, ctx);
		steps.push({
			stepOrder: step.stepOrder,
			nameLao: step.nameLao,
			nameEnglish: step.nameEnglish,
			approverType: step.approverType,
			canResolve: candidates.length > 0
		});
	}
	return {
		workflow: {
			id: workflow.id,
			nameLao: workflow.nameLao,
			nameEnglish: workflow.nameEnglish,
			version: workflow.version
		},
		steps
	};
}

// ============================================================================================
// creation / cancellation (called INSIDE the domain transaction)
// ============================================================================================

export interface NewApprovalInput {
	targetType: ApprovalTargetType;
	targetId: number;
	companyId: number;
	/** null for company-wide targets (PAYROLL_RUN) */
	employeeId: number | null;
	requesterUserId: number;
	/** Phase 13 — resubmission attempt (default 1). Unique per target: a duplicate attempt fails (P2002). */
	attemptNo?: number;
}

/**
 * Creates the instance + step snapshots + candidate snapshots. Throws APPROVER_NOT_FOUND (with the
 * step order / name) if ANY step resolves to nobody, so the surrounding domain transaction rolls
 * back and no orphan request is left. Only step 1 becomes PENDING; the rest WAIT.
 */
export async function createApprovalInstance(
	db: Db,
	input: NewApprovalInput,
	/** false for the legacy backfill: no "requested" audit event is invented for an old submission */
	options: { audit?: boolean } = {}
) {
	await ensureDefaultWorkflows(input.companyId, db);
	const workflow = await db.approvalWorkflow.findFirst({
		where: { companyId: input.companyId, targetType: input.targetType, status: 'ACTIVE' },
		include: { steps: { orderBy: { stepOrder: 'asc' } } }
	});
	if (!workflow || workflow.steps.length === 0) {
		throw Errors.conflict(
			'APPROVAL_WORKFLOW_NOT_FOUND',
			'ຍັງບໍ່ມີຂັ້ນຕອນການອະນຸມັດທີ່ໃຊ້ງານຢູ່ສຳລັບຄຳຂໍປະເພດນີ້ — ກະລຸນາຕິດຕໍ່ HR'
		);
	}

	const ctx = await buildResolveContext(
		db,
		input.targetType,
		input.employeeId,
		input.requesterUserId
	);
	const resolved: { step: (typeof workflow.steps)[number]; candidates: number[] }[] = [];
	for (const step of workflow.steps) {
		const candidates = [...new Set(await resolveStepCandidates(db, step, ctx))];
		if (candidates.length === 0) {
			throw Errors.conflict(
				'APPROVER_NOT_FOUND',
				`ບໍ່ພົບຜູ້ອະນຸມັດສຳລັບຂັ້ນຕອນທີ ${step.stepOrder} (${step.nameLao}) — ກະລຸນາຕິດຕໍ່ HR`,
				{ stepOrder: step.stepOrder, stepName: step.nameLao }
			);
		}
		resolved.push({ step, candidates });
	}

	const first = workflow.steps[0]!.stepOrder;
	const instance = await db.approvalInstance.create({
		data: {
			workflowId: workflow.id,
			workflowVersion: workflow.version,
			targetType: input.targetType,
			targetId: input.targetId,
			companyId: input.companyId,
			employeeId: input.employeeId,
			requesterUserId: input.requesterUserId,
			attemptNo: input.attemptNo ?? 1,
			status: 'PENDING',
			currentStepOrder: first
		}
	});
	for (const { step, candidates } of resolved) {
		await db.approvalStepInstance.create({
			data: {
				approvalInstanceId: instance.id,
				stepOrder: step.stepOrder,
				nameLao: step.nameLao,
				nameEnglish: step.nameEnglish,
				approverType: step.approverType,
				managerLevel: step.managerLevel,
				roleId: step.roleId,
				userId: step.userId,
				permissionCode: step.permissionCode,
				status: step.stepOrder === first ? 'PENDING' : 'WAITING',
				candidates: { create: candidates.map((userId) => ({ userId })) }
			}
		});
	}
	// audit "requested" + notify ONLY the first step's candidates (same transaction as the submission)
	await onInstanceCreated(db, instance, {
		totalSteps: resolved.length,
		firstStepOrder: first,
		firstStepCandidates: resolved[0]!.candidates,
		audit: options.audit !== false
	});
	return instance;
}

// ============================================================================================
// attempts (Phase 13): the ONE place that knows "latest" = highest attemptNo
// ============================================================================================

/** The most recent attempt of a target (any status), or null when it was never submitted. */
export function getLatestApprovalInstance(
	db: Db,
	targetType: ApprovalTargetType,
	targetId: number
) {
	return db.approvalInstance.findFirst({
		where: { targetType, targetId },
		orderBy: { attemptNo: 'desc' }
	});
}

/** The PENDING attempt of a target (at most one can be pending), or null. */
export function getActiveApprovalInstance(
	db: Db,
	targetType: ApprovalTargetType,
	targetId: number
) {
	return db.approvalInstance.findFirst({
		where: { targetType, targetId, status: 'PENDING' },
		orderBy: { attemptNo: 'desc' }
	});
}

/** The attemptNo the NEXT submission of a target must use (1 for a never-submitted target). */
export async function nextAttemptNo(db: Db, targetType: ApprovalTargetType, targetId: number) {
	const latest = await getLatestApprovalInstance(db, targetType, targetId);
	return (latest?.attemptNo ?? 0) + 1;
}

/** Mirrors a NORMAL domain cancellation: current + future steps cancelled, approved history kept. */
export async function cancelApprovalInstance(
	db: Db,
	targetType: ApprovalTargetType,
	targetId: number,
	/** who cancelled (defaults to the requester — the domain services' own cancellation) */
	actorUserId?: number
) {
	const latest = await getLatestApprovalInstance(db, targetType, targetId);
	const instance = latest
		? await db.approvalInstance.findUnique({
				where: { id: latest.id },
				include: {
					steps: {
						where: { status: 'PENDING' },
						select: { candidates: { select: { userId: true } } }
					}
				}
			})
		: null;
	if (instance && instance.status !== 'PENDING') return null;
	if (!instance) {
		// legacy PENDING request without an instance: the domain cancellation is still audited
		await onCancelled(db, targetType, targetId, null, []);
		return null;
	}
	const currentCandidates = instance.steps.flatMap((s) => s.candidates.map((c) => c.userId));
	await onCancelled(db, targetType, targetId, instance, currentCandidates, actorUserId);
	await db.approvalStepInstance.updateMany({
		where: { approvalInstanceId: instance.id, status: { in: ['PENDING', 'WAITING'] } },
		data: { status: 'CANCELLED' }
	});
	return db.approvalInstance.update({
		where: { id: instance.id },
		data: { status: 'CANCELLED', completedAt: new Date() }
	});
}

// ============================================================================================
// read helpers used by the domain services
// ============================================================================================

export interface ApprovalSummary {
	instanceId: number;
	workflowName: string | null;
	currentStep: number | null;
	totalSteps: number;
	status: string;
}

/** Compact workflow summary for domain responses (not the full workflow payload). */
export async function approvalSummaries(
	targetType: ApprovalTargetType,
	targetIds: number[]
): Promise<Map<number, ApprovalSummary>> {
	const map = new Map<number, ApprovalSummary>();
	if (targetIds.length === 0) return map;
	const rows = await prisma.approvalInstance.findMany({
		where: { targetType, targetId: { in: targetIds } },
		include: { workflow: { select: { nameLao: true } }, _count: { select: { steps: true } } },
		// ascending attempts: the LATEST attempt of each target is written last and wins
		orderBy: { attemptNo: 'asc' }
	});
	for (const r of rows) {
		map.set(r.targetId, {
			instanceId: r.id,
			workflowName: r.workflow?.nameLao ?? null,
			currentStep: r.currentStepOrder,
			totalSteps: r._count.steps,
			status: r.status
		});
	}
	return map;
}

export async function withApproval<T extends { id: number }>(
	targetType: ApprovalTargetType,
	items: T[]
): Promise<(T & { approval: ApprovalSummary | null })[]> {
	const map = await approvalSummaries(
		targetType,
		items.map((i) => i.id)
	);
	return items.map((i) => ({ ...i, approval: map.get(i.id) ?? null }));
}

/** Is the user a candidate of the CURRENT (PENDING) step of this target's workflow? */
export async function isCurrentCandidate(
	targetType: ApprovalTargetType,
	targetId: number,
	userId: number
) {
	const count = await prisma.approvalStepCandidate.count({
		where: {
			userId,
			step: { status: 'PENDING', instance: { targetType, targetId, status: 'PENDING' } }
		}
	});
	return count > 0;
}
