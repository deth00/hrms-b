import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, createTestUser, loginAndGetCookie, userWithPermissions } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import { Prisma } from '@prisma/client';
import { setServerClockForTests } from '../src/lib/clock.js';
import { buildChanges, sanitizeForAudit, REDACTED } from '../src/lib/auditRedaction.js';
import { writeAuditEvent } from '../src/services/audit.service.js';
import {
	CORRECTION_REASON,
	LEAVE_REASON,
	MON,
	NOW,
	OT_REASON,
	approve,
	at,
	clockAt,
	correctionCase,
	fx,
	get,
	instanceOf,
	leaveReq,
	mgr,
	otReq,
	patch,
	post,
	reject,
	role,
	setSteps,
	setupFixture,
	subject,
	threeStepLeave,
	uid,
	workflowOf
} from './phase10Fixture.js';

beforeEach(() => at(NOW));
afterEach(() => setServerClockForTests(null));
beforeAll(setupFixture);

/** the newest event for an action (optionally narrowed to an entity) */
async function latest(action: string, where: Prisma.AuditEventWhereInput = {}) {
	return prisma.auditEvent.findFirst({
		where: { action, ...where },
		orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
	});
}
const events = (where: Prisma.AuditEventWhereInput) =>
	prisma.auditEvent.findMany({ where, orderBy: { createdAt: 'asc' } });
const blob = (row: unknown) => JSON.stringify(row);

