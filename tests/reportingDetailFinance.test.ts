import { beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Response } from 'superagent';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import { agent } from './helpers.js';
import { linkedUser, setupPhase13 } from './phase13Fixture.js';
import { ACCT } from './phase14Fixture.js';
import { retryOk, reverse, validateAndExport } from './phase15Fixture.js';
import {
	accrualOk,
	confirmFailed,
	confirmPaid,
	ctx,
	get,
	isolateFixtureNotifications,
	payOk,
	paymentWorld,
	payrollFingerprint,
	payrollWorld,
	post,
	postedOk
} from './phase16Fixture.js';
import { MONEY } from './phase17Fixture.js';
import { pdfAllText, pdfPages } from './pdfText.js';

/**
 * Phase 17B — payroll / payment / accounting DETAIL + money exports (tests 63–97 and the money parts of
 * the CSV / XLSX / PDF / audit tests). Worlds from the Phase 13–16 fixtures (FINALIZED Sep 2025 run).
 */
isolateFixtureNotifications();

const Dec = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
type Row = Record<string, string | number | boolean | null>;
interface Detail {
	context: Record<string, unknown>;
	page: { totalRows: number; totalPages: number };
	rows: Row[];
}
const detail = async (type: string, params: string, cookie = ctx.admin) => {
	const res = await get(`/reports/${type}/detail?pageSize=100&${params}`, cookie);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as Detail;
};
const summary = async (type: string, params: string) => {
	const res = await get(`/reports/${type}/summary?${params}`, ctx.admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as { totals: Record<string, string | number> };
};
const binaryParser = (res: Response, cb: (err: Error | null, body: Buffer) => void) => {
	const chunks: Buffer[] = [];
	res.on('data', (c: Buffer) => chunks.push(c));
	res.on('end', () => cb(null, Buffer.concat(chunks)));
};
async function exportReq(type: string, body: Record<string, unknown>, cookie = ctx.admin) {
	const res = await agent()
		.post(`/api/v1/reports/${type}/export`)
		.set('Cookie', cookie)
		.send(body)
		.buffer(true)
		.parse(binaryParser as never);
	return { res, bytes: res.body as Buffer };
}
/** "5552250.00" → "5,552,250.00" (the PDF's human money form) */
const fmt = (v: string) => {
	const [i, f] = v.split('.');
	return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
};
const sum = (rows: Row[], k: string) =>
	rows.reduce((s, r) => s.plus(String(r[k] ?? 0)), Dec(0)).toFixed(2);

let P: Awaited<ReturnType<typeof payrollWorld>>;
let manager: { cookie: string };
beforeAll(async () => {
	await setupPhase13();
	P = await payrollWorld({ employees: 3, org: true });
	manager = await linkedUser('MANAGER');
}, 180_000);

// =====================================================================================
// 63–76 payroll detail
// =====================================================================================
describe('payroll detail', () => {
	it('63. FINALIZED stored results only (a DRAFT run of another month is not a payroll)', async () => {
		const d = await detail('payroll', `companyId=${P.companyId}`);
		expect(d.context).toMatchObject({
			payrollMonth: '2025-09',
			source: 'FINALIZED_PAYROLL_SNAPSHOT'
		});
		expect(d.page.totalRows).toBe(3);
		const period = await post('/payroll/periods', ctx.admin, {
			companyId: P.companyId,
			code: `D17B_${Date.now()}`,
			name: 'ງວດ DRAFT',
			startDate: '2025-10-01',
			endDate: '2025-10-31',
			payDate: '2025-10-31'
		});
		expect(
			(
				await post('/payroll/runs', ctx.admin, {
					companyId: P.companyId,
					periodId: period.body.data.id
				})
			).status
		).toBe(201);
		expect((await detail('payroll', `companyId=${P.companyId}&payrollMonth=2025-10`)).rows).toEqual(
			[]
		);
	}, 60_000);

	it('66–72. every amount equals the stored result (Decimal fixed-2 strings)', async () => {
		const d = await detail('payroll', `companyId=${P.companyId}`);
		const results = await prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: P.runId },
			include: { statutoryResult: true }
		});
		for (const r of results) {
			const row = d.rows.find((x) => x.employeeCode === r.employeeCodeSnapshot)!;
			expect(row).toMatchObject({
				employeeName: r.employeeNameSnapshot,
				grossEarnings: r.totalEarnings.toFixed(2),
				totalDeductions: r.totalDeductions.toFixed(2),
				pit: r.statutoryResult!.pitCurrentCycle.toFixed(2),
				employeeSso: r.statutoryResult!.employeeSsoCurrentCycle.toFixed(2),
				employerSso: r.statutoryResult!.employerSsoCurrentCycle.toFixed(2),
				netPay: r.netPay.toFixed(2),
				currencyCode: 'LAK',
				runNumber: 1
			});
			for (const k of [
				'grossEarnings',
				'totalDeductions',
				'pit',
				'employeeSso',
				'employerSso',
				'netPay'
			]) {
				expect(row[k]).toMatch(MONEY);
			}
		}
	});

	it('74. summary money totals equal the detail sums', async () => {
		const d = await detail('payroll', `companyId=${P.companyId}`);
		const s = await summary('payroll', `companyId=${P.companyId}&groupBy=none`);
		for (const k of [
			'grossEarnings',
			'totalDeductions',
			'pit',
			'employeeSso',
			'employerSso',
			'netPay'
		]) {
			expect(sum(d.rows, k), k).toBe(s.totals[k]);
		}
		expect(s.totals.employeeCount).toBe(d.page.totalRows);
	});

	it('64–65, 73. historical branch / department snapshots; a later transfer or salary change changes nothing', async () => {
		const before = await detail('payroll', `companyId=${P.companyId}`);
		const snaps = await prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: P.runId },
			select: { employeeCodeSnapshot: true, branchNameSnapshot: true, departmentNameSnapshot: true }
		});
		for (const s of snaps) {
			expect(before.rows.find((r) => r.employeeCode === s.employeeCodeSnapshot)).toMatchObject({
				branch: s.branchNameSnapshot,
				department: s.departmentNameSnapshot
			});
		}
		await prisma.employee.update({
			where: { id: P.emps[0]!.id },
			data: { branchId: P.units!.branches[1]!.id, departmentId: P.units!.departments[1]!.id }
		});
		const c = await post(`/employees/${P.emps[0]!.id}/compensation`, ctx.admin, {
			baseSalary: '9900000',
			effectiveFrom: '2025-11-01'
		});
		expect(c.status).toBe(201);
		const after = await detail('payroll', `companyId=${P.companyId}`);
		expect(after.rows).toEqual(before.rows);
	});

	it('— no payroll recalculation: the stored snapshot is unchanged by detail and export', async () => {
		const fp = await payrollFingerprint(P.runId);
		await detail('payroll', `companyId=${P.companyId}`);
		await exportReq('payroll', { format: 'XLSX', filters: { companyId: P.companyId } });
		expect(await payrollFingerprint(P.runId)).toBe(fp);
	});

	it('75. a manager is forbidden (detail, fields and export)', async () => {
		expect(
			(await get(`/reports/payroll/detail?companyId=${P.companyId}`, manager.cookie)).status
		).toBe(403);
		expect((await get('/reports/payroll/fields', manager.cookie)).status).toBe(403);
		expect(
			(
				await exportReq(
					'payroll',
					{ format: 'CSV', filters: { companyId: P.companyId } },
					manager.cookie
				)
			).res.status
		).toBe(403);
	});

	it('76. no TIN / SSN / bank / salary-rate fields', async () => {
		const d = await detail('payroll', `companyId=${P.companyId}`);
		expect(JSON.stringify(d)).not.toMatch(
			/\btin\b|\bssn\b|socialSecurityNumber|taxNumber|bank|account|baseSalary/i
		);
	});
});

