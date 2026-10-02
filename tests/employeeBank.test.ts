import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import {
	decryptSensitive,
	encryptSensitive,
	parseEncryptionKey,
	assertEncryptionConfig
} from '../src/lib/sensitiveCrypto.js';
import { createTestCompany } from './helpers.js';
import { setupPhase13, linkedUser } from './phase13Fixture.js';
import {
	ACCT,
	bankBody,
	ctx,
	employee,
	get,
	post,
	put,
	setBank,
	type PaymentProfileView
} from './phase14Fixture.js';
import { userWithPermissions } from './helpers.js';

/**
 * PHASE 14 — employee payment method + ENCRYPTED bank accounts (spec tests 1–15).
 */
beforeAll(async () => {
	await setupPhase13();
});

async function newEmployee() {
	const c = await createTestCompany();
	await put(`/payroll/settings?companyId=${c.id}`, ctx.admin, { currencyCode: 'LAK' });
	return employee(c.id, { salary: null });
}

const accountRow = (employeeId: string) =>
	prisma.employeeBankAccount.findFirstOrThrow({
		where: { employeeId, isPrimary: true, status: 'ACTIVE' }
	});

describe('permissions', () => {
	it('1. bank / payment permissions are seeded with the right role defaults', async () => {
		const codes = [
			'employee_bank.view',
			'employee_bank.manage',
			'payroll.payment.view',
			'payroll.payment.manage',
			'payroll.payment.export',
			'payroll.payment.confirm',
			'payroll_payment.view_self'
		];
		const perms = await prisma.permission.findMany({ where: { code: { in: codes } } });
		expect(perms.map((p) => p.code).sort()).toEqual([...codes].sort());
		const grants = async (role: string) =>
			(
				await prisma.rolePermission.findMany({
					where: { role: { code: role }, permission: { code: { in: codes } } },
					include: { permission: true }
				})
			)
				.map((g) => g.permission.code)
				.sort();
		expect(await grants('SUPER_ADMIN')).toEqual([...codes].sort());
		expect(await grants('HR_ADMIN')).toEqual([...codes].sort());
		expect(await grants('MANAGER')).toEqual([]);
		expect(await grants('EMPLOYEE')).toEqual(['payroll_payment.view_self']);
	});
});

