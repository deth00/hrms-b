import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { instructionReferences, normalizeCode } from '../src/lib/paymentStatus.js';
import { setupPhase13 } from './phase13Fixture.js';
import { exportedWorld, finalizedWorld, setBank, batchOk, createBatch } from './phase14Fixture.js';
import {
	batch15,
	confirmFailed,
	confirmPaid,
	exportFile,
	exported15,
	reconProfile,
	resultCsv,
	retryOk,
	reverse,
	uploadOk,
	bankRow
} from './phase15Fixture.js';

/**
 * PHASE 15 — batch sequence / item lineage / instruction references, and PROTECTION OF PHASE 14
 * EXPORTS (spec tests 1–8): an existing export must keep re-downloading byte-identically.
 */
beforeAll(async () => {
	await setupPhase13();
});

describe('batch sequence (migration + uniqueness)', () => {
	it('1. a Phase 14-shaped batch (no kind / sequence given) is ORIGINAL, sequence 1 — the migration default', async () => {
		const w = await finalizedWorld();
		const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: w.runId } });
		// created WITHOUT batchKind / sequenceNo — exactly like a row that existed before the migration
		const row = await prisma.payrollPaymentBatch.create({
			data: {
				companyId: w.companyId,
				payrollRunId: w.runId,
				batchNumber: `PAY-LEGACY-${String(w.runId).padStart(6, '0')}`,
				currencyCode: run.currencyCode,
				paymentDate: new Date('2025-09-30T00:00:00Z')
			}
		});
		expect(row).toMatchObject({ batchKind: 'ORIGINAL', sequenceNo: 1, parentBatchId: null });
		// and a normal API-created batch is ORIGINAL / 1 as well
		const w2 = await finalizedWorld();
		await setBank(w2.emps[0]!.id);
		const b = await batchOk(w2.runId);
		const view = await batch15(b.id);
		expect(view).toMatchObject({ batchKind: 'ORIGINAL', sequenceNo: 1, parentBatch: null });
	});

	it('2. still exactly ONE original batch per run (API 409 + DB unique (run, sequence) backstop)', async () => {
		const w = await finalizedWorld();
		await setBank(w.emps[0]!.id);
		const b = await batchOk(w.runId);
		const again = await createBatch(w.runId);
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('PAYMENT_BATCH_ALREADY_EXISTS');
		// concurrent creation → one winner
		const w2 = await finalizedWorld();
		await setBank(w2.emps[0]!.id);
		const [x, y] = await Promise.all([createBatch(w2.runId), createBatch(w2.runId)]);
		expect([x.status, y.status].sort()).toEqual([201, 409]);
		// the DB itself refuses a second sequence-1 batch for the run
		await expect(
			prisma.payrollPaymentBatch.create({
				data: {
					companyId: w.companyId,
					payrollRunId: w.runId,
					sequenceNo: 1,
					batchNumber: `DUP-${String(b.id).padStart(6, '0')}`,
					currencyCode: 'LAK',
					paymentDate: new Date()
				}
			})
		).rejects.toMatchObject({ code: 'P2002' });
	});

	it('3 + 4. a retry takes the next sequence (…-R1, …-R2) and every retry item points at its source', async () => {
		const w = await exported15({ employees: 2 });
		const [a, b] = w.batch.items;
		await confirmFailed(w.batch.id, a!.id);
		await confirmFailed(w.batch.id, b!.id);
		const r1 = await retryOk(w.batch.id, [a!.id]);
		expect(r1).toMatchObject({
			batchKind: 'RETRY',
			sequenceNo: 2,
			batchNumber: `${w.batch.batchNumber}-R1`,
			parentBatch: { id: w.batch.id }
		});
		expect(r1.items).toHaveLength(1);
		expect(r1.items[0]!.sourcePaymentItemId).toBe(a!.id);
		const r2 = await retryOk(w.batch.id, [b!.id]);
		expect(r2).toMatchObject({ sequenceNo: 3, batchNumber: `${w.batch.batchNumber}-R2` });
		expect(r2.items[0]!.sourcePaymentItemId).toBe(b!.id);
		const src = await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: a!.id } });
		expect(src.status).toBe('FAILED'); // the source attempt is preserved, never overwritten
	});
});

