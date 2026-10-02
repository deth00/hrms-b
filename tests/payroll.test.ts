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

const uid = () => randomUUID().slice(0, 6).toUpperCase();
const get = (path: string, cookie: string) => agent().get(`/api/v1${path}`).set('Cookie', cookie);
const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const patch = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().patch(`/api/v1${path}`).set('Cookie', cookie).send(body);
const put = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().put(`/api/v1${path}`).set('Cookie', cookie).send(body);

const PAYROLL_PERMS = [
	'compensation.view',
	'compensation.manage',
	'pay_components.view',
	'pay_components.manage',
	'payroll.view',
	'payroll.manage',
	'payroll.calculate',
	'payroll.finalize'
];

let admin: string;
beforeAll(async () => {
	admin = await superAdminCookie();
});

// ---------- fixtures ----------
async function newCompany(currency = 'LAK') {
	const c = await createTestCompany();
	const res = await put(`/payroll/settings?companyId=${c.id}`, admin, { currencyCode: currency });
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return c.id;
}
async function newEmp(companyId: string, startDate = '2024-01-01', endDate: string | null = null) {
	const code = `PE_${uid()}`;
	return prisma.employee.create({
		data: {
			employeeCode: code,
			firstNameLao: 'ພະນັກງານ',
			lastNameLao: code,
			startDate: new Date(`${startDate}T00:00:00Z`),
			endDate: endDate ? new Date(`${endDate}T00:00:00Z`) : null,
			companyId
		}
	});
}
async function component(
	companyId: string,
	type: 'EARNING' | 'DEDUCTION',
	extra: Record<string, unknown> = {}
) {
	const res = await post('/pay-components', admin, {
		companyId,
		code: `C_${uid()}`,
		nameLao: type === 'EARNING' ? 'ລາຍຮັບ' : 'ລາຍຈ່າຍ',
		type,
		category: type === 'EARNING' ? 'ALLOWANCE' : 'DEDUCTION',
		...extra
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; code: string };
}
const setSalary = (empId: string, amount: string | number, from: string, cookie = admin) =>
	post(`/employees/${empId}/compensation`, cookie, { baseSalary: amount, effectiveFrom: from });
const assign = (
	empId: string,
	payComponentId: string,
	amount: string | number,
	from: string,
	cookie = admin
) =>
	post(`/employees/${empId}/recurring-pay-components`, cookie, {
		payComponentId,
		amount,
		effectiveFrom: from
	});
async function period(
	companyId: string,
	code = '2026-10',
	start = '2026-10-01',
	end = '2026-10-31'
) {
	const res = await post('/payroll/periods', admin, {
		companyId,
		code,
		name: `งวด ${code}`,
		startDate: start,
		endDate: end,
		payDate: end
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
}
async function run(companyId: string, periodId?: string) {
	const p = periodId ?? (await period(companyId)).id;
	const res = await post('/payroll/runs', admin, { companyId, periodId: p });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return { id: res.body.data.id as string, periodId: p };
}
const calc = (runId: string, cookie = admin) => post(`/payroll/runs/${runId}/calculate`, cookie);
const fin = (runId: string, body: Record<string, unknown> = {}, cookie = admin) =>
	post(`/payroll/runs/${runId}/finalize`, cookie, body);
async function results(runId: string) {
	const res = await get(`/payroll/runs/${runId}/results?pageSize=100`, admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data.items as {
		id: string;
		employee: { id: string; employeeCode: string };
		baseSalary: string | null;
		totalEarnings: string;
		totalDeductions: string;
		netPay: string;
		calculationStatus: 'READY' | 'BLOCKED';
		issues: { code: string }[];
	}[];
}
const resultOf = async (runId: string, empId: string) =>
	(await results(runId)).find((r) => r.employee.id === empId);
const detail = async (resultId: string) =>
	(await get(`/payroll/results/${resultId}`, admin)).body.data;
const audit = (where: Record<string, unknown>) =>
	prisma.auditEvent.findMany({ where, orderBy: { createdAt: 'asc' } });

/** company + one fully configured employee (5,000,000 base, HOUSE +500,000, LOAN −300,000) */
async function standard() {
	const companyId = await newCompany();
	const emp = await newEmp(companyId);
	const house = await component(companyId, 'EARNING');
	const loan = await component(companyId, 'DEDUCTION');
	expect((await setSalary(emp.id, '5000000', '2026-01-01')).status).toBe(201);
	expect((await assign(emp.id, house.id, '500000', '2026-01-01')).status).toBe(201);
	expect((await assign(emp.id, loan.id, '300000', '2026-01-01')).status).toBe(201);
	return { companyId, emp, house, loan };
}

// ============================================================================================
describe('payroll settings', () => {
	it('1. authentication is required', async () => {
		const c = await createTestCompany();
		expect((await agent().get(`/api/v1/payroll/settings?companyId=${c.id}`)).status).toBe(401);
		expect((await agent().put(`/api/v1/payroll/settings?companyId=${c.id}`)).status).toBe(401);
	});

	it('2. viewing needs payroll.view (and the broad scope)', async () => {
		const c = await createTestCompany();
		const plain = await userWithPermissions(['dashboard.view']);
		expect((await get(`/payroll/settings?companyId=${c.id}`, plain.cookie)).status).toBe(403);
		const viewer = await userWithPermissions(['payroll.view', 'employees.view_all']);
		expect((await get(`/payroll/settings?companyId=${c.id}`, viewer.cookie)).status).toBe(200);
	});

	it('3. changing needs payroll.manage', async () => {
		const c = await createTestCompany();
		const viewer = await userWithPermissions(['payroll.view', 'employees.view_all']);
		expect(
			(await put(`/payroll/settings?companyId=${c.id}`, viewer.cookie, { currencyCode: 'LAK' }))
				.status
		).toBe(403);
		const manager = await userWithPermissions(['payroll.manage', 'employees.view_all']);
		expect(
			(await put(`/payroll/settings?companyId=${c.id}`, manager.cookie, { currencyCode: 'LAK' }))
				.status
		).toBe(200);
	});

	it('4. creates and updates settings (monthly, currency upper-cased)', async () => {
		const c = await createTestCompany();
		const before = await get(`/payroll/settings?companyId=${c.id}`, admin);
		expect(before.body.data).toMatchObject({
			configured: false,
			currencyCode: null,
			payFrequency: 'MONTHLY'
		});
		const saved = await put(`/payroll/settings?companyId=${c.id}`, admin, { currencyCode: 'thb' });
		expect(saved.body.data).toMatchObject({
			configured: true,
			currencyCode: 'THB',
			payFrequency: 'MONTHLY'
		});
		const again = await put(`/payroll/settings?companyId=${c.id}`, admin, { currencyCode: 'USD' });
		expect(again.body.data.currencyCode).toBe('USD');
	});

	it('5. an invalid currency or frequency is rejected', async () => {
		const c = await createTestCompany();
		for (const body of [
			{ currencyCode: 'LA' },
			{ currencyCode: 'LAKK' },
			{ currencyCode: '12A' },
			{ currencyCode: 'LAK', payFrequency: 'WEEKLY' }
		]) {
			expect((await put(`/payroll/settings?companyId=${c.id}`, admin, body)).status).toBe(400);
		}
	});

	it('5b. the currency is locked once compensation exists', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		await setSalary(emp.id, '1000', '2026-01-01');
		const res = await put(`/payroll/settings?companyId=${companyId}`, admin, {
			currencyCode: 'USD'
		});
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_CURRENCY_LOCKED');
	});
});

// ============================================================================================
describe('pay components', () => {
	it('6. creates an earning', async () => {
		const companyId = await newCompany();
		const c = await component(companyId, 'EARNING');
		const res = await get(`/pay-components/${c.id}`, admin);
		expect(res.body.data).toMatchObject({
			type: 'EARNING',
			category: 'ALLOWANCE',
			status: 'ACTIVE',
			isRecurring: true
		});
	});

	it('7. creates a deduction', async () => {
		const companyId = await newCompany();
		const c = await component(companyId, 'DEDUCTION');
		expect((await get(`/pay-components/${c.id}`, admin)).body.data.type).toBe('DEDUCTION');
	});

	it('8. duplicate code in one company is rejected (allowed in another)', async () => {
		const a = await newCompany();
		const b = await newCompany();
		const body = { code: `DUP_${uid()}`, nameLao: 'ລາຍການ', type: 'EARNING', category: 'BONUS' };
		expect((await post('/pay-components', admin, { companyId: a, ...body })).status).toBe(201);
		const dup = await post('/pay-components', admin, { companyId: a, ...body });
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('PAY_COMPONENT_CODE_TAKEN');
		expect((await post('/pay-components', admin, { companyId: b, ...body })).status).toBe(201);
	});

	it('9. a component carries no amount — type decides the direction; category must match', async () => {
		const companyId = await newCompany();
		const bad = await post('/pay-components', admin, {
			companyId,
			code: `X_${uid()}`,
			nameLao: 'ກ',
			type: 'DEDUCTION',
			category: 'ALLOWANCE'
		});
		expect(bad.status).toBe(400);
		const withAmount = await post('/pay-components', admin, {
			companyId,
			code: `Y_${uid()}`,
			nameLao: 'ກ',
			type: 'EARNING',
			category: 'ALLOWANCE',
			amount: -5
		});
		expect(withAmount.status).toBe(400); // strict body: no amount on the master
	});

	it('9b. system codes are reserved', async () => {
		const companyId = await newCompany();
		for (const code of ['BASE_SALARY', 'TAX', 'SOCIAL_SECURITY', 'OVERTIME']) {
			const res = await post('/pay-components', admin, {
				companyId,
				code,
				nameLao: 'ກ',
				type: 'EARNING',
				category: 'OTHER_EARNING'
			});
			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe('PAY_CODE_RESERVED');
		}
	});

	it('10. update and disable (type is immutable); no DELETE', async () => {
		const companyId = await newCompany();
		const c = await component(companyId, 'EARNING');
		const upd = await patch(`/pay-components/${c.id}`, admin, {
			nameLao: 'ຊື່ໃໝ່',
			status: 'INACTIVE'
		});
		expect(upd.body.data).toMatchObject({ nameLao: 'ຊື່ໃໝ່', status: 'INACTIVE' });
		expect((await patch(`/pay-components/${c.id}`, admin, { type: 'DEDUCTION' })).status).toBe(400);
		expect((await patch(`/pay-components/${c.id}`, admin, { category: 'DEDUCTION' })).status).toBe(
			400
		);
		expect(
			(await agent().delete(`/api/v1/pay-components/${c.id}`).set('Cookie', admin)).status
		).toBe(404);
	});

	it('11. list is filterable by company / type / status / search and permission-gated', async () => {
		const a = await newCompany();
		const b = await newCompany();
		const c1 = await component(a, 'EARNING');
		await component(a, 'DEDUCTION');
		await component(b, 'EARNING');
		const listA = await get(`/pay-components?companyId=${a}`, admin);
		expect(listA.body.data.total).toBe(2);
		expect((await get(`/pay-components?companyId=${a}&type=EARNING`, admin)).body.data.total).toBe(
			1
		);
		expect(
			(await get(`/pay-components?companyId=${a}&search=${c1.code}`, admin)).body.data.total
		).toBe(1);
		expect(
			(await get(`/pay-components?companyId=${a}&status=INACTIVE`, admin)).body.data.total
		).toBe(0);
		const plain = await userWithPermissions(['dashboard.view']);
		expect((await get('/pay-components', plain.cookie)).status).toBe(403);
		const viewer = await userWithPermissions(['pay_components.view']);
		expect((await get('/pay-components', viewer.cookie)).status).toBe(200);
		expect((await post('/pay-components', viewer.cookie, {})).status).toBe(403);
	});
});

// ============================================================================================
describe('employee compensation', () => {
	it('12. viewing compensation needs compensation.view', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const plain = await userWithPermissions(['dashboard.view']);
		expect((await get(`/employees/${emp.id}/compensation`, plain.cookie)).status).toBe(403);
		const viewer = await userWithPermissions(['compensation.view', 'employees.view_all']);
		expect((await get(`/employees/${emp.id}/compensation`, viewer.cookie)).status).toBe(200);
		expect((await agent().get(`/api/v1/employees/${emp.id}/compensation`)).status).toBe(401);
	});

	it('13. the broad payroll scope (employees.view_all) is required — no manager-tree fallback', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const narrow = await userWithPermissions([
			'compensation.view',
			'compensation.manage',
			'employees.view'
		]);
		expect((await get(`/employees/${emp.id}/compensation`, narrow.cookie)).status).toBe(403);
		expect((await get(`/employees/${emp.id}/compensation-history`, narrow.cookie)).status).toBe(
			403
		);
		expect((await setSalary(emp.id, '1000', '2026-01-01', narrow.cookie)).status).toBe(403);
	});

	it('14. creates the initial salary', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const res = await setSalary(emp.id, '5000000', '2026-01-01');
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data.current).toMatchObject({
			baseSalary: '5000000.00',
			currencyCode: 'LAK',
			effectiveTo: null
		});
		expect(res.body.data.payrollConfigured).toBe(true);
	});

	it('15. money is exact Decimal (string, 2 places; no float artefacts)', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		await setSalary(emp.id, '1234567890123.45', '2026-01-01');
		const row = await prisma.employeeCompensation.findFirstOrThrow({
			where: { employeeId: emp.id }
		});
		expect(row.baseSalary.toFixed(2)).toBe('1234567890123.45');
		const res = await get(`/employees/${emp.id}/compensation`, admin);
		expect(res.body.data.current.baseSalary).toBe('1234567890123.45');
		expect(typeof res.body.data.current.baseSalary).toBe('string');
		// invalid money
		for (const bad of ['-5', '0', '1.234', '1e5', 'abc', '']) {
			expect((await setSalary(emp.id, bad, '2027-01-01')).status, bad).toBe(400);
		}
	});

	it('16. a currency that differs from the payroll settings is rejected', async () => {
		const companyId = await newCompany('LAK');
		const emp = await newEmp(companyId);
		const res = await post(`/employees/${emp.id}/compensation`, admin, {
			baseSalary: '1000',
			effectiveFrom: '2026-01-01',
			currencyCode: 'USD'
		});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('PAYROLL_CURRENCY_MISMATCH');
		const noSettings = await createTestCompany();
		const e2 = await newEmp(noSettings.id);
		const res2 = await setSalary(e2.id, '1000', '2026-01-01');
		expect(res2.status).toBe(409);
		expect(res2.body.error.code).toBe('PAYROLL_SETTINGS_REQUIRED');
	});

	it('17. the effective date cannot precede the employment start or follow its end', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId, '2025-06-01', '2026-12-31');
		const before = await setSalary(emp.id, '1000', '2025-05-31');
		expect(before.status).toBe(400);
		expect(before.body.error.code).toBe('EFFECTIVE_DATE_BEFORE_EMPLOYMENT');
		const after = await setSalary(emp.id, '1000', '2027-01-01');
		expect(after.body.error.code).toBe('EFFECTIVE_DATE_AFTER_EMPLOYMENT');
		expect((await setSalary(emp.id, '1000', '2025-06-01')).status).toBe(201);
	});

	it('18. a salary change closes the previous record the day before', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		await setSalary(emp.id, '5000000', '2026-01-01');
		const res = await setSalary(emp.id, '6000000', '2026-07-01');
		expect(res.status).toBe(201);
		const rows = await prisma.employeeCompensation.findMany({
			where: { employeeId: emp.id },
			orderBy: { effectiveFrom: 'asc' }
		});
		expect(rows).toHaveLength(2);
		expect(rows[0]!.effectiveTo?.toISOString().slice(0, 10)).toBe('2026-06-30');
		expect(rows[1]!.effectiveTo).toBeNull();
		expect(res.body.data.upcoming ?? res.body.data.current).toBeTruthy();
	});

	it('19. salary history is preserved (immutable rows, newest first)', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		await setSalary(emp.id, '5000000', '2026-01-01');
		await setSalary(emp.id, '6000000', '2026-07-01');
		await setSalary(emp.id, '7000000', '2027-01-01');
		const hist = await get(`/employees/${emp.id}/compensation-history`, admin);
		expect(hist.body.data.items.map((r: { baseSalary: string }) => r.baseSalary)).toEqual([
			'7000000.00',
			'6000000.00',
			'5000000.00'
		]);
		// no edit / delete endpoint
		const id = hist.body.data.items[0].id;
		expect(
			(await agent().delete(`/api/v1/employees/${emp.id}/compensation/${id}`).set('Cookie', admin))
				.status
		).toBe(404);
		expect(
			(await patch(`/employees/${emp.id}/compensation`, admin, { baseSalary: '1' })).status
		).toBe(404);
	});

	it('20. overlapping / back-dated compensation is rejected', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		await setSalary(emp.id, '5000000', '2026-01-01');
		await setSalary(emp.id, '6000000', '2026-07-01');
		for (const from of ['2026-07-01', '2026-03-01', '2026-01-01']) {
			const res = await setSalary(emp.id, '7000000', from);
			expect(res.status, from).toBe(409);
			expect(res.body.error.code).toBe('COMPENSATION_PERIOD_OVERLAP');
		}
		expect(await prisma.employeeCompensation.count({ where: { employeeId: emp.id } })).toBe(2);
	});

	it('21. concurrent changes never produce overlapping periods', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const results = await Promise.all([
			setSalary(emp.id, '1000', '2026-01-01'),
			setSalary(emp.id, '2000', '2026-04-01'),
			setSalary(emp.id, '3000', '2026-08-01'),
			setSalary(emp.id, '4000', '2026-08-01')
		]);
		expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
		const rows = await prisma.employeeCompensation.findMany({
			where: { employeeId: emp.id },
			orderBy: { effectiveFrom: 'asc' }
		});
		for (let i = 0; i < rows.length - 1; i++) {
			expect(rows[i]!.effectiveTo, `row ${i}`).not.toBeNull();
			expect(rows[i]!.effectiveTo!.getTime()).toBeLessThan(rows[i + 1]!.effectiveFrom.getTime());
		}
		expect(rows[rows.length - 1]!.effectiveTo).toBeNull();
	});

	it('22. salary is not exposed in the generic employee list / detail / lookup', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		await setSalary(emp.id, '7654321', '2026-01-01');
		const texts = [
			JSON.stringify((await get(`/employees?search=${emp.employeeCode}`, admin)).body),
			JSON.stringify((await get(`/employees/${emp.id}`, admin)).body),
			JSON.stringify((await get(`/employees/lookup?search=${emp.employeeCode}`, admin)).body)
		];
		for (const t of texts) {
			expect(t).not.toMatch(/7654321|baseSalary|salary/i);
		}
	});
});

