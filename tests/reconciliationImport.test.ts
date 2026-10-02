import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { setupPhase13 } from './phase13Fixture.js';
import { ACCT, batchOk, finalizedWorld, setBank, setMethod, validateOk } from './phase14Fixture.js';
import {
	bankRow,
	exported15,
	exportFile,
	exportProfile,
	V15_COLUMNS,
	reconProfile,
	resultCsv,
	resultXlsx,
	upload,
	uploadOk,
	batch15
} from './phase15Fixture.js';

/**
 * PHASE 15 — bank result import: UNTRUSTED file handling (spec tests 17–28) and automatic matching
 * by exact instruction reference ONLY (29–38). Import never changes a payment item.
 */
beforeAll(async () => {
	await setupPhase13();
});

async function world(employees = 2) {
	const w = await exported15({ employees });
	const profile = await reconProfile(w.companyId);
	const xlsxProfile = await reconProfile(w.companyId, { format: 'XLSX', delimiter: null });
	return { ...w, recon: profile, reconXlsx: xlsxProfile };
}

async function dbRowsText(importId: string) {
	const imp = await prisma.paymentReconciliationImport.findUniqueOrThrow({
		where: { id: importId }
	});
	const rows = await prisma.paymentReconciliationRow.findMany({
		where: { reconciliationImportId: importId }
	});
	return JSON.stringify({ imp, rows });
}

