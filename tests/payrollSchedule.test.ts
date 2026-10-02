import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { agent, createTestCompany, superAdminCookie, userWithPermissions } from './helpers.js';
import { prisma } from '../src/config/prisma.js';

const uid = () => randomUUID().slice(0, 6).toUpperCase();
const get = (path: string, cookie: string) => agent().get(`/api/v1${path}`).set('Cookie', cookie);
const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const patch = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().patch(`/api/v1${path}`).set('Cookie', cookie).send(body);
const put = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().put(`/api/v1${path}`).set('Cookie', cookie).send(body);
const date = (iso: string) => new Date(`${iso}T00:00:00Z`);

let admin: string;
beforeAll(async () => {
	admin = await superAdminCookie();
});

// ---------- fixtures ----------
async function newCompany() {
	const c = await createTestCompany();
	expect(
		(await put(`/payroll/settings?companyId=${c.id}`, admin, { currencyCode: 'LAK' })).status
	).toBe(200);
	return c.id;
}
async function branch(companyId: string, name = 'ສາຂາ') {
	return prisma.branch.create({ data: { companyId, code: `BR_${uid()}`, nameLao: name } });
}
interface Placement {
	companyId: string;
	branchId?: string | null;
	from: string;
	to?: string | null;
}
/** an employee whose CURRENT placement is the last row, with explicit assignment history */
async function empWithHistory(
	rows: Placement[],
	startDate = '2024-01-01',
	endDate: string | null = null
) {
	const last = rows[rows.length - 1]!;
	const code = `SE_${uid()}`;
	const emp = await prisma.employee.create({
		data: {
			employeeCode: code,
			firstNameLao: 'ພະນັກງານ',
			lastNameLao: code,
			startDate: date(startDate),
			endDate: endDate ? date(endDate) : null,
			companyId: last.companyId,
			branchId: last.branchId ?? null
		}
	});
	for (const r of rows) {
		await prisma.employeeAssignmentHistory.create({
			data: {
				employeeId: emp.id,
				companyId: r.companyId,
				branchId: r.branchId ?? null,
				effectiveFrom: date(r.from),
				effectiveTo: r.to ? date(r.to) : null
			}
		});
	}
	return emp;
}
const simpleEmp = (companyId: string) => empWithHistory([{ companyId, from: '2024-01-01' }]);
const setSalary = (empId: string, amount: string, from = '2026-01-01') =>
	post(`/employees/${empId}/compensation`, admin, { baseSalary: amount, effectiveFrom: from });
async function component(companyId: string, type: 'EARNING' | 'DEDUCTION') {
	const res = await post('/pay-components', admin, {
		companyId,
		code: `C_${uid()}`,
		nameLao: 'ລາຍການ',
		type,
		category: type === 'EARNING' ? 'ALLOWANCE' : 'DEDUCTION'
	});
	return res.body.data as { id: string; code: string };
}
const scheduleBody = (companyId: string, extra: Record<string, unknown> = {}) => ({
	companyId,
	code: `SCH_${uid()}`,
	nameLao: 'ພະນັກງານລາຍເດືອນ',
	payBasis: 'MONTHLY',
	paymentsPerMonth: 'ONE',
	anchorDate: '2026-01-01',
	payDateRule: 'PERIOD_END',
	employeeScope: 'ALL',
	...extra
});
async function schedule(companyId: string, extra: Record<string, unknown> = {}) {
	const res = await post('/payroll-schedules', admin, scheduleBody(companyId, extra));
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; code: string };
}
const range = (fromMonth: string, toMonth = fromMonth) => ({ fromMonth, toMonth });
const generate = (id: string, r: { fromMonth: string; toMonth: string }, cookie = admin) =>
	post(`/payroll-schedules/${id}/generate-periods`, cookie, r);
const preview = (id: string, r: { fromMonth: string; toMonth: string }, cookie = admin) =>
	post(`/payroll-schedules/${id}/preview-periods`, cookie, r);
