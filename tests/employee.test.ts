import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	agent,
	createTestCompany,
	createTestUser,
	loginAndGetCookie,
	superAdminCookie,
	userWithPermissions
} from './helpers.js';
import { prisma } from '../src/config/prisma.js';

function uniqueCode(prefix: string) {
	return `${prefix}_${randomUUID().slice(0, 6).toUpperCase()}`;
}

/** A complete, self-consistent organization for one company (all ACTIVE). */
async function orgFixture() {
	const company = await createTestCompany();
	const branch = await prisma.branch.create({
		data: { companyId: company.id, code: uniqueCode('BR'), nameLao: 'ສາຂາ' }
	});
	const department = await prisma.department.create({
		data: { companyId: company.id, branchId: branch.id, code: uniqueCode('DEP'), nameLao: 'ພະແນກ' }
	});
	const division = await prisma.division.create({
		data: { departmentId: department.id, code: uniqueCode('DIV'), nameLao: 'ຝ່າຍ' }
	});
	const unit = await prisma.unit.create({
		data: {
			departmentId: department.id,
			divisionId: division.id,
			code: uniqueCode('UNT'),
			nameLao: 'ໜ່ວຍ'
		}
	});
	const position = await prisma.position.create({
		data: { companyId: company.id, code: uniqueCode('POS'), nameLao: 'ຕຳແໜ່ງ' }
	});
	const employmentType = await prisma.employmentType.create({
		data: { companyId: company.id, code: uniqueCode('ET'), nameLao: 'ປະເພດ' }
	});
	return { company, branch, department, division, unit, position, employmentType };
}
type Fixture = Awaited<ReturnType<typeof orgFixture>>;

function employeeBody(fx: Fixture, overrides: Record<string, unknown> = {}) {
	return {
		employeeCode: uniqueCode('EMP'),
		firstNameLao: 'ສົມຊາຍ',
		lastNameLao: 'ທົດສອບ',
		startDate: '2024-01-01',
		companyId: fx.company.id,
		employmentTypeId: fx.employmentType.id,
		...overrides
	};
}

let admin: string;
beforeAll(async () => {
	admin = await superAdminCookie();
});

async function createEmployee(fx: Fixture, overrides: Record<string, unknown> = {}) {
	const res = await agent()
		.post('/api/v1/employees')
		.set('Cookie', admin)
		.send(employeeBody(fx, overrides));
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; employeeCode: string };
}

const transfer = (id: string, body: Record<string, unknown>, cookie = admin) =>
	agent().post(`/api/v1/employees/${id}/transfer`).set('Cookie', cookie).send(body);
const changeStatus = (id: string, body: Record<string, unknown>, cookie = admin) =>
	agent().patch(`/api/v1/employees/${id}/status`).set('Cookie', cookie).send(body);
const historyOf = async (id: string) =>
	(await agent().get(`/api/v1/employees/${id}/assignment-history`).set('Cookie', admin)).body.data
		.items as { effectiveTo: string | null; positionId: string | null }[];