describe('file import + security', () => {
	it('17 + 27. CSV import: rows stored normalized, SHA-256 of the uploaded bytes recorded, items untouched', async () => {
		const w = await world();
		const [a, b] = w.batch.items;
		const bytes = resultCsv([bankRow(a!, 'SUCCESS'), bankRow(b!, 'FAILED')]);
		const res = await upload(w.batch.id, w.recon.id, { name: 'bank-result.csv', bytes });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const imp = res.body.data.import;
		expect(imp).toMatchObject({
			status: 'READY',
			rowCount: 2,
			matchedCount: 2,
			fileName: 'bank-result.csv',
			fileHash: createHash('sha256').update(bytes).digest('hex')
		});
		// preview only: no payment item changed
		const items = await prisma.payrollPaymentItem.findMany({
			where: { paymentBatchId: w.batch.id }
		});
		expect(items.every((i) => i.status === 'EXPORTED')).toBe(true);
		const audit = await prisma.auditEvent.findMany({
			where: { entityId: String(imp.id), action: 'PAYROLL_PAYMENT.RECONCILIATION_IMPORTED' }
		});
		expect(audit).toHaveLength(1);
		expect(audit[0]!.metadataJson).toMatchObject({ fileHash: imp.fileHash, rowCount: 2 });
	});

	it('18. XLSX import (mature parser); text cells keep leading zeros', async () => {
		const w = await world();
		const [a] = w.batch.items;
		const res = await upload(w.batch.id, w.reconXlsx.id, {
			name: 'bank-result.xlsx',
			bytes: resultXlsx([bankRow(a!, 'SUCCESS', { bankRef: '000123' })])
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data.import).toMatchObject({ rowCount: 1, matchedCount: 1, status: 'READY' });
		const row = await prisma.paymentReconciliationRow.findFirstOrThrow({
			where: { reconciliationImportId: res.body.data.import.id }
		});
		expect(row.bankTransactionReference).toBe('000123');
		// a CSV profile refuses an .xlsx file and vice versa
		const mismatch = await upload(w.batch.id, w.recon.id, {
			name: 'bank-result.xlsx',
			bytes: resultXlsx([bankRow(a!, 'SUCCESS')])
		});
		expect(mismatch.status).toBe(400);
		expect(mismatch.body.error.code).toBe('FILE_FORMAT_MISMATCH');
	});

	it('19. a file over 5 MB is rejected (413) before anything is stored', async () => {
		const w = await world();
		const big = Buffer.alloc(5 * 1024 * 1024 + 10, 0x41);
		const res = await upload(w.batch.id, w.recon.id, { name: 'big.csv', bytes: big });
		expect(res.status).toBe(413);
		expect(res.body.error.code).toBe('FILE_TOO_LARGE');
		expect(
			await prisma.paymentReconciliationImport.count({ where: { paymentBatchId: w.batch.id } })
		).toBe(0);
	});

	it('20. more than 10,000 data rows is rejected', async () => {
		const w = await world();
		const rows = Array.from({ length: 10_001 }, (_, i) => ({
			ref: `PI-X-${i}`,
			status: 'SUCCESS'
		}));
		const res = await upload(w.batch.id, w.recon.id, { name: 'many.csv', bytes: resultCsv(rows) });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('ROW_LIMIT_EXCEEDED');
	});

	it('21. .xls / .xlsm / .zip / .exe are rejected — also a legacy .xls renamed to .xlsx and a macro workbook', async () => {
		const w = await world();
		for (const name of ['r.xls', 'r.xlsm', 'r.zip', 'r.exe', 'r.xlsb', 'r']) {
			const res = await upload(w.batch.id, w.reconXlsx.id, { name, bytes: Buffer.from('x') });
			expect(res.status, name).toBe(400);
			expect(res.body.error.code, name).toBe('UNSUPPORTED_FILE_TYPE');
		}
		// a real legacy .xls (OLE / CFB container) renamed .xlsx
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Status'], ['SUCCESS']]), 'S');
		const xls = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }) as Buffer;
		const renamed = await upload(w.batch.id, w.reconXlsx.id, { name: 'renamed.xlsx', bytes: xls });
		expect(renamed.status).toBe(400);
		expect(renamed.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
		// a macro-enabled workbook (vbaProject.bin) renamed .xlsx
		const macroWb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(macroWb, XLSX.utils.aoa_to_sheet([['Status']]), 'S');
		(macroWb as XLSX.WorkBook & { vbaraw?: Buffer }).vbaraw = Buffer.from('fake vba project');
		const xlsm = XLSX.write(macroWb, { type: 'buffer', bookType: 'xlsm', bookVBA: true }) as Buffer;
		const macro = await upload(w.batch.id, w.reconXlsx.id, { name: 'macro.xlsx', bytes: xlsm });
		expect(macro.status).toBe(400);
		expect(macro.body.error.code).toBe('MACRO_NOT_ALLOWED');
	});

	it('22. a FORMULA in a mapped XLSX cell rejects the file (never evaluated)', async () => {
		const w = await world();
		const [a] = w.batch.items;
		const bytes = resultXlsx([bankRow(a!, 'SUCCESS')], { formulaAt: { row: 1, col: 2 } });
		const res = await upload(w.batch.id, w.reconXlsx.id, { name: 'formula.xlsx', bytes });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('FORMULA_CELL_NOT_ALLOWED');
		expect(res.body.error.details).toMatchObject({ rowNumber: 2, column: 'Status' });
		expect(
			await prisma.paymentReconciliationImport.count({ where: { paymentBatchId: w.batch.id } })
		).toBe(0);
	});

	it('23. malformed CSV (unclosed quote / binary / not UTF-8) is rejected safely', async () => {
		const w = await world();
		const cases: [string, Buffer][] = [
			['quote.csv', Buffer.from('Instruction Reference,Status\r\n"PI-1,SUCCESS\r\n')],
			['binary.csv', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3])],
			['latin1.csv', Buffer.from([0x53, 0x74, 0x61, 0x74, 0x75, 0x73, 0x0a, 0xe9, 0xff])]
		];
		for (const [name, bytes] of cases) {
			const res = await upload(w.batch.id, w.recon.id, { name, bytes });
			expect(res.status, name).toBe(400);
			expect(res.body.error.code, name).toBe('MALFORMED_FILE');
		}
		// header missing a mapped column
		const res = await upload(w.batch.id, w.recon.id, {
			name: 'cols.csv',
			bytes: Buffer.from('Foo,Bar\r\n1,2\r\n')
		});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('MAPPED_COLUMN_NOT_FOUND');
	});

	it('24. malformed XLSX (a zip that is no workbook / garbage with a zip header) is rejected safely', async () => {
		const w = await world();
		for (const bytes of [
			Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]),
			Buffer.from('not a workbook at all')
		]) {
			const res = await upload(w.batch.id, w.reconXlsx.id, { name: 'bad.xlsx', bytes });
			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe('MALFORMED_FILE');
		}
	});

	it('25 + 26. unknown columns (e.g. a full account number) are never persisted; the raw file is not stored', async () => {
		const w = await world();
		const [a] = w.batch.items;
		const marker = 'QA-SECRET-NOTE-7c1f';
		const bytes = resultCsv(
			[{ ...bankRow(a!, 'SUCCESS'), extra: { 'Account Number': ACCT, Note: marker } }],
			['Account Number', 'Note']
		);
		const imp = await uploadOk(w.batch.id, w.recon.id, { name: 'extra.csv', bytes });
		const stored = await dbRowsText(imp.id);
		expect(stored).not.toContain(ACCT);
		expect(stored).not.toContain(marker);
		expect(stored).not.toContain('Account Number');
		// no column anywhere holds the file content
		const cols = Object.keys(
			await prisma.paymentReconciliationImport.findUniqueOrThrow({ where: { id: imp.id } })
		);
		expect(cols.some((c) => /content|bytes|raw|blob|data/i.test(c))).toBe(false);
		expect(JSON.stringify(imp)).not.toContain(ACCT);
	});

	it('28. the identical file again returns the SAME import — no duplicate rows, no second audit event', async () => {
		const w = await world();
		const bytes = resultCsv([bankRow(w.batch.items[0]!, 'SUCCESS')]);
		const first = await upload(w.batch.id, w.recon.id, { name: 'r.csv', bytes });
		const second = await upload(w.batch.id, w.recon.id, { name: 'renamed-copy.csv', bytes });
		const [c, d] = await Promise.all([
			upload(w.batch.id, w.recon.id, { name: 'r.csv', bytes }),
			upload(w.batch.id, w.recon.id, { name: 'r.csv', bytes })
		]);
		expect(first.status).toBe(201);
		for (const r of [second, c, d]) {
			expect(r.status).toBe(200);
			expect(r.body.data.duplicate).toBe(true);
			expect(r.body.data.import.id).toBe(first.body.data.import.id);
		}
		expect(
			await prisma.paymentReconciliationImport.count({ where: { paymentBatchId: w.batch.id } })
		).toBe(1);
		expect(
			await prisma.paymentReconciliationRow.count({
				where: { reconciliationImportId: first.body.data.import.id }
			})
		).toBe(1);
		expect(
			await prisma.auditEvent.count({
				where: {
					action: 'PAYROLL_PAYMENT.RECONCILIATION_IMPORTED',
					entityId: String(first.body.data.import.id)
				}
			})
		).toBe(1);
	});
});