async function periodOf(companyId: string, code: string, start: string, end: string) {
	const res = await post('/payroll/periods', admin, {
		companyId,
		code,
		name: code,
		startDate: start,
		endDate: end,
		payDate: end
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
}
async function runFor(companyId: string, periodId: string) {
	const res = await post('/payroll/runs', admin, { companyId, periodId });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; schedule: { id: string } | null };
}
const calc = (runId: string) => post(`/payroll/runs/${runId}/calculate`, admin);
async function results(runId: string) {
	const res = await get(`/payroll/runs/${runId}/results?pageSize=100`, admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data.items as {
		id: string;
		employee: { id: string };
		branch: { id: string; nameLao: string } | null;
		department: { nameLao: string } | null;
		baseSalary: string | null;
		netPay: string;
		calculationStatus: 'READY' | 'BLOCKED';
		issues: { code: string }[];
	}[];
}
const resultOf = async (runId: string, empId: string) =>
	(await results(runId)).find((r) => r.employee.id === empId);
const audit = (where: Record<string, unknown>) =>
	prisma.auditEvent.findMany({ where, orderBy: { createdAt: 'asc' } });

// ============================================================================================
describe('payroll schedule — configuration', () => {
	it('1. authentication is required', async () => {
		expect((await agent().get('/api/v1/payroll-schedules')).status).toBe(401);
		expect((await agent().post('/api/v1/payroll-schedules').send({})).status).toBe(401);
		expect(
			(await agent().post('/api/v1/payroll-schedules/x/preview-periods').send({})).status
		).toBe(401);
	});

	it('2. viewing needs payroll.view AND the broad scope', async () => {
		const companyId = await newCompany();
		const s = await schedule(companyId);
		const plain = await userWithPermissions(['dashboard.view']);
		expect((await get('/payroll-schedules', plain.cookie)).status).toBe(403);
		const noScope = await userWithPermissions(['payroll.view']);
		expect((await get('/payroll-schedules', noScope.cookie)).status).toBe(403);
		expect((await get(`/payroll-schedules/${s.id}`, noScope.cookie)).status).toBe(403);
		const viewer = await userWithPermissions(['payroll.view', 'employees.view_all']);
		expect((await get('/payroll-schedules', viewer.cookie)).status).toBe(200);
		expect((await get(`/payroll-schedules/${s.id}`, viewer.cookie)).status).toBe(200);
		expect((await preview(s.id, range('2026-10'), viewer.cookie)).status).toBe(200);
		expect((await post('/payroll-schedules', viewer.cookie, scheduleBody(companyId))).status).toBe(
			403
		);
		expect((await generate(s.id, range('2026-10'), viewer.cookie)).status).toBe(403);
	});

	it('3. changing needs payroll.manage', async () => {
		const companyId = await newCompany();
		const manager = await userWithPermissions(['payroll.manage', 'employees.view_all']);
		const res = await post('/payroll-schedules', manager.cookie, scheduleBody(companyId));
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(
			(await patch(`/payroll-schedules/${res.body.data.id}`, manager.cookie, { nameLao: 'ຊື່ໃໝ່' }))
				.status
		).toBe(200);
		const viewer = await userWithPermissions(['payroll.view', 'employees.view_all']);
		expect(
			(await patch(`/payroll-schedules/${res.body.data.id}`, viewer.cookie, { nameLao: 'x' }))
				.status
		).toBe(403);
	});

	it('4. creates a monthly schedule with the documented defaults', async () => {
		const companyId = await newCompany();
		const res = await post('/payroll-schedules', admin, {
			companyId,
			code: 'MONTHLY-STAFF',
			nameLao: 'ພະນັກງານລາຍເດືອນ',
			anchorDate: '2026-01-01'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data).toMatchObject({
			code: 'MONTHLY-STAFF',
			payBasis: 'MONTHLY',
			paymentsPerMonth: 'ONE',
			splitDay: null,
			payDateRule: 'PERIOD_END',
			employeeScope: 'ALL',
			groupByBranch: false,
			status: 'ACTIVE',
			memberCount: 0,
			periodCount: 0
		});
		expect(res.body.data.anchorDate).toContain('2026-01-01');
	});

	it('5. a duplicate code is rejected within a company (allowed in another)', async () => {
		const a = await newCompany();
		const b = await newCompany();
		const body = scheduleBody(a);
		expect((await post('/payroll-schedules', admin, body)).status).toBe(201);
		const dup = await post('/payroll-schedules', admin, body);
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('PAYROLL_SCHEDULE_CODE_TAKEN');
		expect((await post('/payroll-schedules', admin, { ...body, companyId: b })).status).toBe(201);
	});

	it('6. an inactive schedule cannot generate; preview and existing periods stay usable', async () => {
		const companyId = await newCompany();
		const s = await schedule(companyId);
		expect((await generate(s.id, range('2026-10'))).status).toBe(200);
		expect(
			(await patch(`/payroll-schedules/${s.id}`, admin, { status: 'INACTIVE' })).body.data.status
		).toBe('INACTIVE');
		const res = await generate(s.id, range('2026-11'));
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_SCHEDULE_INACTIVE');
		expect((await preview(s.id, range('2026-11'))).status).toBe(200);
		// the old period is untouched and still gets a run
		const periods = (await get(`/payroll/periods?companyId=${companyId}`, admin)).body.data.items;
		expect(periods).toHaveLength(1);
		await runFor(companyId, periods[0].id);
	});

	it('7. ONE payment per month has no split day', async () => {
		const companyId = await newCompany();
		const s = await schedule(companyId, { paymentsPerMonth: 'ONE' });
		expect((await get(`/payroll-schedules/${s.id}`, admin)).body.data).toMatchObject({
			paymentsPerMonth: 'ONE',
			splitDay: null
		});
	});

	it('8. TWO payments per month with a split day', async () => {
		const companyId = await newCompany();
		const s = await schedule(companyId, { paymentsPerMonth: 'TWO', splitDay: 15 });
		expect((await get(`/payroll-schedules/${s.id}`, admin)).body.data).toMatchObject({
			paymentsPerMonth: 'TWO',
			splitDay: 15
		});
	});

	it('9. TWO requires a split day', async () => {
		const companyId = await newCompany();
		for (const splitDay of [undefined, null]) {
			const res = await post(
				'/payroll-schedules',
				admin,
				scheduleBody(companyId, { paymentsPerMonth: 'TWO', splitDay })
			);
			expect(res.status).toBe(400);
		}
	});

	it('10. the split day must be an integer 1..28', async () => {
		const companyId = await newCompany();
		for (const splitDay of [0, 29, -1, 1.5, 31]) {
			expect(
				(
					await post(
						'/payroll-schedules',
						admin,
						scheduleBody(companyId, { paymentsPerMonth: 'TWO', splitDay })
					)
				).status,
				String(splitDay)
			).toBe(400);
		}
		for (const splitDay of [1, 28]) {
			expect(
				(
					await post(
						'/payroll-schedules',
						admin,
						scheduleBody(companyId, { paymentsPerMonth: 'TWO', splitDay })
					)
				).status,
				String(splitDay)
			).toBe(201);
		}
	});

	it('11. ONE rejects a split day', async () => {
		const companyId = await newCompany();
		const res = await post(
			'/payroll-schedules',
			admin,
			scheduleBody(companyId, { paymentsPerMonth: 'ONE', splitDay: 15 })
		);
		expect(res.status).toBe(400);
	});

	it('12. DAILY can be stored but is safely unsupported for preview / generation / runs', async () => {
		const companyId = await newCompany();
		const s = await schedule(companyId, { payBasis: 'DAILY' });
		for (const fn of [preview, generate]) {
			const res = await fn(s.id, range('2026-10'));
			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe('PAYROLL_BASIS_NOT_SUPPORTED');
		}
		expect(await prisma.payrollPeriod.count({ where: { companyId } })).toBe(0);
		// even a period force-linked to a DAILY schedule cannot become a run
		const p = await prisma.payrollPeriod.create({
			data: {
				companyId,
				code: 'FORCED',
				name: 'x',
				startDate: date('2026-10-01'),
				endDate: date('2026-10-31'),
				payDate: date('2026-10-31'),
				payrollScheduleId: s.id
			}
		});
		const res = await post('/payroll/runs', admin, { companyId, periodId: p.id });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('PAYROLL_BASIS_NOT_SUPPORTED');
	});

	it('13. a SELECTED schedule keeps its members (company employees only)', async () => {
		const a = await newCompany();
		const b = await newCompany();
		const e1 = await simpleEmp(a);
		const e2 = await simpleEmp(a);
		const foreign = await simpleEmp(b);
		const noMembers = await post(
			'/payroll-schedules',
			admin,
			scheduleBody(a, { employeeScope: 'SELECTED', employeeIds: [] })
		);
		expect(noMembers.status).toBe(400);
		const wrong = await post(
			'/payroll-schedules',
			admin,
			scheduleBody(a, { employeeScope: 'SELECTED', employeeIds: [e1.id, foreign.id] })
		);
		expect(wrong.status).toBe(400);
		expect(wrong.body.error.code).toBe('INVALID_SCHEDULE_EMPLOYEES');
		const s = await schedule(a, { employeeScope: 'SELECTED', employeeIds: [e1.id, e2.id] });
		const detail = (await get(`/payroll-schedules/${s.id}`, admin)).body.data;
		expect(detail.memberCount).toBe(2);
		expect(detail.employees.map((e: { id: string }) => e.id).sort()).toEqual([e1.id, e2.id].sort());
		// membership rows hold no salary
		expect(JSON.stringify(detail)).not.toMatch(/salary/i);
	});

	it('14. scope ALL keeps no members and rejects a list', async () => {
		const a = await newCompany();
		const e1 = await simpleEmp(a);
		const res = await post(
			'/payroll-schedules',
			admin,
			scheduleBody(a, { employeeScope: 'ALL', employeeIds: [e1.id] })
		);
		expect(res.status).toBe(400);
		const s = await schedule(a, { employeeScope: 'SELECTED', employeeIds: [e1.id] });
		const back = await patch(`/payroll-schedules/${s.id}`, admin, { employeeScope: 'ALL' });
		expect(back.body.data).toMatchObject({ employeeScope: 'ALL', memberCount: 0 });
	});

	it('14b. structure is frozen once periods exist; names and scope stay editable', async () => {
		const a = await newCompany();
		const s = await schedule(a);
		await generate(s.id, range('2026-10'));
		const frozen = await patch(`/payroll-schedules/${s.id}`, admin, {
			paymentsPerMonth: 'TWO',
			splitDay: 15
		});
		expect(frozen.status).toBe(409);
		expect(frozen.body.error.code).toBe('PAYROLL_SCHEDULE_HAS_PERIODS');
		expect(
			(await patch(`/payroll-schedules/${s.id}`, admin, { anchorDate: '2026-05-01' })).status
		).toBe(409);
		expect(
			(await patch(`/payroll-schedules/${s.id}`, admin, { nameLao: 'ຊື່ໃໝ່', groupByBranch: true }))
				.status
		).toBe(200);
		// the same value is not a "change"
		expect(
			(await patch(`/payroll-schedules/${s.id}`, admin, { paymentsPerMonth: 'ONE' })).status
		).toBe(200);
	});
});

// ============================================================================================
describe('payroll schedule — period preview', () => {
	it('15. ONE produces one preview period per month', async () => {
		const a = await newCompany();
		const s = await schedule(a, { code: 'MONTHLY-STAFF' });
		const res = await preview(s.id, range('2026-10', '2026-12'));
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data.periods).toHaveLength(3);
		expect(res.body.data.periods[0]).toMatchObject({
			code: 'MONTHLY-STAFF-2026-10',
			startDate: '2026-10-01',
			endDate: '2026-10-31',
			payDate: '2026-10-31',
			cycleNumber: 1,
			state: 'NEW'
		});
		expect(res.body.data.periods[1]).toMatchObject({
			startDate: '2026-11-01',
			endDate: '2026-11-30'
		});
		expect(res.body.data.periods[2]).toMatchObject({
			startDate: '2026-12-01',
			endDate: '2026-12-31'
		});
	});

	it('16. TWO produces two periods per month (split day 15)', async () => {
		const a = await newCompany();
		const s = await schedule(a, { code: 'TWICE', paymentsPerMonth: 'TWO', splitDay: 15 });
		const res = await preview(s.id, range('2026-10'));
		expect(res.body.data.periods).toEqual([
			expect.objectContaining({
				code: 'TWICE-2026-10-1',
				startDate: '2026-10-01',
				endDate: '2026-10-15',
				payDate: '2026-10-15',
				cycleNumber: 1
			}),
			expect.objectContaining({
				code: 'TWICE-2026-10-2',
				startDate: '2026-10-16',
				endDate: '2026-10-31',
				payDate: '2026-10-31',
				cycleNumber: 2
			})
		]);
	});

	it('17. month ends are right (30/31-day months and February)', async () => {
		const a = await newCompany();
		const s = await schedule(a, { paymentsPerMonth: 'TWO', splitDay: 15 });
		const ends = (await preview(s.id, range('2027-01', '2027-04'))).body.data.periods
			.filter((p: { cycleNumber: number }) => p.cycleNumber === 2)
			.map((p: { endDate: string }) => p.endDate);
		expect(ends).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
	});

	it('18. a leap-year February ends on the 29th', async () => {
		const a = await newCompany();
		const one = await schedule(a);
		expect((await preview(one.id, range('2028-02'))).body.data.periods[0]).toMatchObject({
			startDate: '2028-02-01',
			endDate: '2028-02-29'
		});
		const two = await schedule(a, { paymentsPerMonth: 'TWO', splitDay: 28 });
		const p = (await preview(two.id, range('2028-02'))).body.data.periods;
		expect(p[0]).toMatchObject({ endDate: '2028-02-28' });
		expect(p[1]).toMatchObject({ startDate: '2028-02-29', endDate: '2028-02-29' });
		// 28-day February with split day 28: no second cycle — the month is one period, never an inverted cycle 2
		const feb = (await preview(two.id, range('2027-02'))).body.data.periods;
		expect(feb).toHaveLength(1);
		expect(feb[0]).toMatchObject({
			startDate: '2027-02-01',
			endDate: '2027-02-28',
			cycleNumber: 1
		});
	});

	it('19. the anchor date is enforced (earlier cycles are not proposed)', async () => {
		const a = await newCompany();
		const two = await schedule(a, {
			paymentsPerMonth: 'TWO',
			splitDay: 15,
			anchorDate: '2026-10-16'
		});
		const res = await preview(two.id, range('2026-10', '2026-11'));
		expect(res.body.data.skippedBeforeAnchor).toBe(1);
		expect(res.body.data.periods.map((p: { startDate: string }) => p.startDate)).toEqual([
			'2026-10-16',
			'2026-11-01',
			'2026-11-16'
		]);
		const one = await schedule(a, { anchorDate: '2026-10-02' });
		const r2 = await preview(one.id, range('2026-10', '2026-11'));
		expect(r2.body.data.periods).toHaveLength(1);
		expect(r2.body.data.periods[0].startDate).toBe('2026-11-01');
	});

	it('20. payDate follows PERIOD_END', async () => {
		const a = await newCompany();
		const s = await schedule(a, { paymentsPerMonth: 'TWO', splitDay: 10 });
		for (const p of (await preview(s.id, range('2026-10', '2026-11'))).body.data.periods) {
			expect(p.payDate).toBe(p.endDate);
		}
		expect(
			(
				await post(
					'/payroll-schedules',
					admin,
					scheduleBody(a, { payDateRule: 'FIXED_DAY_AFTER_PERIOD' })
				)
			).status
		).toBe(400);
	});

	it('21. preview writes nothing and validates the month range', async () => {
		const a = await newCompany();
		const s = await schedule(a);
		const before = await prisma.payrollPeriod.count();
		expect((await preview(s.id, range('2026-10', '2026-12'))).status).toBe(200);
		expect(await prisma.payrollPeriod.count()).toBe(before);
		for (const r of [
			range('2026-12', '2026-10'),
			range('2026-1', '2026-2'),
			range('2026-13'),
			range('2026-01', '2028-06')
		]) {
			expect((await preview(s.id, r)).status, JSON.stringify(r)).toBe(400);
		}
		expect((await preview(2147483647 as never, range('2026-10'))).status).toBe(404);
		expect((await preview('does-not-exist', range('2026-10'))).status).toBe(400);
	});

	it('21b. preview reports EXISTS and CONFLICT states', async () => {
		const a = await newCompany();
		const s = await schedule(a, { code: 'ONE' });
		await generate(s.id, range('2026-10'));
		await periodOf(a, 'MANUAL-NOV', '2026-11-10', '2026-11-20');
		const res = await preview(s.id, range('2026-10', '2026-12'));
		expect(res.body.data.periods.map((p: { state: string }) => p.state)).toEqual([
			'EXISTS',
			'CONFLICT',
			'NEW'
		]);
		expect(res.body.data.periods[1].conflict).toContain('PAYROLL_PERIOD_OVERLAP');
	});
});

// ============================================================================================
describe('payroll schedule — period generation', () => {
	it('22. generates the periods', async () => {
		const a = await newCompany();
		const s = await schedule(a, { code: 'MONTHLY-STAFF' });
		const res = await generate(s.id, range('2026-10', '2026-12'));
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data).toMatchObject({ createdCount: 3, skippedCount: 0 });
		const rows = await prisma.payrollPeriod.findMany({
			where: { companyId: a },
			orderBy: { startDate: 'asc' }
		});
		expect(rows.map((r) => r.code)).toEqual([
			'MONTHLY-STAFF-2026-10',
			'MONTHLY-STAFF-2026-11',
			'MONTHLY-STAFF-2026-12'
		]);
		expect(rows.every((r) => r.status === 'OPEN')).toBe(true);
	});

	it('23. a retry is idempotent', async () => {
		const a = await newCompany();
		const s = await schedule(a);
		await generate(s.id, range('2026-10', '2026-12'));
		const ids = (
			await prisma.payrollPeriod.findMany({
				where: { companyId: a },
				orderBy: { startDate: 'asc' }
			})
		).map((p) => p.id);
		const again = await generate(s.id, range('2026-10', '2026-12'));
		expect(again.status).toBe(200);
		expect(again.body.data).toMatchObject({ createdCount: 0, skippedCount: 3 });
		expect(
			(
				await prisma.payrollPeriod.findMany({
					where: { companyId: a },
					orderBy: { startDate: 'asc' }
				})
			).map((p) => p.id)
		).toEqual(ids);
		// extending the range creates only the new month
		const more = await generate(s.id, range('2026-10', '2027-01'));
		expect(more.body.data).toMatchObject({ createdCount: 1, skippedCount: 3 });
	});

	it('24. concurrent generation never duplicates', async () => {
		const a = await newCompany();
		const s = await schedule(a, { paymentsPerMonth: 'TWO', splitDay: 15 });
		const results = await Promise.all([
			generate(s.id, range('2026-10', '2026-11')),
			generate(s.id, range('2026-10', '2026-11'))
		]);
		expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
		expect(await prisma.payrollPeriod.count({ where: { companyId: a } })).toBe(4);
		const seqs = (await prisma.payrollPeriod.findMany({ where: { companyId: a } })).map(
			(p) => p.sequenceNumber
		);
		expect(new Set(seqs).size).toBe(4);
	});

	it('25. an overlap with any existing period refuses the whole request', async () => {
		const a = await newCompany();
		const s = await schedule(a);
		await periodOf(a, 'MANUAL-NOV', '2026-11-15', '2026-11-20');
		const res = await generate(s.id, range('2026-10', '2026-12'));
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_PERIOD_OVERLAP');
		expect(res.body.error.details.conflicts).toHaveLength(1);
		expect(
			await prisma.payrollPeriod.count({ where: { companyId: a, generatedBySchedule: true } })
		).toBe(0); // nothing partial
		// a second schedule of the same company cannot generate over the first one's periods either
		const first = await schedule(a, { code: 'FIRST', anchorDate: '2027-01-01' });
		await generate(first.id, range('2027-03'));
		const second = await schedule(a, {
			code: 'SECOND',
			paymentsPerMonth: 'TWO',
			splitDay: 15,
			anchorDate: '2027-01-01'
		});
		expect((await generate(second.id, range('2027-03'))).status).toBe(409);
	});

	it('26. generated periods are linked to their schedule', async () => {
		const a = await newCompany();
		const s = await schedule(a, { paymentsPerMonth: 'TWO', splitDay: 15 });
		await generate(s.id, range('2026-10'));
		const rows = await prisma.payrollPeriod.findMany({
			where: { companyId: a },
			orderBy: { startDate: 'asc' }
		});
		expect(rows.map((r) => [r.payrollScheduleId, r.cycleNumber, r.generatedBySchedule])).toEqual([
			[s.id, 1, true],
			[s.id, 2, true]
		]);
		expect(rows[0]!.sequenceNumber).not.toBe(rows[1]!.sequenceNumber);
		const list = (await get(`/payroll/periods?companyId=${a}`, admin)).body.data.items;
		expect(list.find((p: { cycleNumber?: number }) => p)).toBeTruthy();
		expect(list[0].schedule).toMatchObject({ id: s.id, paymentsPerMonth: 'TWO' });
	});

	it('27. manual periods stay valid (no schedule, no data migration)', async () => {
		const a = await newCompany();
		const p = await periodOf(a, '2026-09', '2026-09-01', '2026-09-30');
		const row = await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: p.id } });
		expect(row).toMatchObject({
			payrollScheduleId: null,
			cycleNumber: null,
			generatedBySchedule: false
		});
		const s = await schedule(a, { anchorDate: '2026-10-01' });
		await generate(s.id, range('2026-10'));
		const run = await runFor(a, p.id);
		expect(run.schedule).toBeNull();
		expect((await calc(run.id)).status).toBe(200);
		expect((await patch(`/payroll/periods/${p.id}`, admin, { name: 'ແກ້ຊື່ໄດ້' })).status).toBe(
			200
		);
	});

	it('28. an inactive schedule cannot generate new periods', async () => {
		const a = await newCompany();
		const s = await schedule(a, { status: 'INACTIVE' });
		const res = await generate(s.id, range('2026-10'));
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_SCHEDULE_INACTIVE');
		expect(await prisma.payrollPeriod.count({ where: { companyId: a } })).toBe(0);
	});

	it('29. a client cannot smuggle schedule identity into manual periods or the generator', async () => {
		const a = await newCompany();
		const s = await schedule(a);
		const base = {
			companyId: a,
			code: 'TRICK',
			name: 'x',
			startDate: '2026-10-01',
			endDate: '2026-10-31',
			payDate: '2026-10-31'
		};
		for (const extra of [
			{ payrollScheduleId: s.id },
			{ generatedBySchedule: true },
			{ cycleNumber: 1 },
			{ sequenceNumber: 5 }
		]) {
			expect(
				(await post('/payroll/periods', admin, { ...base, ...extra })).status,
				JSON.stringify(extra)
			).toBe(400);
		}
		const p = await periodOf(a, 'REAL', '2026-09-01', '2026-09-30');
		expect(
			(await patch(`/payroll/periods/${p.id}`, admin, { payrollScheduleId: s.id })).status
		).toBe(400);
		expect(
			(
				await generate(s.id, {
					...range('2026-10'),
					code: 'MINE',
					startDate: '2026-10-05'
				} as never)
			).status
		).toBe(400);
		expect(
			await prisma.payrollPeriod.count({ where: { companyId: a, generatedBySchedule: true } })
		).toBe(0);
	});

	it('30. company mismatches are rejected', async () => {
		const a = await newCompany();
		const b = await newCompany();
		const s = await schedule(a);
		await generate(s.id, range('2026-10'));
		const period = await prisma.payrollPeriod.findFirstOrThrow({ where: { companyId: a } });
		const wrong = await post('/payroll/runs', admin, { companyId: b, periodId: period.id });
		expect(wrong.status).toBe(400);
		const foreign = await simpleEmp(b);
		const res = await patch(`/payroll-schedules/${s.id}`, admin, {
			employeeScope: 'SELECTED',
			employeeIds: [foreign.id]
		});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('INVALID_SCHEDULE_EMPLOYEES');
	});
});

