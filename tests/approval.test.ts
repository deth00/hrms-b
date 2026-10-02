import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	agent,
	createTestCompany,
	createTestUser,
	loginAndGetCookie,
	superAdminCookie,
	userWithPermissions
} from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import { setServerClockForTests } from '../src/lib/clock.js';
import { backfillPendingApprovals } from '../src/services/approval.service.js';

const uid = () => randomUUID().slice(0, 6).toUpperCase();
const at = (iso: string) => setServerClockForTests(() => new Date(iso));

// Laos = UTC+7. "Now" is Saturday 2026-09-19 10:00 Laos; Mon 2026-09-21 is a working day.
const NOW = '2026-09-19T03:00:00Z';
const MON = '2026-09-21';
const TUE_0900 = '2026-09-22T02:00:00Z';
const laos = (date: string, hm: string) => `${date}T${hm}:00+07:00`;
const clockAt = (date: string, hm: string) => new Date(laos(date, hm)).toISOString();
beforeEach(() => at(NOW));
afterEach(() => setServerClockForTests(null));

const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const patch = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().patch(`/api/v1${path}`).set('Cookie', cookie).send(body);
const get = (path: string, cookie: string) => agent().get(`/api/v1${path}`).set('Cookie', cookie);

type TargetType = 'LEAVE' | 'OVERTIME' | 'ATTENDANCE_CORRECTION';
const REVIEW = ['leave.review', 'overtime.review', 'attendance_corrections.review'];
const VIEW_ALL = 'employees.view_all';

interface Person {
	user: { id: string };
	cookie: string;
	employee: { id: string; employeeCode: string };
}

let admin: string;
let companyId: string;
let shiftId: string;
let leaveTypeId: string;
let M: Person; // direct manager of every subject
let G: Person; // M's manager (level 2)
let HR1: Person;
let HR2: Person;
let DIR: Person;
let OUT: Person; // an unrelated MANAGER
let hrRoleId: string;
let dirRoleId: string;
let plainUser: { user: { id: string }; cookie: string };

async function mkRole(name: string, codes: string[]) {
	const permissions = await prisma.permission.findMany({ where: { code: { in: codes } } });
	return prisma.role.create({
		data: {
			code: `T9_${name}_${uid()}`,
			name: `Test ${name}`,
			permissions: { create: permissions.map((p) => ({ permissionId: p.id })) }
		}
	});
}

async function mkPerson(opts: {
	roleId?: string;
	roleCode?: string;
	managerEmployeeId?: string | null;
	withEmployee?: boolean;
	status?: 'ACTIVE' | 'INACTIVE';
	company?: string;
}): Promise<Person> {
	const created = await createTestUser({ roleCode: opts.roleCode });
	if (opts.roleId)
		await prisma.userRole.create({ data: { userId: created.user.id, roleId: opts.roleId } });
	const cookie = await loginAndGetCookie(created.username, created.password);
	if (opts.status === 'INACTIVE') {
		await prisma.user.update({ where: { id: created.user.id }, data: { status: 'INACTIVE' } });
	}
	const cid = opts.company ?? companyId;
	const employee = await prisma.employee.create({
		data: {
			employeeCode: `E_${uid()}`,
			firstNameLao: 'ພະນັກງານ',
			lastNameLao: 'ທົດສອບ',
			startDate: new Date('2024-01-01T00:00:00.000Z'),
			companyId: cid,
			userId: opts.withEmployee === false ? null : created.user.id,
			managerEmployeeId: opts.managerEmployeeId ?? null
		}
	});
	await prisma.employeeScheduleAssignment.create({
		data: {
			employeeId: employee.id,
			shiftId,
			effectiveFrom: new Date('2026-01-01T00:00:00.000Z')
		}
	});
	return { user: created.user, cookie, employee };
}

beforeAll(async () => {
	admin = await superAdminCookie();
	const company = await createTestCompany();
	companyId = company.id;
	const shiftRes = await post('/shifts', admin, {
		companyId,
		code: `S_${uid()}`,
		nameLao: 'ກະ',
		startTime: '08:00',
		endTime: '17:00',
		breakMinutes: 60,
		lateGraceMinutes: 5,
		earlyLeaveGraceMinutes: 5
	});
	shiftId = shiftRes.body.data.id;
	const lt = await prisma.leaveType.create({
		data: { companyId, code: `LT_${uid()}`, nameLao: 'ລາພັກ', requiresBalance: true }
	});
	leaveTypeId = lt.id;

	hrRoleId = (await mkRole('HR', [...REVIEW, VIEW_ALL, 'leave.view', 'overtime.view'])).id;
	dirRoleId = (await mkRole('DIR', [...REVIEW, VIEW_ALL, 'leave.view', 'overtime.view'])).id;
	G = await mkPerson({ roleCode: 'MANAGER' });
	M = await mkPerson({ roleCode: 'MANAGER', managerEmployeeId: G.employee.id });
	HR1 = await mkPerson({ roleId: hrRoleId });
	HR2 = await mkPerson({ roleId: hrRoleId });
	DIR = await mkPerson({ roleId: dirRoleId });
	OUT = await mkPerson({ roleCode: 'MANAGER' });
	plainUser = await userWithPermissions(['dashboard.view']);
});

/** an employee reporting to M (level 1) and G (level 2), with a leave balance */
async function subject(opts: { managerEmployeeId?: string | null } = {}): Promise<Person> {
	const s = await mkPerson({
		roleCode: 'EMPLOYEE',
		managerEmployeeId: opts.managerEmployeeId === undefined ? M.employee.id : opts.managerEmployeeId
	});
	await prisma.leaveBalance.create({
		data: { employeeId: s.employee.id, leaveTypeId, year: 2026, entitlementDays: '15.00' }
	});
	return s;
}

