import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { resolvePaymentObligationStatus } from '../src/services/paymentObligation.service.js';
import { setupPhase13 } from './phase13Fixture.js';
import { setBank, setMethod } from './phase14Fixture.js';
import {
	apply,
	bankRow,
	batch15,
	confirmFailed,
	confirmPaid,
	exported15,
	exportFile,
	get,
	post,
	ctx,
	reconProfile,
	resultCsv,
	retry,
	retryOk,
	reverse,
	uploadOk,
	validateAndExport
} from './phase15Fixture.js';

/**
 * PHASE 15 — RETRY / REISSUE (spec tests 72–89): a new batch + new items with lineage, current
 * routing, the SOURCE amount (never re-read from payroll), a new instruction reference, and no way to
 * pay one obligation twice.
 */
beforeAll(async () => {
	await setupPhase13();
});

async function failedWorld(employees = 1) {
	const w = await exported15({ employees });
	for (const i of w.batch.items) expect((await confirmFailed(w.batch.id, i.id)).status).toBe(200);
	return { ...w, batch: await batch15(w.batch.id) };
}

describe('eligibility', () => {
	it('72 + 73. FAILED and REVERSED items are eligible', async () => {
		const w = await exported15({ employees: 2 });
		const [a, b] = w.batch.items;
		await confirmFailed(w.batch.id, a!.id);
		await confirmPaid(w.batch.id, b!.id);
		await reverse(w.batch.id, b!.id);
		const view = await batch15(w.batch.id);
		expect(view.items.map((i) => i.retryEligible)).toEqual([true, true]);
		const r = await retryOk(w.batch.id, [a!.id, b!.id]);
		expect(r.items.map((i) => i.sourcePaymentItemId).sort()).toEqual([a!.id, b!.id].sort());
	});

	it('74 + 75. PAID and EXPORTED items are not eligible', async () => {
		const w = await exported15({ employees: 2 });
		const [a, b] = w.batch.items;
		await confirmPaid(w.batch.id, a!.id);
		for (const id of [a!.id, b!.id]) {
			const res = await retry(w.batch.id, [id]);
			expect(res.status).toBe(409);
			expect(res.body.error.code).toBe('PAYMENT_RETRY_NOT_ELIGIBLE');
		}
		// an item of another batch is not addressable through this batch
		const other = await failedWorld();
		const res = await retry(w.batch.id, [other.batch.items[0]!.id]);
		expect(res.status).toBe(404);
	});
});