describe('employee API — authentication & authorization', () => {
	it('requires authentication (401)', async () => {
		expect((await agent().get('/api/v1/employees')).status).toBe(401);
		expect((await agent().post('/api/v1/employees').send({})).status).toBe(401);
	});

	it('list requires employees.view (403 for the EMPLOYEE role)', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);
		expect((await agent().get('/api/v1/employees').set('Cookie', cookie)).status).toBe(403);
		expect((await agent().get('/api/v1/employees/lookup').set('Cookie', cookie)).status).toBe(403);
	});

	it('a view-only user cannot create', async () => {
		const fx = await orgFixture();
		const { cookie } = await userWithPermissions(['employees.view']);
		const res = await agent()
			.post('/api/v1/employees')
			.set('Cookie', cookie)
			.send(employeeBody(fx));
		expect(res.status).toBe(403);
	});

	it('employees.update cannot perform a transfer without employees.transfer', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		const { cookie } = await userWithPermissions([
			'employees.view',
			'employees.view_all',
			'employees.update'
		]);

		const viaPatch = await agent()
			.patch(`/api/v1/employees/${emp.id}`)
			.set('Cookie', cookie)
			.send({ positionId: fx.position.id });
		expect(viaPatch.status).toBe(403);
		expect((await transfer(emp.id, { positionId: fx.position.id }, cookie)).status).toBe(403);
		expect((await historyOf(emp.id)).length).toBe(1);
	});

	it('employees.update cannot change status without employees.status', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		const { cookie } = await userWithPermissions([
			'employees.view',
			'employees.view_all',
			'employees.update'
		]);

		const viaPatch = await agent()
			.patch(`/api/v1/employees/${emp.id}`)
			.set('Cookie', cookie)
			.send({ employmentStatus: 'RESIGNED', endDate: '2025-01-01' });
		expect(viaPatch.status).toBe(403);
		const viaEndpoint = await changeStatus(
			emp.id,
			{ status: 'RESIGNED', endDate: '2025-01-01' },
			cookie
		);
		expect(viaEndpoint.status).toBe(403);
		const stillActive = await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } });
		expect(stillActive.employmentStatus).toBe('ACTIVE');
	});

	it('employees.update cannot link a User without employees.link_user', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		const { user } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const { cookie } = await userWithPermissions([
			'employees.view',
			'employees.view_all',
			'employees.update',
			'employees.create'
		]);

		const link = await agent()
			.patch(`/api/v1/employees/${emp.id}`)
			.set('Cookie', cookie)
			.send({ userId: user.id });
		expect(link.status).toBe(403);

		const createLinked = await agent()
			.post('/api/v1/employees')
			.set('Cookie', cookie)
			.send(employeeBody(fx, { userId: user.id }));
		expect(createLinked.status).toBe(403);
	});

	it('the generic PATCH tells an authorized caller to use the dedicated endpoints', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		const res = await agent()
			.patch(`/api/v1/employees/${emp.id}`)
			.set('Cookie', admin)
			.send({ positionId: fx.position.id });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('USE_TRANSFER_ENDPOINT');
	});

	it('never exposes password hashes or session data', async () => {
		const fx = await orgFixture();
		const { user } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const emp = await createEmployee(fx, { userId: user.id });
		const res = await agent().get(`/api/v1/employees/${emp.id}`).set('Cookie', admin);
		const text = JSON.stringify(res.body);
		expect(text).not.toContain('passwordHash');
		expect(text).not.toContain('tokenHash');
		expect(res.body.data.user.username).toBe(user.username);
	});
});