describe('automatic matching (exact instruction reference only)', () => {
	it('29 + 34. an exact instruction reference with the exact amount / currency is MATCHED', async () => {
		const w = await world();
		const [a] = w.batch.items;
		const imp = await uploadOk(w.batch.id, w.recon.id, {
			name: 'r.csv',
			bytes: resultCsv([bankRow(a!, 'SUCCESS')])
		});
		expect(imp.rows[0]).toMatchObject({
			matchState: 'MATCHED',
			matchMethod: 'AUTO',
			issueCode: null
		});
		expect(imp.rows[0]!.matchedItem!.id).toBe(a!.id);
		// amount given with thousands separators is the same amount
		const grouped = a!.amount!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
		const imp2 = await uploadOk(w.batch.id, w.recon.id, {
			name: 'r2.csv',
			bytes: resultCsv([bankRow(a!, 'SUCCESS', { amount: grouped })])
		});
		expect(imp2.rows[0]!.matchState).toBe('MATCHED');
	});

	it('30. an unknown instruction reference is UNMATCHED (the import is not READY)', async () => {
		const w = await world();
		const imp = await uploadOk(w.batch.id, w.recon.id, {
			name: 'r.csv',
			bytes: resultCsv([{ ref: 'PI-NOPE-000', status: 'SUCCESS' }])
		});
		expect(imp.rows[0]).toMatchObject({
			matchState: 'UNMATCHED',
			issueCode: 'INSTRUCTION_REFERENCE_NOT_FOUND',
			matchedItem: null
		});
		expect(imp.status).toBe('PENDING_REVIEW');
	});

	it('31. two rows for the same instruction: different results → both CONFLICT; identical → DUPLICATE_BANK_RESULT_ROW', async () => {
		const w = await world();
		const [a] = w.batch.items;
		const imp = await uploadOk(w.batch.id, w.recon.id, {
			name: 'r.csv',
			bytes: resultCsv([bankRow(a!, 'SUCCESS'), bankRow(a!, 'FAILED')])
		});
		expect(imp.rows.map((r) => [r.matchState, r.issueCode])).toEqual([
			['CONFLICT', 'DUPLICATE_INSTRUCTION_REFERENCE'],
			['CONFLICT', 'DUPLICATE_INSTRUCTION_REFERENCE']
		]);
		const row = bankRow(a!, 'SUCCESS');
		const imp2 = await uploadOk(w.batch.id, w.recon.id, {
			name: 'd.csv',
			bytes: resultCsv([row, row])
		});
		expect(imp2.rows.map((r) => [r.matchState, r.issueCode])).toEqual([
			['MATCHED', null],
			['CONFLICT', 'DUPLICATE_BANK_RESULT_ROW']
		]);
	});

	it('32 + 33. an amount or currency mismatch is a CONFLICT — never silently accepted', async () => {
		const w = await world();
		const [a, b] = w.batch.items;
		const imp = await uploadOk(w.batch.id, w.recon.id, {
			name: 'r.csv',
			bytes: resultCsv([
				bankRow(a!, 'SUCCESS', { amount: '1.00' }),
				bankRow(b!, 'SUCCESS', { currency: 'USD' })
			])
		});
		expect(imp.rows.map((r) => [r.matchState, r.issueCode])).toEqual([
			['CONFLICT', 'AMOUNT_MISMATCH'],
			['CONFLICT', 'CURRENCY_MISMATCH']
		]);
	});

	it('35 + 36. never matched by employee name or by amount alone (row order irrelevant)', async () => {
		const w = await world();
		const [a] = w.batch.items;
		const imp = await uploadOk(w.batch.id, w.recon.id, {
			name: 'r.csv',
			bytes: resultCsv([
				{ ref: a!.employeeCode, status: 'SUCCESS', amount: a!.amount, currency: 'LAK' },
				{ ref: `${a!.employeeCode} ${a!.instructionReference!.toLowerCase()}`, status: 'SUCCESS' },
				{ ref: null, status: 'SUCCESS', amount: a!.amount, currency: 'LAK' }
			])
		});
		expect(imp.rows.every((r) => r.matchState === 'UNMATCHED' && r.matchedItem === null)).toBe(
			true
		);
		// the exact reference in a different letter case is not the reference either
		const lower = await uploadOk(w.batch.id, w.recon.id, {
			name: 'l.csv',
			bytes: resultCsv([{ ref: a!.instructionReference!.toLowerCase(), status: 'SUCCESS' }])
		});
		expect(lower.rows[0]!.matchState).toBe('UNMATCHED');
	});

	it('37. a CASH item is never matched automatically (and is not in the bank file)', async () => {
		const w = await finalizedWorld({ employees: 2 });
		await setBank(w.emps[0]!.id);
		await setMethod(w.emps[1]!.id, 'CASH');
		const created = await batchOk(w.runId);
		await validateOk(created.id);
		const profile = await exportProfile(w.companyId, { columns: V15_COLUMNS });
		const ex = await exportFile(created.id, profile.id);
		expect(ex.res.status).toBe(200);
		const b = await batch15(created.id);
		const cash = b.items.find((i) => i.paymentMethod === 'CASH')!;
		expect(cash.instructionReference).toBeTruthy();
		expect(ex.bytes.toString()).not.toContain(cash.instructionReference!);
		const recon = await reconProfile(w.companyId);
		const imp = await uploadOk(created.id, recon.id, {
			name: 'r.csv',
			bytes: resultCsv([{ ref: cash.instructionReference, status: 'SUCCESS' }])
		});
		expect(imp.rows[0]).toMatchObject({
			matchState: 'UNMATCHED',
			issueCode: 'ITEM_NOT_BANK_TRANSFER',
			matchedItem: null
		});
		// and a CASH item is not even a manual-match candidate
		expect(imp.candidates.map((c) => c.id)).not.toContain(cash.id);
	});

	it('38. a legacy (Phase 14) batch without instruction references stays manual', async () => {
		const w = await world();
		await prisma.payrollPaymentItem.updateMany({
			where: { paymentBatchId: w.batch.id },
			data: { instructionReference: null }
		});
		const [a] = w.batch.items;
		const imp = await uploadOk(w.batch.id, w.recon.id, {
			name: 'r.csv',
			bytes: resultCsv([bankRow(a!, 'SUCCESS')])
		});
		expect(imp.legacyBatch).toBe(true);
		expect(imp.rows[0]).toMatchObject({ matchState: 'UNMATCHED', matchedItem: null });
		const b = await batch15(w.batch.id);
		expect(b.legacyInstructionReferences).toBe(true);
	});
});