// ============================================================================================
describe('recurring pay components', () => {
	it('23. assigns an earning', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const c = await component(companyId, 'EARNING');
		const res = await assign(emp.id, c.id, '500000', '2026-01-01');
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data.items[0]).toMatchObject({ amount: '500000.00', state: 'CURRENT' });
		expect(res.body.data.items[0].payComponent.type).toBe('EARNING');
	});

	it('24. assigns a deduction (amount is positive; the type decides the direction)', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const c = await component(companyId, 'DEDUCTION');
		const res = await assign(emp.id, c.id, '300000', '2026-01-01');
		expect(res.body.data.items[0].amount).toBe('300000.00');
		expect(res.body.data.items[0].payComponent.type).toBe('DEDUCTION');
	});

	it('25. the amount must be > 0', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const c = await component(companyId, 'DEDUCTION');
		for (const bad of ['-300000', 0, '0.00', -1]) {
			expect((await assign(emp.id, c.id, bad, '2026-01-01')).status).toBe(400);
		}
	});

	it('26. an inactive component cannot be newly assigned (history stays readable)', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const c = await component(companyId, 'EARNING');
		await assign(emp.id, c.id, '100', '2026-01-01');
		await patch(`/pay-components/${c.id}`, admin, { status: 'INACTIVE' });
		const again = await assign(emp.id, c.id, '200', '2026-06-01');
		expect(again.status).toBe(400);
		expect(again.body.error.code).toBe('PAY_COMPONENT_INACTIVE');
		const list = await get(`/employees/${emp.id}/recurring-pay-components`, admin);
		expect(list.body.data.items).toHaveLength(1);
		expect(list.body.data.items[0].payComponent.status).toBe('INACTIVE');
	});

	it('27. a component of another company is rejected', async () => {
		const a = await newCompany();
		const b = await newCompany();
		const emp = await newEmp(a);
		const foreign = await component(b, 'EARNING');
		const res = await assign(emp.id, foreign.id, '100', '2026-01-01');
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('PAY_COMPONENT_COMPANY_MISMATCH');
	});

	it('28. overlapping / back-dated assignment is rejected', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const c = await component(companyId, 'EARNING');
		await assign(emp.id, c.id, '500000', '2026-01-01');
		const res = await assign(emp.id, c.id, '600000', '2026-01-01');
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAY_COMPONENT_PERIOD_OVERLAP');
		expect((await assign(emp.id, c.id, '600000', '2025-12-01')).status).toBe(409);
	});

	it('29. a change preserves history (old row closed, new row created)', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const c = await component(companyId, 'EARNING');
		await assign(emp.id, c.id, '500000', '2026-01-01');
		await assign(emp.id, c.id, '750000', '2026-07-01');
		const rows = await prisma.employeeRecurringPayComponent.findMany({
			where: { employeeId: emp.id },
			orderBy: { effectiveFrom: 'asc' }
		});
		expect(rows.map((r) => r.amount.toFixed(2))).toEqual(['500000.00', '750000.00']);
		expect(rows[0]!.effectiveTo?.toISOString().slice(0, 10)).toBe('2026-06-30');
		expect(rows[1]!.effectiveTo).toBeNull();
	});

	it('30. ending a component sets effectiveTo (no hard delete, once only)', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const c = await component(companyId, 'DEDUCTION');
		const created = await assign(emp.id, c.id, '300000', '2026-01-01');
		const id = created.body.data.items[0].id;
		const end = await post(`/employee-recurring-pay-components/${id}/end`, admin, {
			effectiveTo: '2026-06-30'
		});
		expect(end.status, JSON.stringify(end.body)).toBe(200);
		expect(end.body.data.items[0].effectiveTo).toContain('2026-06-30');
		const again = await post(`/employee-recurring-pay-components/${id}/end`, admin, {
			effectiveTo: '2026-07-31'
		});
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('PAY_COMPONENT_ALREADY_ENDED');
		const e2 = await assign(emp.id, c.id, '1', '2026-08-01');
		const before = await post(
			`/employee-recurring-pay-components/${e2.body.data.items[0].id}/end`,
			admin,
			{ effectiveTo: '2026-07-01' }
		);
		expect(before.status).toBe(400);
		expect(
			await prisma.employeeRecurringPayComponent.count({ where: { employeeId: emp.id } })
		).toBe(2);
	});

	it('31. recurring amounts are exact Decimal', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const c = await component(companyId, 'EARNING');
		await assign(emp.id, c.id, '0.10', '2026-01-01');
		const row = await prisma.employeeRecurringPayComponent.findFirstOrThrow({
			where: { employeeId: emp.id }
		});
		expect(row.amount.toFixed(2)).toBe('0.10');
		const list = await get(`/employees/${emp.id}/recurring-pay-components`, admin);
		expect(list.body.data.items[0].amount).toBe('0.10');
	});
});

