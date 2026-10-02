import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import {
	approveOk,
	ctx,
	finalize,
	get,
	linkedUser,
	setupPhase13,
	submitOk,
	workflowWorld
} from './phase13Fixture.js';
import {
	accrualOk,
	createReversal,
	isolateFixtureNotifications,
	payOk,
	paymentWorld,
	postedOk,
	settlementOk
} from './phase16Fixture.js';
import { reverse } from './phase15Fixture.js';

/**
 * Numeric-ID migration M7 — payroll-side regression: payslip / payment self-service cannot be enumerated
 * with sequential ids, every journal source resolves through its explicit discriminator even where the
 * same integer exists in several tables, and pre-migration (canonical v1) approvals behave as documented.
 */
isolateFixtureNotifications();
beforeAll(async () => {
	await setupPhase13();
});

// ============================================================================================
describe('payslip / payment self-service: no sequential-id enumeration', () => {
	it("PR1. employee A cannot open B's payslip (JSON or PDF) by guessing its numeric id", async () => {
		const a = await linkedUser('EMPLOYEE');
		const b = await linkedUser('EMPLOYEE');
		const pw = await paymentWorld({
			employees: 2,
			userIds: [a.userId as never, b.userId as never]
		});
		const slips = await prisma.payslip.findMany({
			where: { payrollRunId: pw.runId },
			include: { employee: { select: { userId: true } } }
		});
		const mine = slips.find((s) => s.employee.userId === a.userId)!;
		const theirs = slips.find((s) => s.employee.userId === b.userId)!;
		expect(mine).toBeDefined();
		expect(theirs).toBeDefined();
		expect(Math.abs(mine.id - theirs.id)).toBe(1); // adjacent integers: the enumeration scenario

		expect((await get(`/payslips/me/${mine.id}`, a.cookie)).status).toBe(200);
		for (const url of [`/payslips/me/${theirs.id}`, `/payslips/me/${theirs.id}/pdf`]) {
			const res = await get(url, a.cookie);
			expect(res.status, url).toBe(404);
			expect(JSON.stringify(res.body ?? {})).not.toContain(theirs.payslipNumber);
		}
		// the HR route is not a side door
		expect((await get(`/payslips/${theirs.id}`, a.cookie)).status).toBe(403);
		expect((await get(`/payslips/${theirs.id}/pdf`, a.cookie)).status).toBe(403);

		// lists are own-only
		const list = await get('/payslips/me', a.cookie);
		expect(list.status).toBe(200);
		const ids = (list.body.data.items ?? list.body.data).map((s: { id: number }) => s.id);
		expect(ids).toContain(mine.id);
		expect(ids).not.toContain(theirs.id);
		const pays = await get('/payroll-payments/me', a.cookie);
		expect(pays.status).toBe(200);
		const theirItem = pw.items.find((i) => i.employeeId !== mine.employeeId)!;
		expect(JSON.stringify(pays.body)).not.toContain(theirItem.employeeCodeSnapshot);
	});
});

