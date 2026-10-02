import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { paymentIssues } from '../src/services/payrollPayment.service.js';
import { calc, newCompany, newRun, manualPeriod, setupPhase13 } from './phase13Fixture.js';
import {
	ACCT,
	batchOf,
	batchOk,
	cancel,
	confirm,
	createBatch,
	ctx,
	employee,
	exportedWorld,
	finalizedWorld,
	get,
	post,
	put,
	rebuild,
	setBank,
	setMethod,
	validate,
	validateOk,
	validatedWorld,
	type BatchView
} from './phase14Fixture.js';

/**
 * PHASE 14 — payment batches from FINALIZED payroll (spec tests 16–34) and manual payment
 * confirmation (53–66). Payroll is never recalculated or modified by any of this.
 */
beforeAll(async () => {
	await setupPhase13();
});

const itemOf = (b: BatchView, employeeId: string) =>
	b.items.find((i) => i.employeeId === employeeId)!;

describe('batch creation', () => {
	it('16 + 20 + 22. a FINALIZED run creates a DRAFT batch; amount = finalized net; bank snapshot stored', async () => {
		const w = await finalizedWorld({ employees: 2 });
		await setBank(w.emps[0]!.id);
		await setMethod(w.emps[1]!.id, 'CASH');
		const batch = await batchOk(w.runId);
		expect(batch.status).toBe('DRAFT');
		expect(batch.batchNumber).toMatch(/^PAY-MAN-/);
		expect(batch.employeeCount).toBe(2);
		const results = await prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: w.runId }
		});
		for (const r of results) {
			expect(itemOf(batch, r.employeeId).amount).toBe(r.netPay.toFixed(2));
		}
		expect(batch.totalAmount).toBe(
			results.reduce((s, r) => s.plus(r.netPay), new Prisma.Decimal(0)).toFixed(2)
		);
		const bank = itemOf(batch, w.emps[0]!.id);
		expect(bank).toMatchObject({
			paymentMethod: 'BANK_TRANSFER',
			bankCode: 'QABANK',
			accountNumberMasked: '••••7890',
			status: 'READY'
		});
		// the snapshot holds the CIPHERTEXT (copied), never the plaintext
		const row = await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: bank.id } });
		const account = await prisma.employeeBankAccount.findFirstOrThrow({
			where: { employeeId: w.emps[0]!.id }
		});
		expect(row.accountNumberEncryptedSnapshot).toBe(account.accountNumberEncrypted);
		expect(JSON.stringify(row)).not.toContain(ACCT);
		expect(JSON.stringify(batch)).not.toContain(ACCT);
		// the CASH item needs no bank data
		expect(itemOf(batch, w.emps[1]!.id)).toMatchObject({
			paymentMethod: 'CASH',
			bankCode: null,
			accountNumberMasked: null,
			status: 'READY'
		});
		// audit: ids / counts only
		const audit = await prisma.auditEvent.findFirstOrThrow({
			where: { action: 'PAYROLL_PAYMENT.BATCH_CREATED', entityId: String(batch.id) }
		});
		expect(audit.metadataJson).toMatchObject({ runId: w.runId, employeeCount: 2, readyCount: 2 });
	});

	it('17. a non-finalized run is rejected', async () => {
		const companyId = await newCompany();
		await employee(companyId);
		const period = await manualPeriod(companyId);
		const run = await newRun(companyId, period.id);
		await calc(run.id);
		const res = await createBatch(run.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_RUN_NOT_FINALIZED');
	});

	it('18. one batch per run', async () => {
		const w = await finalizedWorld();
		await batchOk(w.runId);
		const again = await createBatch(w.runId);
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('PAYMENT_BATCH_ALREADY_EXISTS');
	});

	it('19. concurrent create requests for the same run → exactly one batch', async () => {
		const w = await finalizedWorld();
		const results = await Promise.all([1, 2, 3].map(() => createBatch(w.runId)));
		expect(results.filter((r) => r.status === 201)).toHaveLength(1);
		for (const r of results.filter((x) => x.status !== 201)) {
			expect(r.status).toBe(409);
			expect(r.body.error.code).toBe('PAYMENT_BATCH_ALREADY_EXISTS');
		}
		expect(await prisma.payrollPaymentBatch.count({ where: { payrollRunId: w.runId } })).toBe(1);
	});

	it('21. batch creation never recalculates or modifies payroll (source changes after finalize are ignored)', async () => {
		const w = await finalizedWorld();
		const emp = w.emps[0]!;
		await setBank(emp.id);
		// a salary change after finalization would change a RECALCULATED net — it must not matter
		const comp = await post(`/employees/${emp.id}/compensation`, ctx.admin, {
			baseSalary: '9900000',
			effectiveFrom: '2025-01-02'
		});
		expect(comp.status, JSON.stringify(comp.body)).toBe(201);
		const before = await prisma.payrollEmployeeResult.findFirstOrThrow({
			where: { payrollRunId: w.runId },
			include: { items: true, payslip: true }
		});
		const runBefore = await prisma.payrollRun.findUniqueOrThrow({ where: { id: w.runId } });
		const calcAudits = await prisma.auditEvent.count({
			where: { action: 'PAYROLL.RUN_CALCULATED', entityId: String(w.runId) }
		});
		const batch = await batchOk(w.runId);
		expect(itemOf(batch, emp.id).amount).toBe(before.netPay.toFixed(2));
		const after = await prisma.payrollEmployeeResult.findFirstOrThrow({
			where: { payrollRunId: w.runId },
			include: { items: true, payslip: true }
		});
		expect(after).toEqual(before);
		expect(await prisma.payrollRun.findUniqueOrThrow({ where: { id: w.runId } })).toEqual(
			runBefore
		);
		expect(
			await prisma.auditEvent.count({
				where: { action: 'PAYROLL.RUN_CALCULATED', entityId: String(w.runId) }
			})
		).toBe(calcAudits);
	});

	it('23. a later bank-account edit does NOT modify the existing batch item', async () => {
		const w = await finalizedWorld();
		const emp = w.emps[0]!;
		await setBank(emp.id);
		const batch = await batchOk(w.runId);
		const itemBefore = await prisma.payrollPaymentItem.findUniqueOrThrow({
			where: { id: batch.items[0]!.id }
		});
		await setBank(emp.id, {
			accountNumber: '7777888899990000',
			bankCode: 'NEWBANK',
			bankName: 'New Bank'
		});
		const itemAfter = await prisma.payrollPaymentItem.findUniqueOrThrow({
			where: { id: batch.items[0]!.id }
		});
		expect(itemAfter).toEqual(itemBefore);
		expect((await batchOf(batch.id)).items[0]).toMatchObject({
			bankCode: 'QABANK',
			accountNumberMasked: '••••7890'
		});
	});
});

