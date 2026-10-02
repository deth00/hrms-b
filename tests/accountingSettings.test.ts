import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { agent, createTestUser, loginAndGetCookie, userWithPermissions } from './helpers.js';
import { newCompany, setupPhase13 } from './phase13Fixture.js';
import {
	ACCOUNTS,
	accountingProfile,
	activate,
	chartOf,
	ctx,
	get,
	glAccount,
	mapping,
	mapOk,
	patch,
	post,
	put,
	ruleSet,
	uid
} from './phase16Fixture.js';
import { isolateFixtureNotifications } from './phase16Fixture.js';

/** Phase 16 — GL accounts, accounting rule sets / mappings, export profiles (tests 25-44). */
isolateFixtureNotifications();
beforeAll(async () => {
	await setupPhase13();
});

async function hrAdminCookie() {
	const { username, password } = await createTestUser({ roleCode: 'HR_ADMIN' });
	return loginAndGetCookie(username, password);
}

describe('GL accounts', () => {
	it('25. creates an account; (company, code) is unique', async () => {
		const companyId = await newCompany();
		const a = await glAccount(companyId, { code: '5100', name: 'Salary expense', type: 'EXPENSE' });
		expect(a.status).toBe('ACTIVE');
		const dup = await post('/payroll/accounting/gl-accounts', ctx.admin, {
			companyId,
			code: '5100',
			name: 'Again',
			type: 'EXPENSE'
		});
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('GL_ACCOUNT_CODE_EXISTS');
		// the same code in ANOTHER company is fine
		await glAccount(await newCompany(), { code: '5100', name: 'Salary expense', type: 'EXPENSE' });
	});

	it('26. strict validation: bad type, bad code characters, unknown fields → 400', async () => {
		const companyId = await newCompany();
		for (const body of [
			{ companyId, code: '5100', name: 'X', type: 'COST' },
			{ companyId, code: '51 00', name: 'X', type: 'EXPENSE' },
			{ companyId, code: '5100', name: 'X', type: 'EXPENSE', balance: 1 }
		]) {
			const res = await post('/payroll/accounting/gl-accounts', ctx.admin, body);
			expect(res.status, JSON.stringify(body)).toBe(400);
		}
	});

	it('27. update name / status (code immutable); there is no DELETE route', async () => {
		const companyId = await newCompany();
		const a = await glAccount(companyId, { code: '2100', name: 'Payable', type: 'LIABILITY' });
		const res = await patch(`/payroll/accounting/gl-accounts/${a.id}`, ctx.admin, {
			name: 'Payroll payable',
			status: 'INACTIVE'
		});
		expect(res.status).toBe(200);
		expect(res.body.data).toMatchObject({
			code: '2100',
			name: 'Payroll payable',
			status: 'INACTIVE'
		});
		const codeChange = await patch(`/payroll/accounting/gl-accounts/${a.id}`, ctx.admin, {
			code: '9999'
		});
		expect(codeChange.status).toBe(400);
		const del = await agent()
			.delete(`/api/v1/payroll/accounting/gl-accounts/${a.id}`)
			.set('Cookie', ctx.admin);
		expect(del.status).toBe(404);
		expect(await prisma.gLAccount.count({ where: { id: a.id } })).toBe(1);
	});

	it('28. an INACTIVE account cannot be used in a new mapping', async () => {
		const companyId = await newCompany();
		const a = await glAccount(companyId, { code: '5100', name: 'Salary', type: 'EXPENSE' });
		await patch(`/payroll/accounting/gl-accounts/${a.id}`, ctx.admin, { status: 'INACTIVE' });
		const rs = await ruleSet(companyId);
		const res = await mapping(rs.id, 'PAYROLL_ACCRUAL', 'BASE_SALARY', { debitAccountId: a.id });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('GL_ACCOUNT_INACTIVE');
	});

	it('29. list filters by company / status / type / search', async () => {
		const companyId = await newCompany();
		await chartOf(companyId);
		const res = await get(
			`/payroll/accounting/gl-accounts?companyId=${companyId}&type=LIABILITY`,
			ctx.admin
		);
		expect(res.status).toBe(200);
		expect(res.body.data.items.map((a: { code: string }) => a.code)).toEqual([
			'2100',
			'2110',
			'2120',
			'2130'
		]);
		const search = await get(
			`/payroll/accounting/gl-accounts?companyId=${companyId}&search=Cash`,
			ctx.admin
		);
		expect(search.body.data.items).toHaveLength(1);
	});

	it('30. audit: GL_ACCOUNT_CREATED / UPDATED with ids / code / status only', async () => {
		const companyId = await newCompany();
		const a = await glAccount(companyId, { code: '1100', name: 'Bank', type: 'ASSET' });
		await patch(`/payroll/accounting/gl-accounts/${a.id}`, ctx.admin, { name: 'Bank clearing' });
		const ev = await prisma.auditEvent.findMany({
			where: { entityType: 'GL_ACCOUNT', entityId: String(a.id) },
			orderBy: { createdAt: 'asc' }
		});
		expect(ev.map((e) => e.action)).toEqual([
			'PAYROLL_ACCOUNTING.GL_ACCOUNT_CREATED',
			'PAYROLL_ACCOUNTING.GL_ACCOUNT_UPDATED'
		]);
	});
});

