import { describe, it, expect } from 'vitest';
import { agent, createTestUser, loginAndGetCookie } from './helpers.js';

describe('POST /api/v1/auth/change-password', () => {
	it('rejects the change when the current password is wrong', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);

		const res = await agent().post('/api/v1/auth/change-password').set('Cookie', cookie).send({
			currentPassword: 'WrongOldPass123',
			newPassword: 'NewPassword123',
			confirmPassword: 'NewPassword123'
		});

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
	});

	it('rejects when newPassword and confirmPassword do not match', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);

		const res = await agent().post('/api/v1/auth/change-password').set('Cookie', cookie).send({
			currentPassword: password,
			newPassword: 'NewPassword123',
			confirmPassword: 'SomethingElse123'
		});

		expect(res.status).toBe(400);
	});

	it('stores the new hash: the old password stops working and the new one works', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);

		const changeRes = await agent()
			.post('/api/v1/auth/change-password')
			.set('Cookie', cookie)
			.send({
				currentPassword: password,
				newPassword: 'BrandNewPass123',
				confirmPassword: 'BrandNewPass123'
			});
		expect(changeRes.status).toBe(200);

		const oldLogin = await agent().post('/api/v1/auth/login').send({ login: username, password });
		expect(oldLogin.status).toBe(401);

		const newLogin = await agent()
			.post('/api/v1/auth/login')
			.send({ login: username, password: 'BrandNewPass123' });
		expect(newLogin.status).toBe(200);
	});

	it('revokes other sessions but keeps the current one active', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookieA = await loginAndGetCookie(username, password);
		const cookieB = await loginAndGetCookie(username, password);

		const changeRes = await agent()
			.post('/api/v1/auth/change-password')
			.set('Cookie', cookieA)
			.send({
				currentPassword: password,
				newPassword: 'AnotherNewPass123',
				confirmPassword: 'AnotherNewPass123'
			});
		expect(changeRes.status).toBe(200);

		const stillA = await agent().get('/api/v1/auth/me').set('Cookie', cookieA);
		expect(stillA.status).toBe(200);

		const revokedB = await agent().get('/api/v1/auth/me').set('Cookie', cookieB);
		expect(revokedB.status).toBe(401);
	});
});
