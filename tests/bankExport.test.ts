import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { neutralizeFormula, unzipStore, buildCsv } from '../src/lib/bankFile.js';
import { linkedUser, setupPhase13 } from './phase13Fixture.js';
import { userWithPermissions } from './helpers.js';
import {
	ACCT,
	batchOf,
	batchOk,
	ctx,
	exportFile,
	exportProfile,
	finalizedWorld,
	get,
	post,
	put,
	setBank,
	setMethod,
	validateOk,
	validatedWorld,
	GENERIC_COLUMNS
} from './phase14Fixture.js';

/**
 * PHASE 14 — bank export profiles + CSV / XLSX bank files (spec tests 35–52, §63 concurrency).
 */
beforeAll(async () => {
	await setupPhase13();
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('export profiles', () => {
	it('35-36. create CSV and XLSX profiles; the field catalog offers only the predefined safe fields', async () => {
		const w = await finalizedWorld();
		const csv = await exportProfile(w.companyId);
		expect(csv.format).toBe('CSV');
		const xlsx = await exportProfile(w.companyId, { format: 'XLSX', delimiter: null });
		expect(xlsx.format).toBe('XLSX');
		const cat = await get('/bank-export-profiles/fields', ctx.admin);
		expect(cat.status).toBe(200);
		expect(cat.body.data.fields.map((f: { field: string }) => f.field)).toEqual([
			'BATCH_NUMBER',
			'PAYMENT_DATE',
			'EMPLOYEE_CODE',
			'EMPLOYEE_NAME',
			'BANK_CODE',
			'BANK_NAME',
			'ACCOUNT_NAME',
			'ACCOUNT_NUMBER',
			'AMOUNT',
			'CURRENCY',
			'PAYMENT_REFERENCE',
			// Phase 15 §9 — the new reconciliation matching key, appended last (old profiles unaffected)
			'INSTRUCTION_REFERENCE'
		]);
		expect(
			cat.body.data.fields.find((f: { field: string }) => f.field === 'ACCOUNT_NUMBER').sensitive
		).toBe(true);
		expect(
			cat.body.data.fields.find((f: { field: string }) => f.field === 'INSTRUCTION_REFERENCE')
				.recommended
		).toBe(true);
		// the generic template is not presented as any specific bank's format + carries the warning
		expect(cat.body.data.template.name).toMatch(/Generic/);
		expect(cat.body.data.warning).toMatch(/Confirm the required file format with your bank/);
		const list = await get(`/bank-export-profiles?companyId=${w.companyId}`, ctx.admin);
		expect(list.body.data.items).toHaveLength(2);
	});

	it('37. only known fields are allowed (no arbitrary DB fields / SQL), no duplicates', async () => {
		const w = await finalizedWorld();
		for (const field of ['SALARY', 'employees.national_id', 'netPay; DROP TABLE users', 'TIN']) {
			const res = await post('/bank-export-profiles', ctx.admin, {
				companyId: w.companyId,
				code: 'BAD',
				name: 'bad',
				format: 'CSV',
				columns: [{ field, header: 'x' }]
			});
			expect(res.status, field).toBe(400);
		}
		const dup = await post('/bank-export-profiles', ctx.admin, {
			companyId: w.companyId,
			code: 'DUP',
			name: 'dup',
			format: 'CSV',
			columns: [
				{ field: 'AMOUNT', header: 'a' },
				{ field: 'AMOUNT', header: 'b' }
			]
		});
		expect(dup.status).toBe(400);
		// write access is payroll.payment.manage only
		const viewer = await userWithPermissions(['payroll.payment.view', 'employees.view_all']);
		const denied = await post('/bank-export-profiles', viewer.cookie, {
			companyId: w.companyId,
			code: 'NOPE',
			name: 'nope',
			format: 'CSV',
			columns: GENERIC_COLUMNS
		});
		expect(denied.status).toBe(403);
	});
});

describe('CSV', () => {
	it('38-41 + 44-46. first export: UTF-8 CSV, exact account number (leading zero), safe name, hash stored, EXPORTED', async () => {
		const w = await validatedWorld({ employees: 2 });
		const profile = await exportProfile(w.companyId);
		const { res, bytes } = await exportFile(w.batch.id, profile.id);
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
		// 44: ASCII-safe attachment name PAY-{periodCode}-{YYYYMMDD}.csv
		const disposition = res.headers['content-disposition'] as string;
		const name = /filename="([^"]+)"/.exec(disposition)![1]!;
		expect(disposition.startsWith('attachment;')).toBe(true);
		expect(name).toMatch(/^PAY-MAN-[A-Z0-9]+-20250930\.csv$/);
		expect(res.headers['cache-control']).toContain('no-store');
		// 38: valid UTF-8 (Lao names round-trip), no BOM by default
		const text = bytes.toString('utf8');
		expect(Buffer.from(text, 'utf8').equals(bytes)).toBe(true);
		expect(bytes[0]).not.toBe(0xef);
		expect(text).toContain('ພະນັກງານ');
		const lines = text.split('\r\n').filter(Boolean);
		expect(lines[0]).toBe(
			'Employee Code,Employee Name,Bank Code,Account Name,Account Number,Amount,Currency'
		);
		expect(lines).toHaveLength(3);
		// 41 + 42: the exact plaintext account number (leading zero kept) IS in the authorized file
		for (const l of lines.slice(1)) expect(l.split(',')[4]).toBe(ACCT);
		expect(lines[1]!.split(',')[5]).toBe('5000000.00');
		// 45: SHA-256 of the bytes stored on the export record (no file content stored)
		const record = await prisma.paymentBatchExport.findFirstOrThrow({
			where: { paymentBatchId: w.batch.id }
		});
		expect(record.fileHash).toBe(sha(bytes));
		expect(res.headers['x-export-hash']).toBe(record.fileHash);
		expect(record.fileName).toBe(name);
		expect(record.rowCount).toBe(2);
		expect(Object.keys(record)).not.toContain('content');
		// 46: first export → batch + items EXPORTED; nothing is PAID
		const b = await batchOf(w.batch.id);
		expect(b.status).toBe('EXPORTED');
		expect(b.items.every((i) => i.status === 'EXPORTED')).toBe(true);
		// 41: outside the file the number stays masked (batch detail, preview)
		expect(JSON.stringify(b)).not.toContain(ACCT);
		const preview = await get(
			`/payroll/payment-batches/${w.batch.id}/export-preview?bankExportProfileId=${profile.id}`,
			ctx.admin
		);
		expect(preview.status).toBe(200);
		expect(JSON.stringify(preview.body)).not.toContain(ACCT);
		expect(preview.body.data.rows[0][4]).toBe('••••7890');
		// audit: ids / counts / hash — never the number or an amount
		const audit = await prisma.auditEvent.findFirstOrThrow({
			where: { action: 'PAYROLL_PAYMENT.EXPORTED', entityId: String(w.batch.id) }
		});
		expect(audit.metadataJson).toMatchObject({
			rowCount: 2,
			exportProfileId: profile.id,
			fileHash: record.fileHash
		});
		expect(JSON.stringify(audit)).not.toContain(ACCT);
		expect(JSON.stringify(audit)).not.toContain('5000000');
	});

	it('39 + 40. CSV escaping + formula-injection protection (text cells, headers)', async () => {
		const w = await finalizedWorld({ employees: 4 });
		const evil = ['=HYPERLINK("http://x","click")', '+1+2', '-3+4', '@SUM(A1)'];
		for (let i = 0; i < 4; i++) {
			await setBank(w.emps[i]!.id, { accountName: evil[i], bankName: 'Bank, "Quoted"\nLine' });
		}
		const batch = await batchOk(w.runId);
		expect((await validateOk(batch.id)).batch.status).toBe('VALIDATED');
		const profile = await exportProfile(w.companyId, {
			columns: [
				{ field: 'ACCOUNT_NAME', header: '=Evil Header' },
				{ field: 'BANK_NAME', header: 'Bank' },
				{ field: 'ACCOUNT_NUMBER', header: 'Account' }
			]
		});
		const { bytes } = await exportFile(batch.id, profile.id);
		const text = bytes.toString('utf8');
		expect(text.startsWith("'=Evil Header,Bank,Account\r\n")).toBe(true);
		for (const e of evil) {
			// neutralized (leading apostrophe) and, where needed, RFC 4180-quoted with doubled quotes
			expect(text).toContain(`'${e}`.includes('"') ? `"'${e.replace(/"/g, '""')}"` : `'${e}`);
		}
		expect(text).toContain('"Bank, ""Quoted""\nLine"');
		// no cell starts with a raw formula character
		expect(text).not.toMatch(/(^|,|\r\n)[=+\-@]/);
		// unit: the neutralizer + a non-default delimiter / BOM
		expect(neutralizeFormula('=1+1')).toBe("'=1+1");
		expect(neutralizeFormula('\t=cmd')).toBe("'\t=cmd");
		expect(neutralizeFormula('001234567890')).toBe('001234567890');
		const semi = buildCsv(
			['a;b', 'c'],
			[
				[
					{ kind: 'text', value: 'x;y' },
					{ kind: 'amount', value: '1.00' }
				]
			],
			{
				delimiter: ';',
				includeHeader: true,
				bom: true
			}
		);
		expect(semi.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
		expect(semi.subarray(3).toString('utf8')).toBe('"a;b";c\r\n"x;y";1.00\r\n');
	});

	it('CASH items are not in the bank file (they are confirmed manually)', async () => {
		const w = await finalizedWorld({ employees: 2 });
		await setBank(w.emps[0]!.id);
		await setMethod(w.emps[1]!.id, 'CASH');
		const batch = await batchOk(w.runId);
		await validateOk(batch.id);
		const profile = await exportProfile(w.companyId);
		const { bytes } = await exportFile(batch.id, profile.id);
		expect(bytes.toString('utf8').split('\r\n').filter(Boolean)).toHaveLength(2); // header + 1 bank row
		const b = await batchOf(batch.id);
		expect(b.items.every((i) => i.status === 'EXPORTED')).toBe(true);
	});
});

describe('XLSX', () => {
	it('42-43. XLSX: one sheet, header, account number stored as TEXT (leading zero), amount numeric', async () => {
		const w = await validatedWorld();
		const profile = await exportProfile(w.companyId, { format: 'XLSX', delimiter: null });
		const { res, bytes } = await exportFile(w.batch.id, profile.id);
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toBe(
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
		);
		expect(/filename="([^"]+)"/.exec(res.headers['content-disposition'] as string)![1]).toMatch(
			/^PAY-MAN-[A-Z0-9]+-20250930\.xlsx$/
		);
		expect(bytes.subarray(0, 2).toString()).toBe('PK');
		const files = unzipStore(bytes);
		expect(Object.keys(files).sort()).toEqual([
			'[Content_Types].xml',
			'_rels/.rels',
			'xl/_rels/workbook.xml.rels',
			'xl/styles.xml',
			'xl/workbook.xml',
			'xl/worksheets/sheet1.xml'
		]);
		const sheet = files['xl/worksheets/sheet1.xml']!;
		expect(files['xl/workbook.xml']).toContain('<sheet name="Payments"');
		expect((files['xl/workbook.xml']!.match(/<sheet /g) ?? []).length).toBe(1);
		// header row
		expect(sheet).toContain(
			'<row r="1"><c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Employee Code</t>'
		);
		// account number: inline STRING with the text (@, numFmtId 49) style — never a number cell
		expect(sheet).toContain(
			`<c r="E2" t="inlineStr" s="1"><is><t xml:space="preserve">${ACCT}</t></is></c>`
		);
		expect(sheet).not.toMatch(new RegExp(`<v>0*${ACCT.replace(/^0+/, '')}</v>`));
		expect(files['xl/styles.xml']).toContain('numFmtId="49"');
		// amount: a numeric cell with a number format
		expect(sheet).toContain('<c r="F2" s="2"><v>5000000.00</v></c>');
	});
});