// ---------- workflow config helpers ----------
const mgr = (level = 1, nameLao = 'ຫົວໜ້າ') => ({
	nameLao,
	approverType: 'MANAGER',
	managerLevel: level
});
const role = (roleId: string, nameLao = 'ບົດບາດ') => ({ nameLao, approverType: 'ROLE', roleId });
const perm = (targetType: TargetType) => ({
	nameLao: 'ພິຈາລະນາ',
	approverType: 'PERMISSION',
	permissionCode:
		targetType === 'LEAVE'
			? 'leave.review'
			: targetType === 'OVERTIME'
				? 'overtime.review'
				: 'attendance_corrections.review'
});
async function workflowOf(targetType: TargetType, company = companyId) {
	const res = await get(`/approval-workflows?companyId=${company}&targetType=${targetType}`, admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data.items.find((w: { status: string }) => w.status === 'ACTIVE') as {
		id: string;
		version: number;
		steps: unknown[];
	};
}
async function setSteps(targetType: TargetType, steps: Record<string, unknown>[]) {
	const wf = await workflowOf(targetType);
	const res = await patch(`/approval-workflows/${wf.id}`, admin, { steps });
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as { id: string; version: number; steps: { stepOrder: number }[] };
}

// ---------- request helpers ----------
const leaveReq = (s: Person, start = MON, end = MON) =>
	post('/leave/me/requests', s.cookie, {
		leaveTypeId,
		startDate: start,
		endDate: end,
		reason: 'ພັກຜ່ອນ'
	});
const otReq = (s: Person, date = MON) =>
	post('/overtime/me/requests', s.cookie, {
		workDate: date,
		requestedStartAt: laos(date, '17:30'),
		requestedEndAt: laos(date, '19:30'),
		reason: 'ງານດ່ວນ'
	});
async function instanceOf(targetType: TargetType, targetId: string) {
	return prisma.approvalInstance.findUniqueOrThrow({
		// Phase 13: attempts — every Leave / OT / Correction submission is attempt 1
		where: { targetType_targetId_attemptNo: { targetType, targetId, attemptNo: 1 } },
		include: {
			steps: { orderBy: { stepOrder: 'asc' }, include: { candidates: true } }
		}
	});
}
const candidatesOf = (inst: Awaited<ReturnType<typeof instanceOf>>, order: number) =>
	inst.steps.find((s) => s.stepOrder === order)!.candidates.map((c) => c.userId);
const approve = (p: { cookie: string }, instanceId: string, note?: string) =>
	post(`/approvals/${instanceId}/approve`, p.cookie, note ? { note } : {});
const reject = (p: { cookie: string }, instanceId: string, note = 'ບໍ່ອະນຸມັດ') =>
	post(`/approvals/${instanceId}/reject`, p.cookie, { note });
const leaveStatus = async (id: string) =>
	(await prisma.leaveRequest.findUniqueOrThrow({ where: { id } })).status;
const otStatus = async (id: string) =>
	(await prisma.overtimeRequest.findUniqueOrThrow({ where: { id } })).status;

/** a Leave request through the 3-step workflow Manager → HR role → Director role */
async function threeStepLeave() {
	await setSteps('LEAVE', [
		mgr(1, 'ຫົວໜ້າໂດຍກົງ'),
		role(hrRoleId, 'HR'),
		role(dirRoleId, 'ຜູ້ອຳນວຍການ')
	]);
	const s = await subject();
	const created = await leaveReq(s);
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	const id = created.body.data.id as string;
	const inst = await instanceOf('LEAVE', id);
	return { s, id, inst, instanceId: inst.id };
}

// ============================================================================================
describe('workflow configuration', () => {
	it('1. viewing workflows requires approval_workflows.view', async () => {
		expect((await get('/approval-workflows', plainUser.cookie)).status).toBe(403);
		const viewer = await userWithPermissions(['approval_workflows.view']);
		expect((await get(`/approval-workflows?companyId=${companyId}`, viewer.cookie)).status).toBe(
			200
		);
		expect((await agent().get('/api/v1/approval-workflows')).status).toBe(401);
	});

	it('2. editing requires approval_workflows.manage', async () => {
		const viewer = await userWithPermissions(['approval_workflows.view']);
		const wf = await workflowOf('LEAVE');
		expect(
			(await patch(`/approval-workflows/${wf.id}`, viewer.cookie, { nameLao: 'ກ' })).status
		).toBe(403);
		const manager = await userWithPermissions(['approval_workflows.manage']);
		expect(
			(await patch(`/approval-workflows/${wf.id}`, manager.cookie, { nameLao: 'ຂັ້ນຕອນການລາ' }))
				.status
		).toBe(200);
	});

	it('3. every company gets default one-step workflows (also via company creation)', async () => {
		const company = await createTestCompany();
		const list = await get(`/approval-workflows?companyId=${company.id}`, admin);
		expect(list.body.data.total).toBe(3);
		for (const w of list.body.data.items) {
			expect(w).toMatchObject({ status: 'ACTIVE', version: 1 });
			expect(w.steps).toHaveLength(1);
			expect(w.steps[0]).toMatchObject({ approverType: 'PERMISSION' });
		}
		expect(
			list.body.data.items
				.map((w: { steps: { permissionCode: string }[] }) => w.steps[0]!.permissionCode)
				.sort()
		).toEqual(['attendance_corrections.review', 'leave.review', 'overtime.review']);
		// a company created through the API has them immediately
		const created = await post('/organization/companies', admin, {
			code: `NC${uid()}`,
			nameLao: 'ບໍລິສັດໃໝ່'
		});
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		expect(
			await prisma.approvalWorkflow.count({ where: { companyId: created.body.data.id } })
		).toBe(3);
	});

	it('4. only one ACTIVE workflow per company + target', async () => {
		const company = await createTestCompany();
		await get(`/approval-workflows?companyId=${company.id}`, admin); // defaults
		const body = {
			companyId: company.id,
			targetType: 'LEAVE',
			code: `X_${uid()}`,
			nameLao: 'ອີກອັນ',
			steps: [perm('LEAVE')]
		};
		const clash = await post('/approval-workflows', admin, body);
		expect(clash.status).toBe(409);
		expect(clash.body.error.code).toBe('ACTIVE_WORKFLOW_EXISTS');
		const inactive = await post('/approval-workflows', admin, { ...body, status: 'INACTIVE' });
		expect(inactive.status, JSON.stringify(inactive.body)).toBe(201);
		const activate = await patch(`/approval-workflows/${inactive.body.data.id}`, admin, {
			status: 'ACTIVE'
		});
		expect(activate.status).toBe(409);
		expect(
			await prisma.approvalWorkflow.count({
				where: { companyId: company.id, targetType: 'LEAVE', status: 'ACTIVE' }
			})
		).toBe(1);
	});

	it('5. at least one step is required', async () => {
		const wf = await workflowOf('OVERTIME');
		expect((await patch(`/approval-workflows/${wf.id}`, admin, { steps: [] })).status).toBe(400);
	});

	it('6. step order must be sequential and unique', async () => {
		const wf = await workflowOf('OVERTIME');
		const a = { ...perm('OVERTIME'), stepOrder: 1 };
		const b = { ...perm('OVERTIME'), stepOrder: 3 };
		const gap = await patch(`/approval-workflows/${wf.id}`, admin, { steps: [a, b] });
		expect(gap.status).toBe(400);
		expect(gap.body.error.code).toBe('INVALID_STEP_ORDER');
		const dup = await patch(`/approval-workflows/${wf.id}`, admin, { steps: [a, { ...a }] });
		expect(dup.body.error.code).toBe('INVALID_STEP_ORDER');
	});

	it('7. an invalid manager level is rejected', async () => {
		const wf = await workflowOf('OVERTIME');
		for (const managerLevel of [0, -1, 6, 1.5]) {
			expect(
				(
					await patch(`/approval-workflows/${wf.id}`, admin, {
						steps: [{ nameLao: 'ຫົວໜ້າ', approverType: 'MANAGER', managerLevel }]
					})
				).status
			).toBe(400);
		}
		expect(
			(
				await patch(`/approval-workflows/${wf.id}`, admin, {
					steps: [{ nameLao: 'ຫົວໜ້າ', approverType: 'MANAGER' }]
				})
			).status
		).toBe(400);
	});

	it('8. an invalid / missing role is rejected', async () => {
		const wf = await workflowOf('OVERTIME');
		const bad = await patch(`/approval-workflows/${wf.id}`, admin, {
			steps: [role(2147483647 as never)]
		});
		expect(bad.status).toBe(400);
		expect(bad.body.error.code).toBe('INVALID_ROLE');
		// numeric-ID contract: a malformed role id never reaches the lookup
		const malformed = await patch(`/approval-workflows/${wf.id}`, admin, {
			steps: [role('does-not-exist')]
		});
		expect(malformed.status).toBe(400);
		expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
		expect(
			(
				await patch(`/approval-workflows/${wf.id}`, admin, {
					steps: [{ nameLao: 'ບົດບາດ', approverType: 'ROLE' }]
				})
			).status
		).toBe(400);
	});

	it('9. an inactive / unknown user step is rejected', async () => {
		const wf = await workflowOf('OVERTIME');
		const inactive = await mkPerson({ roleCode: 'MANAGER', status: 'INACTIVE' });
		const step = (userId: string) => ({ nameLao: 'ຜູ້ໃຊ້', approverType: 'USER', userId });
		const res = await patch(`/approval-workflows/${wf.id}`, admin, {
			steps: [step(inactive.user.id)]
		});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INVALID_USER');
		expect(
			(await patch(`/approval-workflows/${wf.id}`, admin, { steps: [step(2147483647 as never)] }))
				.body.error.code
		).toBe('INVALID_USER');
		expect(
			(await patch(`/approval-workflows/${wf.id}`, admin, { steps: [step('nobody')] })).body.error
				.code
		).toBe('VALIDATION_ERROR');
	});

	it("10. only the target's review permission can be a PERMISSION step", async () => {
		const wf = await workflowOf('LEAVE');
		const step = (permissionCode: string) => ({
			nameLao: 'ສິດ',
			approverType: 'PERMISSION',
			permissionCode
		});
		for (const code of ['dashboard.view', 'overtime.review', 'leave.self']) {
			const res = await patch(`/approval-workflows/${wf.id}`, admin, { steps: [step(code)] });
			expect(res.status, code).toBe(400);
			expect(res.body.error.code).toBe('INVALID_PERMISSION');
		}
		expect(
			(await patch(`/approval-workflows/${wf.id}`, admin, { steps: [step('leave.review')] })).status
		).toBe(200);
	});

	it('11. editing the steps increments the version', async () => {
		const before = await workflowOf('ATTENDANCE_CORRECTION');
		const after = await setSteps('ATTENDANCE_CORRECTION', [mgr(1), perm('ATTENDANCE_CORRECTION')]);
		expect(after.version).toBe(before.version + 1);
		// a name-only edit does not
		const renamed = await patch(`/approval-workflows/${after.id}`, admin, { nameLao: 'ຊື່ໃໝ່' });
		expect(renamed.body.data.version).toBe(after.version);
		await setSteps('ATTENDANCE_CORRECTION', [perm('ATTENDANCE_CORRECTION')]);
	});

	it('12. an existing instance is unaffected by editing the workflow', async () => {
		const { inst, id } = await threeStepLeave();
		await setSteps('LEAVE', [perm('LEAVE')]);
		const again = await instanceOf('LEAVE', id);
		expect(again.steps).toHaveLength(3);
		expect(again.steps.map((s) => s.approverType)).toEqual(['MANAGER', 'ROLE', 'ROLE']);
		expect(again.workflowVersion).toBe(inst.workflowVersion);
	});

	it('preview (no instance is created) reports whether each step can resolve', async () => {
		await setSteps('LEAVE', [mgr(1), mgr(3, 'ຫົວໜ້າລະດັບ 3')]);
		const s = await subject();
		const res = await get('/approval-workflows/preview?targetType=LEAVE', s.cookie);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data.steps.map((x: { canResolve: boolean }) => x.canResolve)).toEqual([
			true,
			false
		]);
		expect(await prisma.approvalInstance.count({ where: { employeeId: s.employee.id } })).toBe(0);
		await setSteps('LEAVE', [perm('LEAVE')]);
	});
});

