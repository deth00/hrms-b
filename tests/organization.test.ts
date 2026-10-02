import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
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

describe('organization API — authentication & authorization', () => {
	it('rejects an unauthenticated request (401)', async () => {
		const res = await agent().get('/api/v1/organization/companies');
		expect(res.status).toBe(401);
	});

	it('rejects an authenticated user without organization.view (403)', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);
		const res = await agent().get('/api/v1/organization/companies').set('Cookie', cookie);
		expect(res.status).toBe(403);
	});

	it('a view-only user (MANAGER) can list but cannot create', async () => {
		const { username, password } = await createTestUser({ roleCode: 'MANAGER' });
		const cookie = await loginAndGetCookie(username, password);

		const listRes = await agent().get('/api/v1/organization/companies').set('Cookie', cookie);
		expect(listRes.status).toBe(200);

		const createRes = await agent()
			.post('/api/v1/organization/companies')
			.set('Cookie', cookie)
			.send({ code: uniqueCode('CO'), nameLao: 'ບໍລິສັດທົດສອບ' });
		expect(createRes.status).toBe(403);
	});
});

describe('Company', () => {
	it('creates a company', async () => {
		const cookie = await superAdminCookie();
		const code = uniqueCode('CO');
		const res = await agent()
			.post('/api/v1/organization/companies')
			.set('Cookie', cookie)
			.send({ code, nameLao: 'ບໍລິສັດທົດສອບ' });
		expect(res.status).toBe(201);
		expect(res.body.data.code).toBe(code);
		expect(res.body.data.status).toBe('ACTIVE');
	});

	it('rejects a duplicate company code', async () => {
		const cookie = await superAdminCookie();
		const code = uniqueCode('CO');
		await agent()
			.post('/api/v1/organization/companies')
			.set('Cookie', cookie)
			.send({ code, nameLao: 'ບໍລິສັດ A' });

		const res = await agent()
			.post('/api/v1/organization/companies')
			.set('Cookie', cookie)
			.send({ code, nameLao: 'ບໍລິສັດ B' });
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('COMPANY_CODE_TAKEN');
	});

	it('requires organization.disable to change status', async () => {
		const admin = await superAdminCookie();
		const company = await createTestCompany();

		const hrOnly = await createTestUser({ roleCode: 'MANAGER' });
		const managerCookie = await loginAndGetCookie(hrOnly.username, hrOnly.password);

		const res = await agent()
			.patch(`/api/v1/organization/companies/${company.id}`)
			.set('Cookie', managerCookie)
			.send({ status: 'INACTIVE' });
		expect(res.status).toBe(403);

		const okRes = await agent()
			.patch(`/api/v1/organization/companies/${company.id}`)
			.set('Cookie', admin)
			.send({ status: 'INACTIVE' });
		expect(okRes.status).toBe(200);
		expect(okRes.body.data.status).toBe('INACTIVE');
	});
});

describe('Branch', () => {
	it('creates a branch under an active company', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();

		const res = await agent()
			.post('/api/v1/organization/branches')
			.set('Cookie', cookie)
			.send({ companyId: company.id, code: uniqueCode('BR'), nameLao: 'ສາຂາທົດສອບ' });
		expect(res.status).toBe(201);
		expect(res.body.data.companyId).toBe(company.id);
	});

	it('rejects creating an ACTIVE branch under an inactive company', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany({ status: 'INACTIVE' });

		const res = await agent()
			.post('/api/v1/organization/branches')
			.set('Cookie', cookie)
			.send({
				companyId: company.id,
				code: uniqueCode('BR'),
				nameLao: 'ສາຂາທົດສອບ',
				status: 'ACTIVE'
			});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INACTIVE_PARENT');
	});
});