describe('create employee & organization validation', () => {
	it('creates an employee directly under a company (skipped levels)', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		const detail = await agent().get(`/api/v1/employees/${emp.id}`).set('Cookie', admin);
		expect(detail.body.data.companyId).toBe(fx.company.id);
		expect(detail.body.data.branchId).toBeNull();
		expect(detail.body.data.departmentId).toBeNull();
	});

	it('creates an employee with Branch + Department + Position', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx, {
			branchId: fx.branch.id,
			departmentId: fx.department.id,
			positionId: fx.position.id
		});
		const detail = await agent().get(`/api/v1/employees/${emp.id}`).set('Cookie', admin);
		expect(detail.body.data.department.id).toBe(fx.department.id);
		expect(detail.body.data.position.id).toBe(fx.position.id);
	});

	it('creates an employee with the full Company→Unit chain', async () => {
		const fx = await orgFixture();
		await createEmployee(fx, {
			branchId: fx.branch.id,
			departmentId: fx.department.id,
			divisionId: fx.division.id,
			unitId: fx.unit.id
		});
	});

	it('rejects a duplicate employeeCode (409)', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		const res = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx, { employeeCode: emp.employeeCode }));
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('EMPLOYEE_CODE_TAKEN');
	});

	it('requires the minimum fields', async () => {
		const res = await agent().post('/api/v1/employees').set('Cookie', admin).send({});
		expect(res.status).toBe(400);
	});

	it('rejects a Department from another company / a Branch from another company', async () => {
		const fx = await orgFixture();
		const other = await orgFixture();

		const badDept = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx, { departmentId: other.department.id }));
		expect(badDept.status).toBe(400);
		expect(badDept.body.error.code).toBe('DEPARTMENT_COMPANY_MISMATCH');

		const badBranch = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx, { branchId: other.branch.id }));
		expect(badBranch.body.error.code).toBe('BRANCH_COMPANY_MISMATCH');
	});

	it('rejects a Department that belongs to a different Branch', async () => {
		const fx = await orgFixture();
		const otherBranch = await prisma.branch.create({
			data: { companyId: fx.company.id, code: uniqueCode('BR'), nameLao: 'ສາຂາອື່ນ' }
		});
		const res = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx, { branchId: otherBranch.id, departmentId: fx.department.id }));
		expect(res.body.error.code).toBe('DEPARTMENT_BRANCH_MISMATCH');
	});

	it('rejects a Division that does not belong to the Department', async () => {
		const fx = await orgFixture();
		const otherDept = await prisma.department.create({
			data: { companyId: fx.company.id, code: uniqueCode('DEP'), nameLao: 'ພະແນກອື່ນ' }
		});
		const res = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx, { departmentId: otherDept.id, divisionId: fx.division.id }));
		expect(res.body.error.code).toBe('DIVISION_DEPARTMENT_MISMATCH');
	});

	it('rejects a Unit that does not belong to the Department', async () => {
		const fx = await orgFixture();
		const otherDept = await prisma.department.create({
			data: { companyId: fx.company.id, code: uniqueCode('DEP'), nameLao: 'ພະແນກອື່ນ' }
		});
		const res = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx, { departmentId: otherDept.id, unitId: fx.unit.id }));
		expect(res.body.error.code).toBe('UNIT_DEPARTMENT_MISMATCH');
	});

	it('rejects a Unit whose Division differs from the employee Division', async () => {
		const fx = await orgFixture();
		const otherDivision = await prisma.division.create({
			data: { departmentId: fx.department.id, code: uniqueCode('DIV'), nameLao: 'ຝ່າຍອື່ນ' }
		});
		const res = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(
				employeeBody(fx, {
					departmentId: fx.department.id,
					divisionId: otherDivision.id,
					unitId: fx.unit.id
				})
			);
		expect(res.body.error.code).toBe('UNIT_DIVISION_MISMATCH');
	});

	it('rejects a Position from another company', async () => {
		const fx = await orgFixture();
		const other = await orgFixture();
		const res = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx, { positionId: other.position.id }));
		expect(res.body.error.code).toBe('POSITION_COMPANY_MISMATCH');
	});

	it('rejects an INACTIVE target master record', async () => {
		const fx = await orgFixture();
		await prisma.position.update({ where: { id: fx.position.id }, data: { status: 'INACTIVE' } });
		const res = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx, { positionId: fx.position.id }));
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INACTIVE_TARGET');
	});

	it('validates the date rules', async () => {
		const fx = await orgFixture();
		const res = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx, { startDate: '2024-06-01', probationEndDate: '2024-01-01' }));
		expect(res.status).toBe(400);
		const badDate = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx, { startDate: '2024-02-30' }));
		expect(badDate.status).toBe(400);
	});

	it('cannot create an employee that is already RESIGNED', async () => {
		const fx = await orgFixture();
		const res = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx, { employmentStatus: 'RESIGNED' }));
		expect(res.status).toBe(400);
	});
});

describe('manager relationship', () => {
	it('assigns a manager via transfer', async () => {
		const fx = await orgFixture();
		const boss = await createEmployee(fx);
		const worker = await createEmployee(fx, { managerEmployeeId: boss.id });
		const detail = await agent().get(`/api/v1/employees/${worker.id}`).set('Cookie', admin);
		expect(detail.body.data.manager.id).toBe(boss.id);
	});

	it('an employee cannot manage themselves', async () => {
		const fx = await orgFixture();
		const a = await createEmployee(fx);
		const res = await transfer(a.id, { managerEmployeeId: a.id });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('MANAGER_SELF');
	});

	it('rejects a two-person cycle (A→B, B→A)', async () => {
		const fx = await orgFixture();
		const a = await createEmployee(fx);
		const b = await createEmployee(fx);
		expect((await transfer(a.id, { managerEmployeeId: b.id })).status).toBe(200);
		const res = await transfer(b.id, { managerEmployeeId: a.id });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('MANAGER_CYCLE');
	});

	it('rejects a three-person cycle (A→B→C→A)', async () => {
		const fx = await orgFixture();
		const a = await createEmployee(fx);
		const b = await createEmployee(fx);
		const c = await createEmployee(fx);
		expect((await transfer(a.id, { managerEmployeeId: b.id })).status).toBe(200);
		expect((await transfer(b.id, { managerEmployeeId: c.id })).status).toBe(200);
		const res = await transfer(c.id, { managerEmployeeId: a.id });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('MANAGER_CYCLE');
	});

	it('allows a manager from a different department (cross-department)', async () => {
		const fx = await orgFixture();
		const otherDept = await prisma.department.create({
			data: { companyId: fx.company.id, code: uniqueCode('DEP'), nameLao: 'ພະແນກອື່ນ' }
		});
		const boss = await createEmployee(fx, { departmentId: otherDept.id });
		await createEmployee(fx, { departmentId: fx.department.id, managerEmployeeId: boss.id });
	});

	it('rejects a non-existent or resigned manager', async () => {
		const fx = await orgFixture();
		const a = await createEmployee(fx);
		expect((await transfer(a.id, { managerEmployeeId: 2147483647 })).status).toBe(400);
		expect((await transfer(a.id, { managerEmployeeId: 'does-not-exist' })).body.error.code).toBe(
			'VALIDATION_ERROR'
		);

		const gone = await createEmployee(fx);
		await changeStatus(gone.id, { status: 'RESIGNED', endDate: '2025-01-01' });
		const res = await transfer(a.id, { managerEmployeeId: gone.id });
		expect(res.body.error.code).toBe('MANAGER_NOT_ACTIVE');
	});
});

