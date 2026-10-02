import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
	agent,
	createTestCompany,
	createTestUser,
	loginAndGetCookie,
	superAdminCookie
} from './helpers.js';
import { prisma } from '../src/config/prisma.js';

function uniqueCode(prefix: string) {
	return `${prefix}_${randomUUID().slice(0, 6).toUpperCase()}`;
}

describe('Position Level', () => {
	it('creates a position level', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();

		const res = await agent()
			.post('/api/v1/position-levels')
			.set('Cookie', cookie)
			.send({ companyId: company.id, code: uniqueCode('LVL'), nameLao: 'ຜູ້ຈັດການ', rank: 2 });
		expect(res.status).toBe(201);
		expect(res.body.data.rank).toBe(2);
	});

	it('rejects a duplicate position level code within the same company', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		const code = uniqueCode('LVL');
		await agent()
			.post('/api/v1/position-levels')
			.set('Cookie', cookie)
			.send({ companyId: company.id, code, nameLao: 'ລະດັບ A', rank: 1 });

		const res = await agent()
			.post('/api/v1/position-levels')
			.set('Cookie', cookie)
			.send({ companyId: company.id, code, nameLao: 'ລະດັບ B', rank: 5 });
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('POSITION_LEVEL_CODE_TAKEN');
	});

	it('rejects a duplicate rank within the same company', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		await agent()
			.post('/api/v1/position-levels')
			.set('Cookie', cookie)
			.send({ companyId: company.id, code: uniqueCode('LVL'), nameLao: 'ລະດັບ A', rank: 3 });

		const res = await agent()
			.post('/api/v1/position-levels')
			.set('Cookie', cookie)
			.send({ companyId: company.id, code: uniqueCode('LVL'), nameLao: 'ລະດັບ B', rank: 3 });
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('POSITION_LEVEL_RANK_TAKEN');
	});
});

describe('Position', () => {
	it('creates a position using a position level from the same company', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		const level = await prisma.positionLevel.create({
			data: { companyId: company.id, code: uniqueCode('LVL'), nameLao: 'ພະນັກງານ', rank: 4 }
		});

		const res = await agent()
			.post('/api/v1/positions')
			.set('Cookie', cookie)
			.send({
				companyId: company.id,
				positionLevelId: level.id,
				code: uniqueCode('POS'),
				nameLao: 'ນັກພັດທະນາລະບົບ'
			});
		expect(res.status).toBe(201);
		expect(res.body.data.positionLevelId).toBe(level.id);
	});

	it('rejects a position level from a different company', async () => {
		const cookie = await superAdminCookie();
		const companyA = await createTestCompany();
		const companyB = await createTestCompany();
		const levelOfB = await prisma.positionLevel.create({
			data: { companyId: companyB.id, code: uniqueCode('LVL'), nameLao: 'ລະດັບ B', rank: 1 }
		});

		const res = await agent()
			.post('/api/v1/positions')
			.set('Cookie', cookie)
			.send({
				companyId: companyA.id,
				positionLevelId: levelOfB.id,
				code: uniqueCode('POS'),
				nameLao: 'ຕຳແໜ່ງ'
			});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('POSITION_LEVEL_COMPANY_MISMATCH');
	});

	it('rejects assigning an inactive position level to a new ACTIVE position', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();
		const inactiveLevel = await prisma.positionLevel.create({
			data: {
				companyId: company.id,
				code: uniqueCode('LVL'),
				nameLao: 'ລະດັບປິດ',
				rank: 9,
				status: 'INACTIVE'
			}
		});

		const res = await agent()
			.post('/api/v1/positions')
			.set('Cookie', cookie)
			.send({
				companyId: company.id,
				positionLevelId: inactiveLevel.id,
				code: uniqueCode('POS'),
				nameLao: 'ຕຳແໜ່ງ',
				status: 'ACTIVE'
			});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INACTIVE_PARENT');
	});

	it('creates then updates a position', async () => {
		const cookie = await superAdminCookie();
		const company = await createTestCompany();

		const createRes = await agent()
			.post('/api/v1/positions')
			.set('Cookie', cookie)
			.send({ companyId: company.id, code: uniqueCode('POS'), nameLao: 'ຕຳແໜ່ງເດີມ' });
		expect(createRes.status).toBe(201);

		const updateRes = await agent()
			.patch(`/api/v1/positions/${createRes.body.data.id}`)
			.set('Cookie', cookie)
			.send({ nameLao: 'ຕຳແໜ່ງໃໝ່' });
		expect(updateRes.status).toBe(200);
		expect(updateRes.body.data.nameLao).toBe('ຕຳແໜ່ງໃໝ່');
	});

	it('requires positions.disable to change status', async () => {
		const admin = await superAdminCookie();
		const company = await createTestCompany();
		const position = await prisma.position.create({
			data: { companyId: company.id, code: uniqueCode('POS'), nameLao: 'ຕຳແໜ່ງ' }
		});

		// MANAGER has positions.view only, not positions.disable.
		const manager = await createTestUser({ roleCode: 'MANAGER' });
		const managerCookie = await loginAndGetCookie(manager.username, manager.password);

		const deniedRes = await agent()
			.patch(`/api/v1/positions/${position.id}`)
			.set('Cookie', managerCookie)
			.send({ status: 'INACTIVE' });
		expect(deniedRes.status).toBe(403);

		const okRes = await agent()
			.patch(`/api/v1/positions/${position.id}`)
			.set('Cookie', admin)
			.send({ status: 'INACTIVE' });
		expect(okRes.status).toBe(200);
		expect(okRes.body.data.status).toBe('INACTIVE');
	});
});
