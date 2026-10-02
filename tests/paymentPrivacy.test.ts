import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { linkedUser, moneyNeedles, profile, setupPhase13 } from './phase13Fixture.js';
import { createTestUser, loginAndGetCookie } from './helpers.js';
import {
	ACCT,
	batchOf,
	confirm,
	ctx,
	exportFile,
	exportedWorld,
	get,
	setBank
} from './phase14Fixture.js';

/**
 * PHASE 14 — employee payment self-service + privacy (spec tests 67–80): own history only, masked
 * accounts, amount-free notifications / audit, payroll + payslips untouched, and a GLOBAL scan proving
 * the full account number exists nowhere except inside an authorized export file.
 */
beforeAll(async () => {
	await setupPhase13();
});

/** exported world whose two employees are linked to EMPLOYEE users */
async function selfWorld() {
	const a = await linkedUser('EMPLOYEE');
	const b = await linkedUser('EMPLOYEE');
	const w = await exportedWorld({ employees: 2, userIds: [a.userId, b.userId] });
	return { ...w, a, b };
}

describe('employee self-service', () => {
	it('67 + 71 + 72. own history only; masked account; no full number, no amount, no batch totals', async () => {
		const w = await selfWorld();
		const [itemA, itemB] = [
			w.batch.items.find((i) => i.employeeId === w.emps[0]!.id)!,
			w.batch.items.find((i) => i.employeeId === w.emps[1]!.id)!
		];
		await confirm(w.batch.id, itemA.id, { status: 'PAID', paymentReference: 'QA-REF-001' });
		const res = await get('/payroll-payments/me', w.a.cookie);
		expect(res.status).toBe(200);
		expect(res.body.data.linkedEmployee).toBe(true);
		expect(res.body.data.items).toHaveLength(1);
		const mine = res.body.data.items[0];
		expect(mine).toMatchObject({
			id: itemA.id,
			status: 'PAID',
			paymentMethod: 'BANK_TRANSFER',
			accountNumberMasked: '••••7890',
			paymentReference: 'QA-REF-001',
			currencyCode: 'LAK'
		});
		expect(mine.paidAt).not.toBeNull();
		expect(mine.periodName).toBeTruthy();
		const text = JSON.stringify(res.body);
		expect(text).not.toContain(ACCT);
		expect(text).not.toContain(itemB.id);
		expect(text).not.toContain(w.batch.id);
		for (const k of ['amount', 'netPay', 'totalAmount', 'employeeCount'])
			expect(text).not.toContain(`"${k}"`);
		// B still sees its own (exported, not yet paid) item — and only that
		const other = await get('/payroll-payments/me', w.b.cookie);
		expect(other.body.data.items.map((i: { id: string }) => i.id)).toEqual([itemB.id]);
		expect(other.body.data.items[0].status).toBe('EXPORTED');
		expect(other.body.data.items[0].paymentReference).toBeNull();
	});

	it("68. another employee's batch / items are inaccessible (admin endpoints 403, no id parameter exists)", async () => {
		const w = await selfWorld();
		expect((await get(`/payroll/payment-batches/${w.batch.id}`, w.a.cookie)).status).toBe(403);
		expect((await get('/payroll/payment-batches', w.a.cookie)).status).toBe(403);
		expect((await get(`/employees/${w.emps[1]!.id}/payment-profile`, w.a.cookie)).status).toBe(403);
		// the self endpoint ignores any client-supplied employee id
		const spoof = await get(`/payroll-payments/me?employeeId=${w.emps[1]!.id}`, w.a.cookie);
		expect(
			spoof.body.data.items.every(
				(i: { id: string }) =>
					w.batch.items.find((x) => x.id === i.id)!.employeeId === w.emps[0]!.id
			)
		).toBe(true);
	});

	it('69. MANAGER has no access to subordinate payments (no permission, no manager tree)', async () => {
		const w = await selfWorld();
		const mgr = await linkedUser('MANAGER');
		const mgrEmployee = await prisma.employee.create({
			data: {
				employeeCode: `MGR_${Date.now()}`,
				firstNameLao: 'ຫົວໜ້າ',
				lastNameLao: 'ທົດສອບ',
				startDate: new Date('2024-01-01'),
				companyId: w.companyId,
				userId: mgr.userId
			}
		});
		await prisma.employee.update({
			where: { id: w.emps[0]!.id },
			data: { managerEmployeeId: mgrEmployee.id }
		});
		for (const path of [
			`/payroll/payment-batches/${w.batch.id}`,
			'/payroll/payment-batches',
			`/payroll/runs/${w.runId}/payment-batch`,
			`/employees/${w.emps[0]!.id}/payment-profile`,
			'/payroll-payments/me'
		]) {
			const r = await get(path, mgr.cookie);
			expect(r.status, path).toBe(403);
			expect(JSON.stringify(r.body)).not.toContain('7890');
		}
	});

	it('70. a user with no linked employee gets a safe empty answer', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);
		const res = await get('/payroll-payments/me', cookie);
		expect(res.status).toBe(200);
		expect(res.body.data).toEqual({ linkedEmployee: false, items: [] });
	});

	it('DRAFT / VALIDATED / CANCELLED batches are not shown to employees', async () => {
		const a = await linkedUser('EMPLOYEE');
		const { validatedWorld } = await import('./phase14Fixture.js');
		await validatedWorld({ userIds: [a.userId] });
		expect((await get('/payroll-payments/me', a.cookie)).body.data.items).toEqual([]);
	});
});