// ============================================================================================
describe('payroll periods', () => {
	it('32. creates a period', async () => {
		const companyId = await newCompany();
		const res = await post('/payroll/periods', admin, {
			companyId,
			code: '2026-10',
			name: 'ເດືອນ ຕຸລາ 2026',
			startDate: '2026-10-01',
			endDate: '2026-10-31',
			payDate: '2026-10-31'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data).toMatchObject({ status: 'OPEN', code: '2026-10' });
	});

	it('33. invalid date range / pay date are rejected', async () => {
		const companyId = await newCompany();
		const base = {
			companyId,
			code: 'X',
			name: 'ກ',
			startDate: '2026-10-31',
			endDate: '2026-10-01',
			payDate: '2026-10-31'
		};
		expect((await post('/payroll/periods', admin, base)).status).toBe(400);
		expect(
			(
				await post('/payroll/periods', admin, {
					...base,
					startDate: '2026-10-01',
					endDate: '2026-10-31',
					payDate: '2026-10-15'
				})
			).status
		).toBe(400);
		expect((await post('/payroll/periods', admin, { ...base, startDate: 'nope' })).status).toBe(
			400
		);
	});

	it('34. duplicate code is rejected', async () => {
		const companyId = await newCompany();
		await period(companyId, '2026-10');
		const res = await post('/payroll/periods', admin, {
			companyId,
			code: '2026-10',
			name: 'ກ',
			startDate: '2027-01-01',
			endDate: '2027-01-31',
			payDate: '2027-01-31'
		});
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_PERIOD_CODE_TAKEN');
	});

	it('35. overlapping periods are rejected (any status), adjacent ones are fine', async () => {
		const companyId = await newCompany();
		await period(companyId, '2026-10', '2026-10-01', '2026-10-31');
		const overlap = await post('/payroll/periods', admin, {
			companyId,
			code: 'B',
			name: 'ກ',
			startDate: '2026-10-31',
			endDate: '2026-11-30',
			payDate: '2026-11-30'
		});
		expect(overlap.status).toBe(409);
		expect(overlap.body.error.code).toBe('PAYROLL_PERIOD_OVERLAP');
		expect((await period(companyId, '2026-11', '2026-11-01', '2026-11-30')).id).toBeTruthy();
	});

	it('36. an open period can be edited (name / pay date / dates when it has no run)', async () => {
		const companyId = await newCompany();
		const p = await period(companyId);
		const res = await patch(`/payroll/periods/${p.id}`, admin, {
			name: 'ຊື່ໃໝ່',
			endDate: '2026-10-30',
			payDate: '2026-10-31'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data.name).toBe('ຊື່ໃໝ່');
		expect((await patch(`/payroll/periods/${p.id}`, admin, { endDate: '2026-09-01' })).status).toBe(
			400
		);
	});

	it('37. a closed period is immutable; a period with a run cannot change its dates', async () => {
		const { companyId } = await standard();
		const p = await period(companyId);
		await run(companyId, p.id);
		const hasRun = await patch(`/payroll/periods/${p.id}`, admin, { endDate: '2026-10-30' });
		expect(hasRun.status).toBe(409);
		expect(hasRun.body.error.code).toBe('PAYROLL_PERIOD_HAS_RUN');
		expect((await patch(`/payroll/periods/${p.id}`, admin, { name: 'ຍັງແກ້ຊື່ໄດ້' })).status).toBe(
			200
		);
		await prisma.payrollPeriod.update({ where: { id: p.id }, data: { status: 'CLOSED' } });
		const closed = await patch(`/payroll/periods/${p.id}`, admin, { name: 'ແກ້ບໍ່ໄດ້' });
		expect(closed.status).toBe(409);
		expect(closed.body.error.code).toBe('PAYROLL_PERIOD_CLOSED');
	});

	it('37b. list filters (company / year / status) and permissions', async () => {
		const companyId = await newCompany();
		await period(companyId, '2026-10', '2026-10-01', '2026-10-31');
		await period(companyId, '2027-01', '2027-01-01', '2027-01-31');
		expect((await get(`/payroll/periods?companyId=${companyId}`, admin)).body.data.total).toBe(2);
		expect(
			(await get(`/payroll/periods?companyId=${companyId}&year=2027`, admin)).body.data.total
		).toBe(1);
		expect(
			(await get(`/payroll/periods?companyId=${companyId}&status=CLOSED`, admin)).body.data.total
		).toBe(0);
		const plain = await userWithPermissions(['dashboard.view']);
		expect((await get('/payroll/periods', plain.cookie)).status).toBe(403);
	});
});

// ============================================================================================
describe('payroll run', () => {
	it('38. creates a DRAFT run with the company currency and calculationVersion 1', async () => {
		const companyId = await newCompany('THB');
		const r = await run(companyId);
		const res = await get(`/payroll/runs/${r.id}`, admin);
		expect(res.body.data).toMatchObject({
			status: 'DRAFT',
			currencyCode: 'THB',
			calculationVersion: 1
		});
		expect(res.body.data.summary.employees).toBe(0);
	});

	it('39. only one run per period', async () => {
		const companyId = await newCompany();
		const r = await run(companyId);
		const dup = await post('/payroll/runs', admin, { companyId, periodId: r.periodId });
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('PAYROLL_RUN_EXISTS');
	});

	it('40. permission checks for every run endpoint', async () => {
		const companyId = await newCompany();
		const r = await run(companyId);
		const viewer = await userWithPermissions(['payroll.view', 'employees.view_all']);
		expect((await get(`/payroll/runs/${r.id}`, viewer.cookie)).status).toBe(200);
		expect((await post('/payroll/runs', viewer.cookie, {})).status).toBe(403);
		expect((await calc(r.id, viewer.cookie)).status).toBe(403);
		expect((await fin(r.id, {}, viewer.cookie)).status).toBe(403);
		const calculator = await userWithPermissions(['payroll.calculate', 'employees.view_all']);
		expect((await calc(r.id, calculator.cookie)).status).toBe(200);
		expect((await fin(r.id, {}, calculator.cookie)).status).toBe(403);
		expect((await agent().get('/api/v1/payroll/runs')).status).toBe(401);
	});

	it('40b. creating a run needs payroll settings and an OPEN period of the same company', async () => {
		const other = await newCompany();
		const p = await period(other);
		const companyId = await newCompany();
		expect((await post('/payroll/runs', admin, { companyId, periodId: p.id })).status).toBe(400);
		await prisma.payrollPeriod.update({ where: { id: p.id }, data: { status: 'CLOSED' } });
		expect((await post('/payroll/runs', admin, { companyId: other, periodId: p.id })).status).toBe(
			409
		);
	});

	it('41. calculates a run', async () => {
		const { companyId } = await standard();
		const r = await run(companyId);
		const res = await calc(r.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data).toMatchObject({ status: 'CALCULATED' });
		expect(res.body.data.calculatedAt).toBeTruthy();
		expect(res.body.data.summary).toMatchObject({ employees: 1, ready: 1, blocked: 0 });
	});

	it('42. an employee whose employment overlaps the period is included', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		expect(await resultOf(r.id, emp.id)).toBeTruthy();
	});

	it('43. employees outside the period are excluded (starts after / ended before)', async () => {
		const { companyId } = await standard();
		const later = await newEmp(companyId, '2026-11-05');
		const earlier = await newEmp(companyId, '2024-01-01', '2026-09-30');
		const r = await run(companyId);
		await calc(r.id);
		const rows = await results(r.id);
		expect(rows.find((x) => x.employee.id === later.id)).toBeUndefined();
		expect(rows.find((x) => x.employee.id === earlier.id)).toBeUndefined();
	});

	it('44. missing compensation → BLOCKED (never assumes 0)', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const r = await run(companyId);
		await calc(r.id);
		const row = await resultOf(r.id, emp.id);
		expect(row).toMatchObject({ calculationStatus: 'BLOCKED', baseSalary: null });
		expect(row!.issues.map((i) => i.code)).toContain('MISSING_COMPENSATION');
	});

	it('45. an employee who starts / leaves inside the period → BLOCKED (partial period)', async () => {
		const companyId = await newCompany();
		const starter = await newEmp(companyId, '2026-10-15');
		const leaver = await newEmp(companyId, '2024-01-01', '2026-10-20');
		await setSalary(starter.id, '1000', '2026-10-15');
		await setSalary(leaver.id, '1000', '2024-01-01');
		const r = await run(companyId);
		await calc(r.id);
		for (const e of [starter, leaver]) {
			const row = await resultOf(r.id, e.id);
			expect(row!.calculationStatus).toBe('BLOCKED');
			expect(row!.issues.map((i) => i.code)).toContain('EMPLOYEE_PARTIAL_PERIOD');
		}
		// a new hire whose pay starts on the hire date does NOT also get a compensation-change issue
		expect((await resultOf(r.id, starter.id))!.issues.map((i) => i.code)).not.toContain(
			'COMPENSATION_CHANGE_WITHIN_PERIOD'
		);
	});

	it('46. a base-salary change inside the period → BLOCKED', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		await setSalary(emp.id, '1000', '2026-01-01');
		await setSalary(emp.id, '2000', '2026-10-16');
		const r = await run(companyId);
		await calc(r.id);
		const row = await resultOf(r.id, emp.id);
		expect(row!.calculationStatus).toBe('BLOCKED');
		expect(row!.issues.map((i) => i.code)).toContain('COMPENSATION_CHANGE_WITHIN_PERIOD');
	});

	it('47. a recurring-component change (or end) inside the period → BLOCKED', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const changed = await newEmp(companyId);
		const c = await component(companyId, 'EARNING');
		for (const e of [emp, changed]) await setSalary(e.id, '1000', '2026-01-01');
		await assign(emp.id, c.id, '100', '2026-01-01');
		await assign(emp.id, c.id, '200', '2026-10-16');
		const ended = await assign(changed.id, c.id, '100', '2026-01-01');
		await post(`/employee-recurring-pay-components/${ended.body.data.items[0].id}/end`, admin, {
			effectiveTo: '2026-10-10'
		});
		const r = await run(companyId);
		await calc(r.id);
		for (const e of [emp, changed]) {
			const row = await resultOf(r.id, e.id);
			expect(row!.calculationStatus).toBe('BLOCKED');
			expect(row!.issues.map((i) => i.code)).toContain('PAY_COMPONENT_CHANGE_WITHIN_PERIOD');
		}
	});
});