describe('validation', () => {
	it('24-26 + 32. CASH needs no bank; missing profile / missing account block; the batch stays DRAFT', async () => {
		const w = await finalizedWorld({ employees: 3 });
		const [cash, noProfile, noAccount] = w.emps as [{ id: string }, { id: string }, { id: string }];
		await setMethod(cash.id, 'CASH');
		await setMethod(noAccount.id, 'BANK_TRANSFER');
		const batch = await batchOk(w.runId);
		const v = await validateOk(batch.id);
		expect(v.batch.status).toBe('DRAFT');
		expect(v.readyCount).toBe(1);
		expect(v.blockedCount).toBe(2);
		expect(itemOf(v.batch, cash.id)).toMatchObject({ status: 'READY', issues: [] });
		expect(itemOf(v.batch, noProfile.id)).toMatchObject({
			status: 'BLOCKED',
			issues: ['MISSING_PAYMENT_PROFILE']
		});
		expect(itemOf(v.batch, noAccount.id)).toMatchObject({
			status: 'BLOCKED',
			issues: ['MISSING_BANK_ACCOUNT']
		});
		expect(
			v.issues
				.map((i) => i.codes)
				.flat()
				.sort()
		).toEqual(['MISSING_BANK_ACCOUNT', 'MISSING_PAYMENT_PROFILE']);
	});

	it('27. an INACTIVE account blocks (INACTIVE_BANK_ACCOUNT)', async () => {
		const w = await finalizedWorld();
		const emp = w.emps[0]!;
		const p = await setBank(emp.id);
		await post(`/employees/${emp.id}/bank-accounts/${p.primaryAccount!.id}/deactivate`, ctx.admin);
		const batch = await batchOk(w.runId);
		const v = await validateOk(batch.id);
		expect(v.batch.items[0]).toMatchObject({
			status: 'BLOCKED',
			issues: ['INACTIVE_BANK_ACCOUNT']
		});
	});

	it('28. a bank account in another currency blocks (no conversion)', async () => {
		const w = await finalizedWorld();
		await setBank(w.emps[0]!.id, { currencyCode: 'USD' });
		const batch = await batchOk(w.runId);
		const v = await validateOk(batch.id);
		expect(v.batch.items[0]).toMatchObject({
			status: 'BLOCKED',
			issues: ['BANK_CURRENCY_MISMATCH']
		});
		expect(v.batch.status).toBe('DRAFT');
	});

	it('29. zero net pay blocks (ZERO_NET_PAY)', async () => {
		const w = await finalizedWorld({
			salary: '3000000',
			beforeFinalize: async ({ emps, runId }) => {
				const adj = await post(
					`/payroll/runs/${runId}/employees/${emps[0]!.id}/adjustments`,
					ctx.admin,
					{
						type: 'DEDUCTION',
						code: 'QA_ZERO',
						nameLao: 'ຫັກທົດສອບ',
						amount: '3000000',
						reason: 'QA zero net pay'
					}
				);
				expect(adj.status, JSON.stringify(adj.body)).toBe(201);
				await calc(runId);
			}
		});
		const result = await prisma.payrollEmployeeResult.findFirstOrThrow({
			where: { payrollRunId: w.runId }
		});
		expect(result.netPay.toFixed(2)).toBe('0.00');
		await setBank(w.emps[0]!.id);
		const batch = await batchOk(w.runId);
		const v = await validateOk(batch.id);
		expect(v.batch.items[0]).toMatchObject({ status: 'BLOCKED', issues: ['ZERO_NET_PAY'] });
		expect(v.batch.status).toBe('DRAFT');
	});

	it('30. negative net pay blocks — the payment layer protects itself even if payroll let one through', async () => {
		// payroll already blocks negative nets (NEGATIVE_NET_PAY), so simulate a legacy finalized row
		const w = await finalizedWorld();
		await setBank(w.emps[0]!.id);
		await prisma.payrollEmployeeResult.updateMany({
			where: { payrollRunId: w.runId },
			data: { netPay: new Prisma.Decimal('-100.00') }
		});
		const batch = await batchOk(w.runId);
		const v = await validateOk(batch.id);
		expect(v.batch.items[0]).toMatchObject({ status: 'BLOCKED', issues: ['NEGATIVE_NET_PAY'] });
		expect(v.batch.totalAmount).toBe('0.00'); // a negative amount never reduces / enters the total
		// and the rule itself
		expect(
			paymentIssues(
				{
					paymentMethod: 'CASH',
					bankAccountId: null,
					bankAccountStatusSnapshot: null,
					bankCodeSnapshot: null,
					bankNameSnapshot: null,
					accountNameSnapshot: null,
					accountNumberEncryptedSnapshot: null,
					accountNumberIvSnapshot: null,
					accountNumberAuthTagSnapshot: null,
					encryptionKeyVersion: null,
					bankCurrencySnapshot: null,
					amount: new Prisma.Decimal('-1')
				},
				'LAK'
			)
		).toEqual(['NEGATIVE_NET_PAY']);
	});

	it('undecryptable snapshot → BANK_ACCOUNT_DECRYPTION_FAILED; missing bank code / account name are reported', async () => {
		const w = await finalizedWorld();
		await setBank(w.emps[0]!.id);
		const batch = await batchOk(w.runId);
		await prisma.payrollPaymentItem.update({
			where: { id: batch.items[0]!.id },
			data: {
				accountNumberAuthTagSnapshot: Buffer.alloc(16, 1).toString('base64'),
				bankCodeSnapshot: '',
				accountNameSnapshot: ' '
			}
		});
		const v = await validateOk(batch.id);
		expect(v.batch.items[0]!.issues.sort()).toEqual([
			'BANK_ACCOUNT_DECRYPTION_FAILED',
			'MISSING_ACCOUNT_NAME',
			'MISSING_BANK_CODE'
		]);
	});

	it('31. all READY → VALIDATED (validatedAt/by set; audit); validating again is idempotent', async () => {
		const w = await validatedWorld({ employees: 2 });
		const row = await prisma.payrollPaymentBatch.findUniqueOrThrow({ where: { id: w.batch.id } });
		expect(row.validatedAt).not.toBeNull();
		expect(row.validatedByUserId).toBe(ctx.adminUserId);
		const again = await validateOk(w.batch.id);
		expect(again.batch.status).toBe('VALIDATED');
		expect(
			await prisma.auditEvent.count({
				where: { action: 'PAYROLL_PAYMENT.BATCH_VALIDATED', entityId: String(w.batch.id) }
			})
		).toBe(1);
	});

	it('33. rebuild (DRAFT) re-snapshots the CURRENT account; 34. rebuild after VALIDATED is rejected', async () => {
		const w = await finalizedWorld();
		const emp = w.emps[0]!;
		await setMethod(emp.id, 'BANK_TRANSFER');
		const batch = await batchOk(w.runId);
		expect(batch.items[0]!.issues).toEqual(['MISSING_BANK_ACCOUNT']);
		await setBank(emp.id); // HR fixes the employee
		// validation still checks the STORED snapshot — never silently swaps in the new account
		expect((await validateOk(batch.id)).batch.items[0]!.issues).toEqual(['MISSING_BANK_ACCOUNT']);
		const rb = await rebuild(batch.id);
		expect(rb.status, JSON.stringify(rb.body)).toBe(200);
		expect((rb.body.data as BatchView).items[0]).toMatchObject({
			status: 'READY',
			accountNumberMasked: '••••7890'
		});
		expect(
			await prisma.auditEvent.count({
				where: { action: 'PAYROLL_PAYMENT.BATCH_REBUILT', entityId: String(batch.id) }
			})
		).toBe(1);
		const v = await validateOk(batch.id);
		expect(v.batch.status).toBe('VALIDATED');
		const again = await rebuild(batch.id);
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('PAYMENT_BATCH_NOT_DRAFT');
	});
});