describe('rule sets and mappings', () => {
	it('31. versions auto-increment per company; created as DRAFT; copy duplicates mappings', async () => {
		const companyId = await newCompany();
		const ids = await chartOf(companyId);
		const v1 = await ruleSet(companyId);
		await mapOk(v1.id, 'PAYROLL_ACCRUAL', 'BASE_SALARY', { debit: 'SALARY_EXP' }, ids);
		const v2res = await post('/payroll/accounting/rule-sets', ctx.admin, {
			companyId,
			name: 'v2',
			effectiveFrom: '2027-01-01',
			copyFromRuleSetId: v1.id
		});
		expect(v2res.status).toBe(201);
		expect(v1.version).toBe(1);
		expect(v1.status).toBe('DRAFT');
		expect(v2res.body.data.version).toBe(2);
		expect(v2res.body.data.mappings).toHaveLength(1);
	});

	it('32. mapping validation: unknown source, wrong side, missing side, same account for both', async () => {
		const companyId = await newCompany();
		const ids = await chartOf(companyId);
		const rs = await ruleSet(companyId);
		const cases: [string, string, Record<string, unknown>, string][] = [
			[
				'PAYROLL_ACCRUAL',
				'BANK_CLEARING',
				{ creditAccountId: ids.BANK },
				'ACCOUNTING_SOURCE_TYPE_INVALID'
			],
			[
				'PAYROLL_ACCRUAL',
				'BASE_SALARY',
				{ creditAccountId: ids.PAYABLE },
				'MAPPING_ACCOUNT_REQUIRED'
			],
			[
				'PAYROLL_ACCRUAL',
				'BASE_SALARY',
				{ debitAccountId: ids.SALARY_EXP, creditAccountId: ids.PAYABLE },
				'MAPPING_ACCOUNT_SIDE_INVALID'
			],
			[
				'PAYROLL_ACCRUAL',
				'EMPLOYER_SSO',
				{ debitAccountId: ids.EMPLOYER_EXP },
				'MAPPING_ACCOUNT_REQUIRED'
			],
			[
				'PAYROLL_ACCRUAL',
				'EMPLOYER_SSO',
				{ debitAccountId: ids.SSO, creditAccountId: ids.SSO },
				'MAPPING_ACCOUNT_SAME'
			],
			[
				'PAYMENT_SETTLEMENT',
				'PAYROLL_PAYABLE',
				{ creditAccountId: ids.PAYABLE },
				'MAPPING_ACCOUNT_REQUIRED'
			]
		];
		for (const [ev, src, body, code] of cases) {
			const res = await mapping(rs.id, ev, src, body);
			expect(res.status, `${src} ${JSON.stringify(res.body)}`).toBe(400);
			expect(res.body.error.code).toBe(code);
		}
	});

	it("33. another company's account cannot be mapped", async () => {
		const companyId = await newCompany();
		const other = await glAccount(await newCompany(), { code: '5100', name: 'X', type: 'EXPENSE' });
		const rs = await ruleSet(companyId);
		const res = await mapping(rs.id, 'PAYROLL_ACCRUAL', 'BASE_SALARY', {
			debitAccountId: other.id
		});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('GL_ACCOUNT_NOT_FOUND');
	});

	it('34. upsert replaces the mapping of (event, source) — one row, audited MAPPING_UPDATED', async () => {
		const companyId = await newCompany();
		const ids = await chartOf(companyId);
		const rs = await ruleSet(companyId);
		await mapOk(rs.id, 'PAYROLL_ACCRUAL', 'NET_PAYABLE', { credit: 'PAYABLE' }, ids);
		await mapOk(
			rs.id,
			'PAYROLL_ACCRUAL',
			'NET_PAYABLE',
			{ credit: 'OTHER_DED', dim: 'EMPLOYEE' },
			ids
		);
		const rows = await prisma.payrollAccountingMapping.findMany({ where: { ruleSetId: rs.id } });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			creditAccountId: ids.OTHER_DED,
			groupingDimension: 'EMPLOYEE'
		});
		expect(
			await prisma.auditEvent.count({
				where: { action: 'PAYROLL_ACCOUNTING.MAPPING_UPDATED', entityId: String(rs.id) }
			})
		).toBe(2);
	});

	it('35. activation requires BASE_SALARY + NET_PAYABLE mappings → ACCOUNTING_RULESET_INCOMPLETE', async () => {
		const companyId = await newCompany();
		const ids = await chartOf(companyId);
		const rs = await ruleSet(companyId);
		await mapOk(rs.id, 'PAYROLL_ACCRUAL', 'BASE_SALARY', { debit: 'SALARY_EXP' }, ids);
		const res = await activate(rs.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('ACCOUNTING_RULESET_INCOMPLETE');
		expect(res.body.error.details.missingSourceTypes).toEqual(['NET_PAYABLE']);
		await mapOk(rs.id, 'PAYROLL_ACCRUAL', 'NET_PAYABLE', { credit: 'PAYABLE' }, ids);
		const ok = await activate(rs.id);
		expect(ok.status).toBe(200);
		expect(ok.body.data.status).toBe('ACTIVE');
	});

	it('36. only ONE ACTIVE rule set per company/date: overlapping activation → ACCOUNTING_RULESET_OVERLAP', async () => {
		const companyId = await newCompany();
		const ids = await chartOf(companyId);
		const mk = async (from: string, to: string | null) => {
			const rs = await ruleSet(companyId, { effectiveFrom: from, effectiveTo: to });
			await mapOk(rs.id, 'PAYROLL_ACCRUAL', 'BASE_SALARY', { debit: 'SALARY_EXP' }, ids);
			await mapOk(rs.id, 'PAYROLL_ACCRUAL', 'NET_PAYABLE', { credit: 'PAYABLE' }, ids);
			return rs;
		};
		const a = await mk('2025-01-01', '2025-12-31');
		const b = await mk('2025-06-01', null);
		const c = await mk('2026-01-01', null);
		expect((await activate(a.id)).status).toBe(200);
		const clash = await activate(b.id);
		expect(clash.status).toBe(409);
		expect(clash.body.error.code).toBe('ACCOUNTING_RULESET_OVERLAP');
		expect((await activate(c.id)).status).toBe(200);
	});

	it('37. concurrent activation of overlapping sets → exactly one ACTIVE', async () => {
		const companyId = await newCompany();
		const ids = await chartOf(companyId);
		const sets = [];
		for (let i = 0; i < 3; i++) {
			const rs = await ruleSet(companyId);
			await mapOk(rs.id, 'PAYROLL_ACCRUAL', 'BASE_SALARY', { debit: 'SALARY_EXP' }, ids);
			await mapOk(rs.id, 'PAYROLL_ACCRUAL', 'NET_PAYABLE', { credit: 'PAYABLE' }, ids);
			sets.push(rs);
		}
		const res = await Promise.all(sets.map((s) => activate(s.id)));
		expect(res.filter((r) => r.status === 200)).toHaveLength(1);
		expect(
			await prisma.payrollAccountingRuleSet.count({ where: { companyId, status: 'ACTIVE' } })
		).toBe(1);
	});

	it('38. header editable only in DRAFT; deactivate works and is audited', async () => {
		const companyId = await newCompany();
		const ids = await chartOf(companyId);
		const rs = await ruleSet(companyId);
		const edit = await patch(`/payroll/accounting/rule-sets/${rs.id}`, ctx.admin, {
			name: 'Renamed'
		});
		expect(edit.status).toBe(200);
		expect(edit.body.data.name).toBe('Renamed');
		await mapOk(rs.id, 'PAYROLL_ACCRUAL', 'BASE_SALARY', { debit: 'SALARY_EXP' }, ids);
		await mapOk(rs.id, 'PAYROLL_ACCRUAL', 'NET_PAYABLE', { credit: 'PAYABLE' }, ids);
		await activate(rs.id);
		const locked = await patch(`/payroll/accounting/rule-sets/${rs.id}`, ctx.admin, {
			effectiveFrom: '2030-01-01'
		});
		expect(locked.status).toBe(409);
		expect(locked.body.error.code).toBe('ACCOUNTING_RULESET_NOT_DRAFT');
		const off = await post(`/payroll/accounting/rule-sets/${rs.id}/deactivate`, ctx.admin);
		expect(off.status).toBe(200);
		expect(off.body.data.status).toBe('INACTIVE');
		const actions = (
			await prisma.auditEvent.findMany({
				where: { entityId: String(rs.id) },
				select: { action: true }
			})
		).map((e) => e.action);
		expect(actions).toEqual(
			expect.arrayContaining([
				'PAYROLL_ACCOUNTING.RULESET_CREATED',
				'PAYROLL_ACCOUNTING.RULESET_ACTIVATED',
				'PAYROLL_ACCOUNTING.RULESET_DEACTIVATED'
			])
		);
	});

	it('39. effectiveTo before effectiveFrom → 400', async () => {
		const res = await post('/payroll/accounting/rule-sets', ctx.admin, {
			companyId: await newCompany(),
			name: 'bad',
			effectiveFrom: '2026-02-01',
			effectiveTo: '2026-01-01'
		});
		expect(res.status).toBe(400);
	});

	it('40. the source-type catalog lists accrual / settlement sources with their sides', async () => {
		const res = await get('/payroll/accounting/source-types', ctx.admin);
		expect(res.status).toBe(200);
		const accrual = res.body.data.PAYROLL_ACCRUAL as { code: string; side: string }[];
		expect(accrual.find((s) => s.code === 'BASE_SALARY')!.side).toBe('DEBIT');
		expect(accrual.find((s) => s.code === 'EMPLOYEE_PIT')!.side).toBe('CREDIT');
		expect(accrual.find((s) => s.code === 'EMPLOYER_SSO')!.side).toBe('BOTH');
		expect(res.body.data.PAYMENT_SETTLEMENT.map((s: { code: string }) => s.code)).toEqual([
			'PAYROLL_PAYABLE',
			'BANK_CLEARING',
			'CASH_CLEARING'
		]);
	});
});