describe('retry batch content', () => {
	it('76 + 77 + 81 + 82. next sequence; the SOURCE amount; a new instruction reference; lineage', async () => {
		const w = await failedWorld();
		const [a] = w.batch.items;
		const r = await retryOk(w.batch.id, [a!.id]);
		expect(r).toMatchObject({ batchKind: 'RETRY', sequenceNo: 2, status: 'DRAFT' });
		const item = r.items[0]!;
		expect(item.amount).toBe(a!.amount);
		expect(item.sourcePaymentItemId).toBe(a!.id);
		expect(item.instructionReference).not.toBe(a!.instructionReference);
		expect(item.instructionReference).toMatch(/^PI-.*-R1-/);
		const audit = await prisma.auditEvent.findFirstOrThrow({
			where: { action: 'PAYROLL_PAYMENT.RETRY_BATCH_CREATED', entityId: String(r.id) }
		});
		expect(audit.metadataJson).toMatchObject({
			parentBatchId: w.batch.id,
			sequenceNo: 2,
			itemCount: 1
		});
		expect(JSON.stringify(audit.metadataJson)).not.toContain(a!.amount!);
		// lineage endpoint
		const lin = await get(`/payroll/payment-items/${item.id}/lineage`, ctx.admin);
		expect(lin.status).toBe(200);
		expect(lin.body.data.attempts.map((x: { itemId: string }) => x.itemId)).toEqual([
			a!.id,
			item.id
		]);
		expect(lin.body.data.obligationStatus).toBe('IN_PROGRESS');
	});

	it('78. retry never reads / recalculates payroll: the amount stays the source amount even if payroll data differs', async () => {
		const w = await failedWorld();
		const [a] = w.batch.items;
		const result = await prisma.payrollEmployeeResult.findFirstOrThrow({
			where: { payrollRunId: w.runId }
		});
		const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: w.runId } });
		// tamper with the stored netPay (as if payroll had changed) — a retry must NOT pick it up
		await prisma.payrollEmployeeResult.update({
			where: { id: result.id },
			data: { netPay: new Prisma.Decimal('1.23') }
		});
		const r = await retryOk(w.batch.id, [a!.id]);
		expect(r.items[0]!.amount).toBe(a!.amount);
		await prisma.payrollEmployeeResult.update({
			where: { id: result.id },
			data: { netPay: result.netPay }
		});
		const runAfter = await prisma.payrollRun.findUniqueOrThrow({ where: { id: w.runId } });
		expect(runAfter.updatedAt).toEqual(run.updatedAt);
		expect(runAfter.status).toBe('FINALIZED');
	});

	it('79. the retry snapshots the CURRENT bank account (the employee changed banks)', async () => {
		const w = await failedWorld();
		const [a] = w.batch.items;
		expect(a!.accountNumberMasked).toBe('••••7890');
		await setBank(w.emps[0]!.id, {
			accountNumber: '009988776655',
			bankCode: 'NEWBANK',
			bankName: 'New Bank'
		});
		const r = await retryOk(w.batch.id, [a!.id]);
		expect(r.items[0]).toMatchObject({
			accountNumberMasked: '••••6655',
			bankCode: 'NEWBANK',
			status: 'READY'
		});
		// the source keeps its old snapshot
		expect((await batch15(w.batch.id)).items[0]!.accountNumberMasked).toBe('••••7890');
	});

	it('80 + 88. a retry may switch BANK → CASH; CASH is excluded from the bank file and paid by hand', async () => {
		const w = await failedWorld();
		const [a] = w.batch.items;
		await setMethod(w.emps[0]!.id, 'CASH');
		const r = await retryOk(w.batch.id, [a!.id]);
		expect(r.items[0]).toMatchObject({
			paymentMethod: 'CASH',
			accountNumberMasked: null,
			status: 'READY'
		});
		const ex = await validateAndExport(r.id, w.profile.id);
		expect(ex.bytes.toString()).not.toContain(r.items[0]!.instructionReference!);
		expect(ex.bytes.toString().trim().split(/\r?\n/)).toHaveLength(1); // header only
		const paid = await confirmPaid(r.id, r.items[0]!.id);
		expect(paid.status).toBe(200);
		expect(await resolvePaymentObligationStatus(a!.payrollEmployeeResultId)).toBe('PAID');
	});
});

describe('double-payment protection', () => {
	it('83. concurrent retries of the same source: exactly one succeeds', async () => {
		const w = await failedWorld();
		const [a] = w.batch.items;
		const [x, y] = await Promise.all([retry(w.batch.id, [a!.id]), retry(w.batch.id, [a!.id])]);
		expect([x.status, y.status].sort()).toEqual([201, 409]);
		const loser = x.status === 409 ? x : y;
		expect(['PAYMENT_RETRY_ALREADY_EXISTS', 'PAYMENT_RETRY_IN_PROGRESS']).toContain(
			loser.body.error.code
		);
		expect(await prisma.payrollPaymentItem.count({ where: { sourcePaymentItemId: a!.id } })).toBe(
			1
		);
		// the DB backstop itself: a second LIVE child of the same source is impossible
		// (retrySourceLockId is UNIQUE: no other row may claim the same source while the child is live)
		await expect(
			prisma.payrollPaymentItem.update({ where: { id: a!.id }, data: { retrySourceLockId: a!.id } })
		).rejects.toMatchObject({ code: 'P2002' });
	});

	it('84. an active retry blocks a second retry (PAYMENT_RETRY_IN_PROGRESS); a paid obligation cannot be retried', async () => {
		const w = await failedWorld();
		const [a] = w.batch.items;
		const r = await retryOk(w.batch.id, [a!.id]);
		const again = await retry(w.batch.id, [a!.id]);
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('PAYMENT_RETRY_IN_PROGRESS');
		// the FAILED source cannot be confirmed PAID by hand either while its retry is live
		const manual = await confirmPaid(w.batch.id, a!.id);
		expect(manual.status).toBe(409);
		expect(manual.body.error.code).toBe('PAYMENT_RETRY_EXISTS');
		// …nor by a bank file (RETRY_EXISTS conflict)
		const recon = await reconProfile(w.companyId);
		const imp = await uploadOk(w.batch.id, recon.id, {
			name: 'r.csv',
			bytes: resultCsv([bankRow(a!, 'SUCCESS')])
		});
		expect(imp.rows[0]).toMatchObject({ matchState: 'CONFLICT', issueCode: 'RETRY_EXISTS' });
		// cancelling the (unexported) retry frees the source again
		expect((await post(`/payroll/payment-batches/${r.id}/cancel`, ctx.admin)).status).toBe(200);
		const r2 = await retryOk(w.batch.id, [a!.id]);
		expect(r2.sequenceNo).toBe(3);
	});

	it('85. a FAILED retry can itself be retried (chain original → #1 → #2); the old source cannot', async () => {
		const w = await failedWorld();
		const [a] = w.batch.items;
		const r1 = await retryOk(w.batch.id, [a!.id]);
		await validateAndExport(r1.id, w.profile.id);
		await confirmFailed(r1.id, r1.items[0]!.id);
		const old = await retry(w.batch.id, [a!.id]);
		expect(old.status).toBe(409);
		expect(old.body.error.code).toBe('PAYMENT_RETRY_ALREADY_EXISTS');
		const r2 = await retryOk(r1.id, [r1.items[0]!.id]);
		expect(r2).toMatchObject({ sequenceNo: 3, parentBatch: { id: r1.id } });
		expect(r2.items[0]!.sourcePaymentItemId).toBe(r1.items[0]!.id);
		expect(r2.items[0]!.amount).toBe(a!.amount);
	});
});

