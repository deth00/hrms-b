import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { hashPassword } from '../lib/password.js';
import { revokeAllUserSessions } from './session.service.js';
import { Errors } from '../utils/AppError.js';
import { buildChanges } from '../lib/auditRedaction.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import type {
	CreateUserInput,
	UpdateUserInput,
	ListUsersQuery
} from '../validation/user.schema.js';

const SAFE_USER_SELECT = {
	id: true,
	username: true,
	email: true,
	displayName: true,
	status: true,
	lastLoginAt: true,
	createdAt: true,
	updatedAt: true,
	roles: { select: { role: { select: { id: true, code: true, name: true } } } }
} satisfies Prisma.UserSelect;

type SafeUserRow = Prisma.UserGetPayload<{ select: typeof SAFE_USER_SELECT }>;

function toSafeUser(user: SafeUserRow) {
	const { roles, ...rest } = user;
	return { ...rest, roles: roles.map((r) => r.role) };
}

export async function listUsers(query: ListUsersQuery) {
	const where: Prisma.UserWhereInput = {
		...(query.status ? { status: query.status } : {}),
		...(query.roleId ? { roles: { some: { roleId: query.roleId } } } : {}),
		...(query.search
			? {
					OR: [
						{ username: { contains: query.search } },
						{ email: { contains: query.search } },
						{ displayName: { contains: query.search } }
					]
				}
			: {})
	};

	const [items, total] = await Promise.all([
		prisma.user.findMany({
			where,
			select: SAFE_USER_SELECT,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.user.count({ where })
	]);

	return {
		items: items.map(toSafeUser),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getUserById(id: number) {
	const user = await prisma.user.findUnique({ where: { id }, select: SAFE_USER_SELECT });
	if (!user) throw Errors.notFound('ບໍ່ພົບຜູ້ໃຊ້');
	return toSafeUser(user);
}

async function assertRolesExist(roleIds: number[]): Promise<void> {
	if (roleIds.length === 0) return;
	const found = await prisma.role.count({ where: { id: { in: roleIds } } });
	if (found !== new Set(roleIds).size) {
		throw Errors.badRequest('INVALID_ROLE', 'ມີບົດບາດທີ່ບໍ່ຖືກຕ້ອງ');
	}
}

export async function createUser(input: CreateUserInput) {
	await assertRolesExist(input.roleIds);

	const [usernameTaken, emailTaken] = await Promise.all([
		prisma.user.findUnique({ where: { username: input.username } }),
		input.email ? prisma.user.findUnique({ where: { email: input.email } }) : null
	]);
	if (usernameTaken) throw Errors.conflict('USERNAME_TAKEN', 'ຊື່ຜູ້ໃຊ້ນີ້ຖືກໃຊ້ແລ້ວ');
	if (emailTaken) throw Errors.conflict('EMAIL_TAKEN', 'ອີເມວນີ້ຖືກໃຊ້ແລ້ວ');

	const passwordHash = await hashPassword(input.password);

	const user = await prisma.$transaction(async (tx) => {
		const created = await tx.user.create({
			data: {
				username: input.username,
				email: input.email,
				displayName: input.displayName,
				passwordHash
			}
		});
		if (input.roleIds.length > 0) {
			await tx.userRole.createMany({
				data: input.roleIds.map((roleId) => ({ userId: created.id, roleId }))
			});
		}
		await writeAuditEvent(tx, {
			action: AuditAction.USER_CREATED,
			entityType: AuditEntity.USER,
			entityId: created.id,
			// never the password / hash — only who was created and with which roles
			metadata: { username: created.username, roleIds: input.roleIds }
		});
		return tx.user.findUniqueOrThrow({ where: { id: created.id }, select: SAFE_USER_SELECT });
	});

	return toSafeUser(user);
}

async function assertSuperAdminSurvives(targetUserId: number): Promise<void> {
	const superAdminRole = await prisma.role.findUnique({ where: { code: 'SUPER_ADMIN' } });
	if (!superAdminRole) return;

	const others = await prisma.user.count({
		where: {
			status: 'ACTIVE',
			id: { not: targetUserId },
			roles: { some: { roleId: superAdminRole.id } }
		}
	});

	if (others === 0) {
		throw Errors.badRequest(
			'LAST_SUPER_ADMIN',
			'ບໍ່ສາມາດດຳເນີນການໄດ້: ລະບົບຕ້ອງມີຜູ້ດູແລລະບົບສູງສຸດ (SUPER_ADMIN) ທີ່ໃຊ້ງານໄດ້ຢ່າງໜ້ອຍ 1 ຄົນ'
		);
	}
}

export async function updateUser(id: number, input: UpdateUserInput) {
	const existing = await prisma.user.findUnique({
		where: { id },
		include: { roles: { include: { role: true } } }
	});
	if (!existing) throw Errors.notFound('ບໍ່ພົບຜູ້ໃຊ້');

	const isCurrentlyActiveSuperAdmin =
		existing.status === 'ACTIVE' && existing.roles.some((r) => r.role.code === 'SUPER_ADMIN');
	const superAdminRoleId = existing.roles.find((r) => r.role.code === 'SUPER_ADMIN')?.roleId;

	const roleWouldStillHaveSuperAdmin =
		input.roleIds === undefined
			? true
			: superAdminRoleId !== undefined && input.roleIds.includes(superAdminRoleId);
	const statusWouldStillBeActive = input.status === undefined ? true : input.status === 'ACTIVE';

	if (isCurrentlyActiveSuperAdmin && !(roleWouldStillHaveSuperAdmin && statusWouldStillBeActive)) {
		await assertSuperAdminSurvives(id);
	}

	if (input.email) {
		const emailTaken = await prisma.user.findFirst({
			where: { email: input.email, id: { not: id } }
		});
		if (emailTaken) throw Errors.conflict('EMAIL_TAKEN', 'ອີເມວນີ້ຖືກໃຊ້ແລ້ວ');
	}

	if (input.roleIds) await assertRolesExist(input.roleIds);

	const user = await prisma.$transaction(async (tx) => {
		await tx.user.update({
			where: { id },
			data: {
				...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
				...(input.email !== undefined ? { email: input.email } : {}),
				...(input.status !== undefined ? { status: input.status } : {})
			}
		});

		if (input.roleIds) {
			await tx.userRole.deleteMany({ where: { userId: id } });
			if (input.roleIds.length > 0) {
				await tx.userRole.createMany({
					data: input.roleIds.map((roleId) => ({ userId: id, roleId }))
				});
			}
		}

		if (input.status === 'INACTIVE') {
			await revokeAllUserSessions(id, undefined, tx);
		}

		const after = await tx.user.findUniqueOrThrow({ where: { id }, select: SAFE_USER_SELECT });
		const base = { entityType: AuditEntity.USER, entityId: id } as const;
		const fieldChanges = buildChanges(
			{ displayName: existing.displayName, email: existing.email },
			{ displayName: after.displayName, email: after.email },
			['displayName', 'email']
		);
		if (fieldChanges) {
			await writeAuditEvent(tx, {
				...base,
				action: AuditAction.USER_UPDATED,
				changes: fieldChanges,
				metadata: { username: after.username }
			});
		}
		if (after.status !== existing.status) {
			await writeAuditEvent(tx, {
				...base,
				action: after.status === 'ACTIVE' ? AuditAction.USER_ENABLED : AuditAction.USER_DISABLED,
				changes: { status: { before: existing.status, after: after.status } },
				metadata: { username: after.username, sessionsRevoked: after.status === 'INACTIVE' }
			});
		}
		const roleBefore = existing.roles.map((r) => r.role.code).sort();
		const roleAfter = after.roles.map((r) => r.role.code).sort();
		if (JSON.stringify(roleBefore) !== JSON.stringify(roleAfter)) {
			await writeAuditEvent(tx, {
				...base,
				action: AuditAction.USER_ROLE_CHANGED,
				changes: { roles: { before: roleBefore, after: roleAfter } },
				metadata: { username: after.username }
			});
		}

		return after;
	});

	return toSafeUser(user);
}

/** Guard for flows that deactivate a user indirectly (e.g. Employee status change): never remove the last SUPER_ADMIN. */
export async function assertUserCanBeDisabled(userId: number): Promise<void> {
	const isActiveSuperAdmin = await prisma.user.count({
		where: { id: userId, status: 'ACTIVE', roles: { some: { role: { code: 'SUPER_ADMIN' } } } }
	});
	if (isActiveSuperAdmin > 0) await assertSuperAdminSurvives(userId);
}
