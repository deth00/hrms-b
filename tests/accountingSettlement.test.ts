import { beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import { setupPhase13 } from './phase13Fixture.js';
import { retryOk, reverse, today, validateAndExport } from './phase15Fixture.js';
import {
	ACCOUNTS,
	cancelJ,
	confirmFailed,
	createReversal,
	createSettlement,
	ctx,
	get,
	journalOf,
	mapOk,
	payOk,
	payrollFingerprint,
	paymentWorld,
	postedOk,
	settlementOk,
	validateJ,
	type JournalView
} from './phase16Fixture.js';
import { isolateFixtureNotifications } from './phase16Fixture.js';

/** Phase 16 — PAYMENT SETTLEMENT + PAYMENT REVERSAL journals (tests 61-80). */
isolateFixtureNotifications();
beforeAll(async () => {
	await setupPhase13();
});

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const status = async (batchId: string) =>
	(await get(`/payroll/payment-batches/${batchId}/accounting-status`, ctx.admin)).body.data as {
		paidCount: number;
		accountedCount: number;
		unaccountedPaidCount: number;
		reversalAccountingPendingCount: number;
		reversals: { reversalId: string; state: string }[];
		canCreateSettlement: boolean;
	};
async function reversalOf(itemId: string) {
	return prisma.payrollPaymentReversal.findUniqueOrThrow({ where: { paymentItemId: itemId } });
}

describe('settlement journal', () => {
	it('61. no PAID item yet → 409 ACCOUNTING_NOTHING_TO_ACCOUNT', async () => {
		const w = await paymentWorld();
		const res = await createSettlement(w.batchId);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('ACCOUNTING_NOTHING_TO_ACCOUNT');
	});

	it('62. BANK item: Dr Payroll Payable / Cr Bank clearing with the EXACT item amount', async () => {
		const w = await paymentWorld({ employees: 2 });
		for (const i of w.items) await payOk(w.batchId, i.id);
		const j = await settlementOk(w.batchId);
		expect(j.journalType).toBe('PAYMENT_SETTLEMENT');
		expect(j.sourceType).toBe('PAYMENT_BATCH');
		expect(j.lines).toHaveLength(4);
		for (const item of w.items) {
			const lines = j.lines.filter((l) => l.sourceId === item.id);
			const dr = lines.find((l) => l.accountCode === ACCOUNTS.PAYABLE.code)!;
			const cr = lines.find((l) => l.accountCode === ACCOUNTS.BANK.code)!;
			expect(D(dr.debit).equals(item.amount)).toBe(true);
			expect(D(cr.credit).equals(item.amount)).toBe(true);
			expect(dr.sourceReference).toBe(item.instructionReference ?? item.transferReference);
		}
		expect(j.totalDebit).toBe(j.totalCredit);
		expect(j.journalNumber).toBe(`PAYST-${w.batchNumber.replace(/_/g, '-')}-1`);
	});

	it('63. CASH item → Cr Cash clearing (method of the PAID attempt)', async () => {
		const w = await paymentWorld({ employees: 2, cashIndexes: [1] });
		for (const i of w.items) await payOk(w.batchId, i.id);
		const j = await settlementOk(w.batchId);
		const cash = w.items.find((i) => i.paymentMethod === 'CASH')!;
		const bank = w.items.find((i) => i.paymentMethod === 'BANK_TRANSFER')!;
		const credit = (id: string) =>
			j.lines.find((l) => l.sourceId === id && D(l.credit).greaterThan(0))!;
		expect(credit(cash.id).accountCode).toBe(ACCOUNTS.CASH.code);
		expect(credit(cash.id).sourceType).toBe('CASH_CLEARING');
		expect(credit(bank.id).accountCode).toBe(ACCOUNTS.BANK.code);
	});

	it('64. partial batch: later PAID items go into ANOTHER settlement journal; then nothing left → 409', async () => {
		const w = await paymentWorld({ employees: 2 });
		await payOk(w.batchId, w.items[0]!.id);
		const first = await settlementOk(w.batchId);
		expect(first.lines.every((l) => l.sourceId === w.items[0]!.id)).toBe(true);
		expect((await status(w.batchId)).unaccountedPaidCount).toBe(0);
		await payOk(w.batchId, w.items[1]!.id);
		const s = await status(w.batchId);
		expect(s).toMatchObject({
			paidCount: 2,
			accountedCount: 1,
			unaccountedPaidCount: 1,
			canCreateSettlement: true
		});
		const second = await settlementOk(w.batchId);
		expect(second.lines.every((l) => l.sourceId === w.items[1]!.id)).toBe(true);
		expect(second.journalNumber.endsWith('-2')).toBe(true);
		const again = await createSettlement(w.batchId);
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('PAYMENT_SETTLEMENT_ALREADY_ACCOUNTED');
	});

	it('65. concurrent settlement creation → one journal; an item is in only one live journal', async () => {
		const w = await paymentWorld({ employees: 2 });
		for (const i of w.items) await payOk(w.batchId, i.id);
		const res = await Promise.all([1, 2, 3].map(() => createSettlement(w.batchId)));
		expect(res.filter((r) => r.status === 201)).toHaveLength(1);
		expect(
			await prisma.payrollJournalSource.count({
				where: { sourceId: { in: w.items.map((i) => i.id) }, activeKey: { not: null } }
			})
		).toBe(2);
	});

	it('66. the DB unique key rejects a second live settlement for an item', async () => {
		const w = await paymentWorld({ employees: 1 });
		await payOk(w.batchId, w.items[0]!.id);
		const j = await settlementOk(w.batchId);
		await expect(
			prisma.payrollJournalSource.create({
				data: {
					journalId: j.id,
					journalType: 'PAYMENT_SETTLEMENT',
					sourceType: 'PAYMENT_ITEM',
					sourceId: w.items[0]!.id,
					activeKey: `SETTLEMENT:${w.items[0]!.id}`
				}
			})
		).rejects.toMatchObject({ code: 'P2002' });
	});

	it('67. retry: the FAILED original is never accounted; only the PAID retry item is', async () => {
		const w = await paymentWorld({ employees: 2 });
		await payOk(w.batchId, w.items[0]!.id);
		expect((await confirmFailed(w.batchId, w.items[1]!.id)).status).toBe(200);
		const original = await settlementOk(w.batchId);
		expect(original.lines.some((l) => l.sourceId === w.items[1]!.id)).toBe(false);
		const retryBatch = await retryOk(w.batchId, [w.items[1]!.id]);
		await validateAndExport(retryBatch.id, w.bankProfileId);
		const retryItem = retryBatch.items[0]!;
		await payOk(retryBatch.id, retryItem.id);
		const rj = await settlementOk(retryBatch.id);
		expect(rj.lines.map((l) => l.sourceId)).toEqual([retryItem.id, retryItem.id]);
		const amount = D(rj.lines[0]!.debit);
		expect(amount.equals(w.items[1]!.amount)).toBe(true);
	}, 60_000);

	it('68. cancel releases the items for a new settlement journal', async () => {
		const w = await paymentWorld({ employees: 1 });
		await payOk(w.batchId, w.items[0]!.id);
		const j = await settlementOk(w.batchId);
		await cancelJ(j.id);
		const again = await settlementOk(w.batchId);
		expect(again.id).not.toBe(j.id);
	});

	it('69. missing CASH_CLEARING mapping → MISSING_ACCOUNTING_MAPPING (source, count)', async () => {
		const w = await paymentWorld({
			employees: 2,
			cashIndexes: [0],
			setup: { settlement: { CASH_CLEARING: null } }
		});
		for (const i of w.items) await payOk(w.batchId, i.id);
		const res = await createSettlement(w.batchId);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('MISSING_ACCOUNTING_MAPPING');
		expect(res.body.error.details.sourceType).toBe('CASH_CLEARING');
		expect(res.body.error.details.affectedCount).toBe(1);
	});

	it('70. settlement never changes payment items, batches or payroll', async () => {
		const w = await paymentWorld({ employees: 2 });
		for (const i of w.items) await payOk(w.batchId, i.id);
		const before = await payrollFingerprint(w.runId);
		const j = await settlementOk(w.batchId);
		await postedOk(j.id);
		expect(await payrollFingerprint(w.runId)).toBe(before);
	});

	it('71. a DRAFT settlement whose item was reversed fails validation (source changed)', async () => {
		const w = await paymentWorld({ employees: 1 });
		await payOk(w.batchId, w.items[0]!.id);
		const j = await settlementOk(w.batchId);
		expect((await reverse(w.batchId, w.items[0]!.id)).status).toBe(200);
		const v = await validateJ(j.id);
		expect(v.status).toBe(409);
		expect(v.body.error.code).toBe('ACCOUNTING_SOURCE_CHANGED');
	});

	it('72. settlement accounting date = the (Laos) paid date; source traceability to the batch', async () => {
		const w = await paymentWorld({ employees: 1 });
		await payOk(w.batchId, w.items[0]!.id);
		const j = await settlementOk(w.batchId);
		const paid = await prisma.payrollPaymentItem.findUniqueOrThrow({
			where: { id: w.items[0]!.id }
		});
		const laos = new Date(paid.paidAt!.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
		expect(j.accountingDate).toBe(laos);
		expect(j.source).toMatchObject({ kind: 'PAYMENT_BATCH', batchId: w.batchId, runId: w.runId });
	});
});

describe('reversal journal', () => {
	async function postedSettlementWorld(employees = 1) {
		const w = await paymentWorld({ employees });
		for (const i of w.items) await payOk(w.batchId, i.id);
		const s = await settlementOk(w.batchId);
		await postedOk(s.id);
		return { ...w, settlement: await journalOf(s.id) };
	}

	it('73. no POSTED settlement → nothing is created (ACCOUNTING_SETTLEMENT_NOT_POSTED)', async () => {
		const w = await paymentWorld({ employees: 1 });
		await payOk(w.batchId, w.items[0]!.id);
		expect((await reverse(w.batchId, w.items[0]!.id)).status).toBe(200);
		const rev = await reversalOf(w.items[0]!.id);
		const res = await createReversal(rev.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('ACCOUNTING_SETTLEMENT_NOT_POSTED');
		expect(await prisma.payrollJournal.count({ where: { sourceId: rev.id } })).toBe(0);
		expect((await status(w.batchId)).reversals[0]!.state).toBe('NOT_REQUIRED');
	});

	it('74. reversal swaps the original POSTED settlement lines exactly (same accounts, amounts, dims)', async () => {
		const w = await postedSettlementWorld(2);
		const item = w.items[0]!;
		expect((await reverse(w.batchId, item.id, { effectiveDate: today() })).status).toBe(200);
		const rev = await reversalOf(item.id);
		expect((await status(w.batchId)).reversalAccountingPendingCount).toBe(1);
		const res = await createReversal(rev.id);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const j = res.body.data as JournalView;
		const orig = w.settlement.lines.filter((l) => l.sourceId === item.id);
		expect(j.lines).toHaveLength(orig.length);
		j.lines.forEach((l, i) => {
			expect(l.accountId).toBe(orig[i]!.accountId);
			expect(l.accountCode).toBe(orig[i]!.accountCode);
			expect(l.debit).toBe(orig[i]!.credit);
			expect(l.credit).toBe(orig[i]!.debit);
			expect(l.employeeCode).toBe(orig[i]!.employeeCode);
		});
		expect(j).toMatchObject({
			journalType: 'PAYMENT_REVERSAL',
			sourceType: 'PAYMENT_REVERSAL',
			sourceId: rev.id,
			reversedJournalId: w.settlement.id,
			accountingDate: today()
		});
		expect(j.journalNumber.startsWith('PAYRV-')).toBe(true);
		expect((await status(w.batchId)).reversalAccountingPendingCount).toBe(0);
	}, 60_000);

	it('75. a mapping change BEFORE generation does not remap the reversal', async () => {
		const w = await postedSettlementWorld(1);
		const item = w.items[0]!;
		// point settlement mappings at other accounts (Bank → Cash, Payable → Other deductions)
		await mapOk(
			w.acct!.ruleSetId,
			'PAYMENT_SETTLEMENT',
			'BANK_CLEARING',
			{ credit: 'CASH' },
			w.acct!.ids
		);
		await mapOk(
			w.acct!.ruleSetId,
			'PAYMENT_SETTLEMENT',
			'PAYROLL_PAYABLE',
			{ debit: 'OTHER_DED' },
			w.acct!.ids
		);
		await reverse(w.batchId, item.id);
		const res = await createReversal((await reversalOf(item.id)).id);
		expect(res.status).toBe(201);
		const codes = (res.body.data as JournalView).lines.map((l) => l.accountCode).sort();
		expect(codes).toEqual([ACCOUNTS.BANK.code, ACCOUNTS.PAYABLE.code].sort());
	});

	it('76. one reversal journal per reversal: duplicate → 409; concurrent → exactly one', async () => {
		const w = await postedSettlementWorld(1);
		await reverse(w.batchId, w.items[0]!.id);
		const rev = await reversalOf(w.items[0]!.id);
		const res = await Promise.all([1, 2, 3].map(() => createReversal(rev.id)));
		expect(res.filter((r) => r.status === 201)).toHaveLength(1);
		for (const r of res.filter((x) => x.status !== 201)) {
			expect(r.body.error.code).toBe('PAYMENT_REVERSAL_JOURNAL_ALREADY_EXISTS');
		}
		expect(await prisma.payrollJournal.count({ where: { sourceId: rev.id } })).toBe(1);
	});

	it('77. the reversal journal validates + posts; the original settlement stays POSTED and unchanged', async () => {
		const w = await postedSettlementWorld(1);
		await reverse(w.batchId, w.items[0]!.id);
		const res = await createReversal((await reversalOf(w.items[0]!.id)).id);
		const posted = await postedOk(res.body.data.id);
		expect(posted.status).toBe('POSTED');
		const orig = await journalOf(w.settlement.id);
		expect(orig.status).toBe('POSTED');
		expect(orig.lines).toEqual(w.settlement.lines);
		expect((await journalOf(w.settlement.id)).status).toBe('POSTED');
	}, 60_000);

	it('78. detail of the original lists its reversal journals; reversal traces to the payment reversal', async () => {
		const w = await postedSettlementWorld(1);
		await reverse(w.batchId, w.items[0]!.id);
		const rev = await reversalOf(w.items[0]!.id);
		const r = (await createReversal(rev.id)).body.data as JournalView;
		const orig = (await get(`/payroll/accounting/journals/${w.settlement.id}`, ctx.admin)).body
			.data;
		expect(orig.reversalJournals.map((x: { id: string }) => x.id)).toEqual([r.id]);
		expect(r.source).toMatchObject({
			kind: 'PAYMENT_REVERSAL',
			reversalId: rev.id,
			batchId: w.batchId,
			paymentItemId: w.items[0]!.id
		});
	}, 60_000);

	it('79. unknown reversal → 404', async () => {
		const res = await createReversal(2147483647 as never);
		expect(res.status).toBe(404);
		const bad = await createReversal('nope');
		expect(bad.status).toBe(400);
		expect(bad.body.error.code).toBe('VALIDATION_ERROR');
	});

	it('80. batch accounting status tracks accounted / unaccounted / reversal-pending counts', async () => {
		const w = await postedSettlementWorld(2);
		let s = await status(w.batchId);
		expect(s).toMatchObject({
			paidCount: 2,
			accountedCount: 2,
			unaccountedPaidCount: 0,
			reversalAccountingPendingCount: 0,
			canCreateSettlement: false
		});
		await reverse(w.batchId, w.items[1]!.id);
		s = await status(w.batchId);
		expect(s.paidCount).toBe(1);
		expect(s.accountedCount).toBe(2);
		expect(s.reversalAccountingPendingCount).toBe(1);
		expect(s.reversals[0]!.state).toBe('PENDING');
	}, 60_000);
});
