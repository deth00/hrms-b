import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { derivePaymentBatchStatus } from '../src/lib/paymentStatus.js';
import { linkedUser, moneyNeedles, setupPhase13 } from './phase13Fixture.js';
import { ACCT } from './phase14Fixture.js';
import {
	apply,
	bankRow,
	batch15,
	cancelImport,
	confirmFailed,
	confirmPaid,
	exported15,
	ignoreRow,
	importOf,
	matchRow,
	reconProfile,
	resultCsv,
	uploadOk,
	today
} from './phase15Fixture.js';

/**
 * PHASE 15 — reconciliation review (spec tests 39–46) and APPLY (47–58). Apply is the ONLY step that
 * changes payment items; it is idempotent, concurrency-safe and never undoes a PAID silently.
 */
beforeAll(async () => {
	await setupPhase13();
});

async function world(o: { employees?: number; userIds?: (string | null)[] } = {}) {
	const w = await exported15({ employees: o.employees ?? 2, userIds: o.userIds });
	const recon = await reconProfile(w.companyId);
	const up = (rows: Parameters<typeof resultCsv>[0], name = 'r.csv') =>
		uploadOk(w.batch.id, recon.id, { name, bytes: resultCsv(rows) });
	return { ...w, recon, up };
}

describe('manual review', () => {
	it('39 + 45. an UNMATCHED row is matched by hand (masked candidates only) → READY', async () => {
		const w = await world();
		const [a] = w.batch.items;
		const imp = await w.up([{ ...bankRow(a!, 'SUCCESS'), ref: 'BANK-OWN-REF-1' }]);
		expect(imp.status).toBe('PENDING_REVIEW');
		expect(imp.candidates.every((c) => /^••••\d{4}$/.test(c.accountNumberMasked ?? ''))).toBe(true);
		expect(JSON.stringify(imp)).not.toContain(ACCT);
		const res = await matchRow(imp.id, imp.rows[0]!.id, a!.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data.rows[0]).toMatchObject({ matchState: 'MATCHED', matchMethod: 'MANUAL' });
		expect(res.body.data.status).toBe('READY');
		const audit = await prisma.auditEvent.findFirstOrThrow({
			where: { entityId: String(imp.id), action: 'PAYROLL_PAYMENT.RECONCILIATION_ROW_MATCHED' }
		});
		expect(audit.metadataJson).toMatchObject({ itemId: a!.id, matchMethod: 'MANUAL' });
	});

	it('40. an item of ANOTHER batch cannot be matched', async () => {
		const w = await world();
		const other = await world();
		const imp = await w.up([{ ref: 'X-1', status: 'SUCCESS' }]);
		const res = await matchRow(imp.id, imp.rows[0]!.id, other.batch.items[0]!.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYMENT_ITEM_NOT_IN_BATCH');
	});

	it('41 + 42. a manual match with a different amount or currency is refused', async () => {
		const w = await world();
		const [a] = w.batch.items;
		const imp = await w.up([
			{ ref: 'X-1', status: 'SUCCESS', amount: '1.00', currency: 'LAK' },
			{ ref: 'X-2', status: 'SUCCESS', amount: a!.amount, currency: 'USD' }
		]);
		const r1 = await matchRow(imp.id, imp.rows[0]!.id, a!.id);
		expect(r1.status).toBe(409);
		expect(r1.body.error.code).toBe('AMOUNT_MISMATCH');
		const r2 = await matchRow(imp.id, imp.rows[1]!.id, a!.id);
		expect(r2.status).toBe(409);
		expect(r2.body.error.code).toBe('CURRENCY_MISMATCH');
		expect((await importOf(imp.id)).rows.every((r) => r.matchState === 'UNMATCHED')).toBe(true);
	});

	it('43. ignoring a row needs a reason; the row is kept and marked IGNORED', async () => {
		const w = await world();
		const imp = await w.up([{ ref: 'NOT-OURS', status: 'SUCCESS' }]);
		expect((await ignoreRow(imp.id, imp.rows[0]!.id, '')).status).toBe(400);
		expect((await ignoreRow(imp.id, imp.rows[0]!.id, 'x')).status).toBe(400);
		const ok = await ignoreRow(imp.id, imp.rows[0]!.id, 'QA: row belongs to another payroll');
		expect(ok.status).toBe(200);
		expect(ok.body.data.rows[0]).toMatchObject({
			matchState: 'IGNORED',
			ignoredReason: 'QA: row belongs to another payroll'
		});
		expect(ok.body.data.status).toBe('READY'); // every row matched or ignored
		expect(
			await prisma.paymentReconciliationRow.count({ where: { reconciliationImportId: imp.id } })
		).toBe(1);
		// audit: no free text
		const audit = await prisma.auditEvent.findFirstOrThrow({
			where: { entityId: String(imp.id), action: 'PAYROLL_PAYMENT.RECONCILIATION_ROW_IGNORED' }
		});
		expect(JSON.stringify(audit)).not.toContain('another payroll');
	});

	it('44. unresolved rows (UNMATCHED / CONFLICT / INVALID) block Apply', async () => {
		const w = await world();
		const [a, b] = w.batch.items;
		const imp = await w.up([
			{ ref: 'UNKNOWN', status: 'SUCCESS' },
			bankRow(a!, 'SUCCESS', { amount: '1.00' }),
			bankRow(b!, 'WHATEVER')
		]);
		expect(imp.rows.map((r) => r.matchState)).toEqual(['UNMATCHED', 'CONFLICT', 'INVALID']);
		expect(imp.rows[2]!.issueCode).toBe('UNKNOWN_EXTERNAL_STATUS');
		const res = await apply(imp.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('RECONCILIATION_NOT_READY');
		const items = await prisma.payrollPaymentItem.findMany({
			where: { paymentBatchId: w.batch.id }
		});
		expect(items.every((i) => i.status === 'EXPORTED')).toBe(true);
	});

	it('46. a CANCELLED import can neither be applied nor reviewed further', async () => {
		const w = await world();
		const imp = await w.up([bankRow(w.batch.items[0]!, 'SUCCESS')]);
		expect((await cancelImport(imp.id)).status).toBe(200);
		const res = await apply(imp.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('RECONCILIATION_CANCELLED');
		expect((await ignoreRow(imp.id, imp.rows[0]!.id, 'too late')).status).toBe(409);
		expect(
			(await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: w.batch.items[0]!.id } }))
				.status
		).toBe('EXPORTED');
		const audit = await prisma.auditEvent.count({
			where: { entityId: String(imp.id), action: 'PAYROLL_PAYMENT.RECONCILIATION_CANCELLED' }
		});
		expect(audit).toBe(1);
	});
});

