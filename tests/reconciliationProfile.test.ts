import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { linkedUser, newCompany, setupPhase13 } from './phase13Fixture.js';
import {
	ctx,
	exported15,
	get,
	post,
	put,
	reconProfile,
	reconProfileBody,
	resultCsv,
	upload,
	bankRow,
	RESULT_COLUMNS,
	STATUS_MAPPING,
	viewOnlyUser
} from './phase15Fixture.js';
import { createTestUser, loginAndGetCookie } from './helpers.js';

/** PHASE 15 — reconciliation profiles (spec tests 9–16): safe predefined fields + status mapping. */
beforeAll(async () => {
	await setupPhase13();
});

describe('reconciliation profiles', () => {
	it('9. HR_ADMIN (payroll.payment.reconcile + employees.view_all) creates, reads back and edits a profile; audited', async () => {
		const companyId = await newCompany();
		const { username, password } = await createTestUser({ roleCode: 'HR_ADMIN' });
		const hr = await loginAndGetCookie(username, password);
		const res = await post('/payment-reconciliation-profiles', hr, reconProfileBody(companyId));
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data).toMatchObject({
			format: 'CSV',
			delimiter: ',',
			hasHeader: true,
			columns: RESULT_COLUMNS,
			statusMapping: STATUS_MAPPING,
			status: 'ACTIVE'
		});
		const id = res.body.data.id;
		const list = await get(`/payment-reconciliation-profiles?companyId=${companyId}`, hr);
		expect(list.body.data.items.map((p: { id: string }) => p.id)).toEqual([id]);
		const edit = await put(`/payment-reconciliation-profiles/${id}`, hr, {
			...reconProfileBody(companyId),
			companyId: undefined,
			code: undefined,
			name: 'QA result (edited)',
			format: 'XLSX',
			sheetName: 'Results'
		});
		expect(edit.status, JSON.stringify(edit.body)).toBe(200);
		expect(edit.body.data).toMatchObject({ format: 'XLSX', sheetName: 'Results', delimiter: null });
		// numeric entity ids are unique per entity type only
		const audit = await prisma.auditEvent.findMany({
			where: { entityType: 'PAYMENT_RECONCILIATION_PROFILE', entityId: String(id) }
		});
		expect(audit.map((a) => a.action).sort()).toEqual([
			'RECONCILIATION_PROFILE.CREATED',
			'RECONCILIATION_PROFILE.UPDATED'
		]);
	});

	it('10 + 11. MANAGER and EMPLOYEE are forbidden (no reconcile permission); view-only payment users too', async () => {
		const companyId = await newCompany();
		const mgr = await linkedUser('MANAGER');
		const emp = await linkedUser('EMPLOYEE');
		const viewer = await viewOnlyUser();
		for (const cookie of [mgr.cookie, emp.cookie, viewer.cookie]) {
			expect(
				(await post('/payment-reconciliation-profiles', cookie, reconProfileBody(companyId))).status
			).toBe(403);
			expect((await get('/payment-reconciliation-profiles', cookie)).status).toBe(403);
			expect((await get('/payment-reconciliation-profiles/fields', cookie)).status).toBe(403);
		}
	});

	it('12. only the predefined fields are offered and accepted', async () => {
		const companyId = await newCompany();
		const cat = await get('/payment-reconciliation-profiles/fields', ctx.admin);
		expect(cat.body.data.fields.map((f: { field: string }) => f.field)).toEqual([
			'INSTRUCTION_REFERENCE',
			'BANK_TRANSACTION_REFERENCE',
			'STATUS',
			'AMOUNT',
			'CURRENCY',
			'PAID_DATE',
			'FAILURE_CODE',
			'FAILURE_REASON'
		]);
		expect(cat.body.data.limits).toMatchObject({ maxBytes: 5 * 1024 * 1024, maxRows: 10000 });
		const p = await reconProfile(companyId);
		expect(p.format).toBe('CSV');
	});

	it('13. arbitrary / database / expression fields are rejected; required INSTRUCTION_REFERENCE + STATUS', async () => {
		const companyId = await newCompany();
		for (const field of ['ACCOUNT_NUMBER', 'employees.salary', 'netPay', '=1+1', 'SELECT 1']) {
			const res = await post(
				'/payment-reconciliation-profiles',
				ctx.admin,
				reconProfileBody(companyId, { columns: [...RESULT_COLUMNS, { field, column: 'X' }] })
			);
			expect(res.status, field).toBe(400);
		}
		// unknown keys are rejected (strict), no expressions smuggled in
		const extra = await post('/payment-reconciliation-profiles', ctx.admin, {
			...reconProfileBody(companyId),
			columns: [{ field: 'STATUS', column: 'Status', expression: 'x' }, RESULT_COLUMNS[0]]
		});
		expect(extra.status).toBe(400);
		const noStatus = await post(
			'/payment-reconciliation-profiles',
			ctx.admin,
			reconProfileBody(companyId, { columns: RESULT_COLUMNS.filter((c) => c.field !== 'STATUS') })
		);
		expect(noStatus.status).toBe(400);
		const noRef = await post(
			'/payment-reconciliation-profiles',
			ctx.admin,
			reconProfileBody(companyId, {
				columns: RESULT_COLUMNS.filter((c) => c.field !== 'INSTRUCTION_REFERENCE')
			})
		);
		expect(noRef.status).toBe(400);
		// no header → columns must be column numbers
		const noHeader = await post(
			'/payment-reconciliation-profiles',
			ctx.admin,
			reconProfileBody(companyId, { hasHeader: false })
		);
		expect(noHeader.status).toBe(400);
		const numbered = await post(
			'/payment-reconciliation-profiles',
			ctx.admin,
			reconProfileBody(companyId, {
				hasHeader: false,
				columns: [
					{ field: 'INSTRUCTION_REFERENCE', column: '1' },
					{ field: 'STATUS', column: '2' }
				]
			})
		);
		expect(numbered.status, JSON.stringify(numbered.body)).toBe(201);
	});

	it('14. status mapping is validated (PAID + FAILED required; values trimmed; no empty values)', async () => {
		const companyId = await newCompany();
		for (const statusMapping of [
			{ PAID: [], FAILED: ['F'], REVERSED: [] },
			{ PAID: ['S'], FAILED: [], REVERSED: [] },
			{ PAID: ['  '], FAILED: ['F'], REVERSED: [] },
			{ PAID: ['S'], FAILED: ['F'], REVERSED: [], OTHER: ['X'] }
		]) {
			const res = await post(
				'/payment-reconciliation-profiles',
				ctx.admin,
				reconProfileBody(companyId, { statusMapping })
			);
			expect(res.status, JSON.stringify(statusMapping)).toBe(400);
		}
		const ok = await post(
			'/payment-reconciliation-profiles',
			ctx.admin,
			reconProfileBody(companyId, {
				statusMapping: { PAID: [' ok '], FAILED: ['NG'], REVERSED: [] }
			})
		);
		expect(ok.status).toBe(201);
		expect(ok.body.data.statusMapping.PAID).toEqual(['ok']);
	});

	it('15. a bank value may map to ONE status only (case-insensitive duplicates rejected)', async () => {
		const companyId = await newCompany();
		const res = await post(
			'/payment-reconciliation-profiles',
			ctx.admin,
			reconProfileBody(companyId, {
				statusMapping: { PAID: ['SUCCESS'], FAILED: ['success'], REVERSED: [] }
			})
		);
		expect(res.status).toBe(400);
		const same = await post(
			'/payment-reconciliation-profiles',
			ctx.admin,
			reconProfileBody(companyId, {
				statusMapping: { PAID: ['S', ' s '], FAILED: ['F'], REVERSED: [] }
			})
		);
		expect(same.status).toBe(400);
	});

	it('16. an INACTIVE profile cannot be used for an import', async () => {
		const w = await exported15();
		const p = await reconProfile(w.companyId);
		const off = await put(`/payment-reconciliation-profiles/${p.id}`, ctx.admin, {
			...reconProfileBody(w.companyId),
			companyId: undefined,
			code: undefined,
			status: 'INACTIVE'
		});
		expect(off.status, JSON.stringify(off.body)).toBe(200);
		const res = await upload(w.batch.id, p.id, {
			name: 'r.csv',
			bytes: resultCsv([bankRow(w.batch.items[0]!, 'SUCCESS')])
		});
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('RECON_PROFILE_INACTIVE');
		// another company's profile is not usable either (indistinguishable from missing)
		const otherCo = await newCompany();
		const foreign = await reconProfile(otherCo);
		const res2 = await upload(w.batch.id, foreign.id, {
			name: 'r.csv',
			bytes: resultCsv([bankRow(w.batch.items[0]!, 'SUCCESS')])
		});
		expect(res2.status).toBe(404);
	});
});
