import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { createTestUser, loginAndGetCookie, userWithPermissions } from './helpers.js';
import { setupPhase13 } from './phase13Fixture.js';
import {
	accrualOk,
	cancelJ,
	ctx,
	get,
	journalOf,
	mapOk,
	patch,
	post,
	postedOk,
	postJ,
	payrollWorld,
	validateJ
} from './phase16Fixture.js';
import { isolateFixtureNotifications } from './phase16Fixture.js';

/** Phase 16 — journal validate / post / cancel, immutability, read models (tests 45-60). */
isolateFixtureNotifications();
beforeAll(async () => {
	await setupPhase13();
});

async function hrAdminCookie() {
	const { username, password } = await createTestUser({ roleCode: 'HR_ADMIN' });
	return loginAndGetCookie(username, password);
}

describe('validate', () => {
	it('45. DRAFT → VALIDATED, audited; validating twice → 409', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		const v = await validateJ(j.id);
		expect(v.status, JSON.stringify(v.body)).toBe(200);
		expect(v.body.data.status).toBe('VALIDATED');
		expect(v.body.data.validatedAt).toBeTruthy();
		const again = await validateJ(j.id);
		expect(again.status).toBe(409);
		expect(
			await prisma.auditEvent.count({
				where: { entityId: String(j.id), action: 'PAYROLL_ACCOUNTING.JOURNAL_VALIDATED' }
			})
		).toBe(1);
	});

	it('46. an account deactivated after creation → ACCOUNTING_ACCOUNT_INACTIVE; journal stays DRAFT', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		await patch(`/payroll/accounting/gl-accounts/${w.acct!.ids.SSO}`, ctx.admin, {
			status: 'INACTIVE'
		});
		const v = await validateJ(j.id);
		expect(v.status).toBe(409);
		expect(v.body.error.code).toBe('ACCOUNTING_ACCOUNT_INACTIVE');
		expect((await journalOf(j.id)).status).toBe('DRAFT');
	});

	it('47. a mapping deactivated after creation → MISSING_ACCOUNTING_MAPPING (Lao message)', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		await mapOk(
			w.acct!.ruleSetId,
			'PAYROLL_ACCRUAL',
			'EMPLOYEE_SSO',
			{ credit: 'SSO' },
			w.acct!.ids
		);
		await prisma.payrollAccountingMapping.updateMany({
			where: { ruleSetId: w.acct!.ruleSetId, sourceType: 'EMPLOYEE_SSO' },
			data: { status: 'INACTIVE' }
		});
		const v = await validateJ(j.id);
		expect(v.status).toBe(409);
		expect(v.body.error.code).toBe('MISSING_ACCOUNTING_MAPPING');
		expect(v.body.error.message).toContain('ຍັງບໍ່ໄດ້ຕັ້ງຄ່າບັນຊີສຳລັບ');
		expect(v.body.error.details.sourceType).toBe('EMPLOYEE_SSO');
	});

	it('48. a mapping pointed at another account after creation → ACCOUNTING_MAPPING_CHANGED', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		await mapOk(
			w.acct!.ruleSetId,
			'PAYROLL_ACCRUAL',
			'NET_PAYABLE',
			{ credit: 'OTHER_DED' },
			w.acct!.ids
		);
		const v = await validateJ(j.id);
		expect(v.status).toBe(409);
		expect(v.body.error.code).toBe('ACCOUNTING_MAPPING_CHANGED');
	});

	it('49. tampered (unbalanced) lines → ACCOUNTING_JOURNAL_UNBALANCED', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		const line = await prisma.payrollJournalLine.findFirstOrThrow({
			where: { journalId: j.id, debit: { gt: 0 } }
		});
		await prisma.payrollJournalLine.update({
			where: { id: line.id },
			data: { debit: line.debit.plus(1) }
		});
		const v = await validateJ(j.id);
		expect(v.status).toBe(409);
		expect(v.body.error.code).toBe('ACCOUNTING_JOURNAL_UNBALANCED');
	});
});