// ============================================================================================
describe('manager resolution', () => {
	it('13. the direct manager is the candidate', async () => {
		await setSteps('LEAVE', [mgr(1)]);
		const s = await subject();
		const created = await leaveReq(s);
		expect(candidatesOf(await instanceOf('LEAVE', created.body.data.id), 1)).toEqual([M.user.id]);
	});

	it("14. manager level 2 resolves the manager's manager", async () => {
		await setSteps('LEAVE', [mgr(2)]);
		const s = await subject();
		const created = await leaveReq(s);
		expect(candidatesOf(await instanceOf('LEAVE', created.body.data.id), 1)).toEqual([G.user.id]);
	});

	it('15. a missing manager → APPROVER_NOT_FOUND and nothing is left behind', async () => {
		await setSteps('LEAVE', [mgr(1)]);
		const s = await subject({ managerEmployeeId: null });
		const res = await leaveReq(s);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('APPROVER_NOT_FOUND');
		expect(res.body.error.details).toMatchObject({ stepOrder: 1 });
		expect(await prisma.leaveRequest.count({ where: { employeeId: s.employee.id } })).toBe(0);
		expect(await prisma.approvalInstance.count({ where: { employeeId: s.employee.id } })).toBe(0);
		// level 3 does not exist for a two-level chain
		await setSteps('LEAVE', [mgr(1), mgr(3, 'ລະດັບ 3')]);
		const s2 = await subject();
		const res2 = await leaveReq(s2);
		expect(res2.body.error).toMatchObject({
			code: 'APPROVER_NOT_FOUND',
			details: { stepOrder: 2 }
		});
		await setSteps('LEAVE', [perm('LEAVE')]);
	});

	it('16. a manager employee with no linked user cannot approve', async () => {
		await setSteps('LEAVE', [mgr(1)]);
		const noUser = await mkPerson({ roleCode: 'MANAGER', withEmployee: false });
		const s = await subject({ managerEmployeeId: noUser.employee.id });
		const res = await leaveReq(s);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('APPROVER_NOT_FOUND');
	});

	it('17. an inactive manager user is excluded', async () => {
		await setSteps('LEAVE', [mgr(1)]);
		const inactive = await mkPerson({ roleCode: 'MANAGER', status: 'INACTIVE' });
		const s = await subject({ managerEmployeeId: inactive.employee.id });
		expect((await leaveReq(s)).body.error.code).toBe('APPROVER_NOT_FOUND');
	});

	it('18. the requester is never a candidate of their own workflow', async () => {
		await setSteps('LEAVE', [perm('LEAVE')]);
		// M can review leave AND request it: still excluded for their own request
		await prisma.leaveBalance.create({
			data: { employeeId: M.employee.id, leaveTypeId, year: 2026, entitlementDays: '15.00' }
		});
		const created = await leaveReq(M, '2026-09-22', '2026-09-22');
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const cands = candidatesOf(await instanceOf('LEAVE', created.body.data.id), 1);
		expect(cands).not.toContain(M.user.id);
		expect(cands.length).toBeGreaterThan(0);
		// a manager-level step whose manager IS the requester has nobody left
		await setSteps('LEAVE', [mgr(1)]);
		const selfManaged = await mkPerson({ roleCode: 'MANAGER', managerEmployeeId: null });
		await prisma.leaveBalance.create({
			data: {
				employeeId: selfManaged.employee.id,
				leaveTypeId,
				year: 2026,
				entitlementDays: '15.00'
			}
		});
		expect((await leaveReq(selfManaged)).body.error.code).toBe('APPROVER_NOT_FOUND');
		await setSteps('LEAVE', [perm('LEAVE')]);
	});
});