describe('Department', () => {
	it('can belong directly to a company (no branch)', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();

		const res = await agent()
			.post('/api/v1/organization/departments')
			.set('Cookie', cookie)
			.send({ companyId: company.id, code: uniqueCode('DEPT'), nameLao: 'ພະແນກທົດສອບ' });
		expect(res.status).toBe(201);
		expect(res.body.data.branchId).toBeNull();
	});

	it('can belong to a branch of the same company', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		const branch = await prisma.branch.create({
			data: { companyId: company.id, code: uniqueCode('BR'), nameLao: 'ສາຂາ' }
		});

		const res = await agent()
			.post('/api/v1/organization/departments')
			.set('Cookie', cookie)
			.send({
				companyId: company.id,
				branchId: branch.id,
				code: uniqueCode('DEPT'),
				nameLao: 'ພະແນກທົດສອບ'
			});
		expect(res.status).toBe(201);
		expect(res.body.data.branchId).toBe(branch.id);
	});

	it('rejects a branch that belongs to a different company', async () => {
		const cookie = await superAdminCookie();
		const companyA = await createTestCompany();
		const companyB = await createTestCompany();
		const branchOfB = await prisma.branch.create({
			data: { companyId: companyB.id, code: uniqueCode('BR'), nameLao: 'ສາຂາ B' }
		});

		const res = await agent()
			.post('/api/v1/organization/departments')
			.set('Cookie', cookie)
			.send({
				companyId: companyA.id,
				branchId: branchOfB.id,
				code: uniqueCode('DEPT'),
				nameLao: 'ພະແນກ'
			});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('BRANCH_COMPANY_MISMATCH');
	});

	it('rejects creating a new ACTIVE department under an inactive branch', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		const branch = await prisma.branch.create({
			data: { companyId: company.id, code: uniqueCode('BR'), nameLao: 'ສາຂາ', status: 'INACTIVE' }
		});

		const res = await agent()
			.post('/api/v1/organization/departments')
			.set('Cookie', cookie)
			.send({
				companyId: company.id,
				branchId: branch.id,
				code: uniqueCode('DEPT'),
				nameLao: 'ພະແນກ',
				status: 'ACTIVE'
			});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INACTIVE_PARENT');
	});
});

