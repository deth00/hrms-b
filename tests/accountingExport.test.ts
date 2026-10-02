import { beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { prisma } from '../src/config/prisma.js';
import { unzipStore } from '../src/lib/bankFile.js';
import { createTestUser, loginAndGetCookie, userWithPermissions } from './helpers.js';
import { linkedUser, newCompany, setupPhase13 } from './phase13Fixture.js';
import {
	accountingProfile,
	accrualOk,
	amountNeedles,
	ctx,
	exportJournal,
	get,
	payOk,
	paymentWorld,
	payrollWorld,
	post,
	postedOk,
	put,
	settlementOk,
	validateJ
} from './phase16Fixture.js';
import { isolateFixtureNotifications } from './phase16Fixture.js';

/** Phase 16 — accounting export + privacy / permissions (tests 81-96). */
isolateFixtureNotifications();
beforeAll(async () => {
	await setupPhase13();
});

async function postedAccrual(o: Parameters<typeof payrollWorld>[0] = {}) {
	const w = await payrollWorld(o);
	const j = await accrualOk(w.runId);
	await postedOk(j.id);
	return { ...w, journal: j };
}
const csvRows = (bytes: Buffer) =>
	bytes
		.toString('utf8')
		.replace(/^\uFEFF/, '')
		.trim()
		.split('\r\n')
		.map((l) => l.split(','));

describe('accounting export', () => {
	it('81. export requires a POSTED journal → 409 ACCOUNTING_JOURNAL_NOT_POSTED', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		const p = await accountingProfile(w.companyId);
		const ex = await exportJournal(j.id, p.id);
		expect(ex.res.status).toBe(409);
		expect(ex.json().error.code).toBe('ACCOUNTING_JOURNAL_NOT_POSTED');
		await validateJ(j.id);
		expect((await exportJournal(j.id, p.id)).res.status).toBe(409);
		expect(await prisma.payrollJournalExport.count({ where: { journalId: j.id } })).toBe(0);
	});

	it('82. CSV: header + one row per line, file name GL-{journal}-{YYYYMMDD}.csv, hash header', async () => {
		const w = await postedAccrual();
		const p = await accountingProfile(w.companyId);
		const ex = await exportJournal(w.journal.id, p.id);
		expect(ex.res.status).toBe(200);
		expect(ex.res.headers['content-type']).toContain('text/csv');
		expect(ex.res.headers['content-disposition']).toBe(
			`attachment; filename="GL-${w.journal.journalNumber}-20250930.csv"`
		);
		const rows = csvRows(ex.bytes);
		expect(rows[0]![0]).toBe('JOURNAL_NUMBER');
		expect(rows).toHaveLength(w.journal.lines.length + 1);
		const debitCol = rows[0]!.indexOf('DEBIT');
		const creditCol = rows[0]!.indexOf('CREDIT');
		const sum = (c: number) =>
			rows.slice(1).reduce((s, r) => s + Math.round(Number(r[c]) * 100), 0);
		expect(sum(debitCol)).toBe(sum(creditCol));
		expect(rows[1]![rows[0]!.indexOf('ACCOUNT_CODE')]).toBe(w.journal.lines[0]!.accountCode);
		expect(ex.res.headers['x-export-hash']).toMatch(/^[0-9a-f]{64}$/);
	});

	it('83. re-export with the same profile regenerates IDENTICAL bytes (hash), even after the profile changes', async () => {
		const w = await postedAccrual();
		const p = await accountingProfile(w.companyId);
		const first = await exportJournal(w.journal.id, p.id);
		await put(`/payroll/accounting/export-profiles/${p.id}`, ctx.admin, {
			name: 'Changed',
			format: 'CSV',
			delimiter: ';',
			columns: [{ field: 'ACCOUNT_CODE', header: 'Acct' }]
		});
		const again = await exportJournal(w.journal.id, p.id);
		expect(again.res.status).toBe(200);
		expect(again.bytes.equals(first.bytes)).toBe(true);
		expect(again.res.headers['x-export-hash']).toBe(first.res.headers['x-export-hash']);
		expect(await prisma.payrollJournalExport.count({ where: { journalId: w.journal.id } })).toBe(1);
		const rec = await prisma.payrollJournalExport.findFirstOrThrow({
			where: { journalId: w.journal.id }
		});
		expect(rec.fileHash).toBe(first.res.headers['x-export-hash']);
		expect((rec.profileSnapshotJson as { delimiter: string }).delimiter).toBe(',');
	});

	it('84. XLSX: codes are TEXT cells (leading zeros kept), debit / credit numeric', async () => {
		const w = await payrollWorld({ employees: 1 });
		// an account code with leading zeros for the net payable
		const acct = await post('/payroll/accounting/gl-accounts', ctx.admin, {
			companyId: w.companyId,
			code: '00210',
			name: 'Payable (leading zero)',
			type: 'LIABILITY'
		});
		await put(`/payroll/accounting/rule-sets/${w.acct!.ruleSetId}/mappings`, ctx.admin, {
			eventType: 'PAYROLL_ACCRUAL',
			sourceType: 'NET_PAYABLE',
			creditAccountId: acct.body.data.id
		});
		const j = await accrualOk(w.runId);
		await postedOk(j.id);
		const p = await accountingProfile(w.companyId, { format: 'XLSX', delimiter: null });
		const ex = await exportJournal(j.id, p.id);
		expect(ex.res.status).toBe(200);
		expect(ex.res.headers['content-disposition']).toContain('.xlsx');
		const files = unzipStore(ex.bytes);
		const sheet = files['xl/worksheets/sheet1.xml']!;
		expect(sheet).toContain('>00210<');
		expect(sheet).not.toContain('<v>210</v>');
		const wb = XLSX.read(ex.bytes, { type: 'buffer' });
		const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]!]!);
		const net = rows.find((r) => r.ACCOUNT_CODE === '00210')!;
		expect(typeof net.CREDIT).toBe('number');
		expect(typeof net.ACCOUNT_CODE).toBe('string');
		// deterministic: exporting again gives the same bytes
		expect((await exportJournal(j.id, p.id)).bytes.equals(ex.bytes)).toBe(true);
	});

	it('85. formula injection: text starting with = + - @ is neutralized', async () => {
		const w = await payrollWorld({ employees: 1 });
		await put(`/payroll/accounting/rule-sets/${w.acct!.ruleSetId}/mappings`, ctx.admin, {
			eventType: 'PAYROLL_ACCRUAL',
			sourceType: 'BASE_SALARY',
			debitAccountId: w.acct!.ids.SALARY_EXP,
			descriptionTemplate: '=HYPERLINK("http://x") {period}'
		});
		const j = await accrualOk(w.runId);
		await postedOk(j.id);
		const p = await accountingProfile(w.companyId, {
			columns: [
				{ field: 'DESCRIPTION', header: 'Description' },
				{ field: 'DEBIT', header: 'Debit' }
			]
		});
		const ex = await exportJournal(j.id, p.id);
		const text = ex.bytes.toString('utf8');
		expect(text).toContain(`"'=HYPERLINK(""http://x"")`);
		expect(text).not.toMatch(/(^|\n|,)=HYPERLINK/);
	});

	it('86. another company profile → 404; inactive profile (first export) → 409', async () => {
		const w = await postedAccrual({ employees: 1 });
		const foreign = await accountingProfile(await newCompany());
		expect((await exportJournal(w.journal.id, foreign.id)).res.status).toBe(404);
		const p = await accountingProfile(w.companyId);
		await put(`/payroll/accounting/export-profiles/${p.id}`, ctx.admin, {
			name: 'off',
			format: 'CSV',
			columns: [{ field: 'DEBIT', header: 'Debit' }],
			status: 'INACTIVE'
		});
		const ex = await exportJournal(w.journal.id, p.id);
		expect(ex.res.status).toBe(409);
		expect(ex.json().error.code).toBe('EXPORT_PROFILE_INACTIVE');
	});

	it('87. export audit: EXPORTED then EXPORT_DOWNLOADED with ids / hash / row count, NO amounts', async () => {
		const w = await postedAccrual();
		const p = await accountingProfile(w.companyId);
		await exportJournal(w.journal.id, p.id);
		await exportJournal(w.journal.id, p.id);
		const ev = await prisma.auditEvent.findMany({
			// numeric entity ids are unique per entity type only
			where: {
				entityType: 'PAYROLL_JOURNAL',
				entityId: String(w.journal.id),
				action: { contains: 'EXPORT' }
			},
			orderBy: { createdAt: 'asc' }
		});
		expect(ev.map((e) => e.action)).toEqual([
			'PAYROLL_ACCOUNTING.JOURNAL_EXPORTED',
			'PAYROLL_ACCOUNTING.EXPORT_DOWNLOADED'
		]);
		const blob = JSON.stringify(ev);
		for (const l of w.journal.lines) {
			const amt = l.debit !== '0.00' ? l.debit : l.credit;
			for (const needle of amountNeedles(amt)) expect(blob).not.toContain(`"${needle}"`);
		}
		expect(blob).not.toContain(w.journal.totalDebit);
	});

	it('88. settlement journal export: CSV rows reference the payment instruction; no bank account number', async () => {
		const w = await paymentWorld({ employees: 1 });
		await payOk(w.batchId, w.items[0]!.id);
		const s = await settlementOk(w.batchId);
		await postedOk(s.id);
		const p = await accountingProfile(w.companyId);
		const ex = await exportJournal(s.id, p.id);
		const text = ex.bytes.toString('utf8');
		expect(text).toContain(w.items[0]!.instructionReference ?? w.items[0]!.transferReference);
		expect(text).not.toContain('001234567890');
		expect(text).not.toContain('1234567890');
	});
});