// ============================================================================================
describe('role / user / permission resolution', () => {
	it('19. role candidates are resolved', async () => {
		await setSteps('LEAVE', [role(hrRoleId)]);
		const s = await subject();
		const created = await leaveReq(s);
		expect(candidatesOf(await instanceOf('LEAVE', created.body.data.id), 1).sort()).toEqual(
			[HR1.user.id, HR2.user.id].sort()
		);
	});

	it('20. a role user without the domain review permission is excluded', async () => {
		const noPerm = await mkRole('NOPERM', [VIEW_ALL, 'leave.self']);
		await mkPerson({ roleId: noPerm.id });
		await setSteps('LEAVE', [role(noPerm.id, 'ບໍ່ມີສິດ')]);
		const s = await subject();
		const res = await leaveReq(s);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('APPROVER_NOT_FOUND');
		await setSteps('LEAVE', [perm('LEAVE')]);
	});

	it('21. a role user outside the employee data scope is excluded (in scope when a manager above)', async () => {
		const scoped = await mkRole('SCOPED', REVIEW);
		const stranger = await mkPerson({ roleId: scoped.id }); // no manager relation, no view_all
		await setSteps('LEAVE', [role(scoped.id, 'ຈຳກັດຂອບເຂດ')]);
		const s = await subject();
		expect((await leaveReq(s)).body.error.code).toBe('APPROVER_NOT_FOUND');
		// the same role, but this person manages the employee → in scope
		const boss = await mkPerson({ roleId: scoped.id, managerEmployeeId: null });
		const s2 = await subject({ managerEmployeeId: boss.employee.id });
		const ok = await leaveReq(s2);
		expect(ok.status, JSON.stringify(ok.body)).toBe(201);
		expect(candidatesOf(await instanceOf('LEAVE', ok.body.data.id), 1)).toEqual([boss.user.id]);
		void stranger;
		await setSteps('LEAVE', [perm('LEAVE')]);
	});

	const userStep = (userId: string) => ({ nameLao: 'ຜູ້ໃຊ້', approverType: 'USER', userId });

	it('22. a specific user is the candidate', async () => {
		await setSteps('LEAVE', [userStep(HR1.user.id)]);
		const s = await subject();
		const created = await leaveReq(s);
		expect(candidatesOf(await instanceOf('LEAVE', created.body.data.id), 1)).toEqual([HR1.user.id]);
		await setSteps('LEAVE', [perm('LEAVE')]);
	});

	it('23. a specific user lacking the review permission cannot be an approver', async () => {
		const nobody = await mkPerson({ roleCode: 'EMPLOYEE' });
		await setSteps('LEAVE', [userStep(nobody.user.id)]);
		const s = await subject();
		const res = await leaveReq(s);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('APPROVER_NOT_FOUND');
		await setSteps('LEAVE', [perm('LEAVE')]);
	});

	it('24. a specific user outside the data scope cannot be an approver', async () => {
		await setSteps('LEAVE', [userStep(OUT.user.id)]);
		const s = await subject(); // OUT is an unrelated manager
		expect((await leaveReq(s)).body.error.code).toBe('APPROVER_NOT_FOUND');
		await setSteps('LEAVE', [perm('LEAVE')]);
	});

	it('25. permission candidates are resolved (everyone holding the review permission in scope)', async () => {
		await setSteps('LEAVE', [perm('LEAVE')]);
		const s = await subject();
		const created = await leaveReq(s);
		const cands = candidatesOf(await instanceOf('LEAVE', created.body.data.id), 1);
		for (const p of [M, G, HR1, HR2, DIR]) expect(cands).toContain(p.user.id);
		expect(cands).not.toContain(s.user.id);
	});

	it('26. permission candidates respect the employee data scope', async () => {
		await setSteps('LEAVE', [perm('LEAVE')]);
		const s = await subject();
		const created = await leaveReq(s);
		const cands = candidatesOf(await instanceOf('LEAVE', created.body.data.id), 1);
		expect(cands).not.toContain(OUT.user.id);
		expect(cands).not.toContain(plainUser.user.id);
	});
});

// ============================================================================================
describe('approval instance', () => {
	it('27. a request creates exactly one approval instance', async () => {
		const { id, inst } = await threeStepLeave();
		expect(inst).toMatchObject({
			status: 'PENDING',
			currentStepOrder: 1,
			targetType: 'LEAVE',
			targetId: id
		});
		expect(inst.workflowVersion).toBeGreaterThan(0);
	});

	it('28. step snapshots are created from the workflow', async () => {
		const { inst } = await threeStepLeave();
		expect(inst.steps.map((s) => [s.stepOrder, s.approverType, s.nameLao])).toEqual([
			[1, 'MANAGER', 'ຫົວໜ້າໂດຍກົງ'],
			[2, 'ROLE', 'HR'],
			[3, 'ROLE', 'ຜູ້ອຳນວຍການ']
		]);
		expect(inst.steps[0]).toMatchObject({ managerLevel: 1 });
		expect(inst.steps[1]!.roleId).toBe(hrRoleId);
	});

	it('29. candidate snapshots are created per step', async () => {
		const { inst } = await threeStepLeave();
		expect(candidatesOf(inst, 1)).toEqual([M.user.id]);
		expect(candidatesOf(inst, 2).sort()).toEqual([HR1.user.id, HR2.user.id].sort());
		expect(candidatesOf(inst, 3)).toEqual([DIR.user.id]);
	});

	it('30. the first step is PENDING', async () => {
		const { inst } = await threeStepLeave();
		expect(inst.steps[0]!.status).toBe('PENDING');
	});

	it('31. later steps are WAITING', async () => {
		const { inst } = await threeStepLeave();
		expect(inst.steps.slice(1).map((s) => s.status)).toEqual(['WAITING', 'WAITING']);
	});

	it('32. one instance per target (unique)', async () => {
		const { id, inst } = await threeStepLeave();
		await expect(
			prisma.approvalInstance.create({
				data: {
					workflowVersion: 1,
					targetType: 'LEAVE',
					targetId: id,
					companyId,
					employeeId: inst.employeeId,
					requesterUserId: inst.requesterUserId
				}
			})
		).rejects.toThrow();
	});
});

// ============================================================================================
describe('sequential approval', () => {
	it('33–36. step by step: manager → HR → director, then APPROVED', async () => {
		const { id, instanceId, s } = await threeStepLeave();

		const r1 = await approve(M, instanceId);
		expect(r1.status, JSON.stringify(r1.body)).toBe(200);
		let inst = await instanceOf('LEAVE', id);
		expect(inst.steps.map((x) => x.status)).toEqual(['APPROVED', 'PENDING', 'WAITING']); // 33
		expect(inst.currentStepOrder).toBe(2);
		expect(await leaveStatus(id)).toBe('PENDING'); // 34

		const r2 = await approve(HR1, instanceId);
		expect(r2.status, JSON.stringify(r2.body)).toBe(200);
		inst = await instanceOf('LEAVE', id);
		expect(inst.steps.map((x) => x.status)).toEqual(['APPROVED', 'APPROVED', 'PENDING']); // 35
		expect(await leaveStatus(id)).toBe('PENDING');

		const r3 = await approve(DIR, instanceId);
		expect(r3.status, JSON.stringify(r3.body)).toBe(200);
		inst = await instanceOf('LEAVE', id);
		expect(inst).toMatchObject({ status: 'APPROVED', currentStepOrder: null }); // 36
		expect(inst.completedAt).toBeTruthy();
		expect(inst.steps.map((x) => x.actedByUserId)).toEqual([M.user.id, HR1.user.id, DIR.user.id]);

		// 37: the domain approval (Phase 7 rules) ran on the final step
		const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
		expect(row).toMatchObject({ status: 'APPROVED', reviewedByUserId: DIR.user.id });
		const balance = await get('/leave/me/balances?year=2026', s.cookie);
		const mine = balance.body.data.items.find(
			(b: { leaveType: { id: string } }) => b.leaveType.id === leaveTypeId
		);
		expect(mine).toMatchObject({ used: 1, available: 14 });
	});

	it('38. a later-step candidate cannot act early', async () => {
		const { instanceId } = await threeStepLeave();
		const res = await approve(DIR, instanceId);
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('NOT_CURRENT_APPROVER');
		expect((await approve(HR1, instanceId)).status).toBe(403);
	});

	it('39. a non-candidate cannot act', async () => {
		const { instanceId } = await threeStepLeave();
		expect((await approve(OUT, instanceId)).status).toBe(403);
		expect((await approve(plainUser, instanceId)).status).toBe(403);
		expect((await reject(plainUser, instanceId)).status).toBe(403);
	});

	it('the step actor list and inbox reflect the advance', async () => {
		const { instanceId } = await threeStepLeave();
		const detail = await get(`/approvals/${instanceId}`, M.cookie);
		expect(detail.body.data).toMatchObject({
			status: 'PENDING',
			canAct: true,
			currentStepOrder: 1
		});
		expect(detail.body.data.steps.map((x: { status: string }) => x.status)).toEqual([
			'PENDING',
			'WAITING',
			'WAITING'
		]);
	});
});

