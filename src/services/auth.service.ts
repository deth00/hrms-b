import { prisma } from '../config/prisma.js';
import { hashPassword, verifyPassword, compareAgainstDummyHash } from '../lib/password.js';
import {
	createSession,
	revokeAllUserSessions,
	revokeSessionByToken,
	type CreatedSession
} from './session.service.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { Errors } from '../utils/AppError.js';
import type { LoginInput, ChangePasswordInput } from '../validation/auth.schema.js';

function normalizeLogin(login: string): string {
	return login.includes('@') ? login.toLowerCase() : login;
}

export async function login(input: LoginInput): Promise<CreatedSession> {
	const identifier = normalizeLogin(input.login);

	const user = await prisma.user.findFirst({
		where: { OR: [{ username: identifier }, { email: identifier }] }
	});

	if (!user) {
		// Run a bcrypt compare anyway so a nonexistent account doesn't respond measurably faster.
		await compareAgainstDummyHash();
		throw Errors.invalidCredentials();
	}

	const passwordOk = await verifyPassword(input.password, user.passwordHash);
	if (!passwordOk || user.status !== 'ACTIVE') {
		throw Errors.invalidCredentials();
	}

	const session = await prisma.$transaction(async (tx) => {
		const created = await createSession(user.id, tx);
		await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
		// success only (failed attempts are not audited); no credential of any kind is recorded
		await writeAuditEvent(tx, {
			action: AuditAction.AUTH_LOGIN_SUCCESS,
			entityType: AuditEntity.USER,
			entityId: user.id,
			actorUserId: user.id
		});
		return created;
	});

	return session;
}

export async function changePassword(
	userId: number,
	currentSessionId: number,
	input: ChangePasswordInput
): Promise<void> {
	const user = await prisma.user.findUnique({ where: { id: userId } });
	if (!user) throw Errors.unauthenticated();

	const ok = await verifyPassword(input.currentPassword, user.passwordHash);
	if (!ok) throw Errors.badRequest('INVALID_CURRENT_PASSWORD', 'ລະຫັດຜ່ານປັດຈຸບັນບໍ່ຖືກຕ້ອງ');

	const passwordHash = await hashPassword(input.newPassword);

	await prisma.$transaction(async (tx) => {
		await tx.user.update({ where: { id: userId }, data: { passwordHash } });
		await revokeAllUserSessions(userId, currentSessionId, tx);
		// the event says THAT the password changed — never the old or new value, never the hash
		await writeAuditEvent(tx, {
			action: AuditAction.AUTH_PASSWORD_CHANGED,
			entityType: AuditEntity.USER,
			entityId: userId,
			actorUserId: userId,
			metadata: { otherSessionsRevoked: true }
		});
	});
}

export async function logout(userId: number, rawToken: string | undefined): Promise<void> {
	await prisma.$transaction(async (tx) => {
		if (rawToken) await revokeSessionByToken(rawToken, tx);
		await writeAuditEvent(tx, {
			action: AuditAction.AUTH_LOGOUT,
			entityType: AuditEntity.USER,
			entityId: userId,
			actorUserId: userId
		});
	});
}