describe('Division & Unit', () => {
	it('creates a division under a department', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		const department = await prisma.department.create({
			data: { companyId: company.id, code: uniqueCode('DEPT'), nameLao: 'ພະແນກ' }
		});

		const res = await agent()
			.post('/api/v1/organization/divisions')
			.set('Cookie', cookie)
			.send({ departmentId: department.id, code: uniqueCode('DIV'), nameLao: 'ຝ່າຍທົດສອບ' });
		expect(res.status).toBe(201);
	});

	it('creates a unit directly under a department, with no division', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		const department = await prisma.department.create({
			data: { companyId: company.id, code: uniqueCode('DEPT'), nameLao: 'ພະແນກ' }
		});

		const res = await agent()
			.post('/api/v1/organization/units')
			.set('Cookie', cookie)
			.send({ departmentId: department.id, code: uniqueCode('UNIT'), nameLao: 'ໜ່ວຍງານທົດສອບ' });
		expect(res.status).toBe(201);
		expect(res.body.data.divisionId).toBeNull();
	});

	it('creates a unit under a division', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		const department = await prisma.department.create({
			data: { companyId: company.id, code: uniqueCode('DEPT'), nameLao: 'ພະແນກ' }
		});
		const division = await prisma.division.create({
			data: { departmentId: department.id, code: uniqueCode('DIV'), nameLao: 'ຝ່າຍ' }
		});

		const res = await agent()
			.post('/api/v1/organization/units')
			.set('Cookie', cookie)
			.send({
				departmentId: department.id,
				divisionId: division.id,
				code: uniqueCode('UNIT'),
				nameLao: 'ໜ່ວຍງານ'
			});
		expect(res.status).toBe(201);
		expect(res.body.data.divisionId).toBe(division.id);
	});

	it('rejects a unit whose division belongs to a different department', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		const deptA = await prisma.department.create({
			data: { companyId: company.id, code: uniqueCode('DEPT'), nameLao: 'ພະແນກ A' }
		});
		const deptB = await prisma.department.create({
			data: { companyId: company.id, code: uniqueCode('DEPT'), nameLao: 'ພະແນກ B' }
		});
		const divisionOfB = await prisma.division.create({
			data: { departmentId: deptB.id, code: uniqueCode('DIV'), nameLao: 'ຝ່າຍ B' }
		});

		const res = await agent()
			.post('/api/v1/organization/units')
			.set('Cookie', cookie)
			.send({
				departmentId: deptA.id,
				divisionId: divisionOfB.id,
				code: uniqueCode('UNIT'),
				nameLao: 'ໜ່ວຍງານ'
			});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('DIVISION_DEPARTMENT_MISMATCH');
	});

	it('rejects creating a new ACTIVE division under an inactive department', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		const department = await prisma.department.create({
			data: {
				companyId: company.id,
				code: uniqueCode('DEPT'),
				nameLao: 'ພະແນກ',
				status: 'INACTIVE'
			}
		});

		const res = await agent()
			.post('/api/v1/organization/divisions')
			.set('Cookie', cookie)
			.send({
				departmentId: department.id,
				code: uniqueCode('DIV'),
				nameLao: 'ຝ່າຍ',
				status: 'ACTIVE'
			});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INACTIVE_PARENT');
	});

	it('rejects creating a new ACTIVE unit under an inactive division', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		const department = await prisma.department.create({
			data: { companyId: company.id, code: uniqueCode('DEPT'), nameLao: 'ພະແນກ' }
		});
		const division = await prisma.division.create({
			data: {
				departmentId: department.id,
				code: uniqueCode('DIV'),
				nameLao: 'ຝ່າຍ',
				status: 'INACTIVE'
			}
		});

		const res = await agent()
			.post('/api/v1/organization/units')
			.set('Cookie', cookie)
			.send({
				departmentId: department.id,
				divisionId: division.id,
				code: uniqueCode('UNIT'),
				nameLao: 'ໜ່ວຍງານ',
				status: 'ACTIVE'
			});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INACTIVE_PARENT');
	});

	it('does not cascade-deactivate: an inactive parent keeps its already-ACTIVE children untouched', async () => {
		const admin = await superAdminCookie();
		const company = await createTestCompany();
		const department = await prisma.department.create({
			data: { companyId: company.id, code: uniqueCode('DEPT'), nameLao: 'ພະແນກ' }
		});
		const division = await prisma.division.create({
			data: { departmentId: department.id, code: uniqueCode('DIV'), nameLao: 'ຝ່າຍ' }
		});

		await agent()
			.patch(`/api/v1/organization/departments/${department.id}`)
			.set('Cookie', admin)
			.send({ status: 'INACTIVE' });

		const stillActive = await prisma.division.findUniqueOrThrow({ where: { id: division.id } });
		expect(stillActive.status).toBe('ACTIVE');
	});

	it('still lists INACTIVE divisions and their units for historical viewing (Unit tab filter)', async () => {
		const admin = await superAdminCookie();
		const company = await createTestCompany();
		const department = await prisma.department.create({
			data: { companyId: company.id, code: uniqueCode('DEPT'), nameLao: 'ພະແນກ' }
		});
		const division = await prisma.division.create({
			data: {
				departmentId: department.id,
				code: uniqueCode('DIV'),
				nameLao: 'ຝ່າຍເກົ່າ',
				status: 'INACTIVE'
			}
		});
		const unit = await prisma.unit.create({
			data: {
				departmentId: department.id,
				divisionId: division.id,
				code: uniqueCode('UNIT'),
				nameLao: 'ໜ່ວຍເກົ່າ'
			}
		});

		const divisions = await agent()
			.get(`/api/v1/organization/divisions?departmentId=${department.id}`)
			.set('Cookie', admin);
		expect(divisions.body.data.items.map((d: { id: string }) => d.id)).toContain(division.id);

		const units = await agent()
			.get(`/api/v1/organization/units?departmentId=${department.id}&divisionId=${division.id}`)
			.set('Cookie', admin);
		expect(units.status).toBe(200);
		expect(units.body.data.items.map((u: { id: string }) => u.id)).toContain(unit.id);
	});
});