// ============================================================================================
describe('rejection', () => {
	it('40–44. any current step may reject: instance REJECTED, future steps CANCELLED, domain REJECTED, note required', async () => {
		const { id, instanceId } = await threeStepLeave();
		const noNote = await post(`/approvals/${instanceId}/reject`, M.cookie, {});
		expect(noNote.status).toBe(400); // 44
		expect((await post(`/approvals/${instanceId}/reject`, M.cookie, { note: '  ' })).status).toBe(
			400
		);

		const res = await reject(M, instanceId, 'ບໍ່ເໝາະສົມ');
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const inst = await instanceOf('LEAVE', id);
		expect(inst.steps.map((x) => x.status)).toEqual(['REJECTED', 'CANCELLED', 'CANCELLED']); // 40, 42
		expect(inst.status).toBe('REJECTED'); // 41
		expect(inst.steps[0]).toMatchObject({ actedByUserId: M.user.id, actionNote: 'ບໍ່ເໝາະສົມ' });
		const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
		expect(row).toMatchObject({ status: 'REJECTED', reviewNote: 'ບໍ່ເໝາະສົມ' }); // 43
		// no later step can act
		expect((await approve(HR1, instanceId)).status).toBe(409);
	});
});

describe('requester exclusion', () => {
	it('45–46. a reviewer who is also the requester is not a candidate and cannot approve their own request', async () => {
		await setSteps('LEAVE', [perm('LEAVE')]);
		const both = await userWithPermissions([
			'leave.self',
			'leave.view',
			'leave.review',
			'employees.view_all'
		]);
		const emp = await prisma.employee.create({
			data: {
				employeeCode: `E_${uid()}`,
				firstNameLao: 'ຜູ້ຂໍ',
				lastNameLao: 'ທົດສອບ',
				startDate: new Date('2024-01-01T00:00:00.000Z'),
				companyId,
				userId: both.user.id
			}
		});
		await prisma.employeeScheduleAssignment.create({
			data: { employeeId: emp.id, shiftId, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') }
		});
		await prisma.leaveBalance.create({
			data: { employeeId: emp.id, leaveTypeId, year: 2026, entitlementDays: '15.00' }
		});
		const created = await post('/leave/me/requests', both.cookie, {
			leaveTypeId,
			startDate: MON,
			endDate: MON,
			reason: 'ພັກ'
		});
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const inst = await instanceOf('LEAVE', created.body.data.id);
		expect(candidatesOf(inst, 1)).not.toContain(both.user.id); // 45
		const own = await approve(both, inst.id);
		expect(own.status).toBe(403); // 46
		const legacy = await post(`/leave/requests/${created.body.data.id}/approve`, both.cookie, {});
		expect(legacy.body.error.code).toBe('CANNOT_REVIEW_OWN_LEAVE');
	});
});

// ============================================================================================
describe('concurrency', () => {
	it('47–48. two candidates approving the same step at once: one wins, the workflow advances once', async () => {
		await setSteps('LEAVE', [role(hrRoleId, 'HR'), role(dirRoleId, 'ຜູ້ອຳນວຍການ')]);
		const s = await subject();
		const created = await leaveReq(s);
		const inst = await instanceOf('LEAVE', created.body.data.id);
		const [a, b] = await Promise.all([approve(HR1, inst.id), approve(HR2, inst.id)]);
		const codes = [a, b].map((r) => r.status).sort();
		expect(codes).toEqual([200, 409]);
		const loser = a.status === 409 ? a : b;
		expect(loser.body.error.code).toBe('APPROVAL_STEP_ALREADY_ACTIONED'); // 47
		const after = await instanceOf('LEAVE', created.body.data.id);
		expect(after.steps.map((x) => x.status)).toEqual(['APPROVED', 'PENDING']); // 48
		expect(after.currentStepOrder).toBe(2);
		expect(after.steps.filter((x) => x.actedByUserId).length).toBe(1);
		expect(await leaveStatus(created.body.data.id)).toBe('PENDING');
	});
});

// ============================================================================================
describe('leave through the workflow', () => {
	it('49. multi-step leave stays PENDING after the manager', async () => {
		const { id, instanceId } = await threeStepLeave();
		await approve(M, instanceId);
		expect(await leaveStatus(id)).toBe('PENDING');
		const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
		expect(row.reviewedByUserId).toBeNull(); // the domain reviewer is only set on FINAL approval
	});

	it('50. the final leave approval validates the balance', async () => {
		const { id, instanceId } = await threeStepLeave();
		await approve(M, instanceId);
		await approve(HR1, instanceId);
		expect((await approve(DIR, instanceId)).status).toBe(200);
		expect(await leaveStatus(id)).toBe('APPROVED');
	});

	it('51. insufficient balance on the final step rolls the workflow action back', async () => {
		const { id, instanceId, s } = await threeStepLeave();
		await approve(M, instanceId);
		await approve(HR1, instanceId);
		// the entitlement is reduced after submission: 1 day requested, 0 available
		await prisma.leaveBalance.updateMany({
			where: { employeeId: s.employee.id },
			data: { entitlementDays: '0.00' }
		});
		const res = await approve(DIR, instanceId);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INSUFFICIENT_LEAVE_BALANCE');
		const inst = await instanceOf('LEAVE', id);
		expect(inst.status).toBe('PENDING');
		expect(inst.steps.map((x) => x.status)).toEqual(['APPROVED', 'APPROVED', 'PENDING']);
		expect(inst.steps[2]!.actedByUserId).toBeNull();
		expect(await leaveStatus(id)).toBe('PENDING');
	});

	it('52. leave rejection through the workflow frees the dates', async () => {
		const { id, instanceId } = await threeStepLeave();
		await approve(M, instanceId);
		expect((await reject(HR1, instanceId, 'ບໍ່ພໍສິດ')).status).toBe(200);
		expect(await leaveStatus(id)).toBe('REJECTED');
		expect(
			await prisma.leaveRequestDay.count({
				where: { leaveRequestId: id, activeKey: { not: null } }
			})
		).toBe(0);
		const inst = await instanceOf('LEAVE', id);
		expect(inst.steps.map((x) => x.status)).toEqual(['APPROVED', 'REJECTED', 'CANCELLED']);
	});

	it('53. cancelling a leave request cancels the workflow', async () => {
		const { id, instanceId, s } = await threeStepLeave();
		await approve(M, instanceId);
		const res = await post(`/leave/me/requests/${id}/cancel`, s.cookie);
		expect(res.status).toBe(200);
		const inst = await instanceOf('LEAVE', id);
		expect(inst.status).toBe('CANCELLED');
		expect(inst.steps.map((x) => x.status)).toEqual(['APPROVED', 'CANCELLED', 'CANCELLED']); // 80, 81
		expect(await leaveStatus(id)).toBe('CANCELLED');
		expect((await approve(HR1, instanceId)).status).toBe(409);
	});

	it('82. a completed workflow cannot be cancelled', async () => {
		await setSteps('LEAVE', [perm('LEAVE')]);
		const s = await subject();
		const created = await leaveReq(s);
		const inst = await instanceOf('LEAVE', created.body.data.id);
		expect((await approve(HR1, inst.id)).status).toBe(200);
		const cancel = await post(`/leave/me/requests/${created.body.data.id}/cancel`, s.cookie);
		expect(cancel.status).toBe(409);
		expect((await instanceOf('LEAVE', created.body.data.id)).status).toBe('APPROVED');
	});
});

// ============================================================================================
describe('overtime through the workflow', () => {
	async function twoStepOt() {
		await setSteps('OVERTIME', [mgr(1), role(hrRoleId, 'HR')]);
		const s = await subject();
		const created = await otReq(s);
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		return {
			s,
			id: created.body.data.id as string,
			instanceId: (await instanceOf('OVERTIME', created.body.data.id)).id
		};
	}

	it('54. multi-step OT: PENDING after the manager, APPROVED after HR', async () => {
		const { id, instanceId } = await twoStepOt();
		expect((await approve(M, instanceId)).status).toBe(200);
		expect(await otStatus(id)).toBe('PENDING');
		expect((await approve(HR1, instanceId)).status).toBe(200);
		expect(await otStatus(id)).toBe('APPROVED');
		expect((await instanceOf('OVERTIME', id)).status).toBe('APPROVED');
	});

	it('55. a leave conflict on the final OT step rolls the action back', async () => {
		const { id, instanceId, s } = await twoStepOt();
		await approve(M, instanceId);
		const day = new Date(`${MON}T00:00:00Z`);
		const leave = await prisma.leaveRequest.create({
			data: {
				employeeId: s.employee.id,
				leaveTypeId,
				startDate: day,
				endDate: day,
				totalDays: '1.00',
				reason: 'ລາ',
				status: 'APPROVED',
				requestedByUserId: s.user.id
			}
		});
		await prisma.leaveRequestDay.create({
			data: {
				leaveRequestId: leave.id,
				employeeId: s.employee.id,
				leaveDate: day,
				activeKey: `${s.employee.id}:${MON}`
			}
		});
		const res = await approve(HR1, instanceId);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('APPROVED_LEAVE_DAY');
		const inst = await instanceOf('OVERTIME', id);
		expect(inst.status).toBe('PENDING');
		expect(inst.steps.map((x) => x.status)).toEqual(['APPROVED', 'PENDING']);
		expect(await otStatus(id)).toBe('PENDING');
	});

	it('56. OT rejection through the workflow', async () => {
		const { id, instanceId } = await twoStepOt();
		expect((await reject(M, instanceId, 'ບໍ່ຈຳເປັນ')).status).toBe(200);
		expect(await otStatus(id)).toBe('REJECTED');
		expect(
			(await prisma.overtimeRequest.findUniqueOrThrow({ where: { id } })).activeKey
		).toBeNull();
	});

	it('57. OT cancellation cancels the workflow', async () => {
		const { id, instanceId, s } = await twoStepOt();
		await approve(M, instanceId);
		expect((await post(`/overtime/me/requests/${id}/cancel`, s.cookie)).status).toBe(200);
		const inst = await instanceOf('OVERTIME', id);
		expect(inst.status).toBe('CANCELLED');
		expect(inst.steps.map((x) => x.status)).toEqual(['APPROVED', 'CANCELLED']);
		expect(await otStatus(id)).toBe('CANCELLED');
	});
});

// ============================================================================================
describe('attendance correction through the workflow', () => {
	/** worked Monday 08:00 → 18:00, then asks (on Tuesday) to correct the check-out to 19:00 */
	async function correctionCase(withOt = false) {
		const s = await subject();
		let otId: string | null = null;
		if (withOt) {
			await setSteps('OVERTIME', [perm('OVERTIME')]);
			const ot = await otReq(s);
			expect(ot.status, JSON.stringify(ot.body)).toBe(201);
			otId = ot.body.data.id;
			expect((await approve(HR1, (await instanceOf('OVERTIME', otId!)).id)).status).toBe(200);
		}
		at(clockAt(MON, '08:00'));
		expect((await post('/attendance/me/check-in', s.cookie)).status).toBe(201);
		at(clockAt(MON, '18:00'));
		expect((await post('/attendance/me/check-out', s.cookie)).status).toBe(200);
		at(TUE_0900);
		await setSteps('ATTENDANCE_CORRECTION', [mgr(1), role(hrRoleId, 'HR')]);
		const corr = await post('/attendance/me/corrections', s.cookie, {
			workDate: MON,
			type: 'TIME_ADJUSTMENT',
			requestedCheckOutAt: laos(MON, '19:00'),
			reason: 'ລືມ Check-out ຕາມເວລາຈິງ'
		});
		expect(corr.status, JSON.stringify(corr.body)).toBe(201);
		const id = corr.body.data.id as string;
		return { s, id, otId, instanceId: (await instanceOf('ATTENDANCE_CORRECTION', id)).id };
	}

	it('58. the overlay is applied only after the FINAL step', async () => {
		const { id, instanceId } = await correctionCase();
		expect((await approve(M, instanceId)).status).toBe(200);
		expect(
			await prisma.attendanceCorrectionApplication.count({ where: { correctionRequestId: id } })
		).toBe(0);
		expect(
			(await prisma.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id } })).status
		).toBe('PENDING');
		expect((await approve(HR1, instanceId)).status).toBe(200);
		expect(
			await prisma.attendanceCorrectionApplication.count({ where: { correctionRequestId: id } })
		).toBe(1);
		expect(
			(await prisma.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id } })).status
		).toBe('APPROVED');
	});

	it('59. the final approval recalculates attendance (raw punches untouched)', async () => {
		const { s, instanceId } = await correctionCase();
		await approve(M, instanceId);
		await approve(HR1, instanceId);
		const rec = await prisma.attendanceRecord.findFirstOrThrow({
			where: { employeeId: s.employee.id }
		});
		expect(rec.effectiveCheckOutAt?.toISOString()).toBe(new Date(laos(MON, '19:00')).toISOString());
		expect(rec.lastCheckOutAt?.toISOString()).toBe(new Date(laos(MON, '18:00')).toISOString());
		expect(rec.isCorrected).toBe(true);
		expect(await prisma.attendancePunch.count({ where: { employeeId: s.employee.id } })).toBe(2);
	});

	it('60. the final approval recalculates approved OT (30 → 90 minutes)', async () => {
		const { otId, instanceId } = await correctionCase(true);
		expect(
			(await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: otId! } })).eligibleMinutes
		).toBe(30);
		await approve(M, instanceId);
		expect(
			(await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: otId! } })).eligibleMinutes
		).toBe(30);
		await approve(HR1, instanceId);
		expect(
			(await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: otId! } })).eligibleMinutes
		).toBe(90);
	});

	it('61. correction rejection through the workflow', async () => {
		const { id, instanceId } = await correctionCase();
		expect((await reject(M, instanceId, 'ເວລາບໍ່ຖືກ')).status).toBe(200);
		const row = await prisma.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id } });
		expect(row).toMatchObject({ status: 'REJECTED', pendingKey: null, reviewNote: 'ເວລາບໍ່ຖືກ' });
		expect(
			await prisma.attendanceCorrectionApplication.count({ where: { correctionRequestId: id } })
		).toBe(0);
	});

	it('62. correction cancellation cancels the workflow', async () => {
		const { id, s, instanceId } = await correctionCase();
		await approve(M, instanceId);
		expect((await post(`/attendance/me/corrections/${id}/cancel`, s.cookie)).status).toBe(200);
		const inst = await instanceOf('ATTENDANCE_CORRECTION', id);
		expect(inst.status).toBe('CANCELLED');
		expect(inst.steps.map((x) => x.status)).toEqual(['APPROVED', 'CANCELLED']);
	});
});

