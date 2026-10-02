import { describe, it, expect } from 'vitest';
import { agent, createTestUser, loginAndGetCookie } from './helpers.js';

describe('authorization', () => {
	it('rejects a protected API call without a session (401)', async () => {
		const res = await agent().get('/api/v1/users');
		expect(res.status).toBe(401);
		expect(res.body.error.code).toBe('UNAUTHENTICATED');
	});

	it('rejects a logged-in user who lacks the required permission (403)', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);

		const res = await agent().get('/api/v1/users').set('Cookie', cookie);

		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('FORBIDDEN');
	});

	it('allows a user who has the required permission (200)', async () => {
		const { username, password } = await createTestUser({ roleCode: 'SUPER_ADMIN' });
		const cookie = await loginAndGetCookie(username, password);

		const res = await agent().get('/api/v1/users').set('Cookie', cookie);

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
	});
});
