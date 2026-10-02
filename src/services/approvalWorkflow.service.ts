import { Prisma } from '@prisma/client';
import type { ApprovalTargetType } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { idCol } from '../lib/sqlIds.js';
import { Errors } from '../utils/AppError.js';
import { isInScope, resolveEmployeeScope } from '../lib/employeeScope.js';
import {
	ALLOWED_STEP_PERMISSIONS,
	MAX_MANAGER_LEVEL,
	isEmployeeTarget
} from '../lib/approvalTargets.js';
import type { AuthContext } from '../types/express.js';
import { assertCompanyExists } from './company.service.js';
import { ensureDefaultWorkflows, previewApprovalSteps } from './approvalInstance.service.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { buildChanges } from '../lib/auditRedaction.js';
import type {
	WorkflowCreateInput,
	WorkflowListQuery,
	WorkflowStepInput,
	WorkflowUpdateInput
} from '../validation/approval.schema.js';

/**
 * Workflow CONFIGURATION. Editing a workflow only affects requests submitted AFTERWARDS: every
 * running ApprovalInstance owns a snapshot of its steps and candidates (approvalInstance.service),
 * so nothing here ever changes an in-flight request. Any change of the steps or of the active state
 * bumps `version`, and new instances record the version they were created under.
 */
const WORKFLOW_INCLUDE = {
	company: { select: { id: true, code: true, nameLao: true } },
	steps: {
		orderBy: { stepOrder: 'asc' as const },
		include: {
			role: { select: { id: true, code: true, name: true } },
			user: { select: { id: true, username: true, displayName: true, status: true } }
		}
	}
} satisfies Prisma.ApprovalWorkflowInclude;
type WorkflowRow = Prisma.ApprovalWorkflowGetPayload<{ include: typeof WORKFLOW_INCLUDE }>;

async function present(row: WorkflowRow) {
	const permissions = await prisma.permission.findMany({
		where: { code: { in: ALLOWED_STEP_PERMISSIONS[row.targetType] } },
		select: { code: true, name: true }
	});
	return {
		id: row.id,
		companyId: row.companyId,
		company: row.company,
		targetType: row.targetType,
		code: row.code,
		nameLao: row.nameLao,
		nameEnglish: row.nameEnglish,
		description: row.description,
		version: row.version,
		status: row.status,
		updatedAt: row.updatedAt,
		steps: row.steps.map((s) => ({
			stepOrder: s.stepOrder,
			nameLao: s.nameLao,
			nameEnglish: s.nameEnglish,
			approverType: s.approverType,
			managerLevel: s.managerLevel,
			roleId: s.roleId,
			role: s.role,
			userId: s.userId,
			user: s.user,
			permissionCode: s.permissionCode
		})),
		allowedPermissions: permissions
	};
}