// ============================================================================================
describe('workflow versions', () => {
	it('63–66. a request keeps the version (and steps) it started on', async () => {
		const first = await setSteps('LEAVE', [
			mgr(1),
			role(hrRoleId, 'HR'),
			role(dirRoleId, 'ຜູ້ອຳນວຍການ')
		]);
		const a = await leaveReq(await subject());
		const instA = await instanceOf('LEAVE', a.body.data.id);
		expect(instA.workflowVersion).toBe(first.version); // 63

		const second = await setSteps('LEAVE', [mgr(1), role(hrRoleId, 'HR')]); // remove the director
		expect(second.version).toBe(first.version + 1); // 64
		const againA = await instanceOf('LEAVE', a.body.data.id);
		expect(againA.steps).toHaveLength(3); // 65
		expect(againA.workflowVersion).toBe(first.version);

		const b = await leaveReq(await subject());
		const instB = await instanceOf('LEAVE', b.body.data.id);
		expect(instB.workflowVersion).toBe(second.version); // 66
		expect(instB.steps).toHaveLength(2);
		// the API shows the version each request was created under
		const detail = await get(`/approvals/${instA.id}`, HR1.cookie);
		expect(detail.body.data.workflow.versionUsed).toBe(first.version);
		await setSteps('LEAVE', [perm('LEAVE')]);
	});
});

