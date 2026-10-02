import { beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import {
	CANONICAL_VERSION,
	canonicalFromStored,
	hashCanonical,
	type StoredResult
} from '../src/services/payrollApprovalSnapshot.js';
import {
	approvedWorld,
	calc,
	finalize,
	linkedUser,
	reopen,
	runOf,
	setupPhase13,
	submitOk,
	approveOk,
	ctx as ctx13
} from './phase13Fixture.js';
import {
	accrualOk,
	createAccrual,
	createReversal,
	createSettlement,
	isolateFixtureNotifications,
	payOk,
	paymentWorld,
	payrollWorld,
	postedOk,
	settlementOk,
	journalOf
} from './phase16Fixture.js';
import { batch15, confirmFailed, exported15, retry, retryOk, reverse } from './phase15Fixture.js';

/**
 * Numeric-ID migration M6 — payroll approval canonicalVersion, the journal-line source discriminator,
 * accounting / retry duplicate protection and payroll / payment notification links.
 */
isolateFixtureNotifications();
beforeAll(async () => {
	await setupPhase13();
});
const CUID_LIKE = /c[a-z0-9]{24}/;

// ============================================================================================
describe('payroll approval canonicalVersion', () => {
	it('P1. submission stores canonical version 2 with the hash; finalize accepts it', async () => {
		const w = await approvedWorld();
		const row = await prisma.payrollRun.findUniqueOrThrow({ where: { id: w.run.id } });
		expect(row.approvalCanonicalVersion).toBe(CANONICAL_VERSION);
		expect(row.approvalSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
		const fin = await finalize(w.run.id);
		expect(fin.status, JSON.stringify(fin.body)).toBe(200);
		// a FINALIZED run is never re-hashed: the stored hash is byte-for-byte what was approved
		const after = await prisma.payrollRun.findUniqueOrThrow({ where: { id: w.run.id } });
		expect(after.approvalSnapshotHash).toBe(row.approvalSnapshotHash);
		expect(after.approvalCanonicalVersion).toBe(CANONICAL_VERSION);
	});

	it('P2. a pre-migration (v1) approval is explicitly OUTDATED at finalize — hash untouched — and re-approval works', async () => {
		const w = await approvedWorld();
		const v1Hash = 'a'.repeat(64); // what a pre-migration (CUID-canonical) approval left behind
		await prisma.payrollRun.update({
			where: { id: w.run.id },
			data: { approvalCanonicalVersion: null, approvalSnapshotHash: v1Hash }
		});
		const fin = await finalize(w.run.id);
		expect(fin.status).toBe(409);
		expect(fin.body.error.code).toBe('PAYROLL_APPROVAL_CANONICAL_OUTDATED');
		expect(fin.body.error.details).toMatchObject({
			approvalCanonicalVersion: 1,
			requiredCanonicalVersion: 2
		});
		const kept = await prisma.payrollRun.findUniqueOrThrow({ where: { id: w.run.id } });
		expect(kept.approvalSnapshotHash).toBe(v1Hash);
		expect(kept.status).toBe('CALCULATED');

		// the documented way out: reopen → recalculate → submit → approve → finalize (hashed with v2)
		expect((await reopen(w.run.id)).status).toBe(200);
		await calc(w.run.id);
		await submitOk(w.run.id);
		await approveOk(w.run.id);
		const ok = await finalize(w.run.id);
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const done = await prisma.payrollRun.findUniqueOrThrow({ where: { id: w.run.id } });
		expect(done.approvalCanonicalVersion).toBe(CANONICAL_VERSION);
		expect(done.approvalSnapshotHash).not.toBe(v1Hash);
	});

	it('P3. canonical form: version is hashed, employees are ordered numerically (9 before 10), hash is deterministic', () => {
		const emp = (employeeId: number) =>
			({
				employeeId,
				employeeCodeSnapshot: `E${employeeId}`,
				calculationStatus: 'READY',
				issuesJson: null,
				currencyCode: 'LAK',
				baseSalarySnapshot: new Prisma.Decimal(1),
				monthlyBaseSalarySnapshot: null,
				cycleAllocationFactorSnapshot: null,
				totalEarnings: new Prisma.Decimal(1),
				totalDeductions: new Prisma.Decimal(0),
				netPay: new Prisma.Decimal(1),
				employerContributionTotal: null,
				items: [],
				segments: [],
				statutoryResult: null
			}) as unknown as StoredResult;
		const run = {
			runId: 3,
			periodId: 4,
			payrollMonth: null,
			cycleNumber: null,
			calculationVersion: 2,
			payrollRuleSetId: null,
			payrollRuleVersion: null
		};
		const c = canonicalFromStored(run, [emp(10), emp(9), emp(100)]);
		expect(c.canonicalVersion).toBe(2);
		expect(c.employees.map((e) => e.employeeId)).toEqual([9, 10, 100]);
		expect(hashCanonical(c)).toBe(
			hashCanonical(canonicalFromStored(run, [emp(100), emp(9), emp(10)]))
		);
		expect(hashCanonical(c)).not.toBe(hashCanonical({ ...c, canonicalVersion: 3 as never }));
	});
});

// ============================================================================================
describe('journal line source discriminator (numeric ids collide across tables)', () => {
	it('P4. accrual: EMPLOYEE-grouped lines → PAYROLL_RESULT + the result id; other lines → PAYROLL_RUN + the run id', async () => {
		const w = await payrollWorld({
			setup: { accrual: { NET_PAYABLE: { credit: 'PAYABLE', dim: 'EMPLOYEE' } } }
		});
		const j = await accrualOk(w.runId);
		const lines = await prisma.payrollJournalLine.findMany({
			where: { journalId: j.id },
			orderBy: { lineNo: 'asc' }
		});
		const results = await prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: w.runId }
		});
		const resultOf = new Map(results.map((r) => [r.employeeId, r.id]));
		const employeeLines = lines.filter((l) => l.employeeId !== null);
		expect(employeeLines.length).toBe(w.emps.length);
		for (const l of employeeLines) {
			expect(l.sourceEntity).toBe('PAYROLL_RESULT');
			expect(l.sourceId).toBe(resultOf.get(l.employeeId!));
		}
		for (const l of lines.filter((x) => x.employeeId === null)) {
			expect(l.sourceEntity).toBe('PAYROLL_RUN');
			expect(l.sourceId).toBe(w.runId);
		}
		// the API exposes the discriminator next to the id
		const view = await journalOf(j.id);
		for (const l of view.lines as unknown as {
			sourceEntity: string | null;
			sourceId: number | null;
		}[]) {
			expect(l.sourceEntity === null).toBe(l.sourceId === null);
		}
		// the source key uses the numeric run id and a second accrual is refused
		const src = await prisma.payrollJournalSource.findFirstOrThrow({ where: { journalId: j.id } });
		expect(src.activeKey).toBe(`ACCRUAL:${w.runId}`);
		const dup = await createAccrual(w.runId);
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('PAYROLL_ACCRUAL_JOURNAL_ALREADY_EXISTS');
	});

	it("P5. settlement → PAYMENT_ITEM lines; a reversal copies ONLY that item's PAYMENT_ITEM lines", async () => {
		const w = await paymentWorld({ employees: 2 });
		for (const i of w.items) await payOk(w.batchId, i.id);
		const st = await settlementOk(w.batchId);
		const lines = await prisma.payrollJournalLine.findMany({ where: { journalId: st.id } });
		expect(lines.length).toBeGreaterThan(0);
		for (const l of lines) {
			expect(l.sourceEntity).toBe('PAYMENT_ITEM');
			expect(w.items.map((i) => i.id)).toContain(l.sourceId);
		}
		const sources = await prisma.payrollJournalSource.findMany({ where: { journalId: st.id } });
		for (const s of sources) expect(s.activeKey).toBe(`SETTLEMENT:${s.sourceId}`);
		expect((await createSettlement(w.batchId)).status).toBe(409);

		await postedOk(st.id);
		const item = w.items[0]!;
		const rev = await reverse(w.batchId, item.id, { reason: 'returned' });
		expect(rev.status, JSON.stringify(rev.body)).toBe(200);
		const reversalId = (
			await prisma.payrollPaymentReversal.findUniqueOrThrow({ where: { paymentItemId: item.id } })
		).id;
		const rj = await createReversal(reversalId as never);
		expect(rj.status, JSON.stringify(rj.body)).toBe(201);
		const rLines = await prisma.payrollJournalLine.findMany({
			where: { journalId: rj.body.data.id }
		});
		const originals = lines.filter((l) => l.sourceId === item.id);
		expect(rLines.length).toBe(originals.length);
		for (const l of rLines) {
			expect(l.sourceEntity).toBe('PAYMENT_ITEM');
			expect(l.sourceId).toBe(item.id);
		}
		expect(
			(
				await prisma.payrollJournalSource.findFirstOrThrow({
					where: { journalId: rj.body.data.id }
				})
			).activeKey
		).toBe(`REVERSAL:${reversalId}`);
	});

	it('P6. invariant on every journal line: sourceEntity is set exactly when sourceId is', async () => {
		const bad = await prisma.payrollJournalLine.count({
			where: {
				OR: [
					{ sourceId: null, NOT: { sourceEntity: null } },
					{ sourceEntity: null, NOT: { sourceId: null } }
				]
			}
		});
		expect(bad).toBe(0);
	});
});