// ============================================================================================
describe('payroll calculation', () => {
	it('48. a BASE_SALARY line item exists', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		const d = await detail((await resultOf(r.id, emp.id))!.id);
		const base = d.items.find((i: { code: string }) => i.code === 'BASE_SALARY');
		expect(base).toMatchObject({
			source: 'BASE_SALARY',
			type: 'EARNING',
			amount: '5000000.00',
			nameLao: 'ເງິນເດືອນພື້ນຖານ'
		});
		expect(d.baseSalary).toBe('5000000.00');
	});

	it('49. a recurring earning is added', async () => {
		const { companyId, emp, house } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		const d = await detail((await resultOf(r.id, emp.id))!.id);
		expect(d.items.find((i: { code: string }) => i.code === house.code)).toMatchObject({
			source: 'RECURRING',
			type: 'EARNING',
			amount: '500000.00'
		});
		expect(d.totalEarnings).toBe('5500000.00');
	});

	it('50. a recurring deduction is subtracted', async () => {
		const { companyId, emp, loan } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		const d = await detail((await resultOf(r.id, emp.id))!.id);
		expect(d.items.find((i: { code: string }) => i.code === loan.code)).toMatchObject({
			source: 'RECURRING',
			type: 'DEDUCTION',
			amount: '300000.00'
		});
		expect(d.totalDeductions).toBe('300000.00');
	});

	async function adjust(
		runId: string,
		empId: string,
		body: Record<string, unknown>,
		cookie = admin
	) {
		return post(`/payroll/runs/${runId}/employees/${empId}/adjustments`, cookie, {
			code: 'BONUS',
			nameLao: 'ໂບນັດ',
			reason: 'ເຫດຜົນທົດສອບ',
			...body
		});
	}

	it('51. a manual earning is added (after recalculation)', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		expect((await adjust(r.id, emp.id, { type: 'EARNING', amount: '1000000' })).status).toBe(201);
		await calc(r.id);
		const row = await resultOf(r.id, emp.id);
		expect(row).toMatchObject({ totalEarnings: '6500000.00', netPay: '6200000.00' });
	});

	it('52. a manual deduction is subtracted', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		await adjust(r.id, emp.id, {
			type: 'DEDUCTION',
			code: 'FINE',
			nameLao: 'ຄ່າປັບ',
			amount: '50000.50'
		});
		await calc(r.id);
		const row = await resultOf(r.id, emp.id);
		expect(row).toMatchObject({ totalDeductions: '350000.50', netPay: '5149999.50' });
	});

	it('53. totals are exact Decimal sums (no floating-point drift)', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const a = await component(companyId, 'EARNING');
		const b = await component(companyId, 'EARNING');
		const d = await component(companyId, 'DEDUCTION');
		await setSalary(emp.id, '1234567.89', '2026-01-01');
		await assign(emp.id, a.id, '0.10', '2026-01-01');
		await assign(emp.id, b.id, '0.20', '2026-01-01');
		await assign(emp.id, d.id, '0.07', '2026-01-01');
		const r = await run(companyId);
		await calc(r.id);
		const row = await resultOf(r.id, emp.id);
		expect(row).toMatchObject({
			totalEarnings: '1234568.19',
			totalDeductions: '0.07',
			netPay: '1234568.12'
		});
	});

	it('54. net pay = total earnings − total deductions (5,200,000)', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		expect(await resultOf(r.id, emp.id)).toMatchObject({
			baseSalary: '5000000.00',
			totalEarnings: '5500000.00',
			totalDeductions: '300000.00',
			netPay: '5200000.00',
			calculationStatus: 'READY'
		});
		const summary = (await get(`/payroll/runs/${r.id}`, admin)).body.data.summary;
		expect(summary).toMatchObject({ employees: 1, ready: 1, blocked: 0, netPay: '5200000.00' });
	});

	it('55. negative net pay → BLOCKED, values stay visible', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const d = await component(companyId, 'DEDUCTION');
		await setSalary(emp.id, '100', '2026-01-01');
		await assign(emp.id, d.id, '250', '2026-01-01');
		const r = await run(companyId);
		await calc(r.id);
		const row = await resultOf(r.id, emp.id);
		expect(row).toMatchObject({
			calculationStatus: 'BLOCKED',
			netPay: '-150.00',
			totalDeductions: '250.00'
		});
		expect(row!.issues.map((i) => i.code)).toContain('NEGATIVE_NET_PAY');
	});

	it('56–59. no attendance / OT / tax / social-security lines exist', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		const d = await detail((await resultOf(r.id, emp.id))!.id);
		const codes = d.items.map((i: { code: string }) => i.code);
		expect(codes).toHaveLength(3);
		for (const forbidden of [
			'TAX',
			'SOCIAL_SECURITY',
			'SSO',
			'OVERTIME',
			'OT',
			'LATE',
			'ABSENT',
			'LEAVE'
		]) {
			expect(codes).not.toContain(forbidden);
		}
		expect(
			d.items.every((i: { source: string }) =>
				['BASE_SALARY', 'RECURRING', 'MANUAL'].includes(i.source)
			)
		).toBe(true);
		expect(d.totalDeductions).toBe('300000.00'); // only the LOAN — no attendance deduction
	});
});