// ============================================================================================
describe('historical company resolution', () => {
	/** company A Jan–Jun, company B from 1 July; both companies have a May period */
	async function twoCompanies() {
		const a = await newCompany();
		const b = await newCompany();
		const emp = await empWithHistory([
			{ companyId: a, from: '2024-01-01', to: '2026-07-01' },
			{ companyId: b, from: '2026-07-01' }
		]);
		expect((await setSalary(emp.id, '4000000')).status, 'salary').toBe(201);
		const pa = await periodOf(a, '2026-05', '2026-05-01', '2026-05-31');
		const pb = await periodOf(b, '2026-05', '2026-05-01', '2026-05-31');
		return { a, b, emp, runA: await runFor(a, pa.id), runB: await runFor(b, pb.id) };
	}

	it('31. an employee now in B but historically in A is included in the historical A period', async () => {
		const { emp, runA } = await twoCompanies();
		expect(emp.companyId).not.toBeNull();
		await calc(runA.id);
		const row = await resultOf(runA.id, emp.id);
		expect(row).toMatchObject({
			calculationStatus: 'READY',
			baseSalary: '4000000.00',
			netPay: '4000000.00'
		});
	});

	it('32. …and is not included in the historical B period', async () => {
		const { emp, runB } = await twoCompanies();
		await calc(runB.id);
		expect(await resultOf(runB.id, emp.id)).toBeUndefined();
	});

	async function midPeriodTransfer() {
		const a = await newCompany();
		const b = await newCompany();
		const emp = await empWithHistory([
			{ companyId: a, from: '2024-01-01', to: '2026-05-15' },
			{ companyId: b, from: '2026-05-15' }
		]);
		await setSalary(emp.id, '4000000');
		const pa = await periodOf(a, '2026-05', '2026-05-01', '2026-05-31');
		const pb = await periodOf(b, '2026-05', '2026-05-01', '2026-05-31');
		return { a, b, emp, runA: await runFor(a, pa.id), runB: await runFor(b, pb.id) };
	}

	it('33. a company transfer INSIDE the period is BLOCKED in both companies (no silent full-month pay)', async () => {
		const { emp, runA, runB } = await midPeriodTransfer();
		await calc(runA.id);
		await calc(runB.id);
		for (const runId of [runA.id, runB.id]) {
			const row = await resultOf(runId, emp.id);
			expect(row!.calculationStatus).toBe('BLOCKED');
		}
		// and finalization refuses
		const fin = await post(`/payroll/runs/${runA.id}/finalize`, admin, {});
		expect(fin.status).toBe(409);
	});

	it('34. the issue code is COMPANY_CHANGE_WITHIN_PERIOD', async () => {
		const { emp, runA } = await midPeriodTransfer();
		await calc(runA.id);
		const row = await resultOf(runA.id, emp.id);
		expect(row!.issues.map((i) => i.code)).toContain('COMPANY_CHANGE_WITHIN_PERIOD');
	});

	it('35. a finalized historical snapshot is unaffected by later transfers and renames', async () => {
		const { a, b, emp, runA } = await twoCompanies();
		await calc(runA.id);
		expect((await post(`/payroll/runs/${runA.id}/finalize`, admin, {})).status).toBe(200);
		// later master-data churn: another transfer, a new branch, a rename
		const br = await branch(b, 'ສາຂາໃໝ່');
		await prisma.employeeAssignmentHistory.updateMany({
			where: { employeeId: emp.id, effectiveTo: null },
			data: { branchId: br.id }
		});
		await prisma.employee.update({
			where: { id: emp.id },
			data: { firstNameLao: 'ປ່ຽນຊື່', branchId: br.id, companyId: a }
		});
		const row = await resultOf(runA.id, emp.id);
		expect(row).toMatchObject({ calculationStatus: 'READY', baseSalary: '4000000.00' });
		expect(row!.branch).toBeNull();
		const d = (await get(`/payroll/results/${row!.id}`, admin)).body.data;
		expect(d.employee.name).toContain('ພະນັກງານ');
	});

	it('35b. legacy employees WITHOUT history rows still use their current company', async () => {
		const a = await newCompany();
		const legacy = await prisma.employee.create({
			data: {
				employeeCode: `LG_${uid()}`,
				firstNameLao: 'ເກົ່າ',
				lastNameLao: 'ບໍ່ມີປະຫວັດ',
				startDate: date('2024-01-01'),
				companyId: a
			}
		});
		await setSalary(legacy.id, '1000');
		const run = await runFor(a, (await periodOf(a, '2026-10', '2026-10-01', '2026-10-31')).id);
		await calc(run.id);
		expect((await resultOf(run.id, legacy.id))!.calculationStatus).toBe('READY');
	});

	it('35c. the resolver answers company / branch / department / position on a date', async () => {
		const { resolveEmployeeAssignmentAtDate } =
			await import('../src/services/employeeAssignmentResolver.js');
		const a = await newCompany();
		const b = await newCompany();
		const br = await branch(a, 'ສາຂາ A');
		const emp = await empWithHistory([
			{ companyId: a, branchId: br.id, from: '2024-01-01', to: '2026-07-01' },
			{ companyId: b, from: '2026-07-01' }
		]);
		const june = await resolveEmployeeAssignmentAtDate(prisma, emp.id, date('2026-06-30'));
		expect(june).toMatchObject({ companyId: a, branchId: br.id, source: 'HISTORY' });
		expect(june!.branch!.nameLao).toBe('ສາຂາ A');
		const july = await resolveEmployeeAssignmentAtDate(prisma, emp.id, date('2026-07-01'));
		expect(july).toMatchObject({ companyId: b, branchId: null });
		const early = await resolveEmployeeAssignmentAtDate(prisma, emp.id, date('2020-01-01'));
		expect(early!.companyId).toBe(a); // before the first row → the first placement
	});
});

