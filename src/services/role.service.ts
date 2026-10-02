import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { buildChanges } from '../lib/auditRedaction.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import type { CreateRoleInput, UpdateRoleInput } from '../validation/role.schema.js';

const ROLE_SUMMARY_SELECT = {
	id: true,
	code: true,
	name: true,
	description: true,
	isSystem: true,
	createdAt: true,
	updatedAt: true,
	_count: { select: { users: true, permissions: true } }
} satisfies Prisma.RoleSelect;

type RoleSummaryRow = Prisma.RoleGetPayload<{ select: typeof ROLE_SUMMARY_SELECT }>;

function toRoleSummary(role: RoleSummaryRow) {
	const { _count, ...rest } = role;
	return { ...rest, userCount: _count.users, permissionCount: _count.permissions };
}

export async function listRoles() {
	const roles = await prisma.role.findMany({
		select: ROLE_SUMMARY_SELECT,
		orderBy: { createdAt: 'asc' }
	});
	return roles.map(toRoleSummary);
}

export async function getRoleById(id: number) {
	const role = await prisma.role.findUnique({
		where: { id },
		include: {
			permissions: { include: { permission: true } },
			_count: { select: { users: true, permissions: true } }
		}
	});
	if (!role) throw Errors.notFound('ບໍ່ພົບບົດບາດ');

	return {
		id: role.id,
		code: role.code,
		name: role.name,
		description: role.description,
		isSystem: role.isSystem,
		createdAt: role.createdAt,
		updatedAt: role.updatedAt,
		userCount: role._count.users,
		permissions: role.permissions.map((rp) => rp.permission)
	};
}

async function assertPermissionsExist(permissionIds: number[]): Promise<void> {
	if (permissionIds.length === 0) return;
	const found = await prisma.permission.count({ where: { id: { in: permissionIds } } });
	if (found !== new Set(permissionIds).size) {
		throw Errors.badRequest('INVALID_PERMISSION', 'ມີສິດອະນຸຍາດທີ່ບໍ່ຖືກຕ້ອງ');
	}
}

export async function createRole(input: CreateRoleInput) {
	await assertPermissionsExist(input.permissionIds);

	const codeTaken = await prisma.role.findUnique({ where: { code: input.code } });
	if (codeTaken) throw Errors.conflict('ROLE_CODE_TAKEN', 'ລະຫັດບົດບາດນີ້ຖືກໃຊ້ແລ້ວ');

	const role = await prisma.$transaction(async (tx) => {
		const created = await tx.role.create({
			data: { code: input.code, name: input.name, description: input.description }
		});
		if (input.permissionIds.length > 0) {
			await tx.rolePermission.createMany({
				data: input.permissionIds.map((permissionId) => ({ roleId: created.id, permissionId }))
			});
		}
		await writeAuditEvent(tx, {
			action: AuditAction.ROLE_CREATED,
			entityType: AuditEntity.ROLE,
			entityId: created.id,
			metadata: { code: created.code, permissionCount: input.permissionIds.length }
		});
		return tx.role.findUniqueOrThrow({ where: { id: created.id }, select: ROLE_SUMMARY_SELECT });
	});

	return toRoleSummary(role);
}

export async function updateRole(id: number, input: UpdateRoleInput) {
	const existing = await prisma.role.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບບົດບາດ');

	if (existing.isSystem && input.permissionIds !== undefined && input.permissionIds.length === 0) {
		throw Errors.badRequest(
			'SYSTEM_ROLE_PROTECTED',
			'ບໍ່ສາມາດເອົາສິດອະນຸຍາດທັງໝົດອອກຈາກບົດບາດລະບົບໄດ້'
		);
	}

	if (input.permissionIds) await assertPermissionsExist(input.permissionIds);

	const role = await prisma.$transaction(async (tx) => {
		const beforePerms = input.permissionIds
			? (
					await tx.rolePermission.findMany({
						where: { roleId: id },
						select: { permission: { select: { code: true } } }
					})
				).map((p) => p.permission.code)
			: null;
		await tx.role.update({
			where: { id },
			data: {
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.description !== undefined ? { description: input.description } : {})
			}
		});

		if (input.permissionIds) {
			await tx.rolePermission.deleteMany({ where: { roleId: id } });
			if (input.permissionIds.length > 0) {
				await tx.rolePermission.createMany({
					data: input.permissionIds.map((permissionId) => ({ roleId: id, permissionId }))
				});
			}
		}

		const fieldChanges = buildChanges(
			{ name: existing.name, description: existing.description },
			{
				name: input.name ?? existing.name,
				description: input.description !== undefined ? input.description : existing.description
			},
			['name', 'description']
		);
		const base = { entityType: AuditEntity.ROLE, entityId: id } as const;
		if (fieldChanges) {
			await writeAuditEvent(tx, {
				...base,
				action: AuditAction.ROLE_UPDATED,
				changes: fieldChanges,
				metadata: { code: existing.code }
			});
		}
		if (beforePerms) {
			const afterPerms = (
				await tx.rolePermission.findMany({
					where: { roleId: id },
					select: { permission: { select: { code: true } } }
				})
			).map((p) => p.permission.code);
			const added = afterPerms.filter((c) => !beforePerms.includes(c)).sort();
			const removed = beforePerms.filter((c) => !afterPerms.includes(c)).sort();
			if (added.length || removed.length) {
				await writeAuditEvent(tx, {
					...base,
					action: AuditAction.ROLE_PERMISSIONS_CHANGED,
					changes: { permissions: { added, removed } },
					metadata: { code: existing.code, permissionCount: afterPerms.length }
				});
			}
		}

		return tx.role.findUniqueOrThrow({ where: { id }, select: ROLE_SUMMARY_SELECT });
	});

	return toRoleSummary(role);
}

export function listPermissions() {
	return prisma.permission.findMany({ orderBy: { code: 'asc' } });
}