describe('export profiles + settings permissions', () => {
	it('41. accounting export profile: only predefined fields; unknown field / duplicates → 400', async () => {
		const companyId = await newCompany();
		const p = await accountingProfile(companyId);
		expect(p.format).toBe('CSV');
		for (const columns of [
			[{ field: 'ACCOUNT_NUMBER', header: 'Bank account' }],
			[{ field: 'SALARY', header: 'x' }],
			[
				{ field: 'DEBIT', header: 'a' },
				{ field: 'DEBIT', header: 'b' }
			]
		]) {
			const res = await post('/payroll/accounting/export-profiles', ctx.admin, {
				companyId,
				code: `QA_${uid()}`,
				name: 'x',
				format: 'CSV',
				columns
			});
			expect(res.status, JSON.stringify(columns)).toBe(400);
		}
		const upd = await put(`/payroll/accounting/export-profiles/${p.id}`, ctx.admin, {
			name: 'QA GL XLSX',
			format: 'XLSX',
			columns: [{ field: 'ACCOUNT_CODE', header: 'Account' }]
		});
		expect(upd.status).toBe(200);
		expect(upd.body.data.delimiter).toBeNull();
	});

	it('42. HR_ADMIN can read settings but cannot change them (settings = SUPER_ADMIN)', async () => {
		const hr = await hrAdminCookie();
		const companyId = await newCompany();
		expect((await get(`/payroll/accounting/gl-accounts?companyId=${companyId}`, hr)).status).toBe(
			200
		);
		expect((await get(`/payroll/accounting/rule-sets?companyId=${companyId}`, hr)).status).toBe(
			200
		);
		const create = await post('/payroll/accounting/gl-accounts', hr, {
			companyId,
			code: '5100',
			name: 'x',
			type: 'EXPENSE'
		});
		expect(create.status).toBe(403);
		expect(
			(
				await post('/payroll/accounting/rule-sets', hr, {
					companyId,
					name: 'x',
					effectiveFrom: '2025-01-01'
				})
			).status
		).toBe(403);
	});

	it('43. settings permission without employees.view_all → 403; unauthenticated → 401', async () => {
		const u = await userWithPermissions(['payroll.accounting.settings']);
		expect((await get('/payroll/accounting/gl-accounts', u.cookie)).status).toBe(403);
		expect((await agent().get('/api/v1/payroll/accounting/gl-accounts')).status).toBe(401);
		const ok = await userWithPermissions(['payroll.accounting.settings', 'employees.view_all']);
		const res = await post('/payroll/accounting/gl-accounts', ok.cookie, {
			companyId: await newCompany(),
			...ACCOUNTS.CASH
		});
		expect(res.status).toBe(201);
	});

	it('44. EMPLOYEE / MANAGER roles cannot read any accounting settings', async () => {
		for (const roleCode of ['EMPLOYEE', 'MANAGER']) {
			const { username, password } = await createTestUser({ roleCode });
			const cookie = await loginAndGetCookie(username, password);
			for (const path of [
				'/payroll/accounting/gl-accounts',
				'/payroll/accounting/rule-sets',
				'/payroll/accounting/export-profiles',
				'/payroll/accounting/source-types'
			]) {
				expect((await get(path, cookie)).status, `${roleCode} ${path}`).toBe(403);
			}
		}
	});
});
