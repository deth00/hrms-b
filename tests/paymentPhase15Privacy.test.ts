import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { linkedUser, moneyNeedles, setupPhase13 } from './phase13Fixture.js';
import { ACCT } from './phase14Fixture.js';
import { createTestUser, loginAndGetCookie } from './helpers.js';
import {
	apply,
	bankRow,
	batch15,
	confirmFailed,
	confirmPaid,
	ctx,
	exported15,
	get,
	ignoreRow,
	matchRow,
	post,
	reconProfile,
	resultCsv,
	retry,
	retryOk,
	reverse,
	upload,
	uploadOk,
	validateAndExport,
	viewOnlyUser
} from './phase15Fixture.js';

/**
 * PHASE 15 — self-service attempt history + permissions + privacy (spec tests 90–104): own attempts
 * only, reversal date but never its internal reason, no amounts / full accounts anywhere, no manager
 * access, and a GLOBAL leakage scan over every Phase 15 table, audit and notification.
 */
beforeAll(async () => {
	await setupPhase13();
});

/** A: FAILED → retry PAID. B: PAID → REVERSED → retry PAID. Both linked to EMPLOYEE users. */
async function historyWorld() {
	const ua = await linkedUser('EMPLOYEE');
	const ub = await linkedUser('EMPLOYEE');
	const w = await exported15({ employees: 2, userIds: [ua.userId, ub.userId] });
	// items are sorted by employee code — pick them by employee (A = emps[0] / ua, B = emps[1] / ub)
	const a = w.batch.items.find((i) => i.employeeId === w.emps[0]!.id)!;
	const b = w.batch.items.find((i) => i.employeeId === w.emps[1]!.id)!;
	await confirmFailed(w.batch.id, a!.id);
	await confirmPaid(w.batch.id, b!.id, 'QA-PAID-B1');
	await reverse(w.batch.id, b!.id, {
		reason: 'QA-INTERNAL-REVERSAL-REASON',
		bankReference: 'QA-REV-BANK-REF'
	});
	const r = await retryOk(w.batch.id, [a!.id, b!.id]);
	await validateAndExport(r.id, w.profile.id);
	for (const i of r.items) await confirmPaid(r.id, i.id, `QA-RETRY-${i.employeeCode}`);
	return { ...w, ua, ub, a: a!, b: b!, retryBatch: await batch15(r.id) };
}