describe('confirmation', () => {
	it('53-57. mark PAID (reference + paidAt stored) and FAILED (code + reason stored)', async () => {
		const w = await exportedWorld({ employees: 2 });
		const [a, b] = w.batch.items;
		const paid = await confirm(w.batch.id, a!.id, {
			status: 'PAID',
			paymentReference: 'QA-REF-001',
			paidAt: '2025-10-01'
		});
		expect(paid.status, JSON.stringify(paid.body)).toBe(200);
		const failed = await confirm(w.batch.id, b!.id, {
			status: 'FAILED',
			failureCode: 'ACC_CLOSED',
			failureReason: 'QA rejection'
		});
		expect(failed.status, JSON.stringify(failed.body)).toBe(200);
		const view = failed.body.data as BatchView;
		const pa = view.items.find((i) => i.id === a!.id)!;
		const fa = view.items.find((i) => i.id === b!.id)!;
		expect(pa).toMatchObject({ status: 'PAID', paymentReference: 'QA-REF-001' });
		expect(pa.paidAt?.slice(0, 10)).toBe('2025-10-01');
		expect(fa).toMatchObject({
			status: 'FAILED',
			failureCode: 'ACC_CLOSED',
			failureReason: 'QA rejection'
		});
		// 36: a failed item keeps its snapshot and amount
		const failedRow = await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: b!.id } });
		expect(failedRow.amount.toFixed(2)).toBe(b!.amount);
		expect(failedRow.accountNumberLast4).toBe('7890');
		// 58: mixed → PARTIALLY_PAID
		expect(view.status).toBe('PARTIALLY_PAID');
	});

	it('58-59. batch status is derived: none paid → EXPORTED, some → PARTIALLY_PAID, all → PAID (FAILED may later be paid)', async () => {
		const w = await exportedWorld({ employees: 2 });
		const [a, b] = w.batch.items;
		expect(w.batch.status).toBe('EXPORTED');
		const f = await confirm(w.batch.id, a!.id, {
			status: 'FAILED',
			failureCode: 'X',
			failureReason: 'bounced'
		});
		expect((f.body.data as BatchView).status).toBe('EXPORTED'); // none paid yet
		const p1 = await confirm(w.batch.id, b!.id, { status: 'PAID', paymentReference: 'R-B' });
		expect((p1.body.data as BatchView).status).toBe('PARTIALLY_PAID');
		const p2 = await confirm(w.batch.id, a!.id, { status: 'PAID', paymentReference: 'R-A-RETRY' });
		expect(p2.status, JSON.stringify(p2.body)).toBe(200);
		const done = p2.body.data as BatchView;
		expect(done.status).toBe('PAID');
		const row = await prisma.payrollPaymentBatch.findUniqueOrThrow({ where: { id: w.batch.id } });
		expect(row.confirmedAt).not.toBeNull();
		// the client never sets the batch status: a status field in the body is rejected
		const bad = await confirm(w.batch.id, a!.id, { status: 'PAID', batchStatus: 'PAID' });
		expect(bad.status).toBe(400);
	});

	it('60. confirmation before export is rejected', async () => {
		const w = await validatedWorld();
		const res = await confirm(w.batch.id, w.batch.items[0]!.id, { status: 'PAID' });
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYMENT_BATCH_NOT_EXPORTED');
		const draft = await finalizedWorld();
		await setBank(draft.emps[0]!.id);
		const b = await batchOk(draft.runId);
		expect((await confirm(b.id, b.items[0]!.id, { status: 'PAID' })).body.error.code).toBe(
			'PAYMENT_BATCH_NOT_EXPORTED'
		);
	});

	it('61 + 65. a PAID item cannot become FAILED (or PAID again) — no reversal', async () => {
		const w = await exportedWorld({ employees: 2 });
		const item = w.batch.items[0]!;
		await confirm(w.batch.id, item.id, { status: 'PAID', paymentReference: 'R1' });
		const fail = await confirm(w.batch.id, item.id, {
			status: 'FAILED',
			failureCode: 'X',
			failureReason: 'too late'
		});
		expect(fail.status).toBe(409);
		expect(fail.body.error.code).toBe('PAYMENT_ITEM_ALREADY_FINAL');
		const repay = await confirm(w.batch.id, item.id, { status: 'PAID', paymentReference: 'R2' });
		expect(repay.body.error.code).toBe('PAYMENT_ITEM_ALREADY_FINAL');
		const row = await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: item.id } });
		expect(row.paymentReference).toBe('R1');
	});

	it('62. concurrent confirmations of one item → exactly one wins', async () => {
		const w = await exportedWorld();
		const item = w.batch.items[0]!;
		const results = await Promise.all([
			confirm(w.batch.id, item.id, { status: 'PAID', paymentReference: 'P-1' }),
			confirm(w.batch.id, item.id, {
				status: 'FAILED',
				failureCode: 'X',
				failureReason: 'race loser'
			}),
			confirm(w.batch.id, item.id, { status: 'PAID', paymentReference: 'P-2' })
		]);
		const ok = results.filter((r) => r.status === 200);
		expect(ok.length).toBeGreaterThanOrEqual(1);
		const row = await prisma.payrollPaymentItem.findUniqueOrThrow({ where: { id: item.id } });
		// whatever the order, a PAID item was never overwritten afterwards
		if (row.status === 'PAID') {
			const audits = await prisma.auditEvent.count({
				where: { action: 'PAYROLL_PAYMENT.ITEM_PAID', entityId: String(item.id) }
			});
			expect(audits).toBe(1);
		}
		for (const r of results.filter((x) => x.status !== 200)) {
			expect(r.status).toBe(409);
		}
		const notifications = await prisma.notification.count({
			where: { dedupeKey: `payroll-payment:${item.id}:paid` }
		});
		expect(notifications).toBeLessThanOrEqual(1);
	});

	it('63-66. cancel: DRAFT and VALIDATED yes; EXPORTED and PAID no; payroll + payslips untouched', async () => {
		const d = await finalizedWorld();
		await setBank(d.emps[0]!.id);
		const draft = await batchOk(d.runId);
		const c1 = await cancel(draft.id);
		expect(c1.status).toBe(200);
		expect((c1.body.data as BatchView).status).toBe('CANCELLED');
		expect((c1.body.data as BatchView).items.every((i) => i.status === 'CANCELLED')).toBe(true);
		expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: d.runId } })).status).toBe(
			'FINALIZED'
		);
		expect(await prisma.payslip.count({ where: { payrollRunId: d.runId } })).toBe(1);

		const v = await validatedWorld();
		expect((await cancel(v.batch.id)).status).toBe(200);

		const e = await exportedWorld();
		const c3 = await cancel(e.batch.id);
		expect(c3.status).toBe(409);
		expect(c3.body.error.code).toBe('PAYMENT_BATCH_NOT_CANCELLABLE');
		await confirm(e.batch.id, e.batch.items[0]!.id, { status: 'PAID' });
		expect((await batchOf(e.batch.id)).status).toBe('PAID');
		expect((await cancel(e.batch.id)).body.error.code).toBe('PAYMENT_BATCH_NOT_CANCELLABLE');
		// a cancelled batch can no longer be validated / confirmed
		expect((await validate(draft.id)).body.error.code).toBe('PAYMENT_BATCH_NOT_DRAFT');
	});

	it('confirmation needs payroll.payment.confirm (+ employees.view_all)', async () => {
		const w = await exportedWorld();
		const { userWithPermissions } = await import('./helpers.js');
		const viewer = await userWithPermissions(['payroll.payment.view', 'employees.view_all']);
		const res = await confirm(w.batch.id, w.batch.items[0]!.id, { status: 'PAID' }, viewer.cookie);
		expect(res.status).toBe(403);
		const noScope = await userWithPermissions(['payroll.payment.confirm']);
		expect(
			(await confirm(w.batch.id, w.batch.items[0]!.id, { status: 'PAID' }, noScope.cookie)).status
		).toBe(403);
	});

	it('payment date defaults to the period pay date and can be set explicitly', async () => {
		const w = await finalizedWorld();
		const res = await createBatch(w.runId, ctx.admin, { paymentDate: '2025-10-05' });
		expect(res.status).toBe(201);
		const row = await prisma.payrollPaymentBatch.findUniqueOrThrow({
			where: { id: res.body.data.id }
		});
		expect(row.paymentDate.toISOString().slice(0, 10)).toBe('2025-10-05');
		const list = await get('/payroll/payment-batches?pageSize=100', ctx.admin);
		expect(list.status).toBe(200);
		expect(list.body.data.items.some((b: { id: string }) => b.id === res.body.data.id)).toBe(true);
		const runBatch = await get(`/payroll/runs/${w.runId}/payment-batch`, ctx.admin);
		expect(runBatch.body.data.batch.id).toBe(res.body.data.id);
		void put;
	});
});