describe('apply', () => {
	it('47 + 48 + 53. EXPORTED + bank PAID → PAID; EXPORTED + bank FAILED → FAILED; reconciliation metadata stored', async () => {
		const w = await world();
		const [a, b] = w.batch.items;
		const paidRow = bankRow(a!, 'SUCCESS', { bankRef: 'BANK-TXN-777', paidDate: '2025-10-01' });
		const imp = await w.up([paidRow, bankRow(b!, 'FAILED')]);
		expect(imp.status).toBe('READY');
		const res = await apply(imp.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data).toMatchObject({ alreadyApplied: false, paid: 1, failed: 1, noChange: 0 });
		expect(res.body.data.import.status).toBe('APPLIED');
		const ia = await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: a!.id } });
		expect(ia).toMatchObject({
			status: 'PAID',
			paymentReference: 'BANK-TXN-777',
			reconciliationImportId: imp.id
		});
		expect(ia.paidAt!.toISOString()).toBe('2025-10-01T05:00:00.000Z');
		expect(ia.reconciledAt).not.toBeNull();
		expect(ia.reconciledByUserId).not.toBeNull();
		const ib = await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: b!.id } });
		expect(ib).toMatchObject({
			status: 'FAILED',
			failureCode: 'AC04',
			failureReason: 'QA: account closed',
			reconciliationImportId: imp.id
		});
		const rows = (await importOf(imp.id)).rows;
		expect(rows.map((r) => r.applyOutcome)).toEqual(['PAID', 'FAILED']);
	});

	it('49. FAILED + bank PAID → PAID (paid after all)', async () => {
		const w = await world({ employees: 1 });
		const [a] = w.batch.items;
		await confirmFailed(w.batch.id, a!.id);
		const imp = await w.up([bankRow(a!, 'SUCCESS')]);
		expect(imp.status).toBe('READY');
		expect((await apply(imp.id)).status).toBe(200);
		expect(
			(await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: a!.id } })).status
		).toBe('PAID');
	});

	it('50 + 55. already PAID + the same PAID result → idempotent no-op, no second notification', async () => {
		const user = await linkedUser('EMPLOYEE');
		const w = await world({ employees: 1, userIds: [user.userId] });
		const [a] = w.batch.items;
		await confirmPaid(w.batch.id, a!.id, 'BANK-SAME-1');
		const before = await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: a!.id } });
		const imp = await w.up([bankRow(a!, 'SUCCESS', { bankRef: 'BANK-SAME-1' })]);
		expect(imp.rows[0]!.matchState).toBe('MATCHED');
		const res = await apply(imp.id);
		expect(res.body.data).toMatchObject({ paid: 0, noChange: 1 });
		const after = await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: a!.id } });
		expect(after.paidAt).toEqual(before.paidAt);
		expect(after.paymentReference).toBe('BANK-SAME-1');
		expect(
			await prisma.notification.count({
				where: { userId: user.userId, type: 'PAYROLL_PAYMENT_PAID' }
			})
		).toBe(1);
		// a contradicting reference for a PAID item is a CONFLICT, not a silent overwrite
		const imp2 = await w.up([bankRow(a!, 'SUCCESS', { bankRef: 'BANK-OTHER-9' })], 'r2.csv');
		expect(imp2.rows[0]).toMatchObject({
			matchState: 'CONFLICT',
			issueCode: 'ALREADY_PAID_DIFFERENT_REFERENCE'
		});
	});

	it('51 + 52. PAID + bank FAILED / REVERSED → CONFLICT REVERSAL_REQUIRED; PAID is never changed automatically', async () => {
		const w = await world();
		const [a, b] = w.batch.items;
		await confirmPaid(w.batch.id, a!.id);
		await confirmPaid(w.batch.id, b!.id);
		const imp = await w.up([bankRow(a!, 'FAILED'), bankRow(b!, 'REVERSED')]);
		expect(imp.rows.map((r) => [r.matchState, r.issueCode])).toEqual([
			['CONFLICT', 'REVERSAL_REQUIRED'],
			['CONFLICT', 'REVERSAL_REQUIRED']
		]);
		expect((await apply(imp.id)).status).toBe(409);
		const items = await prisma.payrollPaymentItem.findMany({
			where: { paymentBatchId: w.batch.id }
		});
		expect(items.every((i) => i.status === 'PAID')).toBe(true);
	});

	it('54. the employee PAID notification carries no amount / account / bank reference', async () => {
		const user = await linkedUser('EMPLOYEE');
		const w = await world({ employees: 1, userIds: [user.userId] });
		const [a] = w.batch.items;
		const imp = await w.up([bankRow(a!, 'SUCCESS', { bankRef: 'BANK-NOTIF-5' })]);
		await apply(imp.id);
		// payment notifications (the payslip notification of the finalized run is not in scope here)
		const notes = await prisma.notification.findMany({
			where: { userId: user.userId, type: { startsWith: 'PAYROLL_PAYMENT' } }
		});
		expect(notes.map((n) => n.type)).toEqual(['PAYROLL_PAYMENT_PAID']);
		const text = JSON.stringify(notes);
		for (const needle of [...moneyNeedles(a!.amount!), ACCT, 'BANK-NOTIF-5', '7890']) {
			expect(text).not.toContain(needle);
		}
	});

	it('56 + 57. concurrent Applies change the items once; applying again is an idempotent no-op', async () => {
		const w = await world();
		const [a, b] = w.batch.items;
		const imp = await w.up([bankRow(a!, 'SUCCESS'), bankRow(b!, 'FAILED')]);
		const [x, y] = await Promise.all([apply(imp.id), apply(imp.id)]);
		expect([x.status, y.status]).toEqual([200, 200]);
		expect([x.body.data.alreadyApplied, y.body.data.alreadyApplied].sort()).toEqual([false, true]);
		const again = await apply(imp.id);
		expect(again.body.data).toMatchObject({ alreadyApplied: true, paid: 0, failed: 0 });
		expect(
			await prisma.auditEvent.count({
				where: { entityId: String(imp.id), action: 'PAYROLL_PAYMENT.RECONCILIATION_APPLIED' }
			})
		).toBe(1);
		expect(
			await prisma.auditEvent.count({
				where: { action: 'PAYROLL_PAYMENT.ITEM_PAID', entityId: String(a!.id) }
			})
		).toBe(0); // reconciliation is audited as ONE apply event, not as manual confirmations
	});

	it('58. the batch status is derived from the items after Apply', async () => {
		const w = await world();
		const [a, b] = w.batch.items;
		const imp1 = await w.up([bankRow(a!, 'SUCCESS')]);
		await apply(imp1.id);
		expect((await batch15(w.batch.id)).status).toBe('PARTIALLY_PAID');
		const imp2 = await w.up([bankRow(b!, 'SUCCESS')], 'second.csv');
		await apply(imp2.id);
		const b2 = await batch15(w.batch.id);
		expect(b2.status).toBe('PAID');
		expect(b2.status).toBe(derivePaymentBatchStatus(b2.items as never));
		// a pure helper check of the central rule
		expect(derivePaymentBatchStatus([{ status: 'FAILED' }, { status: 'EXPORTED' }])).toBe(
			'EXPORTED'
		);
		expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