describe('retry batch lifecycle', () => {
	it('86 + 87. a retry batch uses the normal validation and export (and its own export record)', async () => {
		const w = await failedWorld();
		const [a] = w.batch.items;
		// break the routing: validation must block it exactly like an original batch
		await setMethod(w.emps[0]!.id, 'BANK_TRANSFER');
		await prisma.employeePaymentProfile.update({
			where: { employeeId: w.emps[0]!.id },
			data: { bankAccountId: null }
		});
		const r = await retryOk(w.batch.id, [a!.id]);
		expect(r.items[0]).toMatchObject({ status: 'BLOCKED', issues: ['MISSING_BANK_ACCOUNT'] });
		const blocked = await post(`/payroll/payment-batches/${r.id}/validate`, ctx.admin);
		expect(blocked.body.data.blockedCount).toBe(1);
		expect((await exportFile(r.id, w.profile.id)).res.status).toBe(409);
		// fix the account, rebuild (routing only), validate, export
		await setBank(w.emps[0]!.id, { accountNumber: '001122334455' });
		const reb = await post(`/payroll/payment-batches/${r.id}/rebuild`, ctx.admin);
		expect(reb.status).toBe(200);
		expect(reb.body.data.items[0]).toMatchObject({
			status: 'READY',
			amount: a!.amount,
			sourcePaymentItemId: a!.id
		});
		const ex = await validateAndExport(r.id, w.profile.id);
		expect(ex.bytes.toString()).toContain('001122334455');
		expect(ex.bytes.toString()).toContain(reb.body.data.items[0].instructionReference);
		const after = await batch15(r.id);
		expect(after.status).toBe('EXPORTED');
		expect(after.exports).toHaveLength(1);
	});

	it('89. a PAID retry resolves the obligation PAID (reconciled from the bank file)', async () => {
		const w = await failedWorld();
		const [a] = w.batch.items;
		expect(await resolvePaymentObligationStatus(a!.payrollEmployeeResultId)).toBe('FAILED');
		const r = await retryOk(w.batch.id, [a!.id]);
		expect(await resolvePaymentObligationStatus(a!.payrollEmployeeResultId)).toBe('IN_PROGRESS');
		await validateAndExport(r.id, w.profile.id);
		const recon = await reconProfile(w.companyId);
		const retried = (await batch15(r.id)).items[0]!;
		const imp = await uploadOk(r.id, recon.id, {
			name: 'retry-result.csv',
			bytes: resultCsv([bankRow(retried, 'SUCCESS')])
		});
		expect(imp.status).toBe('READY');
		expect((await apply(imp.id)).status).toBe(200);
		expect(await resolvePaymentObligationStatus(a!.payrollEmployeeResultId)).toBe('PAID');
		// the original batch shows the FAILED attempt, and its obligation as settled
		const orig = await batch15(w.batch.id);
		expect(orig.items[0]).toMatchObject({
			status: 'FAILED',
			obligationStatus: 'PAID',
			retryEligible: false
		});
		expect((await retry(w.batch.id, [a!.id])).status).toBe(409);
	});
});