// ============================================================================================
describe('recalculation', () => {
	it('60. recalculation replaces old results', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		const first = await resultOf(r.id, emp.id);
		await calc(r.id);
		const second = await resultOf(r.id, emp.id);
		expect(second!.id).not.toBe(first!.id); // rebuilt
		expect(await prisma.payrollEmployeeResult.count({ where: { payrollRunId: r.id } })).toBe(1);
	});

	it('61. no duplicate result items after repeated calculation', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		for (let i = 0; i < 3; i++) await calc(r.id);
		const row = await resultOf(r.id, emp.id);
		expect(
			await prisma.payrollResultItem.count({ where: { payrollEmployeeResultId: row!.id } })
		).toBe(3);
		expect(
			await prisma.payrollResultItem.count({ where: { result: { payrollRunId: r.id } } })
		).toBe(3);
	});

	it('62. a manual adjustment is preserved through recalculation', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		await post(`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`, admin, {
			type: 'EARNING',
			code: 'BONUS',
			nameLao: 'ໂບນັດ',
			amount: '1000000',
			reason: 'ເຫດຜົນ'
		});
		await calc(r.id);
		await calc(r.id);
		const d = await detail((await resultOf(r.id, emp.id))!.id);
		expect(d.items.filter((i: { source: string }) => i.source === 'MANUAL')).toHaveLength(1);
		expect(d.netPay).toBe('6200000.00');
		expect(d.manualAdjustments).toHaveLength(1);
	});

	it('63. a compensation change is reflected only after an explicit recalculation (before finalization)', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		expect((await resultOf(r.id, emp.id))!.baseSalary).toBe('5000000.00');
		// a salary change that starts on the first day of the period does not block …
		expect((await setSalary(emp.id, '9000000', '2026-10-01')).status).toBe(201);
		// … and the CALCULATED run is not mutated automatically
		expect((await resultOf(r.id, emp.id))!.baseSalary).toBe('5000000.00');
		await calc(r.id);
		expect(await resultOf(r.id, emp.id)).toMatchObject({
			baseSalary: '9000000.00',
			calculationStatus: 'READY'
		});
		// a brand-new employee only appears after recalculation too
		const other = await newEmp(companyId);
		expect(await resultOf(r.id, other.id)).toBeUndefined();
		await setSalary(other.id, '2000', '2026-01-01');
		await calc(r.id);
		expect(await resultOf(r.id, other.id)).toMatchObject({
			calculationStatus: 'READY',
			baseSalary: '2000.00'
		});
	});

	it('64. a finalized run cannot be recalculated', async () => {
		const { companyId } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		expect((await fin(r.id)).status).toBe(200);
		const res = await calc(r.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_RUN_FINALIZED');
	});
});