// ============================================================================================
describe('payment retry lock (double-pay backstop) with numeric ids', () => {
	it('P7. retrySourceLockId = the numeric source item id; a second retry of the same source is refused', async () => {
		const w = await exported15({ employees: 1 });
		const src = w.batch.items[0]!;
		expect((await confirmFailed(w.batch.id, src.id)).status).toBe(200);
		const r = await retryOk(w.batch.id, [src.id]);
		const child = await prisma.payrollPaymentItem.findFirstOrThrow({
			where: { paymentBatchId: r.id }
		});
		expect(child.sourcePaymentItemId).toBe(src.id);
		expect(child.retrySourceLockId).toBe(src.id);
		expect(typeof child.retrySourceLockId).toBe('number');
		// the retry is still active, so (as in paymentRetry test 84) the lock reports IN_PROGRESS
		const again = await retry(w.batch.id, [src.id]);
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('PAYMENT_RETRY_IN_PROGRESS');
		expect((await batch15(r.id)).items.length).toBe(1);
	});
});

// ============================================================================================
describe('payroll / payslip / payment notification links are numeric', () => {
	it('P8a. payroll-run approval notifications', async () => {
		const w = await approvedWorld();
		const runLinks = await prisma.notification.findMany({
			where: { userId: ctx13.approver.userId, link: { startsWith: '/app/payroll/runs/' } }
		});
		expect(runLinks.map((n) => n.link)).toContain(`/app/payroll/runs/${w.run.id}`);
		for (const n of await prisma.notification.findMany({
			where: { userId: ctx13.approver.userId as never }
		}))
			expect(JSON.stringify([n.link, n.dedupeKey, n.metadataJson])).not.toMatch(CUID_LIKE);
		expect((await runOf(w.run.id)).id).toBe(w.run.id);
	});

	it('P8b. payslip and payment notifications', async () => {
		const u = await linkedUser('EMPLOYEE');
		const pw = await paymentWorld({ employees: 1, userIds: [u.userId as never] });
		const payslip = await prisma.payslip.findFirstOrThrow({ where: { payrollRunId: pw.runId } });
		const slip = await prisma.notification.findFirstOrThrow({
			where: { userId: u.userId as never, type: 'PAYSLIP_ISSUED' }
		});
		expect(slip.link).toBe(`/app/my-payslips/${payslip.id}`);
		expect(slip.dedupeKey).toBe(`payslip:${payslip.id}:issued`);

		await payOk(pw.batchId, pw.items[0]!.id);
		const paid = await prisma.notification.findFirstOrThrow({
			where: { userId: u.userId as never, type: 'PAYROLL_PAYMENT_PAID' }
		});
		expect(paid.link).toBe('/app/my-payments');
		expect(paid.dedupeKey).toBe(`payroll-payment:${pw.items[0]!.id}:paid`);

		for (const n of await prisma.notification.findMany({
			where: { userId: u.userId as never }
		}))
			expect(JSON.stringify([n.link, n.dedupeKey, n.metadataJson])).not.toMatch(CUID_LIKE);
	});
});