describe('Phase 14 export protection', () => {
	it('5 + 6. an existing (Phase 14 style) export re-downloads byte-identically after Phase 15 operations; PAYMENT_REFERENCE semantics unchanged', async () => {
		const w = await exportedWorld({ employees: 2 });
		const first = await exportFile(w.batch.id, w.profile.id);
		const firstHash = createHash('sha256').update(first.bytes).digest('hex');
		expect(firstHash).toBe(w.batch.exports[0]!.fileHash);
		const text = first.bytes.toString('utf8');
		expect(text).not.toContain('PI-'); // the old profile has no instruction-reference column
		// make the batch look exactly like a pre-Phase-15 one: no instruction references
		await prisma.payrollPaymentItem.updateMany({
			where: { paymentBatchId: w.batch.id },
			data: { instructionReference: null }
		});
		// Phase 15 operations on the batch
		const [a, b] = w.batch.items;
		expect((await confirmPaid(w.batch.id, a!.id)).status).toBe(200);
		expect((await reverse(w.batch.id, a!.id)).status).toBe(200);
		expect((await confirmFailed(w.batch.id, b!.id)).status).toBe(200);
		const profile = await reconProfile(w.companyId);
		await uploadOk(w.batch.id, profile.id, {
			name: 'result.csv',
			bytes: resultCsv([{ ref: 'UNKNOWN-REF', status: 'SUCCESS' }])
		});
		await retryOk(w.batch.id, [a!.id, b!.id]);
		// the old export still regenerates to the SAME bytes / hash
		const again = await exportFile(w.batch.id, w.profile.id);
		expect(again.res.status).toBe(200);
		expect(Buffer.compare(again.bytes, first.bytes)).toBe(0);
		expect(again.res.headers['x-export-hash']).toBe(firstHash);
		// PAYMENT_REFERENCE is still the Phase 14 transfer reference ({batchNumber}-{employeeCode})
		const p = await prisma.bankExportProfile.update({
			where: { id: w.profile.id },
			data: { columnMappingJson: [{ field: 'PAYMENT_REFERENCE', header: 'Ref' }] }
		});
		expect(p.id).toBe(w.profile.id);
		const items = await prisma.payrollPaymentItem.findMany({
			where: { paymentBatchId: w.batch.id }
		});
		for (const i of items) {
			expect(i.transferReference).toBe(
				`${w.batch.batchNumber}-${normalizeCode(i.employeeCodeSnapshot)}`
			);
		}
		// editing the profile never changes the frozen export either
		const third = await exportFile(w.batch.id, w.profile.id);
		expect(third.res.headers['x-export-hash']).toBe(firstHash);
	});
});

describe('instruction references', () => {
	it('7. every NEW item gets an immutable PI-{batch}-{employee} reference; it is in a Phase 15 export', async () => {
		const w = await exported15({ employees: 2 });
		for (const i of w.batch.items) {
			expect(i.instructionReference).toBe(
				`PI-${w.batch.batchNumber}-${normalizeCode(i.employeeCode)}`
			);
			expect(i.instructionReference).toMatch(/^[A-Z0-9-]+$/);
		}
		const file = await exportFile(w.batch.id, w.profile.id);
		for (const i of w.batch.items) expect(file.bytes.toString()).toContain(i.instructionReference!);
		// a retry item gets its OWN new reference (never the failed one's)
		await confirmFailed(w.batch.id, w.batch.items[0]!.id);
		const r = await retryOk(w.batch.id, [w.batch.items[0]!.id]);
		expect(r.items[0]!.instructionReference).toBe(
			`PI-${r.batchNumber}-${normalizeCode(w.batch.items[0]!.employeeCode)}`
		);
		expect(r.items[0]!.instructionReference).not.toBe(w.batch.items[0]!.instructionReference);
	});

	it('8. an instruction reference is unique within the batch (generator de-duplicates; DB unique backstop)', async () => {
		expect(instructionReferences('PAY-X', ['A.1', 'A-1', 'a 1'])).toEqual([
			'PI-PAY-X-A-1',
			'PI-PAY-X-A-1-2',
			'PI-PAY-X-A-1-3'
		]);
		const w = await exported15({ employees: 2 });
		const [a, b] = w.batch.items;
		await expect(
			prisma.payrollPaymentItem.update({
				where: { id: b!.id },
				data: { instructionReference: a!.instructionReference }
			})
		).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
		// the result-file helper round-trips the exact reference
		expect(bankRow(a!, 'SUCCESS').ref).toBe(a!.instructionReference);
	});
});