// ============================================================================================
describe('historical branch resolution', () => {
	async function branchCase(groupByBranch: boolean, changeInside = false) {
		const a = await newCompany();
		const x = await branch(a, 'ສາຂາ X');
		const y = await branch(a, 'ສາຂາ Y');
		const changeDate = changeInside ? '2026-05-15' : '2026-07-01';
		const emp = await empWithHistory([
			{ companyId: a, branchId: x.id, from: '2024-01-01', to: changeDate },
			{ companyId: a, branchId: y.id, from: changeDate }
		]);
		await setSalary(emp.id, '3000000');
		const s = await schedule(a, { groupByBranch, anchorDate: '2026-01-01' });
		await generate(s.id, range('2026-05'));
		const period = await prisma.payrollPeriod.findFirstOrThrow({ where: { companyId: a } });
		const run = await runFor(a, period.id);
		await calc(run.id);
		return { a, x, y, emp, run };
	}

	it('36. the historical branch is resolved for the period', async () => {
		const { x, emp, run } = await branchCase(true);
		const row = await resultOf(run.id, emp.id);
		expect(row!.branch).toMatchObject({ id: x.id, nameLao: 'ສາຂາ X' });
		expect(row!.calculationStatus).toBe('READY');
	});

	it("37. the employee's CURRENT branch does not rewrite an old period", async () => {
		const { x, y, emp, run } = await branchCase(true);
		expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } })).branchId).toBe(
			y.id
		);
		const row = await resultOf(run.id, emp.id);
		expect(row!.branch!.id).toBe(x.id);
		await calc(run.id); // recalculation keeps the historical answer
		expect((await resultOf(run.id, emp.id))!.branch!.id).toBe(x.id);
	});

	it('38. a branch change inside a branch-grouped period is BLOCKED', async () => {
		const { emp, run } = await branchCase(true, true);
		const row = await resultOf(run.id, emp.id);
		expect(row!.calculationStatus).toBe('BLOCKED');
		expect(row!.issues.map((i) => i.code)).toContain('BRANCH_CHANGE_WITHIN_PERIOD');
	});

	it('38b. without group-by-branch the same change is not a blocker', async () => {
		const { emp, run } = await branchCase(false, true);
		const row = await resultOf(run.id, emp.id);
		expect(row!.calculationStatus).toBe('READY');
		expect(row!.issues).toHaveLength(0);
	});
});