const PAID = 'PAYROLL_PAYMENT_PAID';

describe('notifications + audit', () => {
	it('73-74. PAID notification: period only (no amount, no account), deduped; none for export / FAILED', async () => {
		const w = await selfWorld();
		const [itemA, itemB] = [
			w.batch.items.find((i) => i.employeeId === w.emps[0]!.id)!,
			w.batch.items.find((i) => i.employeeId === w.emps[1]!.id)!
		];
		// export alone notified nobody
		expect(
			await prisma.notification.count({
				where: { userId: { in: [w.a.userId, w.b.userId] }, type: PAID }
			})
		).toBe(0);
		await confirm(w.batch.id, itemA.id, { status: 'PAID', paymentReference: 'R-A' });
		await confirm(w.batch.id, itemB.id, {
			status: 'FAILED',
			failureCode: 'X',
			failureReason: 'bounced'
		});
		const notes = await prisma.notification.findMany({ where: { userId: w.a.userId, type: PAID } });
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatchObject({
			type: 'PAYROLL_PAYMENT_PAID',
			link: '/app/my-payments',
			dedupeKey: `payroll-payment:${itemA.id}:paid`
		});
		expect(notes[0]!.titleLao).toMatch(/ໄດ້ຖືກບັນທຶກວ່າຈ່າຍແລ້ວ/);
		const text = JSON.stringify(notes);
		for (const needle of [ACCT, '7890', ...moneyNeedles(itemA.amount!)])
			expect(text).not.toContain(needle);
		expect(await prisma.notification.count({ where: { userId: w.b.userId, type: PAID } })).toBe(0);
		// a later FAILED→PAID of B notifies B exactly once; retries never duplicate A
		await confirm(w.batch.id, itemB.id, { status: 'PAID' });
		await confirm(w.batch.id, itemB.id, { status: 'PAID' }); // 409, no side effect
		expect(await prisma.notification.count({ where: { userId: w.b.userId, type: PAID } })).toBe(1);
		expect(await prisma.notification.count({ where: { userId: w.a.userId, type: PAID } })).toBe(1);
		// the notification is visible through the owner's API only (payslip notices from finalize are separate)
		const api = await get('/notifications', w.a.cookie);
		expect(api.body.data.items.map((n: { type: string }) => n.type)).toContain(PAID);
		expect(JSON.stringify(api.body)).not.toContain(ACCT);
	});

	it('75-76. payment audit contains no amount and no full account number', async () => {
		const w = await selfWorld();
		for (const item of w.batch.items) {
			await confirm(w.batch.id, item.id, {
				status: 'PAID',
				paymentReference: `R-${String(item.id).padStart(4, '0')}`
			});
		}
		expect((await batchOf(w.batch.id)).status).toBe('PAID');
		const events = await prisma.auditEvent.findMany({
			where: {
				action: { startsWith: 'PAYROLL_PAYMENT.' },
				OR: [
					{ entityId: String(w.batch.id) },
					{ entityId: { in: w.batch.items.map((i) => String(i.id)) } }
				]
			}
		});
		expect(events.map((e) => e.action).sort()).toEqual([
			'PAYROLL_PAYMENT.BATCH_CREATED',
			'PAYROLL_PAYMENT.BATCH_VALIDATED',
			'PAYROLL_PAYMENT.EXPORTED',
			'PAYROLL_PAYMENT.ITEM_PAID',
			'PAYROLL_PAYMENT.ITEM_PAID'
		]);
		const text = JSON.stringify(events);
		expect(text).not.toContain(ACCT);
		for (const item of w.batch.items) {
			for (const needle of moneyNeedles(item.amount!)) expect(text).not.toContain(needle);
		}
		for (const k of ['"amount"', '"netPay"', '"salary"', '"totalAmount"'])
			expect(text).not.toContain(k);
		const paid = events.find((e) => e.action === 'PAYROLL_PAYMENT.ITEM_PAID')!;
		expect(paid.metadataJson).toMatchObject({
			batchId: w.batch.id,
			bankCode: 'QABANK',
			last4: '7890',
			status: 'PAID'
		});
	});
});

