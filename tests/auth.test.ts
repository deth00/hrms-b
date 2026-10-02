import { describe, it, expect } from 'vitest';
import { agent, createTestUser, loginAndGetCookie } from './helpers.js';
import { prisma } from '../src/config/prisma.js';

describe('POST /api/v1/auth/login', () => {
	it('valid login succeeds and sets a session cookie', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });

		const res = await agent().post('/api/v1/auth/login').send({ login: username, password });

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data.user.username).toBe(username);
		expect(res.body.data.user.password_hash).toBeUndefined();
		expect(res.headers['set-cookie']).toBeDefined();
	});

	it('rejects an invalid password with the generic credentials error', async () => {
		const { username } = await createTestUser({ roleCode: 'EMPLOYEE' });

		const res = await agent()
			.post('/api/v1/auth/login')
			.send({ login: username, password: 'WrongPass123' });

		expect(res.status).toBe(401);
		expect(res.body.success).toBe(false);
		expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
	});

	it('rejects a nonexistent account with the exact same generic error', async () => {
		const res = await agent()
			.post('/api/v1/auth/login')
			.send({ login: 'no-such-user-anywhere', password: 'WhateverPass123' });

		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
	});

	it('rejects an inactive account', async () => {
		const { username, password } = await createTestUser({
			roleCode: 'EMPLOYEE',
			status: 'INACTIVE'
		});

		const res = await agent().post('/api/v1/auth/login').send({ login: username, password });

		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
	});
});

describe('GET /api/v1/auth/me', () => {
	it('returns 401 without a session', async () => {
		const res = await agent().get('/api/v1/auth/me');
		expect(res.status).toBe(401);
	});

	it('returns 200 with a valid session, including roles and permissions', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);

		const res = await agent().get('/api/v1/auth/me').set('Cookie', cookie);

		expect(res.status).toBe(200);
		expect(res.body.data.user.username).toBe(username);
		expect(res.body.data.roles.map((r: { code: string }) => r.code)).toContain('EMPLOYEE');
		expect(res.body.data.permissions).toContain('dashboard.view');
	});
});

describe('POST /api/v1/auth/logout', () => {
	it('revokes the session so it cannot be reused', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);

		const logoutRes = await agent().post('/api/v1/auth/logout').set('Cookie', cookie);
		expect(logoutRes.status).toBe(200);

		const meRes = await agent().get('/api/v1/auth/me').set('Cookie', cookie);
		expect(meRes.status).toBe(401);
	});
});

describe('session expiration', () => {
	it('rejects a session whose expiresAt is in the past', async () => {
		const { user, username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);

		await prisma.session.updateMany({
			where: { userId: user.id },
			data: { expiresAt: new Date(Date.now() - 1000) }
		});

		const res = await agent().get('/api/v1/auth/me').set('Cookie', cookie);
		expect(res.status).toBe(401);
	});
});