// ============================================================================================
describe('legacy pending backfill', () => {
	async function legacyLeave(status: 'PENDING' | 'APPROVED' = 'PENDING') {
		await setSteps('LEAVE', [perm('LEAVE')]);
		const s = await subject();
		const day = new Date('2026-09-23T00:00:00Z');
		const req = await prisma.leaveRequest.create({
			data: {
				employeeId: s.employee.id,
				leaveTypeId,
				startDate: day,
				endDate: day,
				totalDays: '1.00',
				reason: 'ເກົ່າ',
				status,
				requestedByUserId: s.user.id
			}
		});
		await prisma.leaveRequestDay.create({
			data: {
				leaveRequestId: req.id,
				employeeId: s.employee.id,
				leaveDate: day,
				activeKey: status === 'PENDING' ? `${s.employee.id}:2026-09-23` : null
			}
		});
		return { s, req };
	}

	it('67. a pending legacy leave request is backfilled (and can then be approved)', async () => {
		const { req } = await legacyLeave();
		expect(await prisma.approvalInstance.count({ where: { targetId: req.id } })).toBe(0);
		await backfillPendingApprovals();
		const inst = await instanceOf('LEAVE', req.id);
		expect(inst).toMatchObject({ status: 'PENDING', currentStepOrder: 1 });
		expect((await approve(HR1, inst.id)).status).toBe(200);
		expect(await leaveStatus(req.id)).toBe('APPROVED');
	});

	it('68. a pending legacy OT request is backfilled', async () => {
		await setSteps('OVERTIME', [perm('OVERTIME')]);
		const s = await subject();
		const start = new Date(laos(MON, '17:30'));
		const end = new Date(laos(MON, '19:30'));
		const req = await prisma.overtimeRequest.create({
			data: {
				employeeId: s.employee.id,
				workDate: new Date(`${MON}T00:00:00Z`),
				type: 'AFTER_SHIFT',
				requestedStartAt: start,
				requestedEndAt: end,
				plannedMinutes: 120,
				reason: 'ເກົ່າ',
				status: 'PENDING',
				requestedByUserId: s.user.id,
				isWorkingDay: true,
				activeKey: `${s.employee.id}:${MON}:AFTER_SHIFT`
			}
		});
		await backfillPendingApprovals();
		expect(await instanceOf('OVERTIME', req.id)).toMatchObject({ status: 'PENDING' });
	});

	it('69. a pending legacy correction request is backfilled', async () => {
		await setSteps('ATTENDANCE_CORRECTION', [perm('ATTENDANCE_CORRECTION')]);
		const s = await subject();
		const req = await prisma.attendanceCorrectionRequest.create({
			data: {
				employeeId: s.employee.id,
				workDate: new Date('2026-09-18T00:00:00Z'),
				type: 'MISSING_BOTH',
				requestedCheckInAt: new Date(laos('2026-09-18', '08:00')),
				requestedCheckOutAt: new Date(laos('2026-09-18', '17:00')),
				reason: 'ເກົ່າ',
				status: 'PENDING',
				pendingKey: `${s.employee.id}:2026-09-18`,
				requestedByUserId: s.user.id
			}
		});
		await backfillPendingApprovals();
		expect(await instanceOf('ATTENDANCE_CORRECTION', req.id)).toMatchObject({ status: 'PENDING' });
	});

	it('70. completed legacy requests are not backfilled', async () => {
		const { req } = await legacyLeave('APPROVED');
		await backfillPendingApprovals();
		expect(await prisma.approvalInstance.count({ where: { targetId: req.id } })).toBe(0);
	});

	it('71. the backfill is idempotent', async () => {
		const { req } = await legacyLeave();
		const first = await backfillPendingApprovals();
		expect(first.created).toBeGreaterThanOrEqual(1);
		const before = await prisma.approvalInstance.count({ where: { targetId: req.id } });
		const second = await backfillPendingApprovals();
		expect(second.created).toBe(0);
		expect(await prisma.approvalInstance.count({ where: { targetId: req.id } })).toBe(before);
	});

	it('a legacy pending request without an instance is upgraded on demand by the legacy endpoint', async () => {
		const { req } = await legacyLeave();
		const res = await post(`/leave/requests/${req.id}/approve`, HR1.cookie, {});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(await leaveStatus(req.id)).toBe('APPROVED');
	});
});

// ============================================================================================
describe('inbox and history', () => {
	it("72–73. only the CURRENT step's candidates see the item; the next candidate sees it afterwards", async () => {
		const { instanceId } = await threeStepLeave();
		const mine = await get('/approvals/inbox?pageSize=100', M.cookie);
		expect(mine.body.data.items.map((i: { id: string }) => i.id)).toContain(instanceId);
		const item = mine.body.data.items.find((i: { id: string }) => i.id === instanceId);
		expect(item).toMatchObject({
			targetType: 'LEAVE',
			currentStep: { stepOrder: 1 },
			totalSteps: 3
		});
		expect(item.summary.details.totalDays).toBe(1);
		for (const p of [HR1, DIR]) {
			const other = await get('/approvals/inbox?pageSize=100', p.cookie);
			expect(other.body.data.items.map((i: { id: string }) => i.id)).not.toContain(instanceId); // 73
		}
		await approve(M, instanceId);
		expect(
			(await get('/approvals/inbox?pageSize=100', M.cookie)).body.data.items.map(
				(i: { id: string }) => i.id
			)
		).not.toContain(instanceId);
		expect(
			(await get('/approvals/inbox?pageSize=100', HR1.cookie)).body.data.items.map(
				(i: { id: string }) => i.id
			)
		).toContain(instanceId);
	});

	it('74. history lists the instances the user acted on', async () => {
		const { instanceId } = await threeStepLeave();
		await approve(M, instanceId);
		const hist = await get('/approvals/history?pageSize=100', M.cookie);
		const row = hist.body.data.items.find((i: { id: string }) => i.id === instanceId);
		expect(row).toBeTruthy();
		expect(row.myAction).toMatchObject({ stepOrder: 1, action: 'APPROVED' });
		expect(
			(await get('/approvals/history?action=REJECTED&pageSize=100', M.cookie)).body.data.items.map(
				(i: { id: string }) => i.id
			)
		).not.toContain(instanceId);
		expect(
			(await get('/approvals/history?pageSize=100', HR2.cookie)).body.data.items.map(
				(i: { id: string }) => i.id
			)
		).not.toContain(instanceId);
	});

	it('75. the inbox can be filtered by target type', async () => {
		await setSteps('OVERTIME', [mgr(1)]);
		await setSteps('LEAVE', [mgr(1)]);
		const s = await subject();
		const l = await leaveReq(s);
		const o = await otReq(s, '2026-09-22');
		const both = (await get('/approvals/inbox?pageSize=100', M.cookie)).body.data.items.map(
			(i: { targetId: string }) => i.targetId
		);
		expect(both).toEqual(expect.arrayContaining([l.body.data.id, o.body.data.id]));
		const onlyOt = (await get('/approvals/inbox?targetType=OVERTIME&pageSize=100', M.cookie)).body
			.data.items;
		expect(onlyOt.every((i: { targetType: string }) => i.targetType === 'OVERTIME')).toBe(true);
		expect(onlyOt.map((i: { targetId: string }) => i.targetId)).toContain(o.body.data.id);
		expect(onlyOt.map((i: { targetId: string }) => i.targetId)).not.toContain(l.body.data.id);
		await setSteps('OVERTIME', [perm('OVERTIME')]);
		await setSteps('LEAVE', [perm('LEAVE')]);
	});

	it('76. the inbox is paginated', async () => {
		await setSteps('LEAVE', [mgr(1)]);
		for (let i = 0; i < 3; i++) await leaveReq(await subject());
		const p1 = await get('/approvals/inbox?pageSize=2&page=1', M.cookie);
		expect(p1.body.data.items).toHaveLength(2);
		expect(p1.body.data.total).toBeGreaterThanOrEqual(3);
		expect(p1.body.data.totalPages).toBeGreaterThanOrEqual(2);
		const p2 = await get('/approvals/inbox?pageSize=2&page=2', M.cookie);
		expect(p2.body.data.items.length).toBeGreaterThanOrEqual(1);
		expect(p2.body.data.items[0].id).not.toBe(p1.body.data.items[0].id);
		await setSteps('LEAVE', [perm('LEAVE')]);
	});
});

