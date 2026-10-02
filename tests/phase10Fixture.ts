import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
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

/**
 * Shared scaffolding for the Phase 10 suites (audit + notifications): a company with a shift, a
 * management chain (G ← M ← subject), HR / Director style role holders, and request helpers.
 */
export const uid = () => randomUUID().slice(0, 6).toUpperCase();
export const at = (iso: string) => setServerClockForTests(() => new Date(iso));
export const NOW = '2026-09-19T03:00:00Z'; // Saturday 10:00 Laos
export const MON = '2026-09-21';
export const TUE_0900 = '2026-09-22T02:00:00Z';
export const laos = (date: string, hm: string) => `${date}T${hm}:00+07:00`;
export const clockAt = (date: string, hm: string) => new Date(laos(date, hm)).toISOString();

export const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);
export const patch = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().patch(`/api/v1${path}`).set('Cookie', cookie).send(body);
export const get = (path: string, cookie: string) =>
	agent().get(`/api/v1${path}`).set('Cookie', cookie);

export type TargetType = 'LEAVE' | 'OVERTIME' | 'ATTENDANCE_CORRECTION';
export const REVIEW = ['leave.review', 'overtime.review', 'attendance_corrections.review'];
export const VIEW_ALL = 'employees.view_all';

export interface Person {
	user: { id: string; username: string };
	cookie: string;
	employee: { id: string; employeeCode: string };
}

export const fx = {} as {
	admin: string;
	adminUser: { id: string; username: string };
	companyId: string;
	shiftId: string;
	leaveTypeId: string;
	M: Person;
	G: Person;
	HR1: Person;
	HR2: Person;
	DIR: Person;
	hrRoleId: string;
	dirRoleId: string;
	plain: { user: { id: string }; cookie: string };
};

export async function mkRole(name: string, codes: string[]) {
	const permissions = await prisma.permission.findMany({ where: { code: { in: codes } } });
	return prisma.role.create({
		data: {
			code: `T10_${name}_${uid()}`,
			name: `Test ${name}`,
			permissions: { create: permissions.map((p) => ({ permissionId: p.id })) }
		}
	});
}

export async function mkPerson(opts: {
	roleId?: string;
	roleCode?: string;
	managerEmployeeId?: string | null;
}): Promise<Person> {
	const created = await createTestUser({ roleCode: opts.roleCode });
	if (opts.roleId)
		await prisma.userRole.create({ data: { userId: created.user.id, roleId: opts.roleId } });
	const cookie = await loginAndGetCookie(created.username, created.password);
	const employee = await prisma.employee.create({
		data: {
			employeeCode: `E_${uid()}`,
			firstNameLao: 'ພະນັກງານ',
			lastNameLao: 'ທົດສອບ',
			startDate: new Date('2024-01-01T00:00:00.000Z'),
			companyId: fx.companyId,
			userId: created.user.id,
			managerEmployeeId: opts.managerEmployeeId ?? null
		}
	});
	await prisma.employeeScheduleAssignment.create({
		data: {
			employeeId: employee.id,
			shiftId: fx.shiftId,
			effectiveFrom: new Date('2026-01-01T00:00:00.000Z')
		}
	});
	return { user: created.user, cookie, employee };
}

export async function setupFixture() {
	fx.admin = await superAdminCookie();
	const me = await get('/auth/me', fx.admin);
	fx.adminUser = me.body.data.user;
	const company = await createTestCompany();
	fx.companyId = company.id;
	const shiftRes = await post('/shifts', fx.admin, {
		companyId: fx.companyId,
		code: `S_${uid()}`,
		nameLao: 'ກະ',
		startTime: '08:00',
		endTime: '17:00',
		breakMinutes: 60,
		lateGraceMinutes: 5,
		earlyLeaveGraceMinutes: 5
	});
	fx.shiftId = shiftRes.body.data.id;
	const lt = await prisma.leaveType.create({
		data: { companyId: fx.companyId, code: `LT_${uid()}`, nameLao: 'ລາພັກ', requiresBalance: true }
	});
	fx.leaveTypeId = lt.id;
	fx.hrRoleId = (await mkRole('HR', [...REVIEW, VIEW_ALL, 'leave.view', 'overtime.view'])).id;
	fx.dirRoleId = (await mkRole('DIR', [...REVIEW, VIEW_ALL, 'leave.view', 'overtime.view'])).id;
	fx.G = await mkPerson({ roleCode: 'MANAGER' });
	fx.M = await mkPerson({ roleCode: 'MANAGER', managerEmployeeId: fx.G.employee.id });
	fx.HR1 = await mkPerson({ roleId: fx.hrRoleId });
	fx.HR2 = await mkPerson({ roleId: fx.hrRoleId });
	fx.DIR = await mkPerson({ roleId: fx.dirRoleId });
	fx.plain = await userWithPermissions(['dashboard.view']);
}

