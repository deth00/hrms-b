import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { hashPassword } from '../src/lib/password.js';

export const agent = () => request(app);

interface TestUserOptions {
	roleCode?: string;
	status?: 'ACTIVE' | 'INACTIVE';
	password?: string;
}

export async function createTestUser(options: TestUserOptions = {}) {
	const suffix = randomUUID().slice(0, 8);
	const username = `test_${suffix}`;
	const password = options.password ?? 'Password123';
	const passwordHash = await hashPassword(password);

	const user = await prisma.user.create({
		data: {
			username,
			email: `${username}@example.test`,
			displayName: `Test User ${suffix}`,
			passwordHash,
			status: options.status ?? 'ACTIVE'
		}
	});

	if (options.roleCode) {
		const role = await prisma.role.findUniqueOrThrow({ where: { code: options.roleCode } });
		await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
	}

	return { user, username, password };
}

/** Logs in over HTTP (exercising the real endpoint) and returns the "name=value" Cookie header. */
export async function loginAndGetCookie(username: string, password: string): Promise<string> {
	const res = await agent().post('/api/v1/auth/login').send({ login: username, password });
	const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
	if (!setCookie) {
		throw new Error(`Login failed for "${username}": ${JSON.stringify(res.body)}`);
	}
	const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
	return (cookieHeader as string).split(';')[0] as string;
}

/** A quick SUPER_ADMIN session cookie — most Phase 2 tests just need a fully-privileged actor. */
export async function superAdminCookie(): Promise<string> {
	const { username, password } = await createTestUser({ roleCode: 'SUPER_ADMIN' });
	return loginAndGetCookie(username, password);
}

export async function createTestCompany(overrides: { status?: 'ACTIVE' | 'INACTIVE' } = {}) {
	const suffix = randomUUID().slice(0, 8).toUpperCase();
	return prisma.company.create({
		data: {
			code: `CO_${suffix}`,
			nameLao: `ບໍລິສັດທົດສອບ ${suffix}`,
			status: overrides.status ?? 'ACTIVE'
		}
	});
}

/**
 * A logged-in user whose ONLY permissions are the given codes (via a throwaway role) — lets a
 * test prove exactly which permission gates an action, independent of the seeded default roles.
 */
export async function userWithPermissions(codes: string[]) {
	const suffix = randomUUID().slice(0, 8);
	const permissions = await prisma.permission.findMany({ where: { code: { in: codes } } });
	const role = await prisma.role.create({
		data: {
			code: `TEST_ROLE_${suffix}`,
			name: `Test role ${suffix}`,
			permissions: { create: permissions.map((p) => ({ permissionId: p.id })) }
		}
	});
	const { user, username, password } = await createTestUser();
	await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
	const cookie = await loginAndGetCookie(username, password);
	return { user, cookie };
}
