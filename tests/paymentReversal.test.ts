import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { linkedUser, moneyNeedles, setupPhase13 } from './phase13Fixture.js';
import { ACCT } from './phase14Fixture.js';
import {
	batch15,
	confirmFailed,
	confirmPaid,
	ctx,
	exported15,
	reverse,
	today
} from './phase15Fixture.js';
import { agent } from './helpers.js';

/**
 * PHASE 15 — payment REVERSAL (spec tests 59–71): PAID only, append-only record, the original payment
 * facts preserved, derived batch status, private notification + audit, concurrency-safe.
 */
beforeAll(async () => {
	await setupPhase13();
});

async function paidWorld(employees = 1, userIds?: (string | null)[]) {
	const w = await exported15({ employees, userIds });
	for (const i of w.batch.items) {
		const r = await confirmPaid(w.batch.id, i.id, `QA-PAID-${i.employeeCode}`);
		expect(r.status).toBe(200);
	}
	return { ...w, batch: await batch15(w.batch.id) };
}

describe('reversal', () => {
	it('59 + 63 + 64. a PAID item is reversed; paidAt and the payment reference are preserved', async () => {
		const w = await paidWorld();
		const [a] = w.batch.items;
		const before = await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: a!.id } });
		const res = await reverse(w.batch.id, a!.id, { bankReference: 'QA-REV-77' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const after = await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: a!.id } });
		expect(after.status).toBe('REVERSED');
		expect(after.paidAt).toEqual(before.paidAt);
		expect(after.paymentReference).toBe(before.paymentReference);
		expect(after.accountNumberEncryptedSnapshot).toBe(before.accountNumberEncryptedSnapshot);
		expect(after.amount.toFixed(2)).toBe(before.amount.toFixed(2));
		const rev = await prisma.payrollPaymentReversal.findUniqueOrThrow({
			where: { paymentItemId: a!.id }
		});
		expect(rev).toMatchObject({
			bankReference: 'QA-REV-77',
			reason: 'QA: bank returned the transfer'
		});
		expect(rev.effectiveDate.toISOString().slice(0, 10)).toBe(today());
		expect(rev.reversedAt).toBeInstanceOf(Date);
		// the batch view shows the original paid facts + the reversal
		const view = (await batch15(w.batch.id)).items[0]!;
		expect(view.status).toBe('REVERSED');
		expect(view.paymentReference).toBe(before.paymentReference);
		expect(view.reversal).toMatchObject({ bankReference: 'QA-REV-77' });
	});

	it('60 + 61. EXPORTED and FAILED items cannot be reversed', async () => {
		const w = await exported15({ employees: 2 });
		const [a, b] = w.batch.items;
		await confirmFailed(w.batch.id, b!.id);
		for (const id of [a!.id, b!.id]) {
			const res = await reverse(w.batch.id, id);
			expect(res.status).toBe(409);
			expect(res.body.error.code).toBe('PAYMENT_ITEM_NOT_REVERSIBLE');
		}
		expect(
			await prisma.payrollPaymentReversal.count({ where: { paymentBatchId: w.batch.id } })
		).toBe(0);
	});

	it('62. a REVERSED item cannot be reversed twice', async () => {
		const w = await paidWorld();
		const [a] = w.batch.items;
		expect((await reverse(w.batch.id, a!.id)).status).toBe(200);
		const again = await reverse(w.batch.id, a!.id);
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('PAYMENT_ALREADY_REVERSED');
	});

	it('65. the reversal record is immutable (no update / delete route; one per item in the DB)', async () => {
		const w = await paidWorld();
		const [a] = w.batch.items;
		await reverse(w.batch.id, a!.id);
		const rev = await prisma.payrollPaymentReversal.findUniqueOrThrow({
			where: { paymentItemId: a!.id }
		});
		for (const method of ['put', 'patch', 'delete'] as const) {
			const res = await agent()
				[method](`/api/v1/payroll/payment-batches/${w.batch.id}/items/${a!.id}/reverse`)
				.set('Cookie', ctx.admin)
				.send({ reason: 'change it' });
			expect(res.status, method).toBe(404);
		}
		await expect(
			prisma.payrollPaymentReversal.create({
				data: {
					paymentItemId: a!.id,
					paymentBatchId: w.batch.id,
					companyId: w.companyId,
					reason: 'second',
					effectiveDate: new Date(),
					reversedAt: new Date()
				}
			})
		).rejects.toMatchObject({ code: 'P2002' });
		const still = await prisma.payrollPaymentReversal.findUniqueOrThrow({ where: { id: rev.id } });
		expect(still).toEqual(rev);
	});

	it('66. a future effective date is rejected; so is one before the payment date', async () => {
		const w = await paidWorld();
		const [a] = w.batch.items;
		const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
		const res = await reverse(w.batch.id, a!.id, { effectiveDate: future });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('REVERSAL_DATE_IN_FUTURE');
		const early = await reverse(w.batch.id, a!.id, { effectiveDate: '2020-01-01' });
		expect(early.status).toBe(400);
		expect(early.body.error.code).toBe('REVERSAL_BEFORE_PAYMENT');
		expect((await reverse(w.batch.id, a!.id, { effectiveDate: 'not-a-date' })).status).toBe(400);
		expect((await reverse(w.batch.id, a!.id, { reason: '' })).status).toBe(400);
		expect(
			(await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: a!.id } })).status
		).toBe('PAID');
	});

	it('67 + 68. the employee notification and the audit event carry no amount / account / reason / bank reference', async () => {
		const user = await linkedUser('EMPLOYEE');
		const w = await paidWorld(1, [user.userId]);
		const [a] = w.batch.items;
		await reverse(w.batch.id, a!.id, {
			bankReference: 'QA-REV-SECRET',
			reason: 'QA-INTERNAL-REASON'
		});
		const notes = await prisma.notification.findMany({
			where: { userId: user.userId, type: 'PAYROLL_PAYMENT_REVERSED' }
		});
		expect(notes).toHaveLength(1);
		expect(notes[0]!.titleLao).toMatch(/reversed/);
		expect(notes[0]!.dedupeKey).toBe(`payroll-payment:${a!.id}:reversed`);
		const audit = await prisma.auditEvent.findMany({
			where: { action: 'PAYROLL_PAYMENT.ITEM_REVERSED', entityId: String(a!.id) }
		});
		expect(audit).toHaveLength(1);
		expect(audit[0]!.metadataJson).toMatchObject({ itemId: a!.id, status: 'REVERSED' });
		const text = JSON.stringify({ notes, audit });
		for (const needle of [
			...moneyNeedles(a!.amount!),
			ACCT,
			'QA-REV-SECRET',
			'QA-INTERNAL-REASON',
			'7890'
		]) {
			expect(text).not.toContain(needle);
		}
	});

	it('69. concurrent reversals of one item: exactly one succeeds', async () => {
		const w = await paidWorld();
		const [a] = w.batch.items;
		const [x, y] = await Promise.all([reverse(w.batch.id, a!.id), reverse(w.batch.id, a!.id)]);
		expect([x.status, y.status].sort()).toEqual([200, 409]);
		expect(await prisma.payrollPaymentReversal.count({ where: { paymentItemId: a!.id } })).toBe(1);
		expect(
			await prisma.auditEvent.count({
				where: { action: 'PAYROLL_PAYMENT.ITEM_REVERSED', entityId: String(a!.id) }
			})
		).toBe(1);
	});

	it('70 + 71. batch → PARTIALLY_REVERSED, then REVERSED when every item is reversed', async () => {
		const w = await paidWorld(2);
		const [a, b] = w.batch.items;
		expect((await batch15(w.batch.id)).status).toBe('PAID');
		await reverse(w.batch.id, a!.id);
		expect((await batch15(w.batch.id)).status).toBe('PARTIALLY_REVERSED');
		await reverse(w.batch.id, b!.id);
		const done = await batch15(w.batch.id);
		expect(done.status).toBe('REVERSED');
		expect(done.summary).toMatchObject({ paid: 0 });
	});
});