describe('post', () => {
	it('50. post requires VALIDATED → 409 ACCOUNTING_JOURNAL_NOT_VALIDATED for DRAFT', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		const p = await postJ(j.id);
		expect(p.status).toBe(409);
		expect(p.body.error.code).toBe('ACCOUNTING_JOURNAL_NOT_VALIDATED');
	});

	it('51. VALIDATED → POSTED with poster + timestamp; alreadyPosted=false', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		const posted = await postedOk(j.id);
		expect(posted.status).toBe('POSTED');
		expect(posted.alreadyPosted).toBe(false);
		const row = await prisma.payrollJournal.findUniqueOrThrow({ where: { id: j.id } });
		expect(row.postedByUserId).toBe(ctx.adminUserId);
		expect(row.postedAt).toBeTruthy();
	});

	it('52. concurrent posts are idempotent: one POSTED transition, one audit event', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		expect((await validateJ(j.id)).status).toBe(200);
		const res = await Promise.all([1, 2, 3, 4].map(() => postJ(j.id)));
		expect(res.every((r) => r.status === 200)).toBe(true);
		expect(res.filter((r) => r.body.data.alreadyPosted === false)).toHaveLength(1);
		expect(
			await prisma.auditEvent.count({
				where: { entityId: String(j.id), action: 'PAYROLL_ACCOUNTING.JOURNAL_POSTED' }
			})
		).toBe(1);
	});

	it('53. POSTED is immutable: cancel / validate → 409 ACCOUNTING_JOURNAL_POSTED_IMMUTABLE', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		await postedOk(j.id);
		for (const r of [await cancelJ(j.id), await validateJ(j.id)]) {
			expect(r.status).toBe(409);
			expect(r.body.error.code).toBe('ACCOUNTING_JOURNAL_POSTED_IMMUTABLE');
		}
		// the run can not get a second accrual while the posted one lives
		const dup = await post(`/payroll/runs/${w.runId}/accounting-journal`, ctx.admin);
		expect(dup.body.error.code).toBe('PAYROLL_ACCRUAL_JOURNAL_ALREADY_EXISTS');
		expect((await journalOf(j.id)).status).toBe('POSTED');
	});

	it('54. HR_ADMIN can create / validate but NOT post (payroll.accounting.post = SUPER_ADMIN)', async () => {
		const hr = await hrAdminCookie();
		const w = await payrollWorld();
		const c = await post(`/payroll/runs/${w.runId}/accounting-journal`, hr);
		expect(c.status, JSON.stringify(c.body)).toBe(201);
		expect((await validateJ(c.body.data.id, hr)).status).toBe(200);
		const p = await postJ(c.body.data.id, hr);
		expect(p.status).toBe(403);
		expect((await journalOf(c.body.data.id)).status).toBe('VALIDATED');
	});

	it('55. post permission alone (with view_all) can post; manage without post cannot', async () => {
		const poster = await userWithPermissions(['payroll.accounting.post', 'employees.view_all']);
		const manager = await userWithPermissions(['payroll.accounting.manage', 'employees.view_all']);
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		expect((await validateJ(j.id, manager.cookie)).status).toBe(200);
		expect((await postJ(j.id, manager.cookie)).status).toBe(403);
		expect((await postJ(j.id, poster.cookie)).status).toBe(200);
	});
});

describe('cancel', () => {
	it('56. cancel DRAFT and VALIDATED (kept, audited); cancelling twice → 409', async () => {
		const w1 = await payrollWorld();
		const d = await accrualOk(w1.runId);
		expect((await cancelJ(d.id)).body.data.status).toBe('CANCELLED');
		expect((await cancelJ(d.id)).status).toBe(409);
		const w2 = await payrollWorld();
		const v = await accrualOk(w2.runId);
		await validateJ(v.id);
		const c = await cancelJ(v.id);
		expect(c.status).toBe(200);
		expect(c.body.data.status).toBe('CANCELLED');
		const src = await prisma.payrollJournalSource.findMany({ where: { journalId: v.id } });
		expect(src.every((s) => s.activeKey === null)).toBe(true);
		expect(await prisma.payrollJournalLine.count({ where: { journalId: v.id } })).toBeGreaterThan(
			0
		);
	}, 60_000);

	it('57. a CANCELLED journal can not be validated or posted', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		await cancelJ(j.id);
		expect((await validateJ(j.id)).status).toBe(409);
		expect((await postJ(j.id)).status).toBe(409);
	});
});

describe('read models', () => {
	it('58. run accounting card: active journal, applicable rule set, canCreate', async () => {
		const w = await payrollWorld();
		const before = await get(`/payroll/runs/${w.runId}/accounting-journal`, ctx.admin);
		expect(before.status).toBe(200);
		expect(before.body.data).toMatchObject({
			runStatus: 'FINALIZED',
			canCreate: true,
			activeJournal: null
		});
		expect(before.body.data.ruleSet.version).toBe(1);
		const j = await accrualOk(w.runId);
		const after = await get(`/payroll/runs/${w.runId}/accounting-journal`, ctx.admin);
		expect(after.body.data.canCreate).toBe(false);
		expect(after.body.data.activeJournal.id).toBe(j.id);
	});

	it('59. journal list filters by type / status / period / date / company', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		const q = async (qs: string) =>
			(await get(`/payroll/accounting/journals?companyId=${w.companyId}&${qs}`, ctx.admin)).body
				.data.items as { id: string }[];
		expect((await q('journalType=PAYROLL_ACCRUAL')).map((x) => x.id)).toEqual([j.id]);
		expect(await q('journalType=PAYMENT_SETTLEMENT')).toHaveLength(0);
		expect(await q('status=POSTED')).toHaveLength(0);
		expect((await q(`periodId=${w.period.id}`)).map((x) => x.id)).toEqual([j.id]);
		expect(await q('dateFrom=2025-10-01')).toHaveLength(0);
		expect((await q('dateFrom=2025-09-30&dateTo=2025-09-30')).map((x) => x.id)).toEqual([j.id]);
		const bad = await get('/payroll/accounting/journals?status=OPEN', ctx.admin);
		expect(bad.status).toBe(400);
	});

	it('60. journal detail: source traceability, posting note, user names; no sensitive payroll fields', async () => {
		const w = await payrollWorld();
		const j = await accrualOk(w.runId);
		const d = await journalOf(j.id);
		expect(d.source).toMatchObject({
			kind: 'PAYROLL_RUN',
			runId: w.runId,
			periodCode: w.period.code
		});
		const res = await get(`/payroll/accounting/journals/${j.id}`, ctx.admin);
		expect(res.body.data.postingNote).toBe(
			'Posting locks this journal in LaoHR. It does not send data to an external accounting system.'
		);
		expect(res.body.data.createdByName).toBeTruthy();
		const blob = JSON.stringify(res.body.data);
		for (const banned of [
			'"accountNumber',
			'"taxId',
			'"tin"',
			'"socialSecurityNumber',
			'"latitude',
			'"approvalNote'
		]) {
			expect(blob).not.toContain(banned);
		}
	});
});