describe('assignment history & transfer', () => {
	it('creates the initial assignment-history row on create', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx, { departmentId: fx.department.id });
		const history = await historyOf(emp.id);
		expect(history.length).toBe(1);
		expect(history[0]!.effectiveTo).toBeNull();
	});

	it('a profile-only edit does NOT create new assignment history', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		const res = await agent()
			.patch(`/api/v1/employees/${emp.id}`)
			.set('Cookie', admin)
			.send({ phone: '020 5555 1234', address: 'ນະຄອນຫຼວງວຽງຈັນ', nickname: 'ຊາຍ' });
		expect(res.status).toBe(200);
		expect(res.body.data.phone).toBe('020 5555 1234');
		expect((await historyOf(emp.id)).length).toBe(1);
	});

	it('a transfer creates a new row, closes the previous row, and updates the employee', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx, { departmentId: fx.department.id });
		const newDept = await prisma.department.create({
			data: { companyId: fx.company.id, code: uniqueCode('DEP'), nameLao: 'ພະແນກໃໝ່' }
		});

		const res = await transfer(emp.id, {
			departmentId: newDept.id,
			positionId: fx.position.id,
			reason: 'ຍ້າຍພະແນກ'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data.departmentId).toBe(newDept.id);
		expect(res.body.data.positionId).toBe(fx.position.id);

		const history = await historyOf(emp.id);
		expect(history.length).toBe(2);
		const current = history.find((h) => h.effectiveTo === null);
		const closed = history.find((h) => h.effectiveTo !== null);
		expect(current?.positionId).toBe(fx.position.id);
		expect(closed).toBeDefined();
		expect(closed?.positionId).toBeNull();
	});

	it('keeps history readable after a master record is later deactivated', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx, { departmentId: fx.department.id });
		await prisma.department.update({
			where: { id: fx.department.id },
			data: { status: 'INACTIVE' }
		});
		expect((await historyOf(emp.id)).length).toBe(1);
		const detail = await agent().get(`/api/v1/employees/${emp.id}`).set('Cookie', admin);
		expect(detail.body.data.department.id).toBe(fx.department.id);
		// A change that leaves the (now inactive) department untouched is still allowed.
		expect((await transfer(emp.id, { positionId: fx.position.id })).status).toBe(200);
	});

	it('an invalid transfer is rejected and leaves everything unchanged', async () => {
		const fx = await orgFixture();
		const other = await orgFixture();
		const emp = await createEmployee(fx, { departmentId: fx.department.id });

		const res = await transfer(emp.id, { positionId: other.position.id });
		expect(res.status).toBe(400);
		const after = await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } });
		expect(after.positionId).toBeNull();
		expect((await historyOf(emp.id)).length).toBe(1);
	});

	it('rejects an effective date that would overlap the current history row', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx, { startDate: '2024-06-01' });
		const res = await transfer(emp.id, { positionId: fx.position.id, effectiveDate: '2024-01-01' });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INVALID_EFFECTIVE_DATE');
		expect((await historyOf(emp.id)).length).toBe(1);
		const unchanged = await historyOf(emp.id);
		expect(unchanged[0]!.effectiveTo).toBeNull();
	});

	it('rejects a future effective date and a no-op transfer', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		const future = await transfer(emp.id, {
			positionId: fx.position.id,
			effectiveDate: '2999-01-01'
		});
		expect(future.body.error.code).toBe('INVALID_EFFECTIVE_DATE');
		const noop = await transfer(emp.id, { companyId: fx.company.id });
		expect(noop.body.error.code).toBe('NO_CHANGES');
	});

	it('cannot transfer an employee who has resigned', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		await changeStatus(emp.id, { status: 'RESIGNED', endDate: '2025-01-01' });
		const res = await transfer(emp.id, { positionId: fx.position.id });
		expect(res.body.error.code).toBe('EMPLOYEE_ENDED');
	});

	it('rejects an inactive transfer target', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		await prisma.position.update({ where: { id: fx.position.id }, data: { status: 'INACTIVE' } });
		const res = await transfer(emp.id, { positionId: fx.position.id });
		expect(res.body.error.code).toBe('INACTIVE_TARGET');
	});
});