describe('employee self-service', () => {
	it('90 + 91 + 95 + 96 + 97. own attempts only, grouped with the retry lineage; no amount, no full account, no other employee', async () => {
		const w = await historyWorld();
		const res = await get('/payroll-payments/me', w.ua.cookie);
		expect(res.status).toBe(200);
		const obs = res.body.data.obligations;
		expect(obs).toHaveLength(1);
		expect(obs[0].settlementStatus).toBe('PAID');
		expect(
			obs[0].attempts.map((x: { status: string; attemptNo: number; isRetry: boolean }) => [
				x.attemptNo,
				x.status,
				x.isRetry
			])
		).toEqual([
			[1, 'FAILED', false],
			[2, 'PAID', true]
		]);
		expect(obs[0].attempts[1].accountNumberMasked).toBe('••••7890');
		const text = JSON.stringify(res.body);
		expect(text).not.toContain(ACCT);
		expect(text).not.toContain(w.b.id);
		expect(text).not.toContain(w.b.employeeCode);
		for (const k of ['"amount"', '"netPay"', '"totalAmount"', '"employeeCount"'])
			expect(text).not.toContain(k);
		for (const n of moneyNeedles(w.a.amount!)) expect(text).not.toContain(`"${n}"`);
	});

	it('92 + 93 + 94. a reversed attempt shows REVERSED + the reversal date — never the internal reason / bank reference', async () => {
		const w = await historyWorld();
		const res = await get('/payroll-payments/me', w.ub.cookie);
		const ob = res.body.data.obligations[0];
		expect(ob.attempts.map((x: { status: string }) => x.status)).toEqual(['REVERSED', 'PAID']);
		expect(ob.attempts[0].reversedOn).toBeTruthy();
		expect(ob.attempts[0].paidAt).toBeTruthy(); // the original paid date stays visible
		expect(ob.attempts[0].paymentReference).toBeNull(); // not shown for a reversed attempt
		expect(ob.settlementStatus).toBe('PAID');
		const text = JSON.stringify(res.body);
		expect(text).not.toContain('QA-INTERNAL-REVERSAL-REASON');
		expect(text).not.toContain('QA-REV-BANK-REF');
		expect(text).not.toContain('"reason"');
	});

	it('98. a MANAGER has no access to subordinate payments, reconciliation, reversal or retry', async () => {
		const w = await historyWorld();
		const mgr = await linkedUser('MANAGER');
		const recon = await reconProfile(w.companyId);
		const imp = await uploadOk(w.batch.id, recon.id, {
			name: 'r.csv',
			bytes: resultCsv([{ ref: 'NOPE', status: 'SUCCESS' }])
		});
		for (const res of [
			await get(`/payroll/payment-batches/${w.batch.id}`, mgr.cookie),
			await get(`/payroll/reconciliations/${imp.id}`, mgr.cookie),
			await get(`/payroll/payment-batches/${w.batch.id}/reconciliations`, mgr.cookie),
			await get(`/payroll/payment-items/${w.a.id}/lineage`, mgr.cookie),
			await reverse(w.retryBatch.id, w.retryBatch.items[0]!.id, {}, mgr.cookie),
			await retry(w.batch.id, [w.a.id], mgr.cookie)
		]) {
			expect(res.status).toBe(403);
		}
		const own = await get('/payroll-payments/me', mgr.cookie);
		expect(JSON.stringify(own.body)).not.toContain(w.a.id);
	});
});

describe('permissions', () => {
	it('99. reconciliation pages / actions need payroll.payment.reconcile (+ employees.view_all)', async () => {
		const w = await exported15();
		const recon = await reconProfile(w.companyId);
		const imp = await uploadOk(w.batch.id, recon.id, {
			name: 'r.csv',
			bytes: resultCsv([{ ref: 'NOPE', status: 'SUCCESS' }])
		});
		const emp = await linkedUser('EMPLOYEE');
		const viewer = await viewOnlyUser();
		for (const cookie of [emp.cookie, viewer.cookie]) {
			expect((await get(`/payroll/reconciliations/${imp.id}`, cookie)).status).toBe(403);
			expect((await apply(imp.id, cookie)).status).toBe(403);
			expect((await matchRow(imp.id, imp.rows[0]!.id, w.batch.items[0]!.id, cookie)).status).toBe(
				403
			);
			expect((await ignoreRow(imp.id, imp.rows[0]!.id, 'nope nope', cookie)).status).toBe(403);
			expect((await post(`/payroll/reconciliations/${imp.id}/cancel`, cookie)).status).toBe(403);
			const up = await upload(
				w.batch.id,
				recon.id,
				{ name: 'r.csv', bytes: resultCsv([]) },
				cookie
			);
			expect(up.status).toBe(403);
		}
		// the view-only payment role may see the (masked) history list, nothing more
		expect(
			(await get(`/payroll/payment-batches/${w.batch.id}/reconciliations`, viewer.cookie)).status
		).toBe(200);
		expect(
			(await get(`/payroll/payment-batches/${w.batch.id}/reconciliations`, emp.cookie)).status
		).toBe(403);
	});

	it('100 + 101. reversal needs payroll.payment.reverse; retry needs payroll.payment.manage', async () => {
		const w = await exported15({ employees: 2 });
		const [a, b] = w.batch.items;
		await confirmPaid(w.batch.id, a!.id);
		await confirmFailed(w.batch.id, b!.id);
		const emp = await linkedUser('EMPLOYEE');
		const viewer = await viewOnlyUser();
		for (const cookie of [emp.cookie, viewer.cookie]) {
			expect((await reverse(w.batch.id, a!.id, {}, cookie)).status).toBe(403);
			expect((await retry(w.batch.id, [b!.id], cookie)).status).toBe(403);
		}
		expect((await batch15(w.batch.id)).items.map((i) => i.status).sort()).toEqual([
			'FAILED',
			'PAID'
		]);
		const hr = await createTestUser({ roleCode: 'HR_ADMIN' });
		const hrCookie = await loginAndGetCookie(hr.username, hr.password);
		expect((await reverse(w.batch.id, a!.id, {}, hrCookie)).status).toBe(200);
		expect((await retry(w.batch.id, [b!.id], hrCookie)).status).toBe(201);
	});
});