// ============================================================================================
describe('schedule employee scope', () => {
	async function scoped(scope: 'ALL' | 'SELECTED') {
		const a = await newCompany();
		const member = await simpleEmp(a);
		const other = await simpleEmp(a);
		for (const e of [member, other]) await setSalary(e.id, '1000000');
		const s = await schedule(
			a,
			scope === 'SELECTED' ? { employeeScope: 'SELECTED', employeeIds: [member.id] } : {}
		);
		await generate(s.id, range('2026-10'));
		const period = await prisma.payrollPeriod.findFirstOrThrow({ where: { companyId: a } });
		const run = await runFor(a, period.id);
		await calc(run.id);
		return { a, member, other, run, s };
	}

	it('39. SELECTED includes a member', async () => {
		const { member, run } = await scoped('SELECTED');
		expect(await resultOf(run.id, member.id)).toMatchObject({ calculationStatus: 'READY' });
	});

	it('40. SELECTED excludes a non-member', async () => {
		const { other, run } = await scoped('SELECTED');
		expect(await resultOf(run.id, other.id)).toBeUndefined();
		expect((await results(run.id)).length).toBe(1);
	});

	it('41. ALL includes every eligible employee', async () => {
		const { member, other, run } = await scoped('ALL');
		expect(await resultOf(run.id, member.id)).toBeTruthy();
		expect(await resultOf(run.id, other.id)).toBeTruthy();
	});

	it('41b. membership never bypasses the historical company check', async () => {
		const a = await newCompany();
		const b = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '1000000');
		const s = await schedule(a, { employeeScope: 'SELECTED', employeeIds: [emp.id] });
		await generate(s.id, range('2026-10'));
		// the member moves to company B before October (history: A until 2026-09-01)
		await prisma.employeeAssignmentHistory.updateMany({
			where: { employeeId: emp.id },
			data: { effectiveTo: date('2026-09-01') }
		});
		await prisma.employeeAssignmentHistory.create({
			data: { employeeId: emp.id, companyId: b, effectiveFrom: date('2026-09-01') }
		});
		await prisma.employee.update({ where: { id: emp.id }, data: { companyId: b } });
		const period = await prisma.payrollPeriod.findFirstOrThrow({ where: { companyId: a } });
		const run = await runFor(a, period.id);
		await calc(run.id);
		expect(await resultOf(run.id, emp.id)).toBeUndefined();
	});

	it('41c. editing the membership takes effect at the next calculation only', async () => {
		const { other, member, run, s } = await scoped('SELECTED');
		expect(
			(await patch(`/payroll-schedules/${s.id}`, admin, { employeeIds: [member.id, other.id] }))
				.body.data.memberCount
		).toBe(2);
		expect(await resultOf(run.id, other.id)).toBeUndefined(); // stored run untouched
		await calc(run.id);
		expect(await resultOf(run.id, other.id)).toBeTruthy();
	});
});