describe('bank account storage', () => {
	it('2-6. create: encrypted at rest, no plaintext stored, masked response, last4 correct', async () => {
		const emp = await newEmployee();
		const profile = await setBank(emp.id);
		// 5 + 6: masked in the response, never the number
		expect(profile.paymentMethod).toBe('BANK_TRANSFER');
		expect(profile.primaryAccount?.accountNumberMasked).toBe('••••7890');
		expect(profile.primaryAccount?.accountNumberLast4).toBe('7890');
		expect(JSON.stringify(profile)).not.toContain(ACCT);
		expect(JSON.stringify(profile)).not.toContain('Encrypted');
		// 3 + 4: encrypted at rest; the plaintext is nowhere in the row
		const row = await accountRow(emp.id);
		expect(row.accountNumberEncrypted).not.toContain(ACCT);
		expect(JSON.stringify(row)).not.toContain(ACCT);
		expect(Buffer.from(row.accountNumberIv, 'base64')).toHaveLength(12);
		expect(Buffer.from(row.accountNumberAuthTag, 'base64')).toHaveLength(16);
		expect(row.encryptionKeyVersion).toBe(1);
		expect(
			decryptSensitive({
				ciphertext: row.accountNumberEncrypted,
				iv: row.accountNumberIv,
				authTag: row.accountNumberAuthTag,
				keyVersion: row.encryptionKeyVersion
			})
		).toBe(ACCT);
		// raw SQL scan of every text column of the table for the plaintext
		const hits = await prisma.$queryRawUnsafe<unknown[]>(
			`SELECT id FROM employee_bank_accounts WHERE CONCAT_WS('|', bank_code, bank_name, branch_name, account_name, account_number_encrypted, account_number_iv, account_number_auth_tag) LIKE ?`,
			`%${ACCT}%`
		);
		expect(hits).toHaveLength(0);
	});

	it('7. edit WITHOUT an account number keeps the old encrypted value', async () => {
		const emp = await newEmployee();
		await setBank(emp.id);
		const before = await accountRow(emp.id);
		const res = await put(`/employees/${emp.id}/payment-profile`, ctx.admin, {
			paymentMethod: 'BANK_TRANSFER',
			bankAccount: bankBody({ accountNumber: '', accountName: 'Renamed Holder' })
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const after = await accountRow(emp.id);
		expect(after.id).toBe(before.id);
		expect(after.accountName).toBe('Renamed Holder');
		expect(after.accountNumberEncrypted).toBe(before.accountNumberEncrypted);
		expect(after.accountNumberIv).toBe(before.accountNumberIv);
		expect(after.accountNumberAuthTag).toBe(before.accountNumberAuthTag);
		expect((res.body.data as PaymentProfileView).primaryAccount?.accountNumberMasked).toBe(
			'••••7890'
		);
	});

	it('8. a replacement number re-encrypts (new IV) and updates last4', async () => {
		const emp = await newEmployee();
		await setBank(emp.id);
		const before = await accountRow(emp.id);
		const res = await put(`/employees/${emp.id}/payment-profile`, ctx.admin, {
			paymentMethod: 'BANK_TRANSFER',
			bankAccount: bankBody({ accountNumber: '0099 8877 6655' })
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const after = await accountRow(emp.id);
		expect(after.accountNumberIv).not.toBe(before.accountNumberIv);
		expect(after.accountNumberEncrypted).not.toBe(before.accountNumberEncrypted);
		expect(after.accountNumberLast4).toBe('6655');
		expect(
			decryptSensitive({
				ciphertext: after.accountNumberEncrypted,
				iv: after.accountNumberIv,
				authTag: after.accountNumberAuthTag,
				keyVersion: 1
			})
		).toBe('009988776655'); // spaces removed, leading zeros kept
		// re-encrypting the SAME number also yields a fresh IV (never a deterministic ciphertext)
		const a = encryptSensitive(ACCT);
		const b = encryptSensitive(ACCT);
		expect(a.iv).not.toBe(b.iv);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});

	it('first bank account requires a number; invalid formats are rejected', async () => {
		const emp = await newEmployee();
		const missing = await put(`/employees/${emp.id}/payment-profile`, ctx.admin, {
			paymentMethod: 'BANK_TRANSFER',
			bankAccount: bankBody({ accountNumber: '' })
		});
		expect(missing.status).toBe(400);
		expect(missing.body.error.code).toBe('ACCOUNT_NUMBER_REQUIRED');
		const formula = await put(`/employees/${emp.id}/payment-profile`, ctx.admin, {
			paymentMethod: 'BANK_TRANSFER',
			bankAccount: bankBody({ accountNumber: '=1+2' })
		});
		expect(formula.status).toBe(400);
		// the rejected value is never echoed back
		expect(JSON.stringify(formula.body)).not.toContain('=1+2');
	});

	it('9. an invalid encryption key fails safely (config validation + wrong key never decrypts)', async () => {
		expect(() => parseEncryptionKey('too-short')).toThrow(/32 bytes/);
		expect(() => parseEncryptionKey('ab'.repeat(31))).toThrow(/32 bytes/);
		let message = '';
		try {
			parseEncryptionKey('not a key at all');
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).not.toContain('not a key at all'); // the key is never echoed
		expect(parseEncryptionKey('ab'.repeat(32))).toHaveLength(32);
		expect(parseEncryptionKey(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(32);

		const saved = { key: process.env.BANK_ACCOUNT_ENCRYPTION_KEY };
		const enc = encryptSensitive(ACCT);
		try {
			// startup validation: an invalid key refuses to start; a missing key fails only in production
			process.env.BANK_ACCOUNT_ENCRYPTION_KEY = 'invalid-key';
			expect(() => assertEncryptionConfig({ production: false })).toThrow(/invalid/);
			delete process.env.BANK_ACCOUNT_ENCRYPTION_KEY;
			expect(assertEncryptionConfig({ production: false })).toBe(false);
			expect(() => assertEncryptionConfig({ production: true })).toThrow(/required/);
			// a different (valid) key cannot decrypt — the auth tag fails, no garbage plaintext
			process.env.BANK_ACCOUNT_ENCRYPTION_KEY = 'cd'.repeat(32);
			expect(() => decryptSensitive(enc)).toThrow('SENSITIVE_DECRYPTION_FAILED');
			// tampering is detected as well
			process.env.BANK_ACCOUNT_ENCRYPTION_KEY = saved.key;
			const tampered = { ...enc, ciphertext: Buffer.from('x' + enc.ciphertext).toString('base64') };
			expect(() => decryptSensitive(tampered)).toThrow('SENSITIVE_DECRYPTION_FAILED');
			// with no key configured, bank-account writes answer 503 instead of storing plaintext
			delete process.env.BANK_ACCOUNT_ENCRYPTION_KEY;
			const emp = await newEmployee();
			const res = await put(`/employees/${emp.id}/payment-profile`, ctx.admin, {
				paymentMethod: 'BANK_TRANSFER',
				bankAccount: bankBody()
			});
			expect(res.status).toBe(503);
			expect(res.body.error.code).toBe('BANK_ACCOUNT_ENCRYPTION_NOT_CONFIGURED');
			expect(await prisma.employeeBankAccount.count({ where: { employeeId: emp.id } })).toBe(0);
		} finally {
			process.env.BANK_ACCOUNT_ENCRYPTION_KEY = saved.key;
		}
		expect(decryptSensitive(enc)).toBe(ACCT);
	});

	it('10. deactivating an account: INACTIVE, not primary; activation restores it as the one primary', async () => {
		const emp = await newEmployee();
		const p = await setBank(emp.id);
		const accountId = p.primaryAccount!.id;
		const off = await post(`/employees/${emp.id}/bank-accounts/${accountId}/deactivate`, ctx.admin);
		expect(off.status, JSON.stringify(off.body)).toBe(200);
		const offView = off.body.data as PaymentProfileView;
		expect(offView.accounts[0]!.status).toBe('INACTIVE');
		expect(offView.accounts[0]!.isPrimary).toBe(false);
		const on = await post(`/employees/${emp.id}/bank-accounts/${accountId}/activate`, ctx.admin);
		expect(on.status).toBe(200);
		expect((on.body.data as PaymentProfileView).primaryAccount?.id).toBe(accountId);
		expect((on.body.data as PaymentProfileView).primaryAccount?.status).toBe('ACTIVE');
	});

	it('11. only one ACTIVE primary account at a time (history kept)', async () => {
		const emp = await newEmployee();
		await setBank(emp.id);
		const second = await post(`/employees/${emp.id}/bank-accounts`, ctx.admin, {
			...bankBody({ accountNumber: '5555666677778888', bankCode: 'QAB2', bankName: 'QA Bank 2' })
		});
		expect(second.status, JSON.stringify(second.body)).toBe(201);
		const view = second.body.data as PaymentProfileView;
		expect(view.accounts).toHaveLength(2);
		expect(view.accounts.filter((a) => a.isPrimary && a.status === 'ACTIVE')).toHaveLength(1);
		expect(view.primaryAccount?.accountNumberMasked).toBe('••••8888');
		// a non-primary addition leaves the primary alone
		const third = await post(`/employees/${emp.id}/bank-accounts`, ctx.admin, {
			...bankBody({ accountNumber: '1111222233334444' }),
			makePrimary: false
		});
		expect((third.body.data as PaymentProfileView).primaryAccount?.accountNumberMasked).toBe(
			'••••8888'
		);
		const primaries = await prisma.employeeBankAccount.count({
			where: { employeeId: emp.id, isPrimary: true }
		});
		expect(primaries).toBe(1);
	});

	it('12. concurrent "make primary" requests never produce two primaries', async () => {
		const emp = await newEmployee();
		const results = await Promise.all(
			['1000200030004001', '1000200030004002', '1000200030004003', '1000200030004004'].map((n) =>
				post(`/employees/${emp.id}/bank-accounts`, ctx.admin, bankBody({ accountNumber: n }))
			)
		);
		expect(results.every((r) => r.status === 201)).toBe(true);
		const primaries = await prisma.employeeBankAccount.findMany({
			where: { employeeId: emp.id, isPrimary: true, status: 'ACTIVE' }
		});
		expect(primaries).toHaveLength(1);
		const profile = await prisma.employeePaymentProfile.findUniqueOrThrow({
			where: { employeeId: emp.id }
		});
		expect(profile.bankAccountId).toBe(primaries[0]!.id);
	});
});

describe('access control', () => {
	it('13. MANAGER gets 403 on read and write', async () => {
		const emp = await newEmployee();
		await setBank(emp.id);
		const mgr = await linkedUser('MANAGER');
		expect((await get(`/employees/${emp.id}/payment-profile`, mgr.cookie)).status).toBe(403);
		expect(
			(
				await put(`/employees/${emp.id}/payment-profile`, mgr.cookie, {
					paymentMethod: 'CASH'
				})
			).status
		).toBe(403);
	});

	it('14. EMPLOYEE gets 403 (no self-edit of bank accounts in Phase 14)', async () => {
		const emp = await newEmployee();
		const self = await linkedUser('EMPLOYEE');
		await prisma.employee.update({ where: { id: emp.id }, data: { userId: self.userId } });
		expect((await get(`/employees/${emp.id}/payment-profile`, self.cookie)).status).toBe(403);
		expect((await post(`/employees/${emp.id}/bank-accounts`, self.cookie, bankBody())).status).toBe(
			403
		);
	});

	it('view-only permission can read (masked) but not write; employees.view_all is mandatory', async () => {
		const emp = await newEmployee();
		await setBank(emp.id);
		const viewer = await userWithPermissions(['employee_bank.view', 'employees.view_all']);
		const r = await get(`/employees/${emp.id}/payment-profile`, viewer.cookie);
		expect(r.status).toBe(200);
		expect(JSON.stringify(r.body)).not.toContain(ACCT);
		expect(
			(await put(`/employees/${emp.id}/payment-profile`, viewer.cookie, { paymentMethod: 'CASH' }))
				.status
		).toBe(403);
		const noScope = await userWithPermissions(['employee_bank.view', 'employee_bank.manage']);
		expect((await get(`/employees/${emp.id}/payment-profile`, noScope.cookie)).status).toBe(403);
	});
});

describe('audit', () => {
	it('15. bank-account audit events never contain the full account number or cipher material', async () => {
		const emp = await newEmployee();
		const p = await setBank(emp.id);
		await put(`/employees/${emp.id}/payment-profile`, ctx.admin, {
			paymentMethod: 'BANK_TRANSFER',
			bankAccount: bankBody({ accountNumber: '0011 2233 4455' })
		});
		await post(`/employees/${emp.id}/bank-accounts/${p.primaryAccount!.id}/deactivate`, ctx.admin);
		await post(`/employees/${emp.id}/bank-accounts/${p.primaryAccount!.id}/activate`, ctx.admin);
		const row = await accountRow(emp.id);
		const events = await prisma.auditEvent.findMany({ where: { employeeId: emp.id } });
		const actions = events.map((e) => e.action);
		for (const a of [
			'EMPLOYEE_BANK_ACCOUNT.CREATED',
			'EMPLOYEE_BANK_ACCOUNT.UPDATED',
			'EMPLOYEE_BANK_ACCOUNT.DEACTIVATED',
			'EMPLOYEE_BANK_ACCOUNT.ACTIVATED',
			'EMPLOYEE_PAYMENT_PROFILE.UPDATED'
		]) {
			expect(actions).toContain(a);
		}
		const text = JSON.stringify(events);
		for (const needle of [
			ACCT,
			'001122334455',
			row.accountNumberEncrypted,
			row.accountNumberIv,
			row.accountNumberAuthTag
		]) {
			expect(text).not.toContain(needle);
		}
		// what IS recorded: bank code, currency, last4, changed flags
		const updated = events.find((e) => e.action === 'EMPLOYEE_BANK_ACCOUNT.UPDATED')!;
		expect(updated.metadataJson).toMatchObject({
			bankCode: 'QABANK',
			currency: 'LAK',
			last4: '4455',
			accountNumberChanged: true,
			previousLast4: '7890'
		});
		// and read back through the audit API, still nothing
		const api = await get(`/audit-events?employeeId=${emp.id}&pageSize=100`, ctx.admin);
		expect(api.status).toBe(200);
		expect(JSON.stringify(api.body)).not.toContain(ACCT);
	});
});