/** an employee reporting to M (level 1) and G (level 2), with a leave balance */
export async function subject(): Promise<Person> {
	const s = await mkPerson({ roleCode: 'EMPLOYEE', managerEmployeeId: fx.M.employee.id });
	await prisma.leaveBalance.create({
		data: {
			employeeId: s.employee.id,
			leaveTypeId: fx.leaveTypeId,
			year: 2026,
			entitlementDays: '15.00'
		}
	});
	return s;
}

// ---------- workflow config ----------
export const mgr = (level = 1, nameLao = 'ຫົວໜ້າ') => ({
	nameLao,
	approverType: 'MANAGER',
	managerLevel: level
});
export const role = (roleId: string, nameLao = 'ບົດບາດ') => ({
	nameLao,
	approverType: 'ROLE',
	roleId
});
export const perm = (targetType: TargetType) => ({
	nameLao: 'ພິຈາລະນາ',
	approverType: 'PERMISSION',
	permissionCode:
		targetType === 'LEAVE'
			? 'leave.review'
			: targetType === 'OVERTIME'
				? 'overtime.review'
				: 'attendance_corrections.review'
});
export async function workflowOf(targetType: TargetType) {
	const res = await get(
		`/approval-workflows?companyId=${fx.companyId}&targetType=${targetType}`,
		fx.admin
	);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data.items.find((w: { status: string }) => w.status === 'ACTIVE') as {
		id: string;
		version: number;
	};
}
export async function setSteps(targetType: TargetType, steps: Record<string, unknown>[]) {
	const wf = await workflowOf(targetType);
	const res = await patch(`/approval-workflows/${wf.id}`, fx.admin, { steps });
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as { id: string; version: number };
}

// ---------- requests ----------
export const LEAVE_REASON = 'ອາການເຈັບປ່ວຍພິເສດ-ລັບ';
export const OT_REASON = 'ເຫດຜົນ OT ລັບສະເພາະ';
export const CORRECTION_REASON = 'ເຫດຜົນແກ້ໄຂເວລາລັບ';
export const leaveReq = (s: Person, start = MON, end = MON) =>
	post('/leave/me/requests', s.cookie, {
		leaveTypeId: fx.leaveTypeId,
		startDate: start,
		endDate: end,
		reason: LEAVE_REASON
	});
export const otReq = (s: Person, date = MON) =>
	post('/overtime/me/requests', s.cookie, {
		workDate: date,
		requestedStartAt: laos(date, '17:30'),
		requestedEndAt: laos(date, '19:30'),
		reason: OT_REASON
	});
export async function instanceOf(targetType: TargetType, targetId: string) {
	return prisma.approvalInstance.findUniqueOrThrow({
		// Phase 13: attempts — every Leave / OT / Correction submission is attempt 1
		where: { targetType_targetId_attemptNo: { targetType, targetId, attemptNo: 1 } },
		include: { steps: { orderBy: { stepOrder: 'asc' }, include: { candidates: true } } }
	});
}
export const approve = (p: { cookie: string }, instanceId: string, note?: string) =>
	post(`/approvals/${instanceId}/approve`, p.cookie, note ? { note } : {});
export const reject = (p: { cookie: string }, instanceId: string, note = 'ເຫດຜົນປະຕິເສດລັບ') =>
	post(`/approvals/${instanceId}/reject`, p.cookie, { note });

/** a Leave request through Manager → HR role → Director role */
export async function threeStepLeave() {
	await setSteps('LEAVE', [
		mgr(1, 'ຫົວໜ້າໂດຍກົງ'),
		role(fx.hrRoleId, 'HR'),
		role(fx.dirRoleId, 'ຜູ້ອຳນວຍການ')
	]);
	const s = await subject();
	const created = await leaveReq(s);
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	const id = created.body.data.id as string;
	const inst = await instanceOf('LEAVE', id);
	return { s, id, inst, instanceId: inst.id };
}

/** worked Monday 08:00 → 18:00, then asks (on Tuesday) to correct the check-out to 19:00 */
export async function correctionCase() {
	const s = await subject();
	at(clockAt(MON, '08:00'));
	expect((await post('/attendance/me/check-in', s.cookie)).status).toBe(201);
	at(clockAt(MON, '18:00'));
	expect((await post('/attendance/me/check-out', s.cookie)).status).toBe(200);
	at(TUE_0900);
	await setSteps('ATTENDANCE_CORRECTION', [mgr(1), role(fx.hrRoleId, 'HR')]);
	const corr = await post('/attendance/me/corrections', s.cookie, {
		workDate: MON,
		type: 'TIME_ADJUSTMENT',
		requestedCheckOutAt: laos(MON, '19:00'),
		reason: CORRECTION_REASON
	});
	expect(corr.status, JSON.stringify(corr.body)).toBe(201);
	const id = corr.body.data.id as string;
	return { s, id, instanceId: (await instanceOf('ATTENDANCE_CORRECTION', id)).id };
}