// ============================================================================================
describe('runs from schedule-generated periods', () => {
	async function standard() {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		const house = await component(a, 'EARNING');
		const loan = await component(a, 'DEDUCTION');
		expect((await setSalary(emp.id, '5000000')).status).toBe(201);
		expect(
			(
				await post(`/employees/${emp.id}/recurring-pay-components`, admin, {
					payComponentId: house.id,
					amount: '500000',
					effectiveFrom: '2026-01-01'
				})
			).status
		).toBe(201);
		expect(
			(
				await post(`/employees/${emp.id}/recurring-pay-components`, admin, {
					payComponentId: loan.id,
					amount: '300000',
					effectiveFrom: '2026-01-01'
				})
			).status
		).toBe(201);
		const s = await schedule(a, { code: 'MONTHLY-STAFF' });
		await generate(s.id, range('2026-10', '2026-12'));
		const period = await prisma.payrollPeriod.findFirstOrThrow({
			where: { companyId: a },
			orderBy: { startDate: 'asc' }
		});
		const run = await runFor(a, period.id);
		return { a, emp, s, period, run };
	}

	it('42. a schedule-generated period creates a normal run carrying the schedule context', async () => {
		const { s, run } = await standard();
		expect(run.schedule).toMatchObject({ id: s.id, code: 'MONTHLY-STAFF' });
		const detail = (await get(`/payroll/runs/${run.id}`, admin)).body.data;
		expect(detail).toMatchObject({ status: 'DRAFT', calculationVersion: 1, currencyCode: 'LAK' });
		expect(detail.period.cycleNumber).toBe(1);
		expect(
			(await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).payrollScheduleId
		).toBe(s.id);
		// one run per period still holds
		const dup = await post('/payroll/runs', admin, {
			companyId: detail.companyId,
			periodId: detail.period.id
		});
		expect(dup.status).toBe(409);
	});

	it('43. the calculation is still the Phase 11 formula', async () => {
		const { emp, run } = await standard();
		await calc(run.id);
		expect(await resultOf(run.id, emp.id)).toMatchObject({
			baseSalary: '5000000.00',
			netPay: '5200000.00',
			calculationStatus: 'READY'
		});
		const d = (await get(`/payroll/results/${(await resultOf(run.id, emp.id))!.id}`, admin)).body
			.data;
		expect(d.totalEarnings).toBe('5500000.00');
		expect(d.totalDeductions).toBe('300000.00');
	});

	it('44–47. no tax / social security / OT money / attendance deduction lines', async () => {
		const { emp, run } = await standard();
		await calc(run.id);
		const d = (await get(`/payroll/results/${(await resultOf(run.id, emp.id))!.id}`, admin)).body
			.data;
		const codes = d.items.map((i: { code: string }) => i.code);
		expect(codes).toHaveLength(3);
		for (const forbidden of [
			'TAX',
			'PIT',
			'SOCIAL_SECURITY',
			'SSO',
			'OVERTIME',
			'OT',
			'LATE',
			'ABSENT',
			'LEAVE'
		]) {
			expect(codes).not.toContain(forbidden);
		}
		expect(
			d.items.every((i: { source: string }) =>
				['BASE_SALARY', 'RECURRING', 'MANUAL'].includes(i.source)
			)
		).toBe(true);
	});

	it('47b. finalization and immutability work on a generated period', async () => {
		const { run, period } = await standard();
		await calc(run.id);
		expect((await post(`/payroll/runs/${run.id}/finalize`, admin, {})).status).toBe(200);
		expect((await get(`/payroll/periods/${period.id}`, admin)).body.data.status).toBe('CLOSED');
		expect((await calc(run.id)).status).toBe(409);
	});
});