describe('employment status', () => {
	it('RESIGNED requires an endDate', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		const res = await changeStatus(emp.id, { status: 'RESIGNED' });
		expect(res.status).toBe(400);
		const ok = await changeStatus(emp.id, { status: 'RESIGNED', endDate: '2025-03-01' });
		expect(ok.status).toBe(200);
		expect(ok.body.data.employmentStatus).toBe('RESIGNED');
	});

	it('endDate cannot precede the start date', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx, { startDate: '2024-06-01' });
		const res = await changeStatus(emp.id, { status: 'TERMINATED', endDate: '2024-01-01' });
		expect(res.body.error.code).toBe('INVALID_END_DATE');
	});

	it('terminating preserves the employee record and history', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		await changeStatus(emp.id, { status: 'TERMINATED', endDate: '2025-03-01', reason: 'ເຫດຜົນ' });
		const row = await prisma.employee.findUnique({ where: { id: emp.id } });
		expect(row?.employmentStatus).toBe('TERMINATED');
		expect(row?.note).toContain('ເຫດຜົນ');
		expect((await historyOf(emp.id)).length).toBe(1);
	});

	it('disabling the linked user deactivates it and revokes its sessions', async () => {
		const fx = await orgFixture();
		const { user, username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const userCookie = await loginAndGetCookie(username, password);
		const emp = await createEmployee(fx, { userId: user.id });

		const res = await changeStatus(emp.id, {
			status: 'RESIGNED',
			endDate: '2025-03-01',
			disableLinkedUser: true
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);

		expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe(
			'INACTIVE'
		);
		const live = await prisma.session.count({ where: { userId: user.id, revokedAt: null } });
		expect(live).toBe(0);
		expect((await agent().get('/api/v1/auth/me').set('Cookie', userCookie)).status).toBe(401);
		expect(await prisma.employee.count({ where: { id: emp.id } })).toBe(1);
	});

	it('leaves the linked user active when the option is not chosen', async () => {
		const fx = await orgFixture();
		const { user, username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const userCookie = await loginAndGetCookie(username, password);
		const emp = await createEmployee(fx, { userId: user.id });

		await changeStatus(emp.id, { status: 'RESIGNED', endDate: '2025-03-01' });
		expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('ACTIVE');
		expect((await agent().get('/api/v1/auth/me').set('Cookie', userCookie)).status).toBe(200);
	});

	it('disableLinkedUser is only valid for RESIGNED/TERMINATED and needs a linked user', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		const wrongStatus = await changeStatus(emp.id, {
			status: 'SUSPENDED',
			disableLinkedUser: true
		});
		expect(wrongStatus.status).toBe(400);
		const noUser = await changeStatus(emp.id, {
			status: 'RESIGNED',
			endDate: '2025-03-01',
			disableLinkedUser: true
		});
		expect(noUser.body.error.code).toBe('NO_LINKED_USER');
		expect(
			(await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } })).employmentStatus
		).toBe('ACTIVE');
	});

	it('returning to ACTIVE clears the end date', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		await changeStatus(emp.id, { status: 'RESIGNED', endDate: '2025-03-01' });
		const res = await changeStatus(emp.id, { status: 'ACTIVE' });
		expect(res.body.data.endDate).toBeNull();
	});
});

