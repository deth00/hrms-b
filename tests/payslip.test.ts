import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { agent } from './helpers.js';
import {
	approveOk,
	calc,
	ctx,
	employee,
	finalize,
	get,
	linkedUser,
	manualPeriod,
	moneyNeedles,
	newCompany,
	newRun,
	post,
	profile,
	put,
	setupPhase13,
	statutoryRule,
	submitOk,
	twoCycleSchedule,
	uid,
	workflowWorld
} from './phase13Fixture.js';
import { payslipNumberOf } from '../src/services/payslip.service.js';

/**
 * PHASE 13 — immutable payslips: issued by finalization (and by the historical backfill for
 * v1-v5 runs), rendered ONLY from the snapshot, self-service scoped to the linked employee.
 */
beforeAll(async () => {
	await setupPhase13();
});

interface PayslipView {
	id: string;
	payslipNumber: string;
	employeeId: string;
	netPay: string;
	cycleNumber: number | null;
	snapshot: {
		company: { nameLao: string };
		employee: {
			employeeCode: string;
			name: string;
			department: string | null;
			position: string | null;
		};
		payroll: {
			periodCode: string;
			cycleNumber: number | null;
			payrollMonth: string | null;
			calculationVersion: number;
		};
		compensation: { monthlyBaseSalary: string | null; cycleBaseSalary: string | null } | null;
		earnings: { code: string; amount: string }[];
		deductions: { code: string; amount: string }[];
		statutory: {
			pit: { amount: string; direction: 'DEDUCTION' | 'CREDIT' } | null;
			employeeSocialSecurity: { amount: string; direction: string } | null;
			employerSocialSecurity: string | null;
		} | null;
		totals: {
			totalEarnings: string;
			totalDeductions: string;
			netPay: string;
			employerContributionTotal: string | null;
		};
	};
}

/** DIRECT company, N employees with salary, CALCULATED manual run (not finalized). */
async function directWorld(
	o: { employees?: number; userIds?: (string | null)[]; salary?: string } = {}
) {
	const companyId = await newCompany();
	const emps = [];
	for (let i = 0; i < (o.employees ?? 1); i++) {
		emps.push(await employee(companyId, { userId: o.userIds?.[i] ?? null, salary: o.salary }));
	}
	const period = await manualPeriod(companyId);
	const run = await newRun(companyId, period.id);
	await calc(run.id);
	return { companyId, emps, period, run };
}
async function finalizeOk(runId: string) {
	const res = await finalize(runId);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as { payslipCount: number };
}
async function runPayslips(runId: string) {
	const res = await get(`/payroll/runs/${runId}/payslips`, ctx.admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data.items as { id: string; employeeId: string; payslipNumber: string }[];
}
async function payslipOf(runId: string, employeeId: string): Promise<PayslipView> {
	const brief = (await runPayslips(runId)).find((p) => p.employeeId === employeeId)!;
	const res = await get(`/payslips/${brief.id}`, ctx.admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as PayslipView;
}
/** simulate a pre-Phase-13 finalized run (no payslip rows) — test DB only */
const dropPayslips = (runId: string) =>
	prisma.payslip.deleteMany({ where: { payrollRunId: runId } });
const generate = (runId: string, cookie = ctx.admin) =>
	post(`/payroll/runs/${runId}/generate-payslips`, cookie);

// =================================================================================================
// 48-54 issue
// =================================================================================================
describe('issue on finalization', () => {
	it('48, 55-timing. no payslip before FINALIZED (calculated, pending, approved)', async () => {
		const w = await workflowWorld();
		expect(await prisma.payslip.count({ where: { payrollRunId: w.run.id } })).toBe(0);
		await submitOk(w.run.id);
		expect(await prisma.payslip.count({ where: { payrollRunId: w.run.id } })).toBe(0);
		await approveOk(w.run.id);
		expect(await prisma.payslip.count({ where: { payrollRunId: w.run.id } })).toBe(0);
		expect((await runPayslips(w.run.id)).length).toBe(0);
		await finalizeOk(w.run.id);
		expect((await runPayslips(w.run.id)).length).toBe(1);
	});

	it('49-53. finalization issues exactly one payslip per result, deterministic number, retries never duplicate', async () => {
		const w = await directWorld({ employees: 3 });
		const fin = await finalizeOk(w.run.id);
		expect(fin.payslipCount).toBe(3);
		const results = await prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: w.run.id }
		});
		const slips = await prisma.payslip.findMany({ where: { payrollRunId: w.run.id } });
		expect(new Set(slips.map((s) => s.payrollEmployeeResultId))).toEqual(
			new Set(results.map((r) => r.id))
		);
		for (const s of slips) {
			const r = results.find((x) => x.id === s.payrollEmployeeResultId)!;
			expect(s.payslipNumber).toBe(payslipNumberOf(w.period.code, r.employeeCodeSnapshot));
			expect(s.payslipNumber).toMatch(/^PS-[A-Z0-9-]+$/);
		}
		// retry finalize → refused; generate → nothing new
		expect((await finalize(w.run.id)).status).toBe(409);
		const g = await generate(w.run.id);
		expect(g.status).toBe(200);
		expect(g.body.data).toEqual({ created: 0, total: 3 });
		// DB uniqueness is the backstop
		await expect(
			prisma.payslip.create({
				data: {
					...slips[0]!,
					id: undefined,
					snapshotJson: slips[0]!.snapshotJson as Prisma.InputJsonValue
				}
			})
		).rejects.toThrow();
		expect(payslipNumberOf('man_2025/09 (1)', 'emp.001')).toBe('PS-MAN-2025-09-1-EMP-001');
	});

	it('54. a payslip is immutable: no PATCH / DELETE endpoint', async () => {
		const w = await directWorld();
		await finalizeOk(w.run.id);
		const [slip] = await runPayslips(w.run.id);
		const patch = await agent()
			.patch(`/api/v1/payslips/${slip!.id}`)
			.set('Cookie', ctx.admin)
			.send({});
		const del = await agent().delete(`/api/v1/payslips/${slip!.id}`).set('Cookie', ctx.admin);
		expect(patch.status).toBe(404);
		expect(del.status).toBe(404);
	});
});