describe('payroll immutability + global privacy', () => {
	it('77-78. the whole payment lifecycle leaves payroll results, items, statutory rows and payslips unchanged', async () => {
		const a = await linkedUser('EMPLOYEE');
		const { finalizedWorld, batchOk, validateOk, exportProfile } =
			await import('./phase14Fixture.js');
		const w = await finalizedWorld({ userIds: [a.userId] });
		await setBank(w.emps[0]!.id);
		const snapshot = async () => ({
			run: await prisma.payrollRun.findUniqueOrThrow({ where: { id: w.runId } }),
			results: await prisma.payrollEmployeeResult.findMany({
				where: { payrollRunId: w.runId },
				include: { items: true, segments: true, statutoryResult: true }
			}),
			payslips: await prisma.payslip.findMany({ where: { payrollRunId: w.runId } })
		});
		const before = await snapshot();
		const batch = await batchOk(w.runId);
		await validateOk(batch.id);
		const profile = await exportProfile(w.companyId);
		await exportFile(batch.id, profile.id);
		await confirm(batch.id, batch.items[0]!.id, { status: 'PAID', paymentReference: 'R' });
		const after = await snapshot();
		expect(after).toEqual(before);
		// the payslip carries no payment status
		const slip = await get('/payslips/me', a.cookie);
		expect(JSON.stringify(slip.body)).not.toMatch(/PAID|paymentReference|7890/);
	});

	it('79-80. GLOBAL scan: the full account number (and TIN / SSN) appear nowhere except the export file', async () => {
		const empUser = await linkedUser('EMPLOYEE');
		const w = await exportedWorld({ employees: 1, userIds: [empUser.userId] });
		const emp = w.emps[0]!;
		await profile(emp.id, { tin: 'TIN-P14-SECRET', socialSecurityNumber: 'SSN-P14-SECRET' });
		const item = w.batch.items[0]!;
		await confirm(w.batch.id, item.id, { status: 'PAID', paymentReference: 'QA-REF-GLOBAL' });
		// the ONLY place the number may appear: the authorized export bytes
		const file = await exportFile(w.batch.id, w.profile.id);
		expect(file.bytes.toString('utf8')).toContain(ACCT);

		const adminPaths = [
			`/employees/${emp.id}`,
			'/employees?pageSize=100',
			'/employees/lookup',
			`/employees/${emp.id}/assignment-history`,
			`/employees/${emp.id}/payment-profile`,
			'/organization/companies',
			`/organization/companies/${w.companyId}`,
			'/attendance?pageSize=100',
			'/attendance/daily',
			'/leave/requests',
			'/overtime/requests',
			'/approvals/inbox',
			'/approvals/history',
			`/payroll/runs/${w.runId}`,
			`/payroll/runs/${w.runId}/results`,
			`/payroll/runs/${w.runId}/payslips`,
			`/payroll/payment-batches/${w.batch.id}`,
			'/payroll/payment-batches',
			`/payroll/runs/${w.runId}/payment-batch`,
			`/payroll/payment-batches/${w.batch.id}/export-preview?bankExportProfileId=${w.profile.id}`,
			'/audit-events?pageSize=100',
			'/notifications'
		];
		const payslips = await prisma.payslip.findMany({ where: { employeeId: emp.id } });
		for (const p of payslips) adminPaths.push(`/payslips/${p.id}`);
		const audits = await prisma.auditEvent.findMany({
			where: { OR: [{ employeeId: emp.id }, { entityId: String(w.batch.id) }] },
			select: { id: true }
		});
		for (const a of audits) adminPaths.push(`/audit-events/${a.id}`);
		for (const path of adminPaths) {
			const r = await get(path, ctx.admin);
			expect(JSON.stringify(r.body), path).not.toContain(ACCT);
		}
		for (const path of [
			'/payroll-payments/me',
			'/payslips/me',
			'/notifications',
			...payslips.map((p) => `/payslips/me/${p.id}`)
		]) {
			const r = await get(path, empUser.cookie);
			expect(r.status, path).toBe(200);
			const text = JSON.stringify(r.body);
			expect(text, path).not.toContain(ACCT);
			expect(text, path).not.toContain('TIN-P14-SECRET');
			expect(text, path).not.toContain('SSN-P14-SECRET');
		}
		// TIN / SSN stay on the statutory profile only — never in payment data
		const batchText = JSON.stringify(
			(await get(`/payroll/payment-batches/${w.batch.id}`, ctx.admin)).body
		);
		expect(batchText).not.toContain('TIN-P14-SECRET');
		expect(file.bytes.toString('utf8')).not.toContain('TIN-P14-SECRET');
		// database-level: no notification / audit row holds the number
		const dbHits = await prisma.$queryRawUnsafe<unknown[]>(
			`SELECT 'audit' src, id FROM audit_events WHERE CAST(metadata_json AS CHAR) LIKE ? OR CAST(changes_json AS CHAR) LIKE ?
			 UNION ALL SELECT 'notification', id FROM notifications WHERE title_lao LIKE ? OR body_lao LIKE ? OR CAST(metadata_json AS CHAR) LIKE ?
			 UNION ALL SELECT 'payslip', id FROM payslips WHERE CAST(snapshot_json AS CHAR) LIKE ?`,
			...Array(6).fill(`%${ACCT}%`)
		);
		expect(dbHits).toEqual([]);
	});
});