// =====================================================================================
// 77–88 payment detail
// =====================================================================================
describe('payment detail', () => {
	let W: Awaited<ReturnType<typeof paymentWorld>>;
	beforeAll(async () => {
		W = await paymentWorld({ employees: 3 });
		const [i0, i1, i2] = W.items;
		expect((await confirmPaid(W.batchId, i0!.id, 'QA-PAYREF-17B')).status).toBe(200);
		expect((await confirmFailed(W.batchId, i1!.id)).status).toBe(200);
		const retry = await retryOk(W.batchId, [i1!.id]);
		await validateAndExport(retry.id, W.bankProfileId);
		await payOk(retry.id, retry.items[0]!.id);
		await payOk(W.batchId, i2!.id);
		expect((await reverse(W.batchId, i2!.id)).status).toBe(200);
	}, 240_000);

	it('77–82. one row per obligation; retry PAID counted once with 2 attempts; REVERSED latest', async () => {
		const d = await detail('payments', `companyId=${W.companyId}`);
		expect(d.page.totalRows).toBe(3);
		const by = (i: number) =>
			d.rows.find((r) => r.employeeCode === W.items[i]!.employeeCodeSnapshot)!;
		expect(by(0)).toMatchObject({
			settlementStatus: 'PAID',
			attemptCount: 1,
			retried: false,
			reversedOn: null
		});
		expect(by(1)).toMatchObject({
			settlementStatus: 'PAID',
			attemptCount: 2,
			retried: true,
			paymentMethod: 'BANK_TRANSFER'
		});
		expect(by(1).paidAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(by(2)).toMatchObject({ settlementStatus: 'REVERSED', paidAt: null });
		expect(by(2).reversedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		for (let i = 0; i < 3; i++) expect(by(i).amount).toBe(W.items[i]!.amount.toFixed(2));
		const paidOnly = await detail('payments', `companyId=${W.companyId}&status=PAID`);
		expect(paidOnly.page.totalRows).toBe(2);
	});

	it('83. obligation states and amounts reconcile with the summary', async () => {
		const d = await detail('payments', `companyId=${W.companyId}`);
		const s = await summary('payments', `companyId=${W.companyId}&groupBy=none`);
		const count = (st: string) => d.rows.filter((r) => r.settlementStatus === st).length;
		expect(s.totals).toMatchObject({
			obligations: d.page.totalRows,
			paid: count('PAID'),
			reversed: count('REVERSED'),
			failed: count('FAILED'),
			retried: d.rows.filter((r) => r.retried).length,
			paidAmount: sum(
				d.rows.filter((r) => r.settlementStatus === 'PAID'),
				'amount'
			)
		});
	});

	it('84–87. no account digits, bank / payment / transfer / instruction references', async () => {
		const surfaces = [
			JSON.stringify(await detail('payments', `companyId=${W.companyId}`)),
			(
				await exportReq('payments', { format: 'CSV', filters: { companyId: W.companyId } })
			).bytes.toString('utf8')
		];
		for (const text of surfaces) {
			expect(text).not.toContain(ACCT);
			expect(text).not.toContain('QA-PAYREF-17B');
			expect(text).not.toContain('QA-REV-001');
			expect(text).not.toMatch(
				/PI-[A-Z0-9]|accountNumber|bankReference|paymentReference|transferReference|instructionReference/
			);
		}
	});

	it('88. a manager is forbidden', async () => {
		expect(
			(await get(`/reports/payments/detail?companyId=${W.companyId}`, manager.cookie)).status
		).toBe(403);
	});
});

// =====================================================================================
// 89–97 accounting detail
// =====================================================================================
describe('accounting detail', () => {
	let posted: { id: string; totalDebit: string };
	beforeAll(async () => {
		const j = await accrualOk(P.runId);
		posted = await postedOk(j.id);
	}, 60_000);

	it('89–94. one row per journal line with the stored snapshots and Decimal amounts', async () => {
		const d = await detail('accounting', `companyId=${P.companyId}`);
		const lines = await prisma.payrollJournalLine.findMany({
			where: { journal: { companyId: P.companyId } },
			include: { journal: true }
		});
		expect(d.page.totalRows).toBe(lines.length);
		for (const l of lines) {
			const row = d.rows.find(
				(r) => r.journalNumber === l.journal.journalNumber && r.lineNo === l.lineNo
			)!;
			expect(row).toMatchObject({
				journalStatus: 'POSTED',
				accountCode: l.accountCodeSnapshot,
				accountName: l.accountNameSnapshot,
				debit: l.debit.toFixed(2),
				credit: l.credit.toFixed(2)
			});
			expect(row.debit).toMatch(MONEY);
		}
	});

	it('95. POSTED line totals equal the summary posted totals (and the journal totals)', async () => {
		const d = await detail('accounting', `companyId=${P.companyId}&status=POSTED`);
		const s = await summary('accounting', `companyId=${P.companyId}`);
		expect(sum(d.rows, 'debit')).toBe(s.totals.postedDebit);
		expect(sum(d.rows, 'credit')).toBe(s.totals.postedCredit);
		expect(sum(d.rows, 'debit')).toBe(posted.totalDebit);
	});

	it('88/96. no bank data; no payroll recomputation', async () => {
		const fp = await payrollFingerprint(P.runId);
		const d = await detail('accounting', `companyId=${P.companyId}`);
		expect(JSON.stringify(d)).not.toMatch(/bank|accountNumber|sourceReference|PI-[A-Z0-9]/i);
		expect(await payrollFingerprint(P.runId)).toBe(fp);
	});

	it('97. a manager is forbidden', async () => {
		expect(
			(await get(`/reports/accounting/detail?companyId=${P.companyId}`, manager.cookie)).status
		).toBe(403);
	});
});

// =====================================================================================
// money in CSV / XLSX / PDF + audit
// =====================================================================================
describe('money exports', () => {
	it('122. CSV money stays a plain fixed-2 decimal (no separators)', async () => {
		const d = await detail('payroll', `companyId=${P.companyId}`);
		const { bytes } = await exportReq('payroll', {
			format: 'CSV',
			filters: { companyId: P.companyId },
			columns: ['employeeCode', 'netPay']
		});
		const lines = bytes.toString('utf8').slice(1).split('\r\n').filter(Boolean).slice(1);
		expect(lines).toEqual(d.rows.map((r) => `${r.employeeCode},${r.netPay}`));
		expect(lines[0]).toMatch(/^[^,]+,\d+\.\d{2}$/);
	});

	it('131. XLSX money is numeric with a 2-decimal format; codes are text', async () => {
		const { bytes } = await exportReq('payroll', {
			format: 'XLSX',
			filters: { companyId: P.companyId }
		});
		const wb = XLSX.read(bytes, { type: 'buffer', cellNF: true });
		expect(wb.SheetNames).toEqual(['Payroll']);
		const ws = wb.Sheets.Payroll!;
		expect(ws.A2).toMatchObject({ t: 's' });
		const header = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 })[0]!;
		const netCol = XLSX.utils.encode_col(header.indexOf('ສຸດທິ'));
		expect(ws[`${netCol}2`]).toMatchObject({ t: 'n', z: '#,##0.00' });
		const d = await detail('payroll', `companyId=${P.companyId}`);
		expect(Dec(ws[`${netCol}2`].v).toFixed(2)).toBe(d.rows[0]!.netPay);
	});

	it('149–150. PDF: human money, right-aligned table, Decimal totals row, confidential mark', async () => {
		const d = await detail('payroll', `companyId=${P.companyId}`);
		const { res, bytes } = await exportReq('payroll', {
			format: 'PDF',
			filters: { companyId: P.companyId }
		});
		expect(res.headers['content-disposition']).toMatch(/REPORT-PAYROLL-2025-09\.pdf/);
		const text = pdfAllText(bytes);
		expect(text).toContain(fmt(d.rows[0]!.netPay as string));
		expect(text).toContain('ລວມທັງໝົດ');
		expect(text).toContain(fmt(sum(d.rows, 'netPay')));
		expect(text).toContain(fmt(sum(d.rows, 'grossEarnings')));
		expect(text).toContain('Confidential');
		expect(pdfPages(bytes)[0]!.fonts.some((f) => f.includes('NotoSansLao'))).toBe(true);
		expect(text).not.toMatch(/\btin\b|\bssn\b|bank|account/i);
	});

	it('— accounting PDF totals debit and credit', async () => {
		const d = await detail('accounting', `companyId=${P.companyId}`);
		const { bytes } = await exportReq('accounting', {
			format: 'PDF',
			filters: { companyId: P.companyId }
		});
		const text = pdfAllText(bytes);
		expect(text).toContain('ລວມທັງໝົດ');
		expect(text).toContain(fmt(sum(d.rows, 'debit')));
		expect(text).toContain(fmt(sum(d.rows, 'credit')));
	});

	it('163. the export audit never contains amounts', async () => {
		const d = await detail('payroll', `companyId=${P.companyId}`);
		await exportReq('payroll', { format: 'CSV', filters: { companyId: P.companyId } });
		const ev = await prisma.auditEvent.findFirstOrThrow({
			where: { action: 'REPORT.EXPORTED', entityId: 'payroll' },
			orderBy: { createdAt: 'desc' }
		});
		const meta = JSON.stringify(ev.metadataJson);
		expect(ev.metadataJson).toMatchObject({ reportType: 'payroll', format: 'CSV', rowCount: 3 });
		for (const r of d.rows) {
			for (const k of ['netPay', 'grossEarnings', 'pit']) {
				expect(meta).not.toContain(String(r[k]));
				expect(meta).not.toContain(String(r[k]).split('.')[0]);
			}
			expect(meta).not.toContain(String(r.employeeCode));
		}
	});
});