// ============================================================================================
describe('blocked steps and permission changes', () => {
	it('77. a candidate who became inactive can no longer act', async () => {
		await setSteps('LEAVE', [mgr(1)]);
		const boss = await mkPerson({ roleCode: 'MANAGER' });
		const s = await subject({ managerEmployeeId: boss.employee.id });
		const created = await leaveReq(s);
		const inst = await instanceOf('LEAVE', created.body.data.id);
		await prisma.user.update({ where: { id: boss.user.id }, data: { status: 'INACTIVE' } });
		const res = await approve(boss, inst.id);
		expect([401, 403]).toContain(res.status);
		expect((await instanceOf('LEAVE', created.body.data.id)).status).toBe('PENDING');
		await setSteps('LEAVE', [perm('LEAVE')]);
	});

	it('78. a candidate who lost the review permission can no longer act', async () => {
		const temp = await mkRole('TEMP', [...REVIEW, VIEW_ALL]);
		await setSteps('LEAVE', [role(temp.id, 'ຊົ່ວຄາວ')]);
		const reviewer = await mkPerson({ roleId: temp.id });
		const s = await subject();
		const created = await leaveReq(s);
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const inst = await instanceOf('LEAVE', created.body.data.id);
		expect(candidatesOf(inst, 1)).toEqual([reviewer.user.id]);
		await prisma.rolePermission.deleteMany({ where: { roleId: temp.id } });
		const res = await approve(reviewer, inst.id);
		expect(res.status).toBe(403);
		expect((await get('/approvals/inbox', reviewer.cookie)).body.data.items).toHaveLength(0);
		await setSteps('LEAVE', [perm('LEAVE')]);
	});

	it('79. a blocked step is reported (never skipped) and an admin can add an approver', async () => {
		await setSteps('LEAVE', [mgr(1)]);
		const boss = await mkPerson({ roleCode: 'MANAGER' });
		const s = await subject({ managerEmployeeId: boss.employee.id });
		const created = await leaveReq(s);
		const inst = await instanceOf('LEAVE', created.body.data.id);
		await prisma.user.update({ where: { id: boss.user.id }, data: { status: 'INACTIVE' } });

		const detail = await get(`/approvals/${inst.id}`, admin);
		expect(detail.status, JSON.stringify(detail.body)).toBe(200);
		expect(detail.body.data.currentStep).toMatchObject({
			stepOrder: 1,
			blocked: true,
			blockedCode: 'APPROVAL_STEP_BLOCKED'
		});
		expect(detail.body.data.currentStep.candidates[0]).toMatchObject({ active: false });
		expect((await instanceOf('LEAVE', created.body.data.id)).steps[0]!.status).toBe('PENDING');

		// reassignment: only users who could approve at all (permission + scope + not the requester)
		const bad = await post(`/approvals/${inst.id}/current-step/reassign`, admin, {
			userId: plainUser.user.id
		});
		expect(bad.status).toBe(400);
		expect(
			(
				await post(`/approvals/${inst.id}/current-step/reassign`, HR1.cookie, {
					userId: HR2.user.id
				})
			).status
		).toBe(403);
		const ok = await post(`/approvals/${inst.id}/current-step/reassign`, admin, {
			userId: HR1.user.id
		});
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const added = await prisma.approvalStepCandidate.findFirstOrThrow({
			where: { approvalStepInstanceId: inst.steps[0]!.id, userId: HR1.user.id }
		});
		expect(added.assignedByUserId).toBeTruthy();
		expect(
			await prisma.approvalStepCandidate.count({
				where: { approvalStepInstanceId: inst.steps[0]!.id }
			})
		).toBe(2); // old candidate kept
		expect((await approve(HR1, inst.id)).status).toBe(200);
		expect(await leaveStatus(created.body.data.id)).toBe('APPROVED');
		await setSteps('LEAVE', [perm('LEAVE')]);
	});
});

// ============================================================================================
describe('detail access and summaries', () => {
	it('the requester sees the progress (no candidates), an unrelated user is refused', async () => {
		const { instanceId, s } = await threeStepLeave();
		const own = await get(`/approvals/${instanceId}`, s.cookie);
		expect(own.status).toBe(200);
		expect(own.body.data).toMatchObject({ isRequester: true, canAct: false, context: null });
		expect(own.body.data.currentStep.candidates).toEqual([]);
		expect(own.body.data.steps).toHaveLength(3);
		expect((await get(`/approvals/${instanceId}`, plainUser.cookie)).status).toBe(403);
		expect((await get(`/approvals/${instanceId}`, OUT.cookie)).status).toBe(403);
		const reviewer = await get(`/approvals/${instanceId}`, M.cookie);
		expect(reviewer.body.data).toMatchObject({ canAct: true });
		expect(reviewer.body.data.context).toBeTruthy(); // the rich domain context (balances, warnings)
	});

	it('domain responses carry a compact workflow summary', async () => {
		const { id, s } = await threeStepLeave();
		const mine = await get(`/leave/me/requests/${id}`, s.cookie);
		expect(mine.body.data.approval).toMatchObject({
			workflowName: expect.any(String),
			currentStep: 1,
			totalSteps: 3,
			status: 'PENDING'
		});
		const list = await get('/leave/me/requests', s.cookie);
		expect(list.body.data.items[0].approval).toMatchObject({ totalSteps: 3 });
		const reviewer = await get(`/leave/requests/${id}`, M.cookie);
		expect(reviewer.body.data).toMatchObject({ canReview: true });
		expect((await get(`/leave/requests/${id}`, HR1.cookie)).body.data.canReview).toBe(false); // not their step yet
	});

	it('the legacy approve endpoint cannot bypass the workflow', async () => {
		const { id, instanceId } = await threeStepLeave();
		const early = await post(`/leave/requests/${id}/approve`, HR1.cookie, {});
		expect(early.status).toBe(403); // HR is a step-2 candidate, not step 1
		expect(await leaveStatus(id)).toBe('PENDING');
		const first = await post(`/leave/requests/${id}/approve`, M.cookie, {});
		expect(first.status).toBe(200);
		expect(await leaveStatus(id)).toBe('PENDING'); // still one step short of three
		expect((await instanceOf('LEAVE', id)).currentStepOrder).toBe(2);
		void instanceId;
	});
});