describe('privacy + permissions', () => {
	const ALL_PATHS = (runId: string, batchId: string, journalId: string) =>
		[
			['get', `/payroll/runs/${runId}/accounting-journal`],
			['post', `/payroll/runs/${runId}/accounting-journal`],
			['get', `/payroll/payment-batches/${batchId}/accounting-status`],
			['post', `/payroll/payment-batches/${batchId}/accounting-journal`],
			['get', '/payroll/accounting/journals'],
			['get', `/payroll/accounting/journals/${journalId}`],
			['post', `/payroll/accounting/journals/${journalId}/validate`],
			['post', `/payroll/accounting/journals/${journalId}/post`],
			['post', `/payroll/accounting/journals/${journalId}/cancel`]
		] as const;

	it('89. EMPLOYEE and MANAGER roles get 403 on every accounting endpoint', async () => {
		const w = await paymentWorld({ employees: 1 });
		await payOk(w.batchId, w.items[0]!.id);
		const j = await settlementOk(w.batchId);
		for (const role of ['EMPLOYEE', 'MANAGER'] as const) {
			const u = await linkedUser(role);
			for (const [m, path] of ALL_PATHS(w.runId, w.batchId, j.id)) {
				const res = m === 'get' ? await get(path, u.cookie) : await post(path, u.cookie);
				expect(res.status, `${role} ${m} ${path}`).toBe(403);
			}
		}
		expect((await get(`/payroll/accounting/journals/${j.id}`, ctx.admin)).body.data.status).toBe(
			'DRAFT'
		);
	}, 60_000);

	it('90. accounting.view WITHOUT employees.view_all → 403 (lines carry employee codes)', async () => {
		const w = await payrollWorld({ employees: 1 });
		const j = await accrualOk(w.runId);
		const u = await userWithPermissions(['payroll.accounting.view']);
		expect((await get(`/payroll/accounting/journals/${j.id}`, u.cookie)).status).toBe(403);
		const ok = await userWithPermissions(['payroll.accounting.view', 'employees.view_all']);
		expect((await get(`/payroll/accounting/journals/${j.id}`, ok.cookie)).status).toBe(200);
		// view alone cannot create / validate / export
		expect((await validateJ(j.id, ok.cookie)).status).toBe(403);
		expect((await post(`/payroll/runs/${w.runId}/accounting-journal`, ok.cookie)).status).toBe(403);
	});

	it('91. export needs payroll.accounting.export; HR_ADMIN has it', async () => {
		const w = await postedAccrual({ employees: 1 });
		const p = await accountingProfile(w.companyId);
		const viewer = await userWithPermissions(['payroll.accounting.view', 'employees.view_all']);
		expect((await exportJournal(w.journal.id, p.id, viewer.cookie)).res.status).toBe(403);
		const { username, password } = await createTestUser({ roleCode: 'HR_ADMIN' });
		const hr = await loginAndGetCookie(username, password);
		expect((await exportJournal(w.journal.id, p.id, hr)).res.status).toBe(200);
	});

	it('92. seeded role defaults: SUPER_ADMIN all five, HR_ADMIN view/manage/export, MANAGER/EMPLOYEE none', async () => {
		const codes = async (role: string) =>
			(
				await prisma.rolePermission.findMany({
					where: {
						role: { code: role },
						permission: { code: { startsWith: 'payroll.accounting.' } }
					},
					select: { permission: { select: { code: true } } }
				})
			)
				.map((r) => r.permission.code)
				.sort();
		expect(await codes('SUPER_ADMIN')).toEqual([
			'payroll.accounting.export',
			'payroll.accounting.manage',
			'payroll.accounting.post',
			'payroll.accounting.settings',
			'payroll.accounting.view'
		]);
		expect(await codes('HR_ADMIN')).toEqual([
			'payroll.accounting.export',
			'payroll.accounting.manage',
			'payroll.accounting.view'
		]);
		expect(await codes('MANAGER')).toEqual([]);
		expect(await codes('EMPLOYEE')).toEqual([]);
	});

	it('93. no employee notification is created by any accounting action', async () => {
		const w = await paymentWorld({
			employees: 1,
			userIds: [(await linkedUser('EMPLOYEE')).userId]
		});
		const before = await prisma.notification.count();
		await payOk(w.batchId, w.items[0]!.id);
		const afterPay = await prisma.notification.count();
		const j = await accrualOk(w.runId);
		await postedOk(j.id);
		const s = await settlementOk(w.batchId);
		await postedOk(s.id);
		const p = await accountingProfile(w.companyId);
		await exportJournal(s.id, p.id);
		expect(await prisma.notification.count()).toBe(afterPay);
		expect(afterPay).toBeGreaterThanOrEqual(before);
	}, 60_000);

	it('94. journal lines expose codes only — no names / bank / tax / salary detail fields', async () => {
		const w = await paymentWorld({ employees: 1 });
		await payOk(w.batchId, w.items[0]!.id);
		const s = await settlementOk(w.batchId);
		const res = await get(`/payroll/accounting/journals/${s.id}`, ctx.admin);
		const blob = JSON.stringify(res.body.data);
		for (const banned of [
			'"accountNumber',
			'accountNumberMasked',
			'"bankName',
			'"taxId',
			'"employeeName',
			'"baseSalary',
			'"reason',
			'001234567890'
		]) {
			expect(blob, banned).not.toContain(banned);
		}
	});

	it('95. a direct mutation attempt on a POSTED journal has no route (PATCH / PUT / DELETE → 404)', async () => {
		const w = await postedAccrual({ employees: 1 });
		const { agent } = await import('./helpers.js');
		for (const m of ['patch', 'put', 'delete'] as const) {
			const res = await agent()
				[m](`/api/v1/payroll/accounting/journals/${w.journal.id}`)
				.set('Cookie', ctx.admin)
				.send({ totalDebit: '1.00' });
			expect(res.status, m).toBe(404);
		}
		const row = await prisma.payrollJournal.findUniqueOrThrow({ where: { id: w.journal.id } });
		expect(row.status).toBe('POSTED');
		expect(row.totalDebit.toFixed(2)).toBe(w.journal.totalDebit);
	});

	it('96. unauthenticated requests → 401', async () => {
		const { agent } = await import('./helpers.js');
		expect((await agent().get('/api/v1/payroll/accounting/journals')).status).toBe(401);
		expect((await agent().post('/api/v1/payroll/runs/x/accounting-journal')).status).toBe(401);
	});
});