// =================================================================================================
// 55-58 snapshot independence from live data
// =================================================================================================
describe('snapshot never follows live data', () => {
	it('55-58. rename, department / position move, a salary change and a new statutory rule leave the payslip unchanged', async () => {
		const w = await directWorld();
		await statutoryRule(w.companyId);
		await profile(w.emps[0]!.id);
		await calc(w.run.id);
		await finalizeOk(w.run.id);
		const before = await payslipOf(w.run.id, w.emps[0]!.id);
		expect(before.snapshot.statutory).not.toBeNull();

		const dept = await prisma.department.create({
			data: { companyId: w.companyId, code: `D_${uid()}`, nameLao: 'ພະແນກໃໝ່' }
		});
		await prisma.employee.update({
			where: { id: w.emps[0]!.id },
			data: { firstNameLao: 'ຊື່ໃໝ່', lastNameLao: 'ປ່ຽນແລ້ວ', departmentId: dept.id }
		});
		expect(
			(
				await post(`/employees/${w.emps[0]!.id}/compensation`, ctx.admin, {
					baseSalary: '9900000',
					effectiveFrom: '2025-10-01'
				})
			).status
		).toBe(201);
		await statutoryRule(w.companyId, {
			effectiveFrom: '2025-12-01',
			brackets: [{ order: 1, lowerBound: '0', upperBound: null, rate: '0.5' }]
		});

		const after = await payslipOf(w.run.id, w.emps[0]!.id);
		expect(after.snapshot).toEqual(before.snapshot);
		expect(after.snapshot.employee.name).not.toContain('ຊື່ໃໝ່');
		// the PDF is rendered from the same snapshot
		const pdf = await get(`/payslips/${after.id}/pdf`, ctx.admin);
		expect(pdf.status).toBe(200);
	});
});