describe('partial updates', () => {
	it('editing a field without a status keeps the existing status (no silent reactivation)', async () => {
		const admin = await superAdminCookie();
		const company = await createTestCompany();
		const department = await prisma.department.create({
			data: {
				companyId: company.id,
				code: uniqueCode('DEPT'),
				nameLao: 'ພະແນກເກົ່າ',
				status: 'INACTIVE'
			}
		});

		const res = await agent()
			.patch(`/api/v1/organization/departments/${department.id}`)
			.set('Cookie', admin)
			.send({ nameLao: 'ພະແນກເກົ່າ (ແກ້ໄຂ)' });
		expect(res.status).toBe(200);
		expect(res.body.data.status).toBe('INACTIVE');
	});

	it('a user with organization.update but not organization.disable can edit without a status change', async () => {
		const company = await createTestCompany();
		const { cookie } = await userWithPermissions(['organization.view', 'organization.update']);
		const res = await agent()
			.patch(`/api/v1/organization/companies/${company.id}`)
			.set('Cookie', cookie)
			.send({ nameLao: 'ຊື່ໃໝ່' });
		expect(res.status).toBe(200);

		const withStatus = await agent()
			.patch(`/api/v1/organization/companies/${company.id}`)
			.set('Cookie', cookie)
			.send({ status: 'INACTIVE' });
		expect(withStatus.status).toBe(403);
	});
});

describe('pagination, search, and filters', () => {
	it('paginates results', async () => {
		const cookie = await superAdminCookie();
		for (let i = 0; i < 3; i++) await createTestCompany();

		const res = await agent()
			.get('/api/v1/organization/companies?page=1&pageSize=2')
			.set('Cookie', cookie);
		expect(res.status).toBe(200);
		expect(res.body.data.items.length).toBe(2);
		expect(res.body.data.pageSize).toBe(2);
	});

	it('searches by code/name', async () => {
		const cookie = await superAdminCookie();
		const code = uniqueCode('FINDME');
		await agent()
			.post('/api/v1/organization/companies')
			.set('Cookie', cookie)
			.send({ code, nameLao: 'ບໍລິສັດຄົ້ນຫາ' });

		const res = await agent()
			.get(`/api/v1/organization/companies?search=${code}`)
			.set('Cookie', cookie);
		expect(res.status).toBe(200);
		expect(res.body.data.items.some((c: { code: string }) => c.code === code)).toBe(true);
	});

	it('filters by status', async () => {
		const cookie = await superAdminCookie();
		const inactive = await createTestCompany({ status: 'INACTIVE' });

		const res = await agent()
			.get('/api/v1/organization/companies?status=INACTIVE')
			.set('Cookie', cookie);
		expect(res.status).toBe(200);
		expect(res.body.data.items.every((c: { status: string }) => c.status === 'INACTIVE')).toBe(
			true
		);
		expect(res.body.data.items.some((c: { id: string }) => c.id === inactive.id)).toBe(true);
	});

	it('filters departments by parent (companyId/branchId)', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		const otherCompany = await createTestCompany();
		await prisma.department.create({
			data: { companyId: company.id, code: uniqueCode('DEPT'), nameLao: 'ພະແນກ A' }
		});
		await prisma.department.create({
			data: { companyId: otherCompany.id, code: uniqueCode('DEPT'), nameLao: 'ພະແນກ B' }
		});

		const res = await agent()
			.get(`/api/v1/organization/departments?companyId=${company.id}`)
			.set('Cookie', cookie);
		expect(res.status).toBe(200);
		expect(
			res.body.data.items.every((d: { companyId: string }) => d.companyId === company.id)
		).toBe(true);
	});
});