describe('user linking', () => {
	it('links an existing user', async () => {
		const fx = await orgFixture();
		const { user } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const emp = await createEmployee(fx);
		const res = await agent()
			.patch(`/api/v1/employees/${emp.id}`)
			.set('Cookie', admin)
			.send({ userId: user.id });
		expect(res.status).toBe(200);
		expect(res.body.data.user.id).toBe(user.id);
	});

	it('the same user cannot be linked to two employees', async () => {
		const fx = await orgFixture();
		const { user } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const first = await createEmployee(fx, { userId: user.id });
		const second = await createEmployee(fx);
		const res = await agent()
			.patch(`/api/v1/employees/${second.id}`)
			.set('Cookie', admin)
			.send({ userId: user.id });
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('USER_ALREADY_LINKED');

		const onCreate = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx, { userId: user.id }));
		expect(onCreate.status).toBe(409);
		expect(first.id).toBeTruthy();
	});

	it('unlinks a user without deleting it', async () => {
		const fx = await orgFixture();
		const { user } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const emp = await createEmployee(fx, { userId: user.id });
		const res = await agent()
			.patch(`/api/v1/employees/${emp.id}`)
			.set('Cookie', admin)
			.send({ userId: null });
		expect(res.status).toBe(200);
		expect(res.body.data.user).toBeNull();
		expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);
	});

	it('rejects a non-existent user', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		const res = await agent()
			.patch(`/api/v1/employees/${emp.id}`)
			.set('Cookie', admin)
			.send({ userId: 2147483647 });
		expect(res.body.error.code).toBe('INVALID_USER');
		const malformed = await agent()
			.patch(`/api/v1/employees/${emp.id}`)
			.set('Cookie', admin)
			.send({ userId: 'nope' });
		expect(malformed.status).toBe(400);
		expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
	});

	it('the available-users lookup omits already-linked users', async () => {
		const fx = await orgFixture();
		const linked = await createTestUser({ roleCode: 'EMPLOYEE' });
		const free = await createTestUser({ roleCode: 'EMPLOYEE' });
		await createEmployee(fx, { userId: linked.user.id });

		// the lookup returns at most 50 users (username order); the shared test DB holds hundreds of
		// "test_…" users, so each user is searched by its own unique username instead of the shared prefix
		const lookup = (search: string) =>
			agent()
				.get(`/api/v1/employees/lookups/available-users?search=${search}`)
				.set('Cookie', admin);
		const freeRes = await lookup(free.username);
		const linkedRes = await lookup(linked.username);
		const res = freeRes;
		expect(freeRes.body.data.map((u: { id: string }) => u.id)).toContain(free.user.id);
		expect(linkedRes.body.data.map((u: { id: string }) => u.id)).not.toContain(linked.user.id);
		expect(JSON.stringify(res.body)).not.toContain('passwordHash');
	});
});

