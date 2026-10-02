import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { env, isProduction } from '../config/env.js';
import { generateSessionToken, hashSessionToken } from '../lib/sessionToken.js';
import type { AuthContext } from '../types/express.js';

/** Accepts either the shared client or a `$transaction` callback client, so callers can compose atomic mutations. */
type Db = typeof prisma | Prisma.TransactionClient;

export interface CreatedSession {
	token: string;
	expiresAt: Date;
}

export async function createSession(userId: number, db: Db = prisma): Promise<CreatedSession> {
	const token = generateSessionToken();
	const tokenHash = hashSessionToken(token);
	const expiresAt = new Date(Date.now() + env.sessionTtlHours * 60 * 60 * 1000);

	await db.session.create({
		data: { userId, tokenHash, expiresAt }
	});

	return { token, expiresAt };
}

/** Resolves a raw cookie token into a full auth context, or null if it's missing/expired/revoked/inactive-user. */
export async function loadAuthContext(rawToken: string): Promise<AuthContext | null> {
	const tokenHash = hashSessionToken(rawToken);

	const session = await prisma.session.findUnique({
		where: { tokenHash },
		include: {
			user: {
				include: {
					roles: {
						include: {
							role: {
								include: { permissions: { include: { permission: true } } }
							}
						}
					}
				}
			}
		}
	});

	if (!session) return null;
	if (session.revokedAt) return null;
	if (session.expiresAt.getTime() < Date.now()) return null;
	if (session.user.status !== 'ACTIVE') return null;

	// Best-effort activity heartbeat — not on the critical path for the response.
	void prisma.session
		.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
		.catch(() => {});

	const roles = session.user.roles.map((ur) => ur.role);
	const permissions = [
		...new Set(roles.flatMap((role) => role.permissions.map((rp) => rp.permission.code)))
	];

	return {
		sessionId: session.id,
		user: {
			id: session.user.id,
			username: session.user.username,
			email: session.user.email,
			displayName: session.user.displayName,
			status: session.user.status
		},
		roles: roles.map((role) => ({ id: role.id, code: role.code, name: role.name })),
		permissions
	};
}

export async function revokeSessionByToken(rawToken: string, db: Db = prisma): Promise<void> {
	const tokenHash = hashSessionToken(rawToken);
	await db.session.updateMany({
		where: { tokenHash, revokedAt: null },
		data: { revokedAt: new Date() }
	});
}

export async function revokeAllUserSessions(
	userId: number,
	exceptSessionId?: number,
	db: Db = prisma
): Promise<void> {
	await db.session.updateMany({
		where: {
			userId,
			revokedAt: null,
			...(exceptSessionId ? { id: { not: exceptSessionId } } : {})
		},
		data: { revokedAt: new Date() }
	});
}

export function sessionCookieOptions(expiresAt?: Date) {
	return {
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: isProduction,
		path: '/',
		...(expiresAt ? { expires: expiresAt } : {})
	};
}