export async function listWorkflows(query: WorkflowListQuery) {
	if (query.companyId) await ensureDefaultWorkflows(query.companyId);
	const where: Prisma.ApprovalWorkflowWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.targetType ? { targetType: query.targetType } : {})
	};
	const [rows, total] = await Promise.all([
		prisma.approvalWorkflow.findMany({
			where,
			include: WORKFLOW_INCLUDE,
			orderBy: [{ targetType: 'asc' }, { status: 'asc' }, { createdAt: 'asc' }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.approvalWorkflow.count({ where })
	]);
	return {
		items: await Promise.all(rows.map(present)),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getWorkflow(id: number) {
	const row = await prisma.approvalWorkflow.findUnique({
		where: { id },
		include: WORKFLOW_INCLUDE
	});
	if (!row) throw Errors.notFound('ບໍ່ພົບຂັ້ນຕອນການອະນຸມັດ');
	return present(row);
}

// ---------- validation ----------

/**
 * A workflow needs ≥ 1 step; step orders must be exactly 1..n (when the client sends them); a
 * MANAGER step needs a level, ROLE a real role, USER an existing ACTIVE user, PERMISSION one of the
 * review permissions allowed for the target type (never something like dashboard.view).
 */
async function validateSteps(targetType: ApprovalTargetType, steps: WorkflowStepInput[]) {
	if (steps.length === 0) {
		throw Errors.badRequest('WORKFLOW_STEPS_REQUIRED', 'ຕ້ອງມີຢ່າງໜ້ອຍ 1 ຂັ້ນຕອນ');
	}
	const givenOrders = steps.map((s) => s.stepOrder).filter((o): o is number => o !== undefined);
	if (givenOrders.length > 0) {
		const sorted = [...givenOrders].sort((a, b) => a - b);
		const sequential = givenOrders.length === steps.length && sorted.every((o, i) => o === i + 1);
		if (!sequential) {
			throw Errors.badRequest(
				'INVALID_STEP_ORDER',
				'ລຳດັບຂັ້ນຕອນຕ້ອງຕໍ່ເນື່ອງ ແລະ ບໍ່ຊ້ຳກັນ (1, 2, 3, …)'
			);
		}
	}
	for (const [i, step] of steps.entries()) {
		const label = `ຂັ້ນຕອນທີ ${i + 1}`;
		switch (step.approverType) {
			case 'MANAGER':
				// a company-wide target (payroll run) has no employee and therefore no manager chain
				if (!isEmployeeTarget(targetType)) {
					throw Errors.badRequest(
						'MANAGER_STEP_NOT_ALLOWED',
						`${label}: ຂັ້ນຕອນນີ້ໃຊ້ຫົວໜ້າງານເປັນຜູ້ອະນຸມັດບໍ່ໄດ້ — ໃຫ້ໃຊ້ສິດອະນຸຍາດ, ບົດບາດ ຫຼື ຜູ້ໃຊ້`
					);
				}
				if (
					!step.managerLevel ||
					!Number.isInteger(step.managerLevel) ||
					step.managerLevel < 1 ||
					step.managerLevel > MAX_MANAGER_LEVEL
				) {
					throw Errors.badRequest(
						'INVALID_MANAGER_LEVEL',
						`${label}: ລະດັບຫົວໜ້າຕ້ອງເປັນ 1–${MAX_MANAGER_LEVEL}`
					);
				}
				break;
			case 'ROLE': {
				const role = step.roleId
					? await prisma.role.findUnique({ where: { id: step.roleId }, select: { id: true } })
					: null;
				if (!role) throw Errors.badRequest('INVALID_ROLE', `${label}: ບໍ່ພົບບົດບາດທີ່ເລືອກ`);
				break;
			}
			case 'USER': {
				const user = step.userId
					? await prisma.user.findUnique({ where: { id: step.userId }, select: { status: true } })
					: null;
				if (!user || user.status !== 'ACTIVE') {
					throw Errors.badRequest('INVALID_USER', `${label}: ຜູ້ໃຊ້ຕ້ອງມີຢູ່ ແລະ ໃຊ້ງານຢູ່`);
				}
				break;
			}
			case 'PERMISSION':
				if (
					!step.permissionCode ||
					!ALLOWED_STEP_PERMISSIONS[targetType].includes(step.permissionCode)
				) {
					throw Errors.badRequest(
						'INVALID_PERMISSION',
						`${label}: ສິດອະນຸຍາດນີ້ໃຊ້ກັບຂັ້ນຕອນປະເພດນີ້ບໍ່ໄດ້`,
						{ allowed: ALLOWED_STEP_PERMISSIONS[targetType] }
					);
				}
				break;
		}
	}
}

const stepData = (s: WorkflowStepInput, index: number) => ({
	stepOrder: index + 1,
	nameLao: s.nameLao,
	nameEnglish: s.nameEnglish ?? null,
	approverType: s.approverType,
	managerLevel: s.approverType === 'MANAGER' ? (s.managerLevel ?? null) : null,
	roleId: s.approverType === 'ROLE' ? (s.roleId ?? null) : null,
	userId: s.approverType === 'USER' ? (s.userId ?? null) : null,
	permissionCode: s.approverType === 'PERMISSION' ? (s.permissionCode ?? null) : null
});

/** Safe step summary for the audit trail (structure only — no free text). */
const stepSummary = (
	steps: {
		stepOrder: number;
		approverType: string;
		managerLevel: number | null;
		roleId: number | null;
		userId: number | null;
		permissionCode: string | null;
	}[]
) =>
	steps.map((s) => ({
		stepOrder: s.stepOrder,
		approverType: s.approverType,
		managerLevel: s.managerLevel,
		roleId: s.roleId,
		userId: s.userId,
		permissionCode: s.permissionCode
	}));

const activeKeyOf = (companyId: number, targetType: ApprovalTargetType) =>
	`${companyId}:${targetType}`;

async function lockWorkflow(tx: Prisma.TransactionClient, id: number) {
	await tx.$queryRaw`SELECT ${idCol()} AS id FROM approval_workflows WHERE ${idCol()} = ${id} FOR UPDATE`;
}

// ---------- create / update ----------

export async function createWorkflow(input: WorkflowCreateInput) {
	await assertCompanyExists(input.companyId);
	await validateSteps(input.targetType, input.steps);
	const codeTaken = await prisma.approvalWorkflow.findUnique({
		where: { companyId_code: { companyId: input.companyId, code: input.code } }
	});
	if (codeTaken) throw Errors.conflict('WORKFLOW_CODE_TAKEN', 'ລະຫັດຂັ້ນຕອນນີ້ຖືກໃຊ້ແລ້ວ');
	try {
		const created = await prisma.$transaction(async (tx) => {
			if (input.status === 'ACTIVE') {
				const active = await tx.approvalWorkflow.count({
					where: { companyId: input.companyId, targetType: input.targetType, status: 'ACTIVE' }
				});
				if (active > 0) {
					throw Errors.conflict(
						'ACTIVE_WORKFLOW_EXISTS',
						'ມີຂັ້ນຕອນການອະນຸມັດທີ່ໃຊ້ງານຢູ່ແລ້ວສຳລັບປະເພດນີ້ — ແກ້ໄຂອັນເກົ່າ ຫຼື ປິດການນຳໃຊ້ກ່ອນ'
					);
				}
			}
			const row = await tx.approvalWorkflow.create({
				data: {
					companyId: input.companyId,
					targetType: input.targetType,
					code: input.code,
					nameLao: input.nameLao,
					nameEnglish: input.nameEnglish ?? null,
					description: input.description ?? null,
					status: input.status,
					activeKey:
						input.status === 'ACTIVE' ? activeKeyOf(input.companyId, input.targetType) : null,
					steps: { create: input.steps.map(stepData) }
				},
				include: WORKFLOW_INCLUDE
			});
			await writeAuditEvent(tx, {
				action: AuditAction.APPROVAL_WORKFLOW_CHANGED,
				entityType: AuditEntity.APPROVAL_WORKFLOW,
				entityId: row.id,
				companyId: row.companyId,
				changes: {
					version: { before: null, after: row.version },
					steps: { before: null, after: stepSummary(row.steps) }
				},
				metadata: {
					operation: 'created',
					targetType: row.targetType,
					code: row.code,
					status: row.status
				}
			});
			return row;
		});
		return present(created);
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict(
				'ACTIVE_WORKFLOW_EXISTS',
				'ມີຂັ້ນຕອນການອະນຸມັດທີ່ໃຊ້ງານຢູ່ແລ້ວສຳລັບປະເພດນີ້'
			);
		}
		throw err;
	}
}

export async function updateWorkflow(id: number, input: WorkflowUpdateInput) {
	const existing = await prisma.approvalWorkflow.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບຂັ້ນຕອນການອະນຸມັດ');
	if (input.steps) await validateSteps(existing.targetType, input.steps);

	try {
		const updated = await prisma.$transaction(async (tx) => {
			await lockWorkflow(tx, id);
			const current = await tx.approvalWorkflow.findUniqueOrThrow({
				where: { id },
				include: { steps: { orderBy: { stepOrder: 'asc' } } }
			});
			const statusChanged = input.status !== undefined && input.status !== current.status;
			if (statusChanged && input.status === 'ACTIVE') {
				const other = await tx.approvalWorkflow.count({
					where: {
						companyId: current.companyId,
						targetType: current.targetType,
						status: 'ACTIVE',
						id: { not: id }
					}
				});
				if (other > 0) {
					throw Errors.conflict(
						'ACTIVE_WORKFLOW_EXISTS',
						'ມີຂັ້ນຕອນການອະນຸມັດທີ່ໃຊ້ງານຢູ່ແລ້ວສຳລັບປະເພດນີ້ — ປິດການນຳໃຊ້ອັນນັ້ນກ່ອນ'
					);
				}
			}
			if (input.steps) {
				await tx.approvalWorkflowStep.deleteMany({ where: { workflowId: id } });
				await tx.approvalWorkflowStep.createMany({
					data: input.steps.map((s, i) => ({ workflowId: id, ...stepData(s, i) }))
				});
			}
			const row = await tx.approvalWorkflow.update({
				where: { id },
				data: {
					...(input.nameLao !== undefined ? { nameLao: input.nameLao } : {}),
					...(input.nameEnglish !== undefined ? { nameEnglish: input.nameEnglish } : {}),
					...(input.description !== undefined ? { description: input.description } : {}),
					...(statusChanged
						? {
								status: input.status,
								activeKey:
									input.status === 'ACTIVE'
										? activeKeyOf(current.companyId, current.targetType)
										: null
							}
						: {}),
					// a changed definition is a NEW version; running instances keep the one they started on
					...(input.steps || statusChanged ? { version: { increment: 1 } } : {})
				},
				include: WORKFLOW_INCLUDE
			});
			const changes = buildChanges(
				{
					nameLao: current.nameLao,
					nameEnglish: current.nameEnglish,
					status: current.status,
					version: current.version,
					steps: stepSummary(current.steps)
				},
				{
					nameLao: row.nameLao,
					nameEnglish: row.nameEnglish,
					status: row.status,
					version: row.version,
					steps: stepSummary(row.steps)
				},
				['nameLao', 'nameEnglish', 'status', 'version', 'steps']
			);
			if (changes) {
				await writeAuditEvent(tx, {
					action: AuditAction.APPROVAL_WORKFLOW_CHANGED,
					entityType: AuditEntity.APPROVAL_WORKFLOW,
					entityId: id,
					companyId: row.companyId,
					changes,
					metadata: {
						operation: 'updated',
						targetType: row.targetType,
						code: row.code,
						versionBefore: current.version,
						versionAfter: row.version
					}
				});
			}
			return row;
		});
		return present(updated);
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict(
				'ACTIVE_WORKFLOW_EXISTS',
				'ມີຂັ້ນຕອນການອະນຸມັດທີ່ໃຊ້ງານຢູ່ແລ້ວສຳລັບປະເພດນີ້'
			);
		}
		throw err;
	}
}

// ---------- preview (no instance is created) ----------

export async function previewWorkflow(
	targetType: ApprovalTargetType,
	auth: AuthContext,
	employeeId?: number
) {
	if (!isEmployeeTarget(targetType)) {
		throw Errors.badRequest(
			'PREVIEW_NOT_SUPPORTED',
			'ຕົວຢ່າງຂັ້ນຕອນໃຊ້ໄດ້ສະເພາະຄຳຂໍຂອງພະນັກງານ — ເບິ່ງສະຖານະອະນຸມັດຢູ່ໜ້າຮອບເງິນເດືອນ'
		);
	}
	let employee;
	if (employeeId) {
		if (!auth.permissions.includes('approval_workflows.view')) throw Errors.forbidden();
		employee = await prisma.employee.findUnique({
			where: { id: employeeId },
			select: { id: true, companyId: true, userId: true }
		});
		if (!employee) throw Errors.badRequest('INVALID_EMPLOYEE', 'ບໍ່ພົບພະນັກງານ');
		if (!isInScope(await resolveEmployeeScope(auth), employee.id)) throw Errors.forbidden();
	} else {
		employee = await prisma.employee.findUnique({
			where: { userId: auth.user.id },
			select: { id: true, companyId: true, userId: true }
		});
		if (!employee) {
			throw Errors.forbiddenWith('NO_LINKED_EMPLOYEE', 'ບັນຊີນີ້ຍັງບໍ່ໄດ້ເຊື່ອມກັບພະນັກງານ');
		}
	}
	const result = await previewApprovalSteps(prisma, {
		companyId: employee.companyId,
		targetType,
		employeeId: employee.id,
		requesterUserId: employee.userId ?? auth.user.id
	});
	return { targetType, employeeId: employee.id, ...result };
}