// ============================================================================================
describe('manual adjustments', () => {
	const body = (extra: Record<string, unknown> = {}) => ({
		type: 'EARNING',
		code: 'BONUS',
		nameLao: 'ໂບນັດ',
		amount: '1000000',
		reason: 'ຜົນງານພິເສດ',
		...extra
	});

	it('65. adds an adjustment (append-only record, run reported back)', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		const res = await post(`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`, admin, body());
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data.adjustment).toMatchObject({
			code: 'BONUS',
			amount: '1000000.00',
			type: 'EARNING'
		});
		const list = await get(`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`, admin);
		expect(list.body.data.items).toHaveLength(1);
	});

	it('66. the reason is required', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		for (const reason of [undefined, '', '  ', 'ກ']) {
			const res = await post(
				`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`,
				admin,
				body({ reason })
			);
			expect(res.status).toBe(400);
		}
	});

	it('67. a non-positive amount is rejected', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		for (const amount of ['-100', '0', 0, -1, '1.005']) {
			expect(
				(
					await post(
						`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`,
						admin,
						body({ amount })
					)
				).status,
				String(amount)
			).toBe(400);
		}
	});

	it('68. there is no update / delete endpoint for adjustments', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		const created = await post(
			`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`,
			admin,
			body()
		);
		const id = created.body.data.adjustment.id;
		const base = `/api/v1/payroll/runs/${r.id}/employees/${emp.id}/adjustments`;
		expect((await agent().delete(`${base}/${id}`).set('Cookie', admin)).status).toBe(404);
		expect(
			(await agent().patch(`${base}/${id}`).set('Cookie', admin).send({ amount: '1' })).status
		).toBe(404);
		expect(
			(await agent().put(`${base}/${id}`).set('Cookie', admin).send({ amount: '1' })).status
		).toBe(404);
		expect((await agent().delete(base).set('Cookie', admin)).status).toBe(404);
	});

	it('69. adding an adjustment sends the run back to DRAFT (recalculation is explicit)', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		expect((await get(`/payroll/runs/${r.id}`, admin)).body.data.status).toBe('CALCULATED');
		const res = await post(`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`, admin, body());
		expect(res.body.data.run).toMatchObject({ status: 'DRAFT', needsRecalculation: true });
		// finalize is refused until it is recalculated
		const early = await fin(r.id);
		expect(early.status).toBe(409);
		expect(early.body.error.code).toBe('PAYROLL_RUN_NOT_CALCULATED');
	});

	it('70. a finalized run rejects adjustments', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		await fin(r.id);
		const res = await post(`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`, admin, body());
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_RUN_FINALIZED');
	});

	it('70b. adjustment validation: reserved codes, wrong component type, employee outside the run', async () => {
		const { companyId, emp, house } = await standard();
		const r = await run(companyId);
		const reserved = await post(
			`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`,
			admin,
			body({ code: 'TAX' })
		);
		expect(reserved.body.error.code).toBe('PAY_CODE_RESERVED');
		const mismatch = await post(
			`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`,
			admin,
			body({ type: 'DEDUCTION', payComponentId: house.id })
		);
		expect(mismatch.body.error.code).toBe('PAY_COMPONENT_TYPE_MISMATCH');
		const outsider = await newEmp(companyId, '2027-01-01');
		const out = await post(
			`/payroll/runs/${r.id}/employees/${outsider.id}/adjustments`,
			admin,
			body()
		);
		expect(out.body.error.code).toBe('EMPLOYEE_NOT_IN_RUN');
		const ok = await post(
			`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`,
			admin,
			body({ payComponentId: house.id })
		);
		expect(ok.status).toBe(201);
	});
});