describe('re-export, permissions, concurrency', () => {
	it('47. exporting a DRAFT batch is rejected', async () => {
		const w = await finalizedWorld();
		await setMethod(w.emps[0]!.id, 'BANK_TRANSFER');
		const batch = await batchOk(w.runId);
		const profile = await exportProfile(w.companyId);
		const { res, json } = await exportFile(batch.id, profile.id);
		expect(res.status).toBe(409);
		expect(json().error.code).toBe('PAYMENT_BATCH_NOT_VALIDATED');
	});

	it('48-50. MANAGER, EMPLOYEE and view-only users cannot export (view-only sees the masked batch only)', async () => {
		const w = await validatedWorld();
		const profile = await exportProfile(w.companyId);
		const mgr = await linkedUser('MANAGER');
		const emp = await linkedUser('EMPLOYEE');
		const viewer = await userWithPermissions(['payroll.payment.view', 'employees.view_all']);
		for (const cookie of [mgr.cookie, emp.cookie, viewer.cookie]) {
			const { res, bytes } = await exportFile(w.batch.id, profile.id, cookie);
			expect(res.status).toBe(403);
			expect(bytes.toString()).not.toContain(ACCT);
			expect(
				(
					await get(
						`/payroll/payment-batches/${w.batch.id}/export-preview?bankExportProfileId=${profile.id}`,
						cookie
					)
				).status
			).toBe(403);
		}
		// the view-only user can read the batch: masked account, and no amounts without payroll.view
		const view = await get(`/payroll/payment-batches/${w.batch.id}`, viewer.cookie);
		expect(view.status).toBe(200);
		expect(view.body.data.items[0].accountNumberMasked).toBe('••••7890');
		expect(view.body.data.items[0].amount).toBeNull();
		expect(view.body.data.totalAmount).toBeNull();
		expect(JSON.stringify(view.body)).not.toContain(ACCT);
		// nothing was exported by the refused attempts
		expect((await batchOf(w.batch.id)).status).toBe('VALIDATED');
		// MANAGER / EMPLOYEE cannot even read payment batches
		expect((await get(`/payroll/payment-batches/${w.batch.id}`, mgr.cookie)).status).toBe(403);
		expect((await get(`/payroll/payment-batches/${w.batch.id}`, emp.cookie)).status).toBe(403);
	});

	it('51. re-export with the same profile → identical bytes + hash, no new record, no second "first export"', async () => {
		const w = await validatedWorld({ employees: 2 });
		const profile = await exportProfile(w.companyId, { format: 'XLSX', delimiter: null });
		const first = await exportFile(w.batch.id, profile.id);
		// payments confirmed + the PROFILE edited + the employee's bank changed afterwards: still identical
		await post(
			`/payroll/payment-batches/${w.batch.id}/items/${w.batch.items[0]!.id}/confirm`,
			ctx.admin,
			{
				status: 'PAID',
				paymentReference: 'R1'
			}
		);
		await put(`/bank-export-profiles/${profile.id}`, ctx.admin, {
			name: 'edited',
			format: 'CSV',
			delimiter: ';',
			columns: [{ field: 'AMOUNT', header: 'Only amount' }]
		});
		await setBank(w.emps[0]!.id, { accountNumber: '9999000011112222' });
		const second = await exportFile(w.batch.id, profile.id);
		expect(second.res.status).toBe(200);
		expect(second.bytes.equals(first.bytes)).toBe(true);
		expect(second.res.headers['x-export-hash']).toBe(first.res.headers['x-export-hash']);
		expect(await prisma.paymentBatchExport.count({ where: { paymentBatchId: w.batch.id } })).toBe(
			1
		);
		expect(
			await prisma.auditEvent.count({
				where: { action: 'PAYROLL_PAYMENT.EXPORTED', entityId: String(w.batch.id) }
			})
		).toBe(1);
		expect(
			await prisma.auditEvent.count({
				where: { action: 'PAYROLL_PAYMENT.EXPORT_DOWNLOADED', entityId: String(w.batch.id) }
			})
		).toBe(1);
		expect((await batchOf(w.batch.id)).status).toBe('PARTIALLY_PAID'); // re-export changes no status
	});

	it('52. a different profile creates a separate export record', async () => {
		const w = await validatedWorld();
		const csv = await exportProfile(w.companyId);
		const xlsx = await exportProfile(w.companyId, { format: 'XLSX', delimiter: null });
		const a = await exportFile(w.batch.id, csv.id);
		const b = await exportFile(w.batch.id, xlsx.id);
		expect(a.res.status).toBe(200);
		expect(b.res.status).toBe(200);
		const records = await prisma.paymentBatchExport.findMany({
			where: { paymentBatchId: w.batch.id },
			orderBy: { createdAt: 'asc' }
		});
		expect(records).toHaveLength(2);
		expect(records.map((r) => r.format)).toEqual(['CSV', 'XLSX']);
		expect(records[0]!.exportNumber).toMatch(/-E1$/);
		expect(records[1]!.exportNumber).toMatch(/-E2$/);
		expect(records[0]!.fileHash).not.toBe(records[1]!.fileHash);
	});

	it('63. concurrent export requests: all download the same file, ONE record, ONE first-export side effect', async () => {
		const w = await validatedWorld({ employees: 2 });
		const profile = await exportProfile(w.companyId);
		const results = await Promise.all([1, 2, 3].map(() => exportFile(w.batch.id, profile.id)));
		expect(results.every((r) => r.res.status === 200)).toBe(true);
		const hashes = new Set(results.map((r) => sha(r.bytes)));
		expect(hashes.size).toBe(1);
		expect(await prisma.paymentBatchExport.count({ where: { paymentBatchId: w.batch.id } })).toBe(
			1
		);
		expect(
			await prisma.auditEvent.count({
				where: { action: 'PAYROLL_PAYMENT.EXPORTED', entityId: String(w.batch.id) }
			})
		).toBe(1);
		expect((await batchOf(w.batch.id)).status).toBe('EXPORTED');
	});

	it("another company's profile cannot be used", async () => {
		const w = await validatedWorld();
		const other = await finalizedWorld();
		const foreign = await exportProfile(other.companyId);
		const { res } = await exportFile(w.batch.id, foreign.id);
		expect(res.status).toBe(404);
	});
});
