import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { agent, createTestUser, loginAndGetCookie } from './helpers.js';

describe('users API', () => {
	it('rejects a duplicate username on create', async () => {
		const admin = await createTestUser({ roleCode: 'SUPER_ADMIN' });
		const adminCookie = await loginAndGetCookie(admin.username, admin.password);
		const taken = await createTestUser({});

		const res = await agent().post('/api/v1/users').set('Cookie', adminCookie).send({
			username: taken.username,
			displayName: 'Duplicate Username',
			password: 'Password123',
			roleIds: []
		});

		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('USERNAME_TAKEN');
	});

	it('rejects a duplicate email on create', async () => {
		const admin = await createTestUser({ roleCode: 'SUPER_ADMIN' });
		const adminCookie = await loginAndGetCookie(admin.username, admin.password);
		const existing = await createTestUser({});

		const res = await agent()
			.post('/api/v1/users')
			.set('Cookie', adminCookie)
			.send({
				username: `new_${randomUUID().slice(0, 8)}`,
				email: existing.user.email,
				displayName: 'Duplicate Email',
				password: 'Password123',
				roleIds: []
			});

		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('EMAIL_TAKEN');
	});

	it('rejects an invalid role assignment', async () => {
		const admin = await createTestUser({ roleCode: 'SUPER_ADMIN' });
		const adminCookie = await loginAndGetCookie(admin.username, admin.password);

		const res = await agent()
			.post('/api/v1/users')
			.set('Cookie', adminCookie)
			.send({
				username: `bad_${randomUUID().slice(0, 8)}`,
				displayName: 'Bad Role Assignment',
				password: 'Password123',
				roleIds: [2147483647]
			});

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INVALID_ROLE');

		const malformed = await agent()
			.post('/api/v1/users')
			.set('Cookie', adminCookie)
			.send({
				username: `bad_${randomUUID().slice(0, 8)}`,
				displayName: 'Bad Role Assignment',
				password: 'Password123',
				roleIds: ['not-a-real-role-id']
			});
		expect(malformed.status).toBe(400);
		expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
	});

	it('disabling a user immediately revokes their active sessions', async () => {
		const admin = await createTestUser({ roleCode: 'SUPER_ADMIN' });
		const adminCookie = await loginAndGetCookie(admin.username, admin.password);

		const target = await createTestUser({ roleCode: 'EMPLOYEE' });
		const targetCookie = await loginAndGetCookie(target.username, target.password);

		const before = await agent().get('/api/v1/auth/me').set('Cookie', targetCookie);
		expect(before.status).toBe(200);

		const disableRes = await agent()
			.patch(`/api/v1/users/${target.user.id}`)
			.set('Cookie', adminCookie)
			.send({ status: 'INACTIVE' });
		expect(disableRes.status).toBe(200);
		expect(disableRes.body.data.status).toBe('INACTIVE');

		const after = await agent().get('/api/v1/auth/me').set('Cookie', targetCookie);
		expect(after.status).toBe(401);
	});

	it('rejects a status change from a caller who only has users.update, not users.disable', async () => {
		// HR_ADMIN has both in Phase 1's default seed, so this exercises the safeguard with a role
		// that is deliberately given users.update but not users.disable via a custom role.
		const admin = await createTestUser({ roleCode: 'SUPER_ADMIN' });
		const adminCookie = await loginAndGetCookie(admin.username, admin.password);

		const rolesRes = await agent().get('/api/v1/permissions').set('Cookie', adminCookie);
		const usersUpdateId = rolesRes.body.data.find(
			(p: { code: string }) => p.code === 'users.update'
		).id;

		const roleRes = await agent()
			.post('/api/v1/roles')
			.set('Cookie', adminCookie)
			.send({
				code: `UPDATE_ONLY_${randomUUID().slice(0, 6).toUpperCase()}`,
				name: 'Update Only',
				permissionIds: [usersUpdateId]
			});
		expect(roleRes.status).toBe(201);

		const limitedAdmin = await createTestUser({});
		await agent()
			.patch(`/api/v1/users/${limitedAdmin.user.id}`)
			.set('Cookie', adminCookie)
			.send({ roleIds: [roleRes.body.data.id] });
		const limitedCookie = await loginAndGetCookie(limitedAdmin.username, limitedAdmin.password);

		const target = await createTestUser({ roleCode: 'EMPLOYEE' });

		const res = await agent()
			.patch(`/api/v1/users/${target.user.id}`)
			.set('Cookie', limitedCookie)
			.send({ status: 'INACTIVE' });

		expect(res.status).toBe(403);
	});
});