// ============================================================================================
describe('audit core', () => {
	it('1. writeAuditEvent stores action, entity, actor, company and employee', async () => {
		const entityId = `E_${uid()}`;
		await writeAuditEvent(prisma, {
			action: 'TEST.CORE',
			entityType: 'TEST',
			entityId,
			companyId: fx.companyId,
			employeeId: fx.M.employee.id,
			actorUserId: fx.adminUser.id,
			metadata: { hello: 'world' }
		});
		const row = await latest('TEST.CORE', { entityId });
		expect(row).toMatchObject({
			entityType: 'TEST',
			companyId: fx.companyId,
			employeeId: fx.M.employee.id,
			actorUserId: fx.adminUser.id
		});
		expect(row!.metadataJson).toEqual({ hello: 'world' });
	});

	it('2. every response carries a server-generated X-Request-Id (a fresh UUID each time)', async () => {
		const a = await get('/auth/me', fx.admin);
		const b = await get('/auth/me', fx.admin);
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		expect(a.headers['x-request-id']).toMatch(uuid);
		expect(b.headers['x-request-id']).toMatch(uuid);
		expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
	});

	it('3. a client-supplied X-Request-Id is never trusted', async () => {
		const res = await agent().get('/api/v1/health').set('X-Request-Id', 'attacker-chosen-id');
		expect(res.headers['x-request-id']).not.toBe('attacker-chosen-id');
	});

	it('4. the audit row records the same request id that was returned to the client', async () => {
		const res = await post('/shifts', fx.admin, {
			companyId: fx.companyId,
			code: `RQ_${uid()}`,
			nameLao: 'ກະທົດສອບ',
			startTime: '09:00',
			endTime: '18:00',
			breakMinutes: 60
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const row = await latest('SHIFT.CREATED', { entityId: String(res.body.data.id) });
		expect(row!.requestId).toBe(res.headers['x-request-id']);
		expect(row!.actorUserId).toBe(fx.adminUser.id);
	});

	it('5. IP address and user agent are stored; cookies / tokens are not', async () => {
		const res = await agent()
			.post('/api/v1/shifts')
			.set('Cookie', fx.admin)
			.set('User-Agent', 'AuditTest/1.0')
			.send({
				companyId: fx.companyId,
				code: `UA_${uid()}`,
				nameLao: 'ກະ UA',
				startTime: '09:00',
				endTime: '18:00',
				breakMinutes: 60
			});
		const row = (await latest('SHIFT.CREATED', { entityId: String(res.body.data.id) }))!;
		expect(row.userAgent).toBe('AuditTest/1.0');
		expect(row.ipAddress).toBeTruthy();
		const cookieValue = fx.admin.split('=')[1]!;
		expect(blob(row)).not.toContain(cookieValue);
	});

	it('6. the audit model is append-only: no updatedAt column', () => {
		const fields = Object.keys(Prisma.AuditEventScalarFieldEnum);
		expect(fields).not.toContain('updatedAt');
		expect(fields).toContain('createdAt');
	});

	it('7. there is no PATCH / PUT / DELETE / POST for audit events', async () => {
		const row = await latest('AUTH.LOGIN_SUCCESS');
		for (const method of ['patch', 'put', 'delete', 'post'] as const) {
			const res = await agent()[method](`/api/v1/audit-events/${row!.id}`).set('Cookie', fx.admin);
			expect(res.status, method).toBe(404);
		}
		expect((await agent().post('/api/v1/audit-events').set('Cookie', fx.admin)).status).toBe(404);
		expect(await prisma.auditEvent.count({ where: { id: row!.id } })).toBe(1);
	});

	it('8. a rolled-back transaction leaves no audit event behind', async () => {
		const entityId = `RB_${uid()}`;
		await expect(
			prisma.$transaction(async (tx) => {
				await writeAuditEvent(tx, { action: 'TEST.ROLLBACK', entityType: 'TEST', entityId });
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		expect(await prisma.auditEvent.count({ where: { entityId } })).toBe(0);
	});

	it('9. a refused business action writes no success event (duplicate shift code)', async () => {
		const code = `DUP_${uid()}`;
		const body = {
			companyId: fx.companyId,
			code,
			nameLao: 'ກະຊ້ຳ',
			startTime: '09:00',
			endTime: '18:00',
			breakMinutes: 60
		};
		expect((await post('/shifts', fx.admin, body)).status).toBe(201);
		expect((await post('/shifts', fx.admin, body)).status).toBe(409);
		const shifts = await prisma.shift.findMany({ where: { code } });
		expect(
			await prisma.auditEvent.count({
				where: { action: 'SHIFT.CREATED', entityId: String(shifts[0]!.id) }
			})
		).toBe(1);
	});
});

// ============================================================================================
describe('redaction', () => {
	it('10. password-like keys are redacted at any depth', () => {
		const out = sanitizeForAudit({
			password: 'Secret123',
			newPassword: 'Secret456',
			currentPassword: 'Secret789',
			passwordHash: '$2a$10$abcdefghijklmnopqrstuv',
			nested: { deep: { confirmPassword: 'x', ok: 'fine' } },
			list: [{ password: 'p' }]
		}) as Record<string, unknown>;
		const text = JSON.stringify(out);
		for (const secret of ['Secret123', 'Secret456', 'Secret789', 'abcdefghijklmnopqrstuv']) {
			expect(text).not.toContain(secret);
		}
		expect(out.password).toBe(REDACTED);
		expect((out.nested as { deep: { ok: string } }).deep.ok).toBe('fine');
	});

	it('11. session tokens, cookies and authorization headers are redacted', () => {
		const out = JSON.stringify(
			sanitizeForAudit({
				token: 'tok-1',
				sessionToken: 'tok-2',
				tokenHash: 'h',
				cookie: 'hr_session=abc',
				headers: { Authorization: 'Bearer zzz', 'Set-Cookie': 'a=b' },
				databaseUrl: 'mysql://u:p@h/db'
			})
		);
		for (const secret of ['tok-1', 'tok-2', 'hr_session=abc', 'zzz', 'a=b', 'mysql://']) {
			expect(out).not.toContain(secret);
		}
	});

	it('12. bcrypt-looking and Bearer-looking string VALUES are redacted even under innocent keys', () => {
		const out = sanitizeForAudit({
			note: '$2b$12$abcdefghijklmnopqrstuvwxyz',
			x: 'Bearer abc.def'
		});
		expect(out).toEqual({ note: REDACTED, x: REDACTED });
	});

	it('13. nationalId / passportNumber changes are {changed:true} — never the value', () => {
		const changes = buildChanges(
			{ nationalId: 'OLD-111', passportNumber: 'P-OLD', nickname: 'ກ' },
			{ nationalId: 'NEW-222', passportNumber: 'P-NEW', nickname: 'ຂ' },
			['nationalId', 'passportNumber', 'nickname']
		);
		expect(changes).toEqual({
			nationalId: { changed: true },
			passportNumber: { changed: true },
			nickname: { before: 'ກ', after: 'ຂ' }
		});
		expect(blob(changes)).not.toMatch(/OLD-111|NEW-222|P-OLD|P-NEW/);
	});

	it('14. buildChanges keeps only changed fields, normalises dates/decimals, null when unchanged', () => {
		const date = new Date('2026-01-02T03:04:05Z');
		const c = buildChanges(
			{ a: 1, b: date, c: new Prisma.Decimal('1.50'), d: 'same' },
			{ a: 2, b: date, c: new Prisma.Decimal('2.50'), d: 'same' },
			['a', 'b', 'c', 'd']
		);
		expect(c).toEqual({ a: { before: 1, after: 2 }, c: { before: '1.5', after: '2.5' } });
		expect(buildChanges({ a: 1 }, { a: 1 }, ['a'])).toBeNull();
		expect(buildChanges({ a: 1 }, {}, ['a'])).toBeNull();
	});

	it('15. free-text reasons and raw GPS coordinates are masked in diffs', () => {
		const c = buildChanges(
			{ reason: 'a', latitude: 1, longitude: 2, note: 'x' },
			{ reason: 'b', latitude: 3, longitude: 4, note: 'y' },
			['reason', 'latitude', 'longitude', 'note']
		);
		expect(Object.values(c!).every((v) => v.changed === true)).toBe(true);
	});

	it('16. writeAuditEvent sanitises even when a caller passes secrets by mistake', async () => {
		const entityId = `S_${uid()}`;
		await writeAuditEvent(prisma, {
			action: 'TEST.SANITISE',
			entityType: 'TEST',
			entityId,
			changes: { password: 'PlainSecret1' },
			metadata: { passwordHash: '$2a$10$zzzzzzzzzzzzzzzzzzzzzz', ok: 1 }
		});
		const row = await latest('TEST.SANITISE', { entityId });
		expect(blob(row)).not.toMatch(/PlainSecret1|zzzzzzzz/);
		expect(row!.metadataJson).toMatchObject({ ok: 1 });
	});
});

// ============================================================================================
describe('auth and user audit', () => {
	it('17. login success is audited (actor = user) with no credential in the row', async () => {
		const u = await createTestUser({ roleCode: 'EMPLOYEE', password: 'LoginSecret9' });
		await loginAndGetCookie(u.username, u.password);
		const row = await latest('AUTH.LOGIN_SUCCESS', { actorUserId: u.user.id });
		expect(row).toMatchObject({ entityType: 'USER', entityId: String(u.user.id) });
		expect(row!.requestId).toBeTruthy();
		expect(blob(row)).not.toContain('LoginSecret9');
	});

	it('18. a failed login writes no audit event', async () => {
		const u = await createTestUser({ roleCode: 'EMPLOYEE' });
		const res = await agent()
			.post('/api/v1/auth/login')
			.send({ login: u.username, password: 'wrong-pass-1' });
		expect(res.status).toBe(401);
		expect(await prisma.auditEvent.count({ where: { actorUserId: u.user.id } })).toBe(0);
	});

	it('19. logout is audited', async () => {
		const u = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(u.username, u.password);
		expect((await post('/auth/logout', cookie)).status).toBe(200);
		expect(await latest('AUTH.LOGOUT', { actorUserId: u.user.id })).toBeTruthy();
	});

	it('20. a password change is audited without the old or new password', async () => {
		const u = await createTestUser({ roleCode: 'EMPLOYEE', password: 'OldSecret123' });
		const cookie = await loginAndGetCookie(u.username, u.password);
		const res = await post('/auth/change-password', cookie, {
			currentPassword: 'OldSecret123',
			newPassword: 'BrandNewSecret456',
			confirmPassword: 'BrandNewSecret456'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const row = await latest('AUTH.PASSWORD_CHANGED', { actorUserId: u.user.id });
		expect(row).toBeTruthy();
		expect(blob(row)).not.toMatch(/OldSecret123|BrandNewSecret456|\$2[aby]\$/);
		const stored = await prisma.user.findUniqueOrThrow({ where: { id: u.user.id } });
		expect(blob(row)).not.toContain(stored.passwordHash);
	});

	it('21. creating a user is audited without the password', async () => {
		const username = `au_${uid().toLowerCase()}`;
		const res = await post('/users', fx.admin, {
			username,
			displayName: 'ຜູ້ໃຊ້ໃໝ່',
			password: 'CreateSecret77',
			roleIds: []
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const row = await latest('USER.CREATED', { entityId: String(res.body.data.id) });
		expect(row!.metadataJson).toMatchObject({ username });
		expect(blob(row)).not.toContain('CreateSecret77');
	});

	async function newUser() {
		const res = await post('/users', fx.admin, {
			username: `au_${uid().toLowerCase()}`,
			displayName: 'ຊື່ເກົ່າ',
			password: 'Password123',
			roleIds: []
		});
		return res.body.data as { id: string };
	}

	it('22. a user edit records a safe before/after diff', async () => {
		const u = await newUser();
		expect((await patch(`/users/${u.id}`, fx.admin, { displayName: 'ຊື່ໃໝ່' })).status).toBe(200);
		const row = await latest('USER.UPDATED', { entityId: String(u.id) });
		expect(row!.changesJson).toEqual({ displayName: { before: 'ຊື່ເກົ່າ', after: 'ຊື່ໃໝ່' } });
		expect(row!.actorUserId).toBe(fx.adminUser.id);
	});

	it('23. disabling and re-enabling a user are separate audit actions', async () => {
		const u = await newUser();
		await patch(`/users/${u.id}`, fx.admin, { status: 'INACTIVE' });
		expect((await latest('USER.DISABLED', { entityId: String(u.id) }))!.changesJson).toEqual({
			status: { before: 'ACTIVE', after: 'INACTIVE' }
		});
		await patch(`/users/${u.id}`, fx.admin, { status: 'ACTIVE' });
		expect(await latest('USER.ENABLED', { entityId: String(u.id) })).toBeTruthy();
	});

	it('24. a role assignment change is audited with role codes before/after', async () => {
		const u = await newUser();
		const emp = await prisma.role.findUniqueOrThrow({ where: { code: 'EMPLOYEE' } });
		await patch(`/users/${u.id}`, fx.admin, { roleIds: [emp.id] });
		const row = await latest('USER.ROLE_CHANGED', { entityId: String(u.id) });
		expect(row!.changesJson).toEqual({ roles: { before: [], after: ['EMPLOYEE'] } });
	});

	it('25. a no-op user update writes no event', async () => {
		const u = await newUser();
		const before = await prisma.auditEvent.count({ where: { entityId: String(u.id) } });
		await patch(`/users/${u.id}`, fx.admin, { displayName: 'ຊື່ເກົ່າ' });
		expect(await prisma.auditEvent.count({ where: { entityId: String(u.id) } })).toBe(before);
	});

	it('26. role create / update / permission change are audited', async () => {
		const perms = await prisma.permission.findMany({
			where: { code: { in: ['dashboard.view', 'users.view'] } }
		});
		const created = await post('/roles', fx.admin, {
			code: `AR_${uid()}`,
			name: 'ບົດບາດທົດສອບ',
			permissionIds: [perms[0]!.id]
		});
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const id = created.body.data.id as string;
		expect(await latest('ROLE.CREATED', { entityId: String(id) })).toBeTruthy();
		await patch(`/roles/${id}`, fx.admin, { name: 'ຊື່ໃໝ່' });
		expect((await latest('ROLE.UPDATED', { entityId: String(id) }))!.changesJson).toEqual({
			name: { before: 'ບົດບາດທົດສອບ', after: 'ຊື່ໃໝ່' }
		});
		await patch(`/roles/${id}`, fx.admin, { permissionIds: [perms[1]!.id] });
		const row = await latest('ROLE.PERMISSIONS_CHANGED', { entityId: String(id) });
		expect(row!.changesJson).toEqual({
			permissions: {
				added: ['users.view'],
				removed: ['dashboard.view']
			}
		});
	});
});

// ============================================================================================
describe('employee, organisation and configuration audit', () => {
	async function org() {
		const branch = await prisma.branch.create({
			data: { companyId: fx.companyId, code: `B_${uid()}`, nameLao: 'ສາຂາ' }
		});
		const it = await prisma.department.create({
			data: { companyId: fx.companyId, branchId: branch.id, code: `IT_${uid()}`, nameLao: 'ໄອທີ' }
		});
		const hr = await prisma.department.create({
			data: {
				companyId: fx.companyId,
				branchId: branch.id,
				code: `HR_${uid()}`,
				nameLao: 'ບຸກຄະລາກອນ'
			}
		});
		const et = await prisma.employmentType.create({
			data: { companyId: fx.companyId, code: `ET_${uid()}`, nameLao: 'ປະຈຳ' }
		});
		return { it, hr, et };
	}
	async function newEmployee(extra: Record<string, unknown> = {}) {
		const o = await org();
		const res = await post('/employees', fx.admin, {
			employeeCode: `AE_${uid()}`,
			firstNameLao: 'ສົມ',
			lastNameLao: 'ໃຈ',
			startDate: '2024-01-01',
			companyId: fx.companyId,
			departmentId: o.it.id,
			employmentTypeId: o.et.id,
			...extra
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return { emp: res.body.data as { id: string; employeeCode: string }, ...o };
	}

	it('27. employee creation is audited with identifiers only (no national id)', async () => {
		const { emp } = await newEmployee({
			nationalId: 'NID-SECRET-999',
			passportNumber: 'PP-SECRET-1'
		});
		const row = await latest('EMPLOYEE.CREATED', { employeeId: emp.id });
		expect(row).toMatchObject({ entityType: 'EMPLOYEE', companyId: fx.companyId });
		expect(blob(row)).not.toMatch(/NID-SECRET-999|PP-SECRET-1/);
	});

	it('28. an employee edit stores only changed fields; sensitive ones as {changed:true}', async () => {
		const { emp } = await newEmployee({ nationalId: 'NID-OLD-123' });
		const res = await patch(`/employees/${emp.id}`, fx.admin, {
			nickname: 'ນ້ອງ',
			nationalId: 'NID-NEW-456',
			firstNameLao: 'ສົມ'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const row = await latest('EMPLOYEE.UPDATED', { employeeId: emp.id });
		expect(row!.changesJson).toEqual({
			nickname: { before: null, after: 'ນ້ອງ' },
			nationalId: { changed: true }
		});
		expect(blob(row)).not.toMatch(/NID-OLD-123|NID-NEW-456/);
	});

	it('29. an employee edit that changes nothing writes no event', async () => {
		const { emp } = await newEmployee();
		const before = await prisma.auditEvent.count({ where: { employeeId: emp.id } });
		await patch(`/employees/${emp.id}`, fx.admin, { firstNameLao: 'ສົມ' });
		expect(await prisma.auditEvent.count({ where: { employeeId: emp.id } })).toBe(before);
	});

	it('30. a transfer records before → after with readable labels (IT → HR)', async () => {
		const { emp, hr } = await newEmployee();
		const res = await post(`/employees/${emp.id}/transfer`, fx.admin, { departmentId: hr.id });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const row = await latest('EMPLOYEE.TRANSFERRED', { employeeId: emp.id });
		expect(row!.changesJson).toEqual({
			departmentId: {
				before: { id: expect.any(Number), label: 'ໄອທີ' },
				after: { id: hr.id, label: 'ບຸກຄະລາກອນ' }
			}
		});
		expect(row!.actorUserId).toBe(fx.adminUser.id);
	});

	it('31. a status change is audited (no reason text) and can also disable the linked user', async () => {
		const u = await createTestUser({ roleCode: 'EMPLOYEE' });
		const { emp } = await newEmployee({ userId: u.user.id });
		const res = await patch(`/employees/${emp.id}/status`, fx.admin, {
			status: 'RESIGNED',
			endDate: '2026-09-01',
			reason: 'ເຫດຜົນລາອອກລັບ',
			disableLinkedUser: true
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const row = await latest('EMPLOYEE.STATUS_CHANGED', { employeeId: emp.id });
		expect(row!.changesJson).toMatchObject({
			employmentStatus: { before: 'ACTIVE', after: 'RESIGNED' }
		});
		expect(blob(row)).not.toContain('ເຫດຜົນລາອອກລັບ');
		const disabled = await latest('USER.DISABLED', { entityId: String(u.user.id) });
		expect(disabled!.metadataJson).toMatchObject({ via: 'EMPLOYEE_STATUS_CHANGE' });
	});

	it('32. linking and unlinking a user account is audited', async () => {
		const u = await createTestUser({ roleCode: 'EMPLOYEE' });
		const { emp } = await newEmployee();
		await patch(`/employees/${emp.id}`, fx.admin, { userId: u.user.id });
		expect(
			(await latest('EMPLOYEE.USER_LINK_CHANGED', { employeeId: emp.id }))!.changesJson
		).toEqual({
			userId: { before: null, after: u.user.id }
		});
		await patch(`/employees/${emp.id}`, fx.admin, { userId: null });
		const rows = await events({ action: 'EMPLOYEE.USER_LINK_CHANGED', employeeId: emp.id });
		expect(rows).toHaveLength(2);
		expect(rows[1]!.changesJson).toEqual({ userId: { before: u.user.id, after: null } });
	});

	it('33. shift create / update / disable are audited', async () => {
		const res = await post('/shifts', fx.admin, {
			companyId: fx.companyId,
			code: `SH_${uid()}`,
			nameLao: 'ກະທົດສອບ',
			startTime: '08:00',
			endTime: '17:00',
			breakMinutes: 60
		});
		const id = res.body.data.id as string;
		expect(await latest('SHIFT.CREATED', { entityId: String(id) })).toBeTruthy();
		await patch(`/shifts/${id}`, fx.admin, { nameLao: 'ກະໃໝ່' });
		expect((await latest('SHIFT.UPDATED', { entityId: String(id) }))!.changesJson).toEqual({
			nameLao: { before: 'ກະທົດສອບ', after: 'ກະໃໝ່' }
		});
		await patch(`/shifts/${id}`, fx.admin, { status: 'INACTIVE' });
		expect(await latest('SHIFT.DISABLED', { entityId: String(id) })).toBeTruthy();
	});

	it('34. holiday create / update are audited', async () => {
		const res = await post('/holidays', fx.admin, {
			companyId: fx.companyId,
			holidayDate: '2026-12-02',
			nameLao: 'ວັນຊາດ'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const id = res.body.data.id as string;
		expect(await latest('HOLIDAY.CREATED', { entityId: String(id) })).toBeTruthy();
		await patch(`/holidays/${id}`, fx.admin, { nameLao: 'ວັນຊາດ ສປປ ລາວ' });
		expect(await latest('HOLIDAY.UPDATED', { entityId: String(id) })).toBeTruthy();
	});

	it('35. a work location change never stores raw coordinates', async () => {
		const res = await post('/work-locations', fx.admin, {
			companyId: fx.companyId,
			code: `WL_${uid()}`,
			nameLao: 'ສຳນັກງານ',
			latitude: 17.9757,
			longitude: 102.6331,
			radiusMeters: 150
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const id = res.body.data.id as string;
		await patch(`/work-locations/${id}`, fx.admin, { latitude: 18.1111, longitude: 103.2222 });
		const created = await latest('WORK_LOCATION.CREATED', { entityId: String(id) });
		const updated = await latest('WORK_LOCATION.UPDATED', { entityId: String(id) });
		expect(updated!.changesJson).toEqual({
			latitude: { changed: true },
			longitude: { changed: true }
		});
		expect(blob([created, updated])).not.toMatch(/17\.9757|102\.6331|18\.1111|103\.2222/);
	});

	it('36. organisation and position master data are audited', async () => {
		const res = await post('/organization/departments', fx.admin, {
			companyId: fx.companyId,
			code: `D_${uid()}`,
			nameLao: 'ພະແນກໃໝ່'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const row = await latest('ORG.CREATED', { entityId: String(res.body.data.id) });
		expect(row!.metadataJson).toMatchObject({ kind: 'DEPARTMENT' });
		const pos = await post('/positions', fx.admin, {
			companyId: fx.companyId,
			code: `P_${uid()}`,
			nameLao: 'ຕຳແໜ່ງໃໝ່'
		});
		expect(pos.status, JSON.stringify(pos.body)).toBe(201);
		expect(await latest('POSITION.CREATED', { entityId: String(pos.body.data.id) })).toBeTruthy();
	});

	it('37. schedule assignment is audited', async () => {
		const { emp } = await newEmployee();
		const res = await post(`/employees/${emp.id}/schedules`, fx.admin, {
			shiftId: fx.shiftId,
			effectiveFrom: '2026-09-01'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const row = await latest('SCHEDULE.ASSIGNED', { employeeId: emp.id });
		expect(row!.metadataJson).toMatchObject({ shiftId: fx.shiftId, effectiveFrom: '2026-09-01' });
	});

	it('38. leave balance create / update / adjustment are audited (adjustment reason not copied)', async () => {
		const { emp } = await newEmployee();
		const created = await post('/leave-balances', fx.admin, {
			employeeId: emp.id,
			leaveTypeId: fx.leaveTypeId,
			year: 2026,
			entitlementDays: 10
		});
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const id = created.body.data.id as string;
		expect(await latest('LEAVE_BALANCE.CREATED', { entityId: String(id) })).toBeTruthy();
		await patch(`/leave-balances/${id}`, fx.admin, { entitlementDays: 12 });
		expect(
			(await latest('LEAVE_BALANCE.UPDATED', { entityId: String(id) }))!.changesJson
		).toMatchObject({
			entitlementDays: { before: '10', after: '12' }
		});
		const adj = await post(`/leave-balances/${id}/adjustments`, fx.admin, {
			days: 2,
			reason: 'ເຫດຜົນປັບຍອດລັບ'
		});
		expect(adj.status, JSON.stringify(adj.body)).toBe(201);
		const row = await latest('LEAVE_BALANCE.ADJUSTED', { entityId: String(id) });
		expect(row!.changesJson).toEqual({ balanceDays: { before: '12', after: '14' } });
		expect(blob(row)).not.toContain('ເຫດຜົນປັບຍອດລັບ');
	});

	it('39. attendance / overtime policy changes are audited', async () => {
		const att = await patch(`/attendance-policies/${fx.companyId}`, fx.admin, {
			missingCheckOutGraceMinutes: 90
		});
		expect(att.status, JSON.stringify(att.body)).toBe(200);
		const row = await latest('POLICY.UPDATED', {
			entityId: String(fx.companyId),
			metadataJson: { path: '$.policy', equals: 'ATTENDANCE' }
		});
		expect(row!.changesJson).toMatchObject({ missingCheckOutGraceMinutes: { after: 90 } });
		const ot = await agent()
			.put(`/api/v1/overtime-policies?companyId=${fx.companyId}`)
			.set('Cookie', fx.admin)
			.send({ minimumRequestMinutes: 45 });
		expect(ot.status, JSON.stringify(ot.body)).toBe(200);
		expect(
			await latest('POLICY.UPDATED', {
				entityId: String(fx.companyId),
				metadataJson: { path: '$.policy', equals: 'OVERTIME' }
			})
		).toBeTruthy();
	});
});

// ============================================================================================
describe('attendance audit', () => {
	it('40. check-in and check-out are audited with no raw GPS coordinates', async () => {
		const s = await subject();
		at(clockAt(MON, '08:00'));
		const inRes = await post('/attendance/me/check-in', s.cookie, {
			latitude: 17.123456,
			longitude: 102.654321,
			accuracyMeters: 12.5
		});
		expect(inRes.status, JSON.stringify(inRes.body)).toBe(201);
		at(clockAt(MON, '17:00'));
		const outRes = await post('/attendance/me/check-out', s.cookie, {
			latitude: 17.123456,
			longitude: 102.654321,
			accuracyMeters: 12.5
		});
		expect(outRes.status, JSON.stringify(outRes.body)).toBe(200);
		const rows = await events({
			employeeId: s.employee.id,
			action: { in: ['ATTENDANCE.CHECK_IN', 'ATTENDANCE.CHECK_OUT'] }
		});
		expect(rows.map((r) => r.action)).toEqual(['ATTENDANCE.CHECK_IN', 'ATTENDANCE.CHECK_OUT']);
		expect(rows[0]).toMatchObject({ entityType: 'ATTENDANCE', actorUserId: s.user.id });
		expect(blob(rows)).not.toMatch(/17\.123456|102\.654321|12\.5|latitude|longitude/);
	});

	it('41. a refused check-out (not checked in) writes no event', async () => {
		const s = await subject();
		at(clockAt(MON, '17:00'));
		expect((await post('/attendance/me/check-out', s.cookie)).status).toBe(400);
		expect(await prisma.auditEvent.count({ where: { employeeId: s.employee.id } })).toBe(0);
	});
});

// ============================================================================================
describe('leave / overtime / correction / approval audit', () => {
	it('42. leave submission is audited with ids and totals — never the reason', async () => {
		const s = await subject();
		const res = await leaveReq(s);
		expect(res.status).toBe(201);
		const row = await latest('LEAVE.REQUESTED', { entityId: String(res.body.data.id) });
		expect(row).toMatchObject({
			entityType: 'LEAVE_REQUEST',
			employeeId: s.employee.id,
			actorUserId: s.user.id
		});
		expect(row!.metadataJson).toMatchObject({
			targetType: 'LEAVE',
			startDate: MON,
			endDate: MON,
			totalDays: 1
		});
		expect(blob(row)).not.toContain(LEAVE_REASON);
	});

	it('43. an intermediate approval is audited (step + workflow version) and the final one too', async () => {
		const { id, instanceId, inst } = await threeStepLeave();
		await approve(fx.M, instanceId);
		const stepRow = await latest('LEAVE.APPROVAL_STEP_APPROVED', { entityId: String(id) });
		expect(stepRow).toMatchObject({ actorUserId: fx.M.user.id, entityType: 'LEAVE_REQUEST' });
		expect(stepRow!.metadataJson).toMatchObject({
			approvalInstanceId: instanceId,
			stepOrder: 1,
			workflowVersion: inst.workflowVersion
		});
		expect(await latest('LEAVE.APPROVED', { entityId: String(id) })).toBeNull();
		await approve(fx.HR1, instanceId);
		await approve(fx.DIR, instanceId);
		const finalRow = await latest('LEAVE.APPROVED', { entityId: String(id) });
		expect(finalRow).toMatchObject({ actorUserId: fx.DIR.user.id });
		expect(finalRow!.metadataJson).toMatchObject({ finalStepOrder: 3, totalSteps: 3 });
		const generic = await events({
			action: 'APPROVAL.STEP_APPROVED',
			entityId: String(instanceId)
		});
		expect(generic).toHaveLength(3);
		expect(generic[0]!.entityType).toBe('APPROVAL_INSTANCE');
	});

	it('44. a rejection is audited without the rejection note', async () => {
		const { id, instanceId } = await threeStepLeave();
		await approve(fx.M, instanceId);
		expect((await reject(fx.HR1, instanceId, 'ເຫດຜົນປະຕິເສດລັບ-AAA')).status).toBe(200);
		const row = await latest('LEAVE.REJECTED', { entityId: String(id) });
		expect(row).toMatchObject({ actorUserId: fx.HR1.user.id });
		expect(row!.metadataJson).toMatchObject({ rejectedAtStepOrder: 2 });
		const generic = await latest('APPROVAL.STEP_REJECTED', { entityId: String(instanceId) });
		expect(blob([row, generic])).not.toContain('AAA');
	});

	it('45. leave cancellation is audited', async () => {
		const { s, id, instanceId } = await threeStepLeave();
		await post(`/leave/me/requests/${id}/cancel`, s.cookie);
		const row = await latest('LEAVE.CANCELLED', { entityId: String(id) });
		expect(row).toMatchObject({ actorUserId: s.user.id });
		expect(row!.metadataJson).toMatchObject({
			approvalInstanceId: instanceId,
			cancelledAtStepOrder: 1
		});
	});

	it('46. overtime submission, approval and rejection are audited without the reason', async () => {
		await setSteps('OVERTIME', [mgr(1)]);
		const s = await subject();
		const created = await otReq(s);
		const id = created.body.data.id as string;
		const row = await latest('OVERTIME.REQUESTED', { entityId: String(id) });
		expect(row!.metadataJson).toMatchObject({ workDate: MON, plannedMinutes: 120 });
		await approve(fx.M, (await instanceOf('OVERTIME', id)).id);
		expect(await latest('OVERTIME.APPROVED', { entityId: String(id) })).toBeTruthy();
		const s2 = await subject();
		const c2 = await otReq(s2);
		await reject(fx.M, (await instanceOf('OVERTIME', c2.body.data.id)).id);
		expect(await latest('OVERTIME.REJECTED', { entityId: String(c2.body.data.id) })).toBeTruthy();
		expect(blob(await events({ entityType: 'OVERTIME_REQUEST' }))).not.toContain(OT_REASON);
	});

	it('47. correction submission and final approval are audited without the reason', async () => {
		const { id, instanceId } = await correctionCase();
		expect(await latest('ATTENDANCE.CORRECTION_REQUESTED', { entityId: String(id) })).toBeTruthy();
		await approve(fx.M, instanceId);
		expect(
			await latest('ATTENDANCE.APPROVAL_STEP_APPROVED', { entityId: String(id) })
		).toBeTruthy();
		await approve(fx.HR1, instanceId);
		expect(await latest('ATTENDANCE.APPROVED', { entityId: String(id) })).toBeTruthy();
		expect(blob(await events({ entityType: 'ATTENDANCE_CORRECTION' }))).not.toContain(
			CORRECTION_REASON
		);
	});

	it('48. a refused final approval (no balance) leaves no LEAVE.APPROVED event', async () => {
		const { s, id, instanceId } = await threeStepLeave();
		await approve(fx.M, instanceId);
		await approve(fx.HR1, instanceId);
		await prisma.leaveBalance.updateMany({
			where: { employeeId: s.employee.id },
			data: { entitlementDays: '0.00' }
		});
		expect((await approve(fx.DIR, instanceId)).status).toBeGreaterThanOrEqual(400);
		expect(await latest('LEAVE.APPROVED', { entityId: String(id) })).toBeNull();
		expect(
			await events({ action: 'APPROVAL.STEP_APPROVED', entityId: String(instanceId) })
		).toHaveLength(2);
	});

	it('49. reassignment is audited with the assigned user', async () => {
		const { instanceId } = await threeStepLeave();
		const extra = await userWithPermissions(['leave.review', 'employees.view_all']);
		const res = await post(`/approvals/${instanceId}/current-step/reassign`, fx.admin, {
			userId: extra.user.id
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const row = await latest('APPROVAL.STEP_REASSIGNED', { entityId: String(instanceId) });
		expect(row).toMatchObject({ actorUserId: fx.adminUser.id });
		expect(row!.metadataJson).toMatchObject({ assignedUserId: extra.user.id, stepOrder: 1 });
	});

	it('50. workflow edits are audited with version before → after and a safe step summary', async () => {
		const wf = await workflowOf('OVERTIME');
		const res = await patch(`/approval-workflows/${wf.id}`, fx.admin, {
			steps: [mgr(1, 'ຊື່ຂັ້ນຕອນລັບ'), role(fx.hrRoleId, 'HR')]
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const row = await latest('APPROVAL.WORKFLOW_CHANGED', { entityId: String(wf.id) });
		const changes = row!.changesJson as {
			version: { before: number; after: number };
			steps: { after: { approverType: string; stepOrder: number }[] };
		};
		expect(changes.version).toEqual({ before: wf.version, after: wf.version + 1 });
		expect(changes.steps.after.map((s) => s.approverType)).toEqual(['MANAGER', 'ROLE']);
		expect(row!.metadataJson).toMatchObject({
			versionBefore: wf.version,
			versionAfter: wf.version + 1
		});
		expect(blob(row)).not.toContain('ຊື່ຂັ້ນຕອນລັບ'); // step names are free text — not copied
	});

	it('51. an unchanged workflow update (same name) writes no event', async () => {
		const wf = await workflowOf('LEAVE');
		const current = await get(`/approval-workflows/${wf.id}`, fx.admin);
		const before = await prisma.auditEvent.count({ where: { entityId: String(wf.id) } });
		await patch(`/approval-workflows/${wf.id}`, fx.admin, { nameLao: current.body.data.nameLao });
		expect(await prisma.auditEvent.count({ where: { entityId: String(wf.id) } })).toBe(before);
	});
});

// ============================================================================================
describe('audit API — permissions, filters, search', () => {
	it('52. unauthenticated → 401; without audit.view → 403', async () => {
		expect((await agent().get('/api/v1/audit-events')).status).toBe(401);
		expect((await get('/audit-events', fx.plain.cookie)).status).toBe(403);
		expect((await get('/audit-events/abc', fx.plain.cookie)).status).toBe(403);
	});

	it('53. audit.view WITHOUT the company-wide employee scope cannot read the global log', async () => {
		const narrow = await userWithPermissions(['audit.view', 'employees.view']);
		const res = await get('/audit-events', narrow.cookie);
		expect(res.status).toBe(403);
		const row = await latest('AUTH.LOGIN_SUCCESS');
		expect((await get(`/audit-events/${row!.id}`, narrow.cookie)).status).toBe(403);
	});

	it('54. SUPER_ADMIN and HR_ADMIN (seeded roles) can read; MANAGER and EMPLOYEE cannot', async () => {
		const mk = async (roleCode: string) => {
			const u = await createTestUser({ roleCode });
			return loginAndGetCookie(u.username, u.password);
		};
		expect((await get('/audit-events', fx.admin)).status).toBe(200);
		expect((await get('/audit-events', await mk('HR_ADMIN'))).status).toBe(200);
		expect((await get('/audit-events', await mk('MANAGER'))).status).toBe(403);
		expect((await get('/audit-events', await mk('EMPLOYEE'))).status).toBe(403);
	});

	it('55. the list is newest-first and paginated', async () => {
		const res = await get('/audit-events?pageSize=5', fx.admin);
		expect(res.status).toBe(200);
		const items = res.body.data.items as { createdAt: string }[];
		expect(items.length).toBeLessThanOrEqual(5);
		const times = items.map((i) => new Date(i.createdAt).getTime());
		expect([...times].sort((a, b) => b - a)).toEqual(times);
		expect(res.body.data.total).toBeGreaterThan(5);
		const page2 = await get('/audit-events?pageSize=5&page=2', fx.admin);
		expect(page2.body.data.items[0].id).not.toBe(items[0]!.id);
		expect((await get('/audit-events?pageSize=500', fx.admin)).status).toBe(400);
	});

	it('56. filters: action (exact + module), entityType, actor, employee', async () => {
		const s = await subject();
		await leaveReq(s);
		const exact = await get(
			`/audit-events?action=LEAVE.REQUESTED&employeeId=${s.employee.id}`,
			fx.admin
		);
		expect(exact.body.data.total).toBe(1);
		const module = await get(`/audit-events?action=LEAVE&employeeId=${s.employee.id}`, fx.admin);
		expect(
			module.body.data.items.every((i: { action: string }) => i.action.startsWith('LEAVE.'))
		).toBe(true);
		const entity = await get(
			`/audit-events?entityType=LEAVE_REQUEST&employeeId=${s.employee.id}`,
			fx.admin
		);
		expect(entity.body.data.total).toBe(1);
		const actor = await get(`/audit-events?actorUserId=${s.user.id}`, fx.admin);
		expect(
			actor.body.data.items.every((i: { actor: { id: string } }) => i.actor.id === s.user.id)
		).toBe(true);
		expect(actor.body.data.total).toBeGreaterThan(0);
	});

	it('57. date range filter uses the Laos calendar day', async () => {
		const marker = `DATE_${uid()}`;
		const at1 = new Date('2031-05-10T16:30:00Z'); // 23:30 Laos on 10 May
		const at2 = new Date('2031-05-10T17:30:00Z'); // 00:30 Laos on 11 May
		for (const createdAt of [at1, at2]) {
			await prisma.auditEvent.create({
				data: { action: 'TEST.DATE', entityType: 'TEST', entityId: marker, createdAt }
			});
		}
		const may10 = await get(
			`/audit-events?entityType=TEST&search=${marker}&from=2031-05-10&to=2031-05-10`,
			fx.admin
		);
		expect(may10.body.data.total).toBe(1);
		const may11 = await get(
			`/audit-events?entityType=TEST&search=${marker}&from=2031-05-11&to=2031-05-11`,
			fx.admin
		);
		expect(may11.body.data.total).toBe(1);
		const both = await get(
			`/audit-events?entityType=TEST&search=${marker}&from=2031-05-10&to=2031-05-11`,
			fx.admin
		);
		expect(both.body.data.total).toBe(2);
	});

	it('58. search matches action, actor name/username, entity id and employee code/name', async () => {
		const s = await subject();
		const res = await leaveReq(s);
		const id = res.body.data.id as string;
		const byEntity = await get(`/audit-events?search=${id}`, fx.admin);
		expect(
			byEntity.body.data.items.some((i: { entityId: string }) => i.entityId === String(id))
		).toBe(true);
		const byEmployee = await get(`/audit-events?search=${s.employee.employeeCode}`, fx.admin);
		expect(byEmployee.body.data.total).toBeGreaterThan(0);
		const byActor = await get(`/audit-events?search=${s.user.username}`, fx.admin);
		expect(byActor.body.data.total).toBeGreaterThan(0);
		const byAction = await get('/audit-events?search=LEAVE.REQUESTED', fx.admin);
		expect(byAction.body.data.total).toBeGreaterThan(0);
	});

	it('59. search does NOT scan raw metadata', async () => {
		const marker = `META_${uid()}`;
		await writeAuditEvent(prisma, {
			action: 'TEST.META',
			entityType: 'TEST',
			entityId: `X_${uid()}`,
			metadata: { hidden: marker }
		});
		expect((await get(`/audit-events?search=${marker}`, fx.admin)).body.data.total).toBe(0);
	});

	it('60. the detail endpoint returns sanitised changes/metadata and 404 for unknown ids', async () => {
		const u = await createTestUser({ roleCode: 'EMPLOYEE' });
		const { emp } = await (async () => {
			const et = await prisma.employmentType.create({
				data: { companyId: fx.companyId, code: `ET_${uid()}`, nameLao: 'ປະຈຳ' }
			});
			const res = await post('/employees', fx.admin, {
				employeeCode: `AD_${uid()}`,
				firstNameLao: 'ກ',
				lastNameLao: 'ຂ',
				startDate: '2024-01-01',
				companyId: fx.companyId,
				employmentTypeId: et.id,
				userId: u.user.id
			});
			return { emp: res.body.data as { id: string } };
		})();
		await patch(`/employees/${emp.id}`, fx.admin, { nationalId: 'DETAIL-SECRET-1', nickname: 'ນ' });
		const row = await latest('EMPLOYEE.UPDATED', { employeeId: emp.id });
		const res = await get(`/audit-events/${row!.id}`, fx.admin);
		expect(res.status).toBe(200);
		expect(res.body.data.changes.nationalId).toEqual({ changed: true });
		expect(res.body.data.actor).toMatchObject({ id: fx.adminUser.id });
		expect(res.body.data.requestId).toBe(row!.requestId);
		expect(blob(res.body)).not.toContain('DETAIL-SECRET-1');
		expect((await get('/audit-events/2147483647', fx.admin)).status).toBe(404);
		expect((await get('/audit-events/does-not-exist', fx.admin)).status).toBe(400);
	});

	it('61. no listed event exposes a password, hash, token or cookie value', async () => {
		const res = await get('/audit-events?pageSize=100', fx.admin);
		const text = blob(res.body);
		expect(text).not.toMatch(/passwordHash|\$2[aby]\$|hr_session=|ChangeMe123|Password123/);
		const ids = (res.body.data.items as { id: string }[]).slice(0, 20).map((i) => i.id);
		for (const id of ids) {
			const detail = await get(`/audit-events/${id}`, fx.admin);
			expect(blob(detail.body)).not.toMatch(/passwordHash|\$2[aby]\$|hr_session=|Password123/);
		}
	});

	it('62. historical actions before Audit Log existed are not fabricated', async () => {
		// a request created directly in the DB (as a pre-Phase-10 row would be) has no audit history
		const s = await subject();
		const legacy = await prisma.leaveRequest.create({
			data: {
				employeeId: s.employee.id,
				leaveTypeId: fx.leaveTypeId,
				startDate: new Date('2026-09-25T00:00:00Z'),
				endDate: new Date('2026-09-25T00:00:00Z'),
				totalDays: '1.00',
				reason: 'legacy',
				status: 'APPROVED',
				requestedByUserId: s.user.id
			}
		});
		expect(
			await prisma.auditEvent.count({
				where: { entityType: 'LEAVE_REQUEST', entityId: String(legacy.id) }
			})
		).toBe(0);
		expect(randomUUID()).toBeTruthy();
	});
});