// ============================================================================================
describe('finalization', () => {
	it('71. a calculated, READY run finalizes', async () => {
		const { companyId } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		const res = await fin(r.id, { expectedNetPay: '5200000.00' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data).toMatchObject({ status: 'FINALIZED' });
		expect(res.body.data.finalizedAt).toBeTruthy();
	});

	it('72. a BLOCKED result prevents finalization (nothing changes)', async () => {
		const { companyId } = await standard();
		const blocked = await newEmp(companyId); // no salary
		const r = await run(companyId);
		await calc(r.id);
		const res = await fin(r.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_HAS_BLOCKED_RESULTS');
		expect(res.body.error.details.blockedCount).toBe(1);
		expect((await get(`/payroll/runs/${r.id}`, admin)).body.data.status).toBe('CALCULATED');
		expect((await resultOf(r.id, blocked.id))!.calculationStatus).toBe('BLOCKED');
	});

	it('73. finalization closes the period', async () => {
		const { companyId } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		await fin(r.id);
		expect((await get(`/payroll/periods/${r.periodId}`, admin)).body.data.status).toBe('CLOSED');
	});

	it('74. a finalized run is immutable (calculate / adjust / period edit / finalize again)', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		await fin(r.id);
		expect((await calc(r.id)).body.error.code).toBe('PAYROLL_RUN_FINALIZED');
		expect((await fin(r.id)).body.error.code).toBe('PAYROLL_RUN_FINALIZED');
		expect(
			(
				await post(`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`, admin, {
					type: 'EARNING',
					code: 'B',
					nameLao: 'ກ',
					amount: '1',
					reason: 'ເຫດຜົນ'
				})
			).status
		).toBe(409);
		expect((await patch(`/payroll/periods/${r.periodId}`, admin, { name: 'ແກ້' })).status).toBe(
			409
		);
		expect((await agent().delete(`/api/v1/payroll/runs/${r.id}`).set('Cookie', admin)).status).toBe(
			404
		);
	});

	it('75. a later base-salary change does not change the finalized result', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		await fin(r.id);
		expect((await setSalary(emp.id, '6000000', '2026-12-01')).status).toBe(201);
		const row = await resultOf(r.id, emp.id);
		expect(row).toMatchObject({ baseSalary: '5000000.00', netPay: '5200000.00' });
	});

	it('76. a later recurring-component change does not change the finalized result', async () => {
		const { companyId, emp, house } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		await fin(r.id);
		expect((await assign(emp.id, house.id, '999999', '2026-12-01')).status).toBe(201);
		await patch(`/pay-components/${house.id}`, admin, { status: 'INACTIVE', nameLao: 'ປ່ຽນຊື່' });
		const d = await detail((await resultOf(r.id, emp.id))!.id);
		expect(d.totalEarnings).toBe('5500000.00');
		expect(d.items.find((i: { code: string }) => i.code === house.code)).toMatchObject({
			amount: '500000.00',
			nameLao: 'ລາຍຮັບ'
		});
	});

	it('77. result snapshots (employee, department, position) are preserved', async () => {
		const companyId = await newCompany();
		const dept = await prisma.department.create({
			data: { companyId, code: `D_${uid()}`, nameLao: 'ພະແນກເດີມ' }
		});
		const pos = await prisma.position.create({
			data: { companyId, code: `P_${uid()}`, nameLao: 'ຕຳແໜ່ງເດີມ' }
		});
		const emp = await prisma.employee.create({
			data: {
				employeeCode: `SN_${uid()}`,
				firstNameLao: 'ສົມ',
				lastNameLao: 'ໃຈ',
				startDate: new Date('2024-01-01T00:00:00Z'),
				companyId,
				departmentId: dept.id,
				positionId: pos.id
			}
		});
		await setSalary(emp.id, '1000', '2026-01-01');
		const r = await run(companyId);
		await calc(r.id);
		await fin(r.id);
		await prisma.department.update({ where: { id: dept.id }, data: { nameLao: 'ຊື່ໃໝ່' } });
		await prisma.employee.update({
			where: { id: emp.id },
			data: { firstNameLao: 'ປ່ຽນ', departmentId: null }
		});
		const d = await detail((await resultOf(r.id, emp.id))!.id);
		expect(d.employee.name).toBe(`ສົມ ໃຈ`);
		expect(d.department).toMatchObject({ nameLao: 'ພະແນກເດີມ' });
		expect(d.position).toMatchObject({ nameLao: 'ຕຳແໜ່ງເດີມ' });
	});

	it('77b. a stale confirmation (expectedNetPay) is refused with the current figure', async () => {
		const { companyId } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		const res = await fin(r.id, { expectedNetPay: '1.00' });
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_RESULT_CHANGED');
		expect(res.body.error.details.netPay).toBe('5200000.00');
		expect((await get(`/payroll/runs/${r.id}`, admin)).body.data.status).toBe('CALCULATED');
	});

	it('77c. finalization uses the LATEST data (re-validated), and an empty run cannot finalize', async () => {
		const { companyId } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		const late = await newEmp(companyId); // joins the run after the calculation, no salary → must block
		const res = await fin(r.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_HAS_BLOCKED_RESULTS');
		expect(late.id).toBeTruthy();
		const emptyCompany = await newCompany();
		const empty = await run(emptyCompany);
		await calc(empty.id);
		expect((await fin(empty.id)).body.error.code).toBe('PAYROLL_RUN_EMPTY');
	});

	it('77d. finalizing a DRAFT run is refused', async () => {
		const { companyId } = await standard();
		const r = await run(companyId);
		expect((await fin(r.id)).body.error.code).toBe('PAYROLL_RUN_NOT_CALCULATED');
	});
});

// ============================================================================================
describe('payroll security', () => {
	it('78. a MANAGER (seeded role) has no payroll or compensation access', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const u = await createTestUser({ roleCode: 'MANAGER' });
		const cookie = await loginAndGetCookie(u.username, u.password);
		expect((await get(`/employees/${emp.id}/compensation`, cookie)).status).toBe(403);
		expect((await get('/payroll/runs', cookie)).status).toBe(403);
		expect((await get('/payroll/periods', cookie)).status).toBe(403);
		expect((await get(`/payroll/settings?companyId=${companyId}`, cookie)).status).toBe(403);
		expect((await get('/pay-components', cookie)).status).toBe(403);
	});

	it('79. payroll permissions WITHOUT employees.view_all are refused everywhere', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const r = await run(companyId);
		const u = await userWithPermissions(PAYROLL_PERMS);
		for (const path of [
			'/payroll/runs',
			'/payroll/periods',
			`/payroll/runs/${r.id}`,
			`/payroll/runs/${r.id}/results`,
			`/employees/${emp.id}/compensation`,
			`/employees/${emp.id}/recurring-pay-components`,
			`/payroll/settings?companyId=${companyId}`
		]) {
			expect((await get(path, u.cookie)).status, path).toBe(403);
		}
		expect((await calc(r.id, u.cookie)).status).toBe(403);
		expect((await fin(r.id, {}, u.cookie)).status).toBe(403);
		expect((await post('/payroll/periods', u.cookie, {})).status).toBe(403);
		// pay components (master data, no amounts) only need their own permission
		expect((await get('/pay-components', u.cookie)).status).toBe(200);
	});

	it('80. an ordinary employee user cannot see any salary', async () => {
		const { companyId, emp } = await standard();
		const u = await createTestUser({ roleCode: 'EMPLOYEE' });
		await prisma.employee.update({ where: { id: emp.id }, data: { userId: u.user.id } });
		const cookie = await loginAndGetCookie(u.username, u.password);
		expect((await get(`/employees/${emp.id}/compensation`, cookie)).status).toBe(403);
		expect((await get(`/employees/${emp.id}/compensation-history`, cookie)).status).toBe(403);
		const r = await run(companyId);
		await calc(r.id);
		expect((await get(`/payroll/runs/${r.id}/results`, cookie)).status).toBe(403);
		const result = await resultOf(r.id, emp.id);
		expect((await get(`/payroll/results/${result!.id}`, cookie)).status).toBe(403);
		// and the employee's own normal endpoints leak nothing
		const me = JSON.stringify((await get('/auth/me', cookie)).body);
		expect(me).not.toMatch(/5000000|salary/i);
	});

	it('81. compensation is not leaked to a user with compensation.view but without the scope', async () => {
		const { emp } = await standard();
		const u = await userWithPermissions(['compensation.view', 'employees.view']);
		const res = await get(`/employees/${emp.id}/compensation`, u.cookie);
		expect(res.status).toBe(403);
		expect(JSON.stringify(res.body)).not.toMatch(/5000000/);
	});

	it('82. the payroll lists / results are protected (401 / 403)', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		const result = await resultOf(r.id, emp.id);
		for (const path of [
			'/payroll/runs',
			'/payroll/periods',
			`/payroll/runs/${r.id}/results`,
			`/payroll/results/${result!.id}`
		]) {
			expect((await agent().get(`/api/v1${path}`)).status, path).toBe(401);
			const plain = await userWithPermissions(['dashboard.view']);
			expect((await get(path, plain.cookie)).status, path).toBe(403);
		}
	});

	it('82b. HR_ADMIN (seeded) holds every Phase 11 permission; MANAGER / EMPLOYEE hold none', async () => {
		for (const [roleCode, expected] of [
			['HR_ADMIN', true],
			['MANAGER', false],
			['EMPLOYEE', false]
		] as const) {
			const role = await prisma.role.findUniqueOrThrow({
				where: { code: roleCode },
				include: { permissions: { include: { permission: true } } }
			});
			const codes = role.permissions.map((p) => p.permission.code);
			for (const p of PAYROLL_PERMS) expect(codes.includes(p), `${roleCode} ${p}`).toBe(expected);
		}
	});

	it('82c. notifications never carry salary data (no payroll notification is emitted)', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		await fin(r.id);
		await setSalary(emp.id, '9999999', '2027-01-01');
		const text = JSON.stringify(await prisma.notification.findMany());
		expect(text).not.toMatch(/5000000|5200000|9999999|PAYROLL/i);
	});
});