// ============================================================================================
describe('journal source discriminator: no table guessing', () => {
	it('PR2. every line / source / header resolves through its discriminator to exactly its own row, although the same integers exist in several tables', async () => {
		const pw = await paymentWorld({
			employees: 2,
			setup: { accrual: { NET_PAYABLE: { credit: 'PAYABLE', dim: 'EMPLOYEE' } } }
		});
		const accrual = await accrualOk(pw.runId);
		for (const i of pw.items) await payOk(pw.batchId, i.id);
		const st = await settlementOk(pw.batchId);
		await postedOk(st.id);
		expect((await reverse(pw.batchId, pw.items[0]!.id, { reason: 'returned' })).status).toBe(200);
		const reversal = await prisma.payrollPaymentReversal.findUniqueOrThrow({
			where: { paymentItemId: pw.items[0]!.id }
		});
		const rj = await createReversal(reversal.id as never);
		expect(rj.status, JSON.stringify(rj.body)).toBe(201);
		const journalIds = [accrual.id, st.id, rj.body.data.id as number];

		// Resolution below goes ONLY through (sourceEntity, sourceId). Whether equal integers happen to exist
		// in several source tables depends on hr_test's drifting AUTO_INCREMENT counters; the real colliding
		// data is proven on the rehearsal (M7_rehearsal_verify: "source_entity resolves source_id_new to the
		// SAME legacy row" = 0 over lines whose ids also exist as result ids).
		const lines = await prisma.payrollJournalLine.findMany({
			where: { journalId: { in: journalIds } }
		});
		const entities = new Set<string>();
		for (const l of lines) {
			expect(l.sourceEntity === null, `line ${l.id}`).toBe(l.sourceId === null);
			if (l.sourceId === null) continue;
			entities.add(l.sourceEntity!);
			switch (l.sourceEntity) {
				case 'PAYROLL_RUN':
					expect(l.sourceId).toBe(pw.runId);
					expect(l.employeeId).toBeNull();
					break;
				case 'PAYROLL_RESULT': {
					const r = await prisma.payrollEmployeeResult.findUniqueOrThrow({
						where: { id: l.sourceId }
					});
					expect(r.payrollRunId).toBe(pw.runId);
					expect(r.employeeId).toBe(l.employeeId);
					break;
				}
				case 'PAYMENT_ITEM': {
					const i = await prisma.payrollPaymentItem.findUniqueOrThrow({
						where: { id: l.sourceId }
					});
					expect(i.paymentBatchId).toBe(pw.batchId);
					expect(i.employeeId).toBe(l.employeeId ?? i.employeeId);
					break;
				}
				default:
					throw new Error(`unexpected sourceEntity ${l.sourceEntity}`);
			}
		}
		expect([...entities].sort()).toEqual(['PAYMENT_ITEM', 'PAYROLL_RESULT', 'PAYROLL_RUN']);

		// journal_sources: the type is part of the key, so equal integers of different types never clash
		const sources = await prisma.payrollJournalSource.findMany({
			where: { journalId: { in: journalIds } }
		});
		const prefix = {
			PAYROLL_RUN: 'ACCRUAL',
			PAYMENT_ITEM: 'SETTLEMENT',
			PAYMENT_REVERSAL: 'REVERSAL'
		};
		expect(new Set(sources.map((s) => s.sourceType))).toEqual(
			new Set(['PAYROLL_RUN', 'PAYMENT_ITEM', 'PAYMENT_REVERSAL'])
		);
		for (const s of sources) expect(s.activeKey).toBe(`${prefix[s.sourceType]}:${s.sourceId}`);

		// headers: the source type selects the table
		const headers = await prisma.payrollJournal.findMany({ where: { id: { in: journalIds } } });
		const want = {
			[accrual.id]: ['PAYROLL_RUN', pw.runId],
			[st.id]: ['PAYMENT_BATCH', pw.batchId]
		};
		want[rj.body.data.id] = ['PAYMENT_REVERSAL', reversal.id];
		for (const h of headers) expect([h.sourceType, h.sourceId]).toEqual(want[h.id]);

		// the API trace follows the same discriminator
		for (const id of journalIds) {
			const view = await get(`/payroll/accounting/journals/${id}`, ctx.admin);
			expect(view.status).toBe(200);
			for (const l of view.body.data.lines) {
				expect(typeof l.sourceId === 'number' || l.sourceId === null).toBe(true);
				expect(l.sourceEntity === null).toBe(l.sourceId === null);
			}
		}
	}, 60_000);
});

// ============================================================================================
describe('payroll approval: pre-migration (canonical v1) runs', () => {
	it('PR3. a FINALIZED v1 run is never re-hashed and stays fully usable (payslips, payment batch, accounting)', async () => {
		const pw = await paymentWorld({ employees: 1 });
		const v1Hash = 'b'.repeat(64);
		await prisma.payrollRun.update({
			where: { id: pw.runId },
			data: { approvalCanonicalVersion: null, approvalSnapshotHash: v1Hash }
		});
		const before = await prisma.payrollRun.findUniqueOrThrow({ where: { id: pw.runId } });
		// reads and downstream operations on the finalized run
		expect((await get(`/payroll/runs/${pw.runId}`, ctx.admin)).status).toBe(200);
		await payOk(pw.batchId, pw.items[0]!.id);
		await accrualOk(pw.runId);
		await settlementOk(pw.batchId);
		const after = await prisma.payrollRun.findUniqueOrThrow({ where: { id: pw.runId } });
		expect(after.status).toBe('FINALIZED');
		expect(after.approvalSnapshotHash).toBe(v1Hash);
		expect(after.approvalCanonicalVersion).toBeNull();
		expect(after.approvalSnapshotJson).toEqual(before.approvalSnapshotJson);
	}, 60_000);

	it('PR4. an IN-FLIGHT v1 submission (still PENDING) can be approved but is OUTDATED at finalize — never silently stale', async () => {
		// calculated + submitted = PENDING; then age the pending submission to what a pre-migration one left
		const base = await workflowWorld();
		await submitOk(base.run.id);
		expect(
			(await prisma.payrollRun.findUniqueOrThrow({ where: { id: base.run.id } })).approvalState
		).toBe('PENDING');
		const v1Hash = 'c'.repeat(64);
		await prisma.payrollRun.update({
			where: { id: base.run.id },
			data: { approvalCanonicalVersion: null, approvalSnapshotHash: v1Hash }
		});
		await approveOk(base.run.id);
		const fin = await finalize(base.run.id);
		expect(fin.status).toBe(409);
		expect(fin.body.error.code).toBe('PAYROLL_APPROVAL_CANONICAL_OUTDATED');
		const kept = await prisma.payrollRun.findUniqueOrThrow({ where: { id: base.run.id } });
		expect(kept.status).toBe('CALCULATED');
		expect(kept.approvalSnapshotHash).toBe(v1Hash);
	});
});