// =================================================================================================
// 59-65 historical backfill
// =================================================================================================
describe('historical backfill (generate-payslips)', () => {
	async function backfillCheck(runId: string, expectVersion: number) {
		await dropPayslips(runId);
		const g1 = await generate(runId);
		expect(g1.status, JSON.stringify(g1.body)).toBe(200);
		expect(g1.body.data.created).toBeGreaterThan(0);
		const g2 = await generate(runId);
		expect(g2.body.data.created).toBe(0); // 64. idempotent
		const slips = await runPayslips(runId);
		const detail = await get(`/payslips/${slips[0]!.id}`, ctx.admin);
		expect(detail.body.data.snapshot.payroll.calculationVersion).toBe(expectVersion);
		return detail.body.data as PayslipView;
	}

	it('59. v1 (no rules) — backfilled without statutory / segments', async () => {
		const w = await directWorld();
		await finalizeOk(w.run.id);
		const p = await backfillCheck(w.run.id, 1);
		expect(p.snapshot.statutory).toBeNull();
		expect(p.snapshot.payroll.cycleNumber).toBeNull();
		expect(p.snapshot.earnings.map((e) => e.code)).toContain('BASE_SALARY');
	});

	it('60. v2 (rule-based) run', async () => {
		const companyId = await newCompany();
		const rule = await post('/payroll-rules', ctx.admin, {
			companyId,
			nameLao: 'ກົດ',
			effectiveFrom: '2025-01-01',
			prorationMethod: 'CALENDAR_DAYS'
		});
		expect(rule.status).toBe(201);
		await employee(companyId);
		const period = await manualPeriod(companyId);
		const run = await newRun(companyId, period.id);
		expect((await calc(run.id)).calculationVersion).toBe(2);
		await finalizeOk(run.id);
		const p = await backfillCheck(run.id, 2);
		expect(p.snapshot.statutory).toBeNull();
	});

	it('61-62. v3 / v4 multi-cycle runs keep their cycle context', async () => {
		const companyId = await newCompany();
		const emp = await employee(companyId, { salary: '6000000' });
		const [c1, c2] = await twoCycleSchedule(companyId);
		const r1 = await newRun(companyId, c1!.id);
		expect((await calc(r1.id)).calculationVersion).toBe(4);
		await finalizeOk(r1.id);
		const p4 = await backfillCheck(r1.id, 4);
		expect(p4.snapshot.payroll.cycleNumber).toBe(1);
		expect(p4.snapshot.compensation?.monthlyBaseSalary).toBe('6000000.00');
		expect(p4.snapshot.compensation?.cycleBaseSalary).toBe('3000000.00');
		// a historical v3 run (a frozen version number no fresh calculation produces anymore)
		const r2 = await newRun(companyId, c2!.id);
		await calc(r2.id);
		await finalizeOk(r2.id);
		await prisma.payrollRun.update({ where: { id: r2.id }, data: { calculationVersion: 3 } });
		await prisma.payrollEmployeeResult.updateMany({
			where: { payrollRunId: r2.id },
			data: { calculationVersion: 3 }
		});
		const p3 = await backfillCheck(r2.id, 3);
		expect(p3.snapshot.payroll.cycleNumber).toBe(2);
		void emp;
	});

	it('63. v5 (statutory) run', async () => {
		const w = await directWorld();
		await statutoryRule(w.companyId);
		await profile(w.emps[0]!.id);
		expect((await calc(w.run.id)).calculationVersion).toBe(5);
		await finalizeOk(w.run.id);
		const p = await backfillCheck(w.run.id, 5);
		expect(p.snapshot.statutory?.pit?.direction).toBe('DEDUCTION');
	});

	it('65. a non-finalized run cannot be backfilled; generate needs payslip.generate', async () => {
		const w = await directWorld();
		const res = await generate(w.run.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_RUN_NOT_FINALIZED');
		const viewer = await linkedUser('MANAGER');
		expect((await generate(w.run.id, viewer.cookie)).status).toBe(403);
	});

	it('56. generation never calls the calculation engine (a finalized run with changed source data still yields the finalized figures)', async () => {
		const w = await directWorld({ salary: '4000000' });
		await finalizeOk(w.run.id);
		const finalizedNet = (
			await prisma.payrollEmployeeResult.findFirstOrThrow({ where: { payrollRunId: w.run.id } })
		).netPay.toFixed(2);
		await dropPayslips(w.run.id);
		await post(`/employees/${w.emps[0]!.id}/compensation`, ctx.admin, {
			baseSalary: '8800000',
			effectiveFrom: '2025-09-15'
		});
		await generate(w.run.id);
		const p = await payslipOf(w.run.id, w.emps[0]!.id);
		expect(p.snapshot.totals.netPay).toBe(finalizedNet);
	});
});

// =================================================================================================
// 66-73 self-service + admin access + PDF
// =================================================================================================
describe('self-service and access', () => {
	it('66-70, 90-92. own payslips only; other ids 404; manager 403 on admin routes; admin reads; no-link safe', async () => {
		const me = await linkedUser('EMPLOYEE');
		const other = await linkedUser('EMPLOYEE');
		const manager = await linkedUser('MANAGER');
		const w = await directWorld({ employees: 2, userIds: [me.userId, other.userId] });
		// the manager manages BOTH employees — still no payslip access
		const mgrEmp = await employee(w.companyId, { userId: manager.userId });
		await calc(w.run.id);
		await prisma.employee.updateMany({
			where: { id: { in: w.emps.map((e) => e.id) } },
			data: { managerEmployeeId: mgrEmp.id }
		});
		// 55. nothing visible before finalization
		expect((await get('/payslips/me', me.cookie)).body.data.items).toHaveLength(0);
		await finalizeOk(w.run.id);

		const list = await get('/payslips/me', me.cookie);
		expect(list.status).toBe(200);
		expect(list.body.data.linkedEmployee).toBe(true);
		expect(list.body.data.items).toHaveLength(1);
		expect(list.body.data.items[0].employeeId).toBe(w.emps[0]!.id);
		const mine = list.body.data.items[0].id;
		const theirs = (await runPayslips(w.run.id)).find((p) => p.employeeId === w.emps[1]!.id)!.id;

		expect((await get(`/payslips/me/${mine}`, me.cookie)).status).toBe(200);
		const foreign = await get(`/payslips/me/${theirs}`, me.cookie);
		expect(foreign.status).toBe(404);
		expect(JSON.stringify(foreign.body)).not.toContain(w.emps[1]!.employeeCode);
		expect((await get(`/payslips/me/${theirs}/pdf`, me.cookie)).status).toBe(404);
		// employees cannot use the admin endpoints
		expect((await get(`/payslips/${mine}`, me.cookie)).status).toBe(403);
		// manager: no subordinate payslips anywhere
		expect((await get(`/payslips/${theirs}`, manager.cookie)).status).toBe(403);
		expect((await get(`/payslips/${theirs}/pdf`, manager.cookie)).status).toBe(403);
		// MANAGER lacks payslip.view_self entirely → refused at the permission gate
		expect((await get(`/payslips/me/${theirs}`, manager.cookie)).status).toBe(403);
		expect((await get(`/payroll/runs/${w.run.id}/payslips`, manager.cookie)).status).toBe(403);
		// admin
		expect((await get(`/payslips/${theirs}`, ctx.admin)).status).toBe(200);
		// a user WITHOUT an employee link (holds payslip.view_self via EMPLOYEE role)
		const loner = await linkedUser('EMPLOYEE');
		const empty = await get('/payslips/me', loner.cookie);
		expect(empty.status).toBe(200);
		expect(empty.body.data).toEqual({ linkedEmployee: false, items: [] });
		expect((await get(`/payslips/me/${mine}`, loner.cookie)).status).toBe(404);
		// MANAGER role has no payslip.view_self at all
		expect((await get('/payslips/me', manager.cookie)).status).toBe(403);
	});

	it('71-73. PDF: authorized, application/pdf, safe attachment filename, real PDF bytes', async () => {
		const me = await linkedUser('EMPLOYEE');
		const w = await directWorld({ userIds: [me.userId] });
		await finalizeOk(w.run.id);
		const [slip] = (await get('/payslips/me', me.cookie)).body.data.items;
		const res = await agent()
			.get(`/api/v1/payslips/me/${slip.id}/pdf`)
			.set('Cookie', me.cookie)
			.buffer(true)
			.parse((r, cb) => {
				const chunks: Buffer[] = [];
				r.on('data', (c: Buffer) => chunks.push(c));
				r.on('end', () => cb(null, Buffer.concat(chunks)));
			});
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toBe('application/pdf');
		expect(res.headers['content-disposition']).toMatch(
			/^attachment; filename="PS-[A-Z0-9-]+\.pdf"$/
		);
		expect(res.headers['cache-control']).toContain('no-store');
		const body = res.body as Buffer;
		expect(body.subarray(0, 5).toString()).toBe('%PDF-');
		expect(body.length).toBeGreaterThan(2000);
		// fonts are embedded (self-hosted, no CDN)
		expect(body.toString('latin1')).toMatch(/NotoSansLao/);
		// unauthenticated → 401
		expect((await agent().get(`/api/v1/payslips/me/${slip.id}/pdf`)).status).toBe(401);
	});
});

// =================================================================================================
// 74-85 snapshot content + privacy
// =================================================================================================
describe('snapshot content', () => {
	it('74-78, 82-85. earnings, deductions, PIT, employee SSO, employer SSO informational; no TIN / SSN / GPS / reasons', async () => {
		const w = await directWorld({ salary: '6000000' });
		await statutoryRule(w.companyId);
		await profile(w.emps[0]!.id, { tin: 'TIN-SECRET-P13', socialSecurityNumber: 'SSN-SECRET-P13' });
		const adj = await post(
			`/payroll/runs/${w.run.id}/employees/${w.emps[0]!.id}/adjustments`,
			ctx.admin,
			{
				type: 'DEDUCTION',
				code: 'ADV_P13',
				nameLao: 'ຫັກເງິນເບີກລ່ວງໜ້າ',
				amount: '100000',
				reason: 'ADJ-REASON-SECRET-P13'
			}
		);
		expect(adj.status, JSON.stringify(adj.body)).toBe(201);
		await calc(w.run.id);
		await finalizeOk(w.run.id);
		const p = await payslipOf(w.run.id, w.emps[0]!.id);
		const s = p.snapshot;
		expect(s.earnings.map((e) => e.code)).toContain('BASE_SALARY'); // 74
		expect(s.deductions.map((d) => d.code)).toContain('ADV_P13'); // 75
		expect(s.statutory!.pit).toMatchObject({ direction: 'DEDUCTION' }); // 76
		expect(s.statutory!.employeeSocialSecurity).toMatchObject({
			amount: '247500.00',
			direction: 'DEDUCTION'
		}); // 77
		expect(s.statutory!.employerSocialSecurity).toBe('270000.00'); // 78 informational
		// statutory lines are NOT duplicated inside the generic deductions list, and employer SSO is not a deduction
		expect(s.deductions.map((d) => d.code)).not.toContain('SOCIAL_SECURITY_EMPLOYEE');
		expect(s.totals.employerContributionTotal).toBe('270000.00');
		const expectedNet = new Prisma.Decimal(s.totals.totalEarnings)
			.minus(s.totals.totalDeductions)
			.toFixed(2);
		expect(s.totals.netPay).toBe(expectedNet); // employer cost never reduces net pay
		// every money value is a fixed-2 string
		for (const line of [...s.earnings, ...s.deductions])
			expect(line.amount).toMatch(/^-?\d+\.\d{2}$/);

		const raw = JSON.stringify(await prisma.payslip.findUniqueOrThrow({ where: { id: p.id } }));
		for (const secret of ['TIN-SECRET-P13', 'SSN-SECRET-P13', 'ADJ-REASON-SECRET-P13']) {
			expect(raw, secret).not.toContain(secret); // 82, 83, 85
		}
		for (const key of [
			'latitude',
			'longitude',
			'checkIn',
			'punch',
			'selfie',
			'"tin"',
			'socialSecurityNumber'
		]) {
			expect(raw, key).not.toContain(key); // 84
		}
	});

	it('79. a statutory CREDIT is rendered as an ADDITION (never a negative deduction)', async () => {
		const companyId = await newCompany();
		await statutoryRule(companyId, { sso: false });
		const emp = await employee(companyId, { salary: '3000000' });
		await profile(emp.id);
		const [c1, c2] = await twoCycleSchedule(companyId);
		const r1 = await newRun(companyId, c1!.id);
		await calc(r1.id);
		await finalizeOk(r1.id);
		// simulate a large withholding already frozen in cycle 1 (e.g. a one-off bonus of that cycle)
		const res1 = await prisma.payrollEmployeeResult.findFirstOrThrow({
			where: { payrollRunId: r1.id }
		});
		await prisma.payrollStatutoryResult.update({
			where: { payrollEmployeeResultId: res1.id },
			data: {
				pitTaxableGross: new Prisma.Decimal('60000000'),
				pitCurrentCycle: new Prisma.Decimal('12000000')
			}
		});
		const r2 = await newRun(companyId, c2!.id);
		await calc(r2.id);
		await finalizeOk(r2.id);
		const p = await payslipOf(r2.id, emp.id);
		expect(p.snapshot.statutory!.pit).toMatchObject({ direction: 'CREDIT' });
		expect(p.snapshot.statutory!.pit!.amount).toMatch(/^\d+\.\d{2}$/); // positive, shown as "+"
		expect(p.snapshot.deductions.map((d) => d.code)).not.toContain('PIT');
		// 80-81. cycle context
		expect(p.snapshot.payroll.cycleNumber).toBe(2);
		expect(p.snapshot.compensation?.monthlyBaseSalary).toBe('3000000.00');
		expect(p.snapshot.compensation?.cycleBaseSalary).toBe('1500000.00');
	});
});

// =================================================================================================
// 86-89 notifications + audit
// =================================================================================================
describe('payslip notifications and audit', () => {
	it('86-89. first issue notifies the linked user once (no amount); retries never duplicate; audit has no amount', async () => {
		const me = await linkedUser('EMPLOYEE');
		const w = await directWorld({ employees: 2, userIds: [me.userId, null], salary: '5432100' });
		await finalizeOk(w.run.id);
		const notes = await prisma.notification.findMany({
			where: { userId: me.userId, type: 'PAYSLIP_ISSUED' }
		});
		expect(notes).toHaveLength(1);
		const [slip] = (await get('/payslips/me', me.cookie)).body.data.items;
		expect(notes[0]!.link).toBe(`/app/my-payslips/${slip.id}`);
		expect(notes[0]!.titleLao).toContain(w.period.name);
		// idempotent regeneration — no new notification
		await generate(w.run.id);
		expect(
			await prisma.notification.count({ where: { userId: me.userId, type: 'PAYSLIP_ISSUED' } })
		).toBe(1);
		const audits = await prisma.auditEvent.findMany({
			where: {
				action: { in: ['PAYSLIP.CREATED', 'PAYSLIP.BATCH_CREATED'] },
				companyId: w.companyId
			}
		});
		expect(audits.filter((a) => a.action === 'PAYSLIP.CREATED')).toHaveLength(2);
		expect(audits.find((a) => a.action === 'PAYSLIP.BATCH_CREATED')!.metadataJson).toMatchObject({
			count: 2
		});
		const run = await get(`/payroll/runs/${w.run.id}`, ctx.admin);
		const blob = JSON.stringify([notes, audits]);
		for (const n of [
			...moneyNeedles(run.body.data.summary.netPay),
			...moneyNeedles('5432100.00')
		]) {
			expect(blob, n).not.toContain(n);
		}
	});

	it('95. TIN / SSN never leak through payslip, run, approval or employee endpoints', async () => {
		const me = await linkedUser('EMPLOYEE');
		const w = await directWorld({ userIds: [me.userId] });
		await statutoryRule(w.companyId);
		await profile(w.emps[0]!.id, { tin: 'TIN-LEAK-P13', socialSecurityNumber: 'SSN-LEAK-P13' });
		await calc(w.run.id);
		await finalizeOk(w.run.id);
		const [slip] = await runPayslips(w.run.id);
		const bodies = await Promise.all([
			get(`/payslips/${slip!.id}`, ctx.admin),
			get(`/payslips/me/${slip!.id}`, me.cookie),
			get(`/payslips/me`, me.cookie),
			get(`/payroll/runs/${w.run.id}`, ctx.admin),
			get(`/payroll/runs/${w.run.id}/payslips`, ctx.admin),
			get(`/employees/${w.emps[0]!.id}`, ctx.admin)
		]);
		const blob = JSON.stringify(bodies.map((b) => b.body));
		expect(blob).not.toContain('TIN-LEAK-P13');
		expect(blob).not.toContain('SSN-LEAK-P13');
		void put;
	});
});