describe('privacy', () => {
	it('102 + 103 + 104. no amount / full account / salary in any Phase 15 audit event or notification; global leak scan', async () => {
		const w = await historyWorld();
		const recon = await reconProfile(w.companyId);
		const r = w.retryBatch;
		const imp = await uploadOk(r.id, recon.id, {
			name: 'r.csv',
			bytes: resultCsv(
				r.items.map((i) => bankRow(i, 'SUCCESS', { bankRef: `QA-RETRY-${i.employeeCode}` }))
			)
		});
		await apply(imp.id);
		const audit = await prisma.auditEvent.findMany({
			where: {
				OR: [
					{ action: { startsWith: 'PAYROLL_PAYMENT.RECONCILIATION' } },
					{ action: 'PAYROLL_PAYMENT.ITEM_REVERSED' },
					{ action: 'PAYROLL_PAYMENT.RETRY_BATCH_CREATED' },
					{ action: { startsWith: 'RECONCILIATION_PROFILE' } }
				],
				companyId: w.companyId
			}
		});
		expect(audit.length).toBeGreaterThanOrEqual(4);
		const notes = await prisma.notification.findMany({
			where: { userId: { in: [w.ua.userId, w.ub.userId] }, type: { startsWith: 'PAYROLL_PAYMENT' } }
		});
		expect(notes.map((n) => n.type).sort()).toEqual([
			'PAYROLL_PAYMENT_PAID',
			'PAYROLL_PAYMENT_PAID',
			'PAYROLL_PAYMENT_PAID',
			'PAYROLL_PAYMENT_REVERSED'
		]);
		const result = await prisma.payrollEmployeeResult.findFirstOrThrow({
			where: { payrollRunId: w.runId }
		});
		const needles = [
			ACCT,
			'001234567890',
			...moneyNeedles(w.a.amount!),
			...moneyNeedles(result.totalEarnings.toFixed(2)),
			'QA-INTERNAL-REVERSAL-REASON'
		];
		const text = JSON.stringify({ audit, notes });
		for (const n of needles) expect(text, n).not.toContain(n);
		for (const n of notes) {
			for (const k of ['QA-PAID-B1', 'QA-REV-BANK-REF', 'QA-RETRY-'])
				expect(n.titleLao).not.toContain(k);
		}
		// GLOBAL scan: the full account number exists in no Phase 15 table
		const rows = JSON.stringify(
			await Promise.all([
				prisma.paymentReconciliationImport.findMany(),
				prisma.paymentReconciliationRow.findMany(),
				prisma.paymentReconciliationProfile.findMany(),
				prisma.payrollPaymentReversal.findMany(),
				prisma.payrollPaymentItem.findMany({
					select: {
						instructionReference: true,
						paymentReference: true,
						failureCode: true,
						failureReason: true,
						transferReference: true,
						accountNumberLast4: true
					}
				})
			])
		);
		expect(rows).not.toContain(ACCT);
		// batch API responses stay masked as well
		expect(JSON.stringify(await batch15(r.id))).not.toContain(ACCT);
		expect(
			JSON.stringify((await get(`/payroll/reconciliations/${imp.id}`, ctx.admin)).body)
		).not.toContain(ACCT);
	});
});