describe('list, search, filters, pagination', () => {
	it('searches by code, name, email and phone', async () => {
		const fx = await orgFixture();
		const code = uniqueCode('FIND');
		const emp = await createEmployee(fx, {
			employeeCode: code,
			firstNameEnglish: 'Zebulon',
			workEmail: `${code.toLowerCase()}@corp.test`,
			phone: '02099887766'
		});
		for (const term of [code, 'Zebulon', `${code.toLowerCase()}@corp`, '02099887766']) {
			const res = await agent()
				.get(`/api/v1/employees?search=${encodeURIComponent(term)}`)
				.set('Cookie', admin);
			expect(res.body.data.items.map((e: { id: string }) => e.id)).toContain(emp.id);
		}
	});

	it('filters by employment status', async () => {
		const fx = await orgFixture();
		const active = await createEmployee(fx);
		const gone = await createEmployee(fx);
		await changeStatus(gone.id, { status: 'RESIGNED', endDate: '2025-03-01' });

		const res = await agent()
			.get(`/api/v1/employees?status=RESIGNED&companyId=${fx.company.id}`)
			.set('Cookie', admin);
		const ids = res.body.data.items.map((e: { id: string }) => e.id);
		expect(ids).toEqual([gone.id]);
		expect(ids).not.toContain(active.id);
	});

	it('filters by branch / department / division / unit / position / employment type', async () => {
		const fx = await orgFixture();
		const inDept = await createEmployee(fx, {
			branchId: fx.branch.id,
			departmentId: fx.department.id,
			divisionId: fx.division.id,
			unitId: fx.unit.id,
			positionId: fx.position.id
		});
		await createEmployee(fx);

		const filters = [
			`branchId=${fx.branch.id}`,
			`departmentId=${fx.department.id}`,
			`divisionId=${fx.division.id}`,
			`unitId=${fx.unit.id}`,
			`positionId=${fx.position.id}`
		];
		for (const filter of filters) {
			const res = await agent().get(`/api/v1/employees?${filter}`).set('Cookie', admin);
			expect(res.body.data.items.map((e: { id: string }) => e.id)).toEqual([inDept.id]);
		}
		const byType = await agent()
			.get(`/api/v1/employees?employmentTypeId=${fx.employmentType.id}`)
			.set('Cookie', admin);
		expect(byType.body.data.total).toBe(2);
	});

	it('paginates', async () => {
		const fx = await orgFixture();
		for (let i = 0; i < 3; i++) await createEmployee(fx);
		const page1 = await agent()
			.get(`/api/v1/employees?companyId=${fx.company.id}&page=1&pageSize=2`)
			.set('Cookie', admin);
		expect(page1.body.data.items.length).toBe(2);
		expect(page1.body.data.total).toBe(3);
		expect(page1.body.data.totalPages).toBe(2);
		const page2 = await agent()
			.get(`/api/v1/employees?companyId=${fx.company.id}&page=2&pageSize=2`)
			.set('Cookie', admin);
		expect(page2.body.data.items.length).toBe(1);
	});

	it('the list omits the most sensitive personal identifiers', async () => {
		const fx = await orgFixture();
		await createEmployee(fx, { nationalId: 'NID-SECRET-123', passportNumber: 'P-SECRET-1' });
		const res = await agent()
			.get(`/api/v1/employees?companyId=${fx.company.id}`)
			.set('Cookie', admin);
		expect(JSON.stringify(res.body)).not.toContain('NID-SECRET-123');
		expect(JSON.stringify(res.body)).not.toContain('P-SECRET-1');
	});
});

describe('data scope', () => {
	it('an HR/admin-scope user (employees.view_all) sees every employee', async () => {
		const fx = await orgFixture();
		const a = await createEmployee(fx);
		const b = await createEmployee(fx);
		const res = await agent()
			.get(`/api/v1/employees?companyId=${fx.company.id}`)
			.set('Cookie', admin);
		const ids = res.body.data.items.map((e: { id: string }) => e.id);
		expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
	});

	it('a MANAGER sees only their own record and their reports, not the whole directory', async () => {
		const fx = await orgFixture();
		const { user, username, password } = await createTestUser({ roleCode: 'MANAGER' });
		const mgr = await createEmployee(fx, { userId: user.id });
		const direct = await createEmployee(fx, { managerEmployeeId: mgr.id });
		const indirect = await createEmployee(fx, { managerEmployeeId: direct.id });
		const outsider = await createEmployee(fx);
		const cookie = await loginAndGetCookie(username, password);

		const list = await agent().get('/api/v1/employees?pageSize=100').set('Cookie', cookie);
		expect(list.status).toBe(200);
		const ids = list.body.data.items.map((e: { id: string }) => e.id).sort();
		expect(ids).toEqual([mgr.id, direct.id, indirect.id].sort());
		expect(ids).not.toContain(outsider.id);

		expect((await agent().get(`/api/v1/employees/${direct.id}`).set('Cookie', cookie)).status).toBe(
			200
		);
	});

	it('an unrelated manager cannot open an employee outside their scope', async () => {
		const fx = await orgFixture();
		const { user, username, password } = await createTestUser({ roleCode: 'MANAGER' });
		await createEmployee(fx, { userId: user.id });
		const outsider = await createEmployee(fx);
		const cookie = await loginAndGetCookie(username, password);

		expect(
			(await agent().get(`/api/v1/employees/${outsider.id}`).set('Cookie', cookie)).status
		).toBe(403);
		expect(
			(
				await agent()
					.get(`/api/v1/employees/${outsider.id}/assignment-history`)
					.set('Cookie', cookie)
			).status
		).toBe(403);
	});

	it('a manager-permission user with NO linked employee sees nothing (no directory leak)', async () => {
		const fx = await orgFixture();
		await createEmployee(fx);
		const { username, password } = await createTestUser({ roleCode: 'MANAGER' });
		const cookie = await loginAndGetCookie(username, password);
		const res = await agent().get('/api/v1/employees').set('Cookie', cookie);
		expect(res.status).toBe(200);
		expect(res.body.data.items).toEqual([]);
		expect(res.body.data.total).toBe(0);
	});

	it('the manager lookup honors scope too', async () => {
		const fx = await orgFixture();
		const { user, username, password } = await createTestUser({ roleCode: 'MANAGER' });
		const mgr = await createEmployee(fx, { userId: user.id });
		const outsider = await createEmployee(fx);
		const cookie = await loginAndGetCookie(username, password);
		const res = await agent().get('/api/v1/employees/lookup').set('Cookie', cookie);
		const ids = res.body.data.map((e: { id: string }) => e.id);
		expect(ids).toContain(mgr.id);
		expect(ids).not.toContain(outsider.id);
	});
});