// ============================================================================================
describe('payroll schedule audit', () => {
	it('48. creating a schedule is audited', async () => {
		const a = await newCompany();
		const s = await schedule(a, { code: 'AUD-CREATE', paymentsPerMonth: 'TWO', splitDay: 15 });
		const rows = await audit({ action: 'PAYROLL_SCHEDULE.CREATED', entityId: String(s.id) });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ entityType: 'PAYROLL_SCHEDULE', companyId: a });
		expect(rows[0]!.metadataJson).toMatchObject({
			code: 'AUD-CREATE',
			paymentsPerMonth: 'TWO',
			splitDay: 15,
			employeeScope: 'ALL'
		});
		expect(rows[0]!.actorUserId).toBeTruthy();
	});

	it('49. updating a schedule is audited with a config diff (and skipped when nothing changed)', async () => {
		const a = await newCompany();
		const s = await schedule(a);
		await patch(`/payroll-schedules/${s.id}`, admin, { nameLao: 'ຊື່ໃໝ່', groupByBranch: true });
		await patch(`/payroll-schedules/${s.id}`, admin, { nameLao: 'ຊື່ໃໝ່' }); // no-op
		const rows = await audit({ action: 'PAYROLL_SCHEDULE.UPDATED', entityId: String(s.id) });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.changesJson).toMatchObject({
			nameLao: { before: 'ພະນັກງານລາຍເດືອນ', after: 'ຊື່ໃໝ່' },
			groupByBranch: { before: false, after: true }
		});
	});

	it('50. period generation is audited with the count and ids (only when something was created)', async () => {
		const a = await newCompany();
		const s = await schedule(a);
		await generate(s.id, range('2026-10', '2026-12'));
		await generate(s.id, range('2026-10', '2026-12')); // idempotent retry: no second event
		const rows = await audit({
			action: 'PAYROLL_SCHEDULE.PERIODS_GENERATED',
			entityId: String(s.id)
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]!.metadataJson).toMatchObject({
			fromMonth: '2026-10',
			toMonth: '2026-12',
			createdCount: 3,
			skippedCount: 0
		});
		expect((rows[0]!.metadataJson as { periodIds: string[] }).periodIds).toHaveLength(3);
	});

	it('51. no salary reaches the schedule audit events or the audit API', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '7654321');
		const s = await schedule(a, { employeeScope: 'SELECTED', employeeIds: [emp.id] });
		await generate(s.id, range('2026-10'));
		const run = await runFor(
			a,
			(await prisma.payrollPeriod.findFirstOrThrow({ where: { companyId: a } })).id
		);
		await calc(run.id);
		const scheduleRows = await prisma.auditEvent.findMany({
			where: { entityType: 'PAYROLL_SCHEDULE' }
		});
		expect(scheduleRows.length).toBeGreaterThan(0);
		expect(JSON.stringify(scheduleRows)).not.toMatch(/7654321|salary/i);
		// the company's other events (compensation) only say "changed" — never the amount
		const allRows = await prisma.auditEvent.findMany({ where: { companyId: a } });
		expect(JSON.stringify(allRows)).not.toMatch(/7654321/);
		const api = JSON.stringify(
			(await get(`/audit-events?entityType=PAYROLL_SCHEDULE&pageSize=100`, admin)).body
		);
		expect(api).not.toMatch(/7654321/);
	});

	it('51b. a refused generation (overlap) writes no audit event and no period', async () => {
		const a = await newCompany();
		const s = await schedule(a);
		await periodOf(a, 'BLOCKER', '2026-11-05', '2026-11-08');
		expect((await generate(s.id, range('2026-10', '2026-12'))).status).toBe(409);
		expect(
			await audit({ action: 'PAYROLL_SCHEDULE.PERIODS_GENERATED', entityId: String(s.id) })
		).toHaveLength(0);
	});
});