// ============================================================================================
describe('payroll audit', () => {
	it('83. payroll settings changes are audited', async () => {
		const c = await createTestCompany();
		await put(`/payroll/settings?companyId=${c.id}`, admin, { currencyCode: 'LAK' });
		await put(`/payroll/settings?companyId=${c.id}`, admin, { currencyCode: 'THB' });
		const rows = await audit({ action: 'PAYROLL.SETTINGS_UPDATED', companyId: c.id });
		expect(rows).toHaveLength(2);
		expect(rows[1]!.changesJson).toMatchObject({ currencyCode: { before: 'LAK', after: 'THB' } });
	});

	it('84. pay component create / update are audited', async () => {
		const companyId = await newCompany();
		const c = await component(companyId, 'EARNING');
		await patch(`/pay-components/${c.id}`, admin, { nameLao: 'ຊື່ໃໝ່' });
		expect(await audit({ action: 'PAY_COMPONENT.CREATED', entityId: String(c.id) })).toHaveLength(
			1
		);
		const upd = await audit({ action: 'PAY_COMPONENT.UPDATED', entityId: String(c.id) });
		expect(upd[0]!.changesJson).toEqual({ nameLao: { before: 'ລາຍຮັບ', after: 'ຊື່ໃໝ່' } });
	});

	it('85. compensation created / changed events carry ids and dates only', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		await setSalary(emp.id, '5000000', '2026-01-01');
		await setSalary(emp.id, '6000000', '2026-07-01');
		const created = await audit({ action: 'COMPENSATION.CREATED', employeeId: emp.id });
		const changed = await audit({ action: 'COMPENSATION.CHANGED', employeeId: emp.id });
		expect(created).toHaveLength(1);
		expect(changed).toHaveLength(1);
		expect(changed[0]!.metadataJson).toMatchObject({
			effectiveFrom: '2026-07-01',
			previousCompensationId: expect.any(Number),
			newCompensationId: expect.any(Number)
		});
		expect(changed[0]!.changesJson).toEqual({ baseSalary: { changed: true } });
	});

	it('86. raw salary / amounts never reach the global audit log', async () => {
		const { companyId, emp, house } = await standard();
		await setSalary(emp.id, '6000000', '2026-07-01').catch(() => null);
		const r = await run(companyId);
		await calc(r.id);
		await post(`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`, admin, {
			type: 'EARNING',
			code: 'B',
			nameLao: 'ກ',
			amount: '1234567',
			reason: 'ເຫດຜົນລັບ'
		});
		await calc(r.id);
		await fin(r.id);
		const rows = await prisma.auditEvent.findMany({
			where: { OR: [{ employeeId: emp.id }, { companyId }] }
		});
		const text = JSON.stringify(rows);
		expect(text).not.toMatch(/5000000|6000000|500000|300000|5200000|1234567|5500000/);
		expect(text).not.toContain('ເຫດຜົນລັບ');
		// and the API output of the audit log is clean too
		const apiText = JSON.stringify(
			(await get(`/audit-events?employeeId=${emp.id}&pageSize=100`, admin)).body
		);
		expect(apiText).not.toMatch(/5000000|6000000|1234567/);
		expect(house.id).toBeTruthy();
	});

	it('86b. recurring assignment / end are audited without the amount', async () => {
		const companyId = await newCompany();
		const emp = await newEmp(companyId);
		const c = await component(companyId, 'DEDUCTION');
		const a = await assign(emp.id, c.id, '300000', '2026-01-01');
		await post(`/employee-recurring-pay-components/${a.body.data.items[0].id}/end`, admin, {
			effectiveTo: '2026-06-30'
		});
		const assigned = await audit({
			action: 'RECURRING_PAY_COMPONENT.ASSIGNED',
			employeeId: emp.id
		});
		const ended = await audit({ action: 'RECURRING_PAY_COMPONENT.ENDED', employeeId: emp.id });
		expect(assigned).toHaveLength(1);
		expect(ended).toHaveLength(1);
		expect(JSON.stringify([assigned, ended])).not.toContain('300000');
	});

	it('87. a manual adjustment is audited without the raw amount or reason', async () => {
		const { companyId, emp } = await standard();
		const r = await run(companyId);
		await post(`/payroll/runs/${r.id}/employees/${emp.id}/adjustments`, admin, {
			type: 'EARNING',
			code: 'BONUS',
			nameLao: 'ໂບນັດ',
			amount: '777777',
			reason: 'ເຫດຜົນພິເສດຫຼາຍ'
		});
		const rows = await audit({ action: 'PAYROLL.MANUAL_ADJUSTMENT_ADDED', employeeId: emp.id });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.metadataJson).toMatchObject({ payrollRunId: r.id, type: 'EARNING' });
		expect(JSON.stringify(rows)).not.toMatch(/777777|ເຫດຜົນພິເສດຫຼາຍ/);
	});

	it('88. period create / update and run create / calculate are audited', async () => {
		const { companyId } = await standard();
		const p = await period(companyId);
		await patch(`/payroll/periods/${p.id}`, admin, { name: 'ຊື່ໃໝ່' });
		const r = await run(companyId, p.id);
		await calc(r.id);
		expect(await audit({ action: 'PAYROLL.PERIOD_CREATED', entityId: String(p.id) })).toHaveLength(
			1
		);
		expect(await audit({ action: 'PAYROLL.PERIOD_UPDATED', entityId: String(p.id) })).toHaveLength(
			1
		);
		expect(await audit({ action: 'PAYROLL.RUN_CREATED', entityId: String(r.id) })).toHaveLength(1);
		const calculated = await audit({ action: 'PAYROLL.RUN_CALCULATED', entityId: String(r.id) });
		expect(calculated).toHaveLength(1);
		expect(calculated[0]!.metadataJson).toMatchObject({
			employees: 1,
			ready: 1,
			blocked: 0,
			calculationVersion: 1
		});
	});

	it('89. finalization is audited with the actor', async () => {
		const { companyId } = await standard();
		const r = await run(companyId);
		await calc(r.id);
		await fin(r.id);
		const rows = await audit({ action: 'PAYROLL.RUN_FINALIZED', entityId: String(r.id) });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ entityType: 'PAYROLL_RUN', companyId });
		expect(rows[0]!.actorUserId).toBeTruthy();
		expect(rows[0]!.requestId).toBeTruthy();
	});

	it('90. a refused finalization leaves no event and changes nothing (transaction safety)', async () => {
		const { companyId } = await standard();
		await newEmp(companyId); // blocks
		const r = await run(companyId);
		await calc(r.id);
		const before = await prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: r.id },
			orderBy: { employeeCodeSnapshot: 'asc' }
		});
		expect((await fin(r.id)).status).toBe(409);
		expect(await audit({ action: 'PAYROLL.RUN_FINALIZED', entityId: String(r.id) })).toHaveLength(
			0
		);
		const run2 = await prisma.payrollRun.findUniqueOrThrow({
			where: { id: r.id },
			include: { period: true }
		});
		expect(run2.status).toBe('CALCULATED');
		expect(run2.finalizedAt).toBeNull();
		expect(run2.period.status).toBe('OPEN');
		const after = await prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: r.id },
			orderBy: { employeeCodeSnapshot: 'asc' }
		});
		expect(after.map((x) => x.id)).toEqual(before.map((x) => x.id)); // results untouched (not replaced)
	});
});