describe('employment types', () => {
	it('creates, reads, edits and lists', async () => {
		const company = await createTestCompany();
		const code = uniqueCode('ET');
		const created = await agent()
			.post('/api/v1/employment-types')
			.set('Cookie', admin)
			.send({ companyId: company.id, code, nameLao: 'ພະນັກງານປະຈຳ' });
		expect(created.status).toBe(201);

		const id = created.body.data.id;
		expect((await agent().get(`/api/v1/employment-types/${id}`).set('Cookie', admin)).status).toBe(
			200
		);
		const edited = await agent()
			.patch(`/api/v1/employment-types/${id}`)
			.set('Cookie', admin)
			.send({ nameLao: 'ປະຈຳ (ແກ້ໄຂ)', nameEnglish: 'Full time' });
		expect(edited.body.data.nameLao).toBe('ປະຈຳ (ແກ້ໄຂ)');

		const list = await agent()
			.get(`/api/v1/employment-types?companyId=${company.id}&search=${code}`)
			.set('Cookie', admin);
		expect(list.body.data.total).toBe(1);
		const lookup = await agent()
			.get(`/api/v1/employment-types/lookup?companyId=${company.id}`)
			.set('Cookie', admin);
		expect(lookup.body.data.length).toBe(1);
	});

	it('rejects a duplicate code within a company (409)', async () => {
		const company = await createTestCompany();
		const body = { companyId: company.id, code: uniqueCode('ET'), nameLao: 'ປະເພດ' };
		await agent().post('/api/v1/employment-types').set('Cookie', admin).send(body);
		const res = await agent().post('/api/v1/employment-types').set('Cookie', admin).send(body);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('EMPLOYMENT_TYPE_CODE_TAKEN');
	});

	it('cannot create an ACTIVE type under an inactive company', async () => {
		const company = await createTestCompany({ status: 'INACTIVE' });
		const res = await agent()
			.post('/api/v1/employment-types')
			.set('Cookie', admin)
			.send({ companyId: company.id, code: uniqueCode('ET'), nameLao: 'ປະເພດ' });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INACTIVE_PARENT');
	});

	it('deactivating a type does not cascade to employees, and inactive types are not assignable', async () => {
		const fx = await orgFixture();
		const emp = await createEmployee(fx);
		await agent()
			.patch(`/api/v1/employment-types/${fx.employmentType.id}`)
			.set('Cookie', admin)
			.send({ status: 'INACTIVE' });
		const detail = await agent().get(`/api/v1/employees/${emp.id}`).set('Cookie', admin);
		expect(detail.body.data.employmentType.id).toBe(fx.employmentType.id);

		const another = await agent()
			.post('/api/v1/employees')
			.set('Cookie', admin)
			.send(employeeBody(fx));
		expect(another.body.error.code).toBe('INACTIVE_TARGET');
	});

	it('changing status needs employees.status; create needs employees.create', async () => {
		const fx = await orgFixture();
		const { cookie } = await userWithPermissions(['employees.view', 'employees.update']);
		const statusChange = await agent()
			.patch(`/api/v1/employment-types/${fx.employmentType.id}`)
			.set('Cookie', cookie)
			.send({ status: 'INACTIVE' });
		expect(statusChange.status).toBe(403);
		const rename = await agent()
			.patch(`/api/v1/employment-types/${fx.employmentType.id}`)
			.set('Cookie', cookie)
			.send({ nameLao: 'ຊື່ໃໝ່' });
		expect(rename.status).toBe(200);

		const create = await agent()
			.post('/api/v1/employment-types')
			.set('Cookie', cookie)
			.send({ companyId: fx.company.id, code: uniqueCode('ET'), nameLao: 'x' });
		expect(create.status).toBe(403);
	});
});
