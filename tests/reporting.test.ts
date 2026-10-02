import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { agent, createTestCompany } from './helpers.js';
import { setServerClockForTests } from '../src/lib/clock.js';
import { formatDateOnly, todayInLaos } from '../src/lib/dates.js';
import {
	D,
	FRI,
	MON,
	SAT,
	THU,
	TUE,
	WED,
	get,
	ok,
	post,
	reportingWorld,
	roleSessions,
	withPerms,
	type World
} from './phase17Fixture.js';

/**
 * Phase 17A — reporting security, real dashboard, employee / attendance / leave / OT summaries and
 * input safety (tests 1–66 and 91–99; the money reports are in reportingFinance.test.ts).
 */
let w: World;
let other: World;
let s: { superAdmin: string; hrAdmin: string };

beforeAll(async () => {
	s = await roleSessions();
	w = await reportingWorld();
	other = await reportingWorld(); // a second company — must never leak into company C
}, 120_000);
afterEach(() => setServerClockForTests(null));

type Metrics = Record<string, number | string | null | Record<string, unknown>>;
interface Summary {
	context: Record<string, unknown>;
	totals: Metrics;
	groups: { key: string; code: string | null; label: string; metrics: Metrics }[];
	trend?: Record<string, unknown>[];
	balances?: { year: number; items: Record<string, unknown>[] } | null;
}
interface Dashboard {
	context: Record<string, unknown>;
	employees: (Metrics & { byBranch: unknown[]; byDepartment: unknown[] }) | null;
	attendance:
		| (Record<string, unknown> & {
				metrics: Record<string, number>;
				attendanceRate: { numerator: number; denominator: number; percent: string | null };
				trend: { date: string; present: number }[];
		  })
		| null;
	approvals: {
		waitingForMe: number;
		items: { targetType: string; employee: { id: string } | null }[];
	};
	recentActivity: { source: string; items: Record<string, unknown>[] };
	payroll: unknown;
	payments: unknown;
	accounting: unknown;
}

const q = (params: Record<string, string | undefined>) =>
	'?' +
	Object.entries(params)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
		.join('&');
const dash = async (cookie: string, params: Record<string, string | undefined> = {}) =>
	ok<Dashboard>(await get(`/dashboard/summary${q(params)}`, cookie));
const report = async (
	kind: string,
	cookie: string,
	params: Record<string, string | undefined> = {}
) => ok<Summary>(await get(`/reports/${kind}/summary${q(params)}`, cookie));
// group keys are strings (ids, enum values or type keys alike)
const group = (r: Summary, key: string | number) =>
	r.groups.find((g) => g.key === String(key))?.metrics;

const WEEK = { from: MON, to: FRI };
const JUNE = { from: '2025-06-01', to: '2025-06-30' };

// =====================================================================================
// 1–14 security
// =====================================================================================
describe('reporting security', () => {
	it('1. reports.view is seeded: SUPER_ADMIN, HR_ADMIN and MANAGER hold it, EMPLOYEE does not', async () => {
		const perm = await prisma.permission.findUnique({ where: { code: 'reports.view' } });
		expect(perm).not.toBeNull();
		const holders = await prisma.role.findMany({
			where: { permissions: { some: { permissionId: perm!.id } }, isSystem: true },
			select: { code: true }
		});
		const codes = holders.map((r) => r.code);
		expect(codes).toEqual(expect.arrayContaining(['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER']));
		expect(codes).not.toContain('EMPLOYEE');
	});

	it('2. SUPER_ADMIN may open every report', async () => {
		for (const kind of ['employees', 'attendance', 'leave', 'overtime']) {
			expect(
				(await get(`/reports/${kind}/summary?companyId=${w.companyId}`, s.superAdmin)).status
			).toBe(200);
		}
		for (const kind of ['payroll', 'payments', 'accounting']) {
			expect(
				(await get(`/reports/${kind}/summary?companyId=${w.companyId}`, s.superAdmin)).status
			).toBe(200);
		}
		const opts = ok<{ reports: string[] }>(await get('/reports/filter-options', s.superAdmin));
		expect(opts.reports).toHaveLength(7);
	});

	it('3. HR_ADMIN may open every report (it holds each domain permission + employees.view_all)', async () => {
		for (const kind of [
			'employees',
			'attendance',
			'leave',
			'overtime',
			'payroll',
			'payments',
			'accounting'
		]) {
			const res = await get(`/reports/${kind}/summary?companyId=${w.companyId}`, s.hrAdmin);
			expect(res.status, `${kind} ${JSON.stringify(res.body)}`).toBe(200);
		}
	});

	it('4. MANAGER: team reports only — payroll / payments / accounting are 403', async () => {
		for (const kind of ['employees', 'attendance', 'leave', 'overtime']) {
			expect((await get(`/reports/${kind}/summary`, w.manager.cookie)).status).toBe(200);
		}
		for (const kind of ['payroll', 'payments', 'accounting']) {
			const res = await get(`/reports/${kind}/summary?companyId=${w.companyId}`, w.manager.cookie);
			expect(res.status).toBe(403);
			expect(res.body.error.code).toBe('FORBIDDEN');
		}
		const opts = ok<{ reports: string[]; scope: string }>(
			await get('/reports/filter-options', w.manager.cookie)
		);
		expect(opts.reports).toEqual(['employees', 'attendance', 'leave', 'overtime']);
		expect(opts.scope).toBe('TEAM');
	});

	it('5. EMPLOYEE is denied every organisation report and the filter options', async () => {
		for (const kind of [
			'employees',
			'attendance',
			'leave',
			'overtime',
			'payroll',
			'payments',
			'accounting'
		]) {
			expect((await get(`/reports/${kind}/summary`, w.employeeUser.cookie)).status).toBe(403);
		}
		expect((await get('/reports/filter-options', w.employeeUser.cookie)).status).toBe(403);
	});

	it('6. company isolation: a company filter aggregates that company only; a manager cannot pick another company', async () => {
		const c = await report('employees', s.hrAdmin, { companyId: w.companyId });
		const dbCount = await prisma.employee.count({
			where: { companyId: w.companyId, employmentStatus: { notIn: ['RESIGNED', 'TERMINATED'] } }
		});
		expect(c.totals.total).toBe(dbCount);
		expect(c.totals.total).toBe(7);
		const otherDepts = [other.d1, other.d2];
		expect(c.groups.some((g) => otherDepts.includes(g.key))).toBe(false);
		const res = await get(
			`/reports/employees/summary?companyId=${other.companyId}`,
			w.manager.cookie
		);
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('REPORT_FILTER_NOT_ALLOWED');
		// the manager's own view never contains the other company either
		const mine = await report('employees', w.manager.cookie);
		expect(mine.totals.total).toBe(3);
	});

	it('7. branch filter narrows to the branch', async () => {
		const r = await report('employees', s.hrAdmin, { companyId: w.companyId, branchId: w.b1 });
		expect(r.totals.total).toBe(4); // MGR, A, B, G
		const bad = await get(
			`/reports/employees/summary?companyId=${w.companyId}&branchId=${other.b1}`,
			s.hrAdmin
		);
		expect(bad.status).toBe(400);
		expect(bad.body.error.code).toBe('REPORT_FILTER_INVALID');
	});

	it('8. department filter narrows to the department', async () => {
		const r = await report('employees', s.hrAdmin, { departmentId: w.d2 });
		expect(r.totals).toMatchObject({ total: 2, separated: 1 }); // Cp, Dd (+ F resigned)
	});

	it('9. a manager cannot filter outside the team (known and unknown ids alike → 403)', async () => {
		for (const [field, id] of [
			['departmentId', w.d2],
			['branchId', w.b2],
			['employeeId', w.emp.Cp.id],
			['departmentId', 2147483647]
		]) {
			const res = await get(
				`/reports/attendance/summary?${field}=${id}&from=${MON}&to=${FRI}`,
				w.manager.cookie
			);
			expect(res.status, `${field}=${id}`).toBe(403);
			expect(res.body.error.code).toBe('REPORT_FILTER_NOT_ALLOWED');
		}
		// inside the team it works
		expect(
			(
				await get(
					`/reports/attendance/summary?departmentId=${w.d1}&from=${MON}&to=${FRI}`,
					w.manager.cookie
				)
			).status
		).toBe(200);
	});

	it('10. payroll report requires payroll.view', async () => {
		const c = await withPerms(['reports.view', 'employees.view', 'employees.view_all']);
		expect((await get(`/reports/payroll/summary?companyId=${w.companyId}`, c)).status).toBe(403);
	});

	it('11. payroll report requires employees.view_all', async () => {
		const c = await withPerms(['reports.view', 'payroll.view']);
		expect((await get(`/reports/payroll/summary?companyId=${w.companyId}`, c)).status).toBe(403);
		const full = await withPerms(['reports.view', 'payroll.view', 'employees.view_all']);
		expect((await get(`/reports/payroll/summary?companyId=${w.companyId}`, full)).status).toBe(200);
	});

	it('12. payment report requires payroll.payment.view (+ employees.view_all)', async () => {
		const noPay = await withPerms(['reports.view', 'payroll.view', 'employees.view_all']);
		expect((await get(`/reports/payments/summary?companyId=${w.companyId}`, noPay)).status).toBe(
			403
		);
		const noAll = await withPerms(['reports.view', 'payroll.payment.view']);
		expect((await get(`/reports/payments/summary?companyId=${w.companyId}`, noAll)).status).toBe(
			403
		);
		const full = await withPerms(['reports.view', 'payroll.payment.view', 'employees.view_all']);
		expect((await get(`/reports/payments/summary?companyId=${w.companyId}`, full)).status).toBe(
			200
		);
	});

	it('13. accounting report requires payroll.accounting.view (+ employees.view_all)', async () => {
		const noAcct = await withPerms(['reports.view', 'payroll.view', 'employees.view_all']);
		expect((await get(`/reports/accounting/summary?companyId=${w.companyId}`, noAcct)).status).toBe(
			403
		);
		const full = await withPerms(['reports.view', 'payroll.accounting.view', 'employees.view_all']);
		expect((await get(`/reports/accounting/summary?companyId=${w.companyId}`, full)).status).toBe(
			200
		);
	});

	it('14. direct API access cannot bypass: reports.view alone gives nothing; domain permission alone gives no report', async () => {
		const reportsOnly = await withPerms(['reports.view']);
		for (const kind of [
			'employees',
			'attendance',
			'leave',
			'overtime',
			'payroll',
			'payments',
			'accounting'
		]) {
			expect(
				(await get(`/reports/${kind}/summary?companyId=${w.companyId}`, reportsOnly)).status
			).toBe(403);
		}
		const domainOnly = await withPerms(['employees.view', 'employees.view_all', 'attendance.view']);
		expect((await get('/reports/employees/summary', domainOnly)).status).toBe(403);
		expect((await get('/reports/attendance/summary', domainOnly)).status).toBe(403);
		expect((await agent().get('/api/v1/reports/employees/summary')).status).toBe(401);
	});
});

// =====================================================================================
// 15–32 dashboard
// =====================================================================================
describe('real dashboard', () => {
	it('15. employee count is the real database count', async () => {
		const d = await dash(s.hrAdmin, { companyId: w.companyId, date: WED });
		expect(d.employees).toMatchObject({
			total: 7,
			active: 6,
			inactive: 1,
			probation: 1,
			separated: 1
		});
		expect(d.employees!.byDepartment.length).toBeGreaterThan(0);
	});

	it('16. no demo constant: the count follows the data and nothing is labelled DEMO', async () => {
		const before = (await dash(s.hrAdmin, { companyId: w.companyId, date: WED })).employees!
			.total as number;
		const extra = await prisma.employee.create({
			data: {
				employeeCode: `EXTRA_${Date.now()}`,
				firstNameLao: 'ເພີ່ມ',
				lastNameLao: 'ທົດສອບ',
				startDate: D('2024-01-01'),
				companyId: w.companyId
			}
		});
		const after = await dash(s.hrAdmin, { companyId: w.companyId, date: WED });
		expect(after.employees!.total).toBe(before + 1);
		expect(JSON.stringify(after)).not.toMatch(/DEMO/i);
		await prisma.employee.delete({ where: { id: extra.id } });
	});

	it('17. employee data scope applies to the dashboard (manager sees the team only)', async () => {
		const d = await dash(w.manager.cookie, { date: WED });
		expect(d.employees!.total).toBe(3);
		expect(d.context.scope).toBe('TEAM');
	});

	it('18–21. present / late / leave / absent come from the canonical daily result', async () => {
		const a = (await dash(s.hrAdmin, { companyId: w.companyId, date: WED })).attendance!;
		expect(a.metrics).toMatchObject({
			scheduled: 5,
			present: 3,
			late: 1,
			onLeave: 1,
			absent: 1,
			pending: 0
		});
		expect(a.metrics.lateMinutes).toBe(15);
		expect(a.metrics.noSchedule).toBe(1); // E
	});

	it('22. an off day is never absent', async () => {
		const a = (await dash(s.hrAdmin, { companyId: w.companyId, date: SAT })).attendance!;
		expect(a.metrics).toMatchObject({ absent: 0, scheduled: 0, offDay: 5 });
	});

	it('23. a holiday is never absent', async () => {
		const a = (await dash(s.hrAdmin, { companyId: w.companyId, date: THU })).attendance!;
		expect(a.metrics).toMatchObject({ absent: 0, scheduled: 0, holiday: 5 });
	});

	it('24. an employee not yet hired (or already gone) is not counted', async () => {
		const wed = (await dash(s.hrAdmin, { companyId: w.companyId, date: WED })).attendance!;
		expect(wed.metrics.scheduled).toBe(5); // G (hired 06-10) and F (left 05-01) excluded
		const after = (await dash(s.hrAdmin, { companyId: w.companyId, date: '2025-06-11' }))
			.attendance!;
		expect(after.metrics.scheduled).toBe(6); // G is counted from the hire date on
	});

	it('25. attendance rate = present / (scheduled − onLeave)', async () => {
		const a = (await dash(s.hrAdmin, { companyId: w.companyId, date: WED })).attendance!;
		expect(a.attendanceRate).toEqual({ numerator: 3, denominator: 4, percent: '75.00' });
		const team = (await dash(w.manager.cookie, { date: WED })).attendance!;
		expect(team.attendanceRate).toEqual({ numerator: 3, denominator: 3, percent: '100.00' });
	});

	it('26. zero denominator → percent null (never NaN / Infinity)', async () => {
		const a = (await dash(s.hrAdmin, { companyId: w.companyId, date: SAT })).attendance!;
		expect(a.attendanceRate).toEqual({ numerator: 0, denominator: 0, percent: null });
	});

	it('27. the date filter changes the figures and the 7-day trend ends on it', async () => {
		const mon = (await dash(s.hrAdmin, { companyId: w.companyId, date: MON })).attendance!;
		expect(mon.metrics).toMatchObject({ present: 5, absent: 0 });
		const wed = (await dash(s.hrAdmin, { companyId: w.companyId, date: WED })).attendance!;
		expect(wed.trend).toHaveLength(7);
		expect(wed.trend[6]!.date).toBe(WED);
		expect(wed.trend.find((t) => t.date === TUE)!.present).toBe(5);
		expect((await get(`/dashboard/summary?date=2999-01-01`, s.hrAdmin)).status).toBe(400);
	});

	it('28. "today" is the Laos business date (UTC+7) — midnight boundary', async () => {
		setServerClockForTests(() => new Date('2025-06-04T16:59:59Z')); // 23:59:59 Laos, 4 June
		const before = await dash(s.hrAdmin, { companyId: w.companyId });
		expect(before.context.date).toBe('2025-06-04');
		const future = await get(`/dashboard/summary?date=2025-06-05`, s.hrAdmin);
		expect(future.status).toBe(400);
		expect(future.body.error.code).toBe('REPORT_DATE_RANGE_INVALID');
		setServerClockForTests(() => new Date('2025-06-04T17:00:00Z')); // 00:00 Laos, 5 June
		const after = await dash(s.hrAdmin, { companyId: w.companyId });
		expect(after.context.date).toBe('2025-06-05');
		expect(after.attendance!.metrics.holiday).toBe(5); // Thu 5 June is the company holiday
	});

	it('29. approvals = the real "waiting for me" inbox (same count as /approvals/inbox)', async () => {
		// a real leave request by A → its manager (MGR) becomes a current-step candidate
		const today = todayInLaos(new Date());
		let day = new Date(today.getTime() + 14 * 86_400_000);
		while (day.getUTCDay() !== 1) day = new Date(day.getTime() + 86_400_000);
		const iso = formatDateOnly(day);
		await prisma.leaveBalance.create({
			data: {
				employeeId: w.emp.A.id,
				leaveTypeId: w.lt1,
				year: day.getUTCFullYear(),
				entitlementDays: 5
			}
		});
		const created = await post('/leave/me/requests', w.employeeUser.cookie, {
			leaveTypeId: w.lt1,
			startDate: iso,
			endDate: iso,
			reason: 'QA dashboard inbox'
		});
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const d = await dash(w.manager.cookie);
		const inbox = ok<{ total: number }>(await get('/approvals/inbox', w.manager.cookie));
		expect(d.approvals.waitingForMe).toBe(inbox.total);
		expect(d.approvals.waitingForMe).toBeGreaterThanOrEqual(1);
		expect(
			d.approvals.items.some((i) => i.targetType === 'LEAVE' && i.employee?.id === w.emp.A.id)
		).toBe(true);
		// the employee (requester) is never a candidate
		expect((await dash(w.employeeUser.cookie)).approvals.waitingForMe).toBe(0);
	});

	it('30. unauthorized widgets are null (never computed, never sent)', async () => {
		const mgr = await dash(w.manager.cookie, { date: WED });
		expect(mgr.payroll).toBeNull();
		expect(mgr.payments).toBeNull();
		expect(mgr.accounting).toBeNull();
		expect(mgr.employees).not.toBeNull();
		const emp = await dash(w.employeeUser.cookie, { date: WED });
		expect(emp.employees).toBeNull();
		expect(emp.attendance).toBeNull();
		expect(emp.payroll).toBeNull();
		const hr = await dash(s.hrAdmin, { companyId: w.companyId, date: WED });
		expect(hr.payroll).not.toBeNull();
		expect(hr.payments).not.toBeNull();
		expect(hr.accounting).not.toBeNull();
	});

	it('31. recent activity: audit only with audit.view + view_all, otherwise own notifications', async () => {
		expect((await dash(s.hrAdmin, { date: WED })).recentActivity.source).toBe('AUDIT');
		const mgr = await dash(w.manager.cookie, { date: WED });
		expect(mgr.recentActivity.source).toBe('NOTIFICATIONS');
		const own = await prisma.notification.findMany({
			where: { userId: w.manager.userId },
			select: { id: true }
		});
		const ids = new Set(own.map((n) => n.id));
		expect(mgr.recentActivity.items.every((i) => ids.has(i.id as string))).toBe(true);
		const auditOnly = await withPerms(['dashboard.view', 'audit.view']); // no view_all → no audit
		expect((await dash(auditOnly)).recentActivity.source).toBe('NOTIFICATIONS');
	});

	it('32. audit items carry display fields only — no ip / request id / changes / metadata', async () => {
		const items = (await dash(s.hrAdmin)).recentActivity.items;
		expect(items.length).toBeGreaterThan(0);
		for (const i of items) {
			expect(Object.keys(i).sort()).toEqual(
				['action', 'actor', 'at', 'employee', 'entityType', 'id', 'link', 'title'].sort()
			);
		}
		expect(JSON.stringify(items)).not.toMatch(/ipAddress|requestId|changes|metadata|userAgent/);
	});
});

// =====================================================================================
// 33–40 employee report
// =====================================================================================
describe('employee summary report', () => {
	it('33–34. current headcount with active / inactive / probation / separated', async () => {
		const r = await report('employees', s.hrAdmin, { companyId: w.companyId });
		expect(r.totals).toMatchObject({
			total: 7,
			active: 6,
			inactive: 1,
			probation: 1,
			separated: 1
		});
		expect(r.totals.byStatus).toMatchObject({ ACTIVE: 5, PROBATION: 1, SUSPENDED: 1, RESIGNED: 1 });
		expect(r.context).toMatchObject({ historical: false, timezone: 'Asia/Vientiane' });
	});

	it('35. group by branch', async () => {
		const r = await report('employees', s.hrAdmin, { companyId: w.companyId, groupBy: 'branch' });
		expect(group(r, w.b1)).toMatchObject({ total: 4 });
		expect(group(r, w.b2)).toMatchObject({ total: 2, separated: 1 });
		expect(group(r, 'UNASSIGNED')).toMatchObject({ total: 1, inactive: 1 });
	});

	it('36. group by department (default)', async () => {
		const r = await report('employees', s.hrAdmin, { companyId: w.companyId });
		expect(r.context.groupBy).toBe('department');
		expect(group(r, w.d1)).toMatchObject({ total: 4, active: 4 });
		expect(group(r, w.d2)).toMatchObject({ total: 2, probation: 1 });
	});

	it('37. group by employment type', async () => {
		const r = await report('employees', s.hrAdmin, {
			companyId: w.companyId,
			groupBy: 'employmentType'
		});
		expect(group(r, w.pt)).toMatchObject({ total: 1 });
		expect(group(r, w.ft)).toMatchObject({ total: 5, separated: 1 });
	});

	it('38. manager scope: own record + reports only', async () => {
		const r = await report('employees', w.manager.cookie, { groupBy: 'department' });
		expect(r.totals.total).toBe(3);
		expect(r.groups.map((g) => g.key)).toEqual([String(w.d1)]);
	});

	it('39. cross-company isolation — company-wide users filter one company at a time', async () => {
		const c = await report('employees', s.hrAdmin, { companyId: w.companyId, groupBy: 'company' });
		expect(c.groups.map((g) => g.key)).toEqual([String(w.companyId)]);
		const o = await report('employees', s.hrAdmin, {
			companyId: other.companyId,
			groupBy: 'company'
		});
		expect(o.groups.map((g) => g.key)).toEqual([String(other.companyId)]);
	});

	it('40. historical headcount is refused honestly (HISTORICAL_HEADCOUNT_NOT_AVAILABLE)', async () => {
		const res = await get(`/reports/employees/summary?asOf=2025-01-01`, s.hrAdmin);
		expect(res.status).toBe(400);
		expect(res.body.error).toMatchObject({
			code: 'REPORT_HISTORICAL_DATA_UNAVAILABLE',
			details: { reason: 'HISTORICAL_HEADCOUNT_NOT_AVAILABLE' }
		});
		const today = formatDateOnly(todayInLaos(new Date()));
		expect((await get(`/reports/employees/summary?asOf=${today}`, s.hrAdmin)).status).toBe(200);
	});
});

// =====================================================================================
// 41–54 attendance report
// =====================================================================================
describe('attendance summary report', () => {
	it('41–48. scheduled / present / late / early / absent / leave / worked over the week', async () => {
		const r = await report('attendance', s.hrAdmin, {
			companyId: w.companyId,
			...WEEK,
			groupBy: 'none'
		});
		expect(r.totals).toMatchObject({
			scheduled: 20,
			present: 18,
			late: 1,
			lateMinutes: 15,
			earlyLeave: 1,
			earlyLeaveMinutes: 30,
			absent: 1,
			onLeave: 1,
			holiday: 5,
			noSchedule: 5,
			workedMinutes: 18 * 480 - 45
		});
		expect(r.totals.attendanceRate).toEqual({ numerator: 18, denominator: 19, percent: '94.74' });
		expect(r.trend).toHaveLength(5);
		expect(r.groups).toEqual([]);
	});

	it('49. date range: explicit range is honoured; default is the current month up to today', async () => {
		const one = await report('attendance', s.hrAdmin, {
			companyId: w.companyId,
			from: WED,
			to: WED,
			groupBy: 'none'
		});
		expect(one.context).toMatchObject({ from: WED, to: WED, days: 1 });
		expect(one.totals).toMatchObject({ scheduled: 5, present: 3 });
		const def = await report('attendance', s.hrAdmin, { companyId: w.companyId });
		const today = todayInLaos(new Date());
		expect(def.context.to).toBe(formatDateOnly(today));
		expect(def.context.from).toBe(
			formatDateOnly(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)))
		);
	});

	it('50. range validation: > 93 days is REPORT_DATE_RANGE_TOO_LARGE; the future is refused', async () => {
		const big = await get(`/reports/attendance/summary?from=2025-01-01&to=2025-06-30`, s.hrAdmin);
		expect(big.status).toBe(400);
		expect(big.body.error).toMatchObject({
			code: 'REPORT_DATE_RANGE_TOO_LARGE',
			details: { maxDays: 93 }
		});
		const future = await get(
			`/reports/attendance/summary?from=2999-01-01&to=2999-01-02`,
			s.hrAdmin
		);
		expect(future.body.error.code).toBe('REPORT_DATE_RANGE_INVALID');
	});

	it('51. group by branch', async () => {
		const r = await report('attendance', s.hrAdmin, {
			companyId: w.companyId,
			...WEEK,
			groupBy: 'branch'
		});
		expect(group(r, w.b1)).toMatchObject({ scheduled: 12, present: 12, late: 1, absent: 0 });
		expect(group(r, w.b2)).toMatchObject({ scheduled: 8, present: 6, absent: 1, onLeave: 1 });
		expect(group(r, 'UNASSIGNED')).toMatchObject({ scheduled: 0, noSchedule: 5 });
	});

	it('52. group by department', async () => {
		const r = await report('attendance', s.hrAdmin, {
			companyId: w.companyId,
			...WEEK,
			groupBy: 'department'
		});
		expect(group(r, w.d1)).toMatchObject({ present: 12, earlyLeave: 1, earlyLeaveMinutes: 30 });
		expect(group(r, w.d2)).toMatchObject({ present: 6 });
		expect((group(r, w.d2)!.attendanceRate as { percent: string }).percent).toBe('85.71'); // 6 / 7
	});

	it('53. group by employee', async () => {
		const r = await report('attendance', s.hrAdmin, {
			companyId: w.companyId,
			...WEEK,
			groupBy: 'employee'
		});
		expect(group(r, w.emp.B.id)).toMatchObject({
			present: 4,
			late: 1,
			lateMinutes: 15,
			earlyLeave: 1,
			earlyLeaveMinutes: 30,
			workedMinutes: 4 * 480 - 45
		});
		expect(group(r, w.emp.Cp.id)).toMatchObject({ present: 3, absent: 1 });
		expect(r.groups.find((g) => g.key === String(w.emp.B.id))!.code).toBe(w.emp.B.code);
		expect(group(r, w.emp.G.id)).toBeUndefined();
	});

	it('54. no reclassification: the report equals the Attendance module’s own daily results', async () => {
		const daily = ok<{ items: { result: string }[]; total: number }>(
			await get(`/attendance/daily?date=${WED}&companyId=${w.companyId}&pageSize=100`, s.hrAdmin)
		);
		const count = (r: string[]) => daily.items.filter((i) => r.includes(i.result)).length;
		const rep = await report('attendance', s.hrAdmin, {
			companyId: w.companyId,
			from: WED,
			to: WED,
			groupBy: 'none'
		});
		expect(rep.totals).toMatchObject({
			present: count([
				'PRESENT',
				'LATE',
				'EARLY_LEAVE',
				'LATE_AND_EARLY',
				'IN_PROGRESS',
				'INCOMPLETE'
			]),
			late: count(['LATE', 'LATE_AND_EARLY']),
			absent: count(['ABSENT']),
			onLeave: count(['LEAVE']),
			noSchedule: count(['NO_SCHEDULE'])
		});
		// raw punches never change the verdict: a record whose raw check-in is late but whose cached
		// calculation says PRESENT stays PRESENT
		await prisma.attendanceRecord.update({
			where: { employeeId_workDate: { employeeId: w.emp.A.id, workDate: D(WED) } },
			data: { firstCheckInAt: new Date(`${WED}T02:30:00Z`) }
		});
		const again = await report('attendance', s.hrAdmin, {
			companyId: w.companyId,
			from: WED,
			to: WED,
			groupBy: 'none'
		});
		expect(again.totals).toMatchObject({ present: 3, late: 1 });
	});
});

// =====================================================================================
// 55–66 leave / overtime reports
// =====================================================================================
describe('leave and overtime summary reports', () => {
	it('55–59. leave: requests by status; approvedDays only from APPROVED charged days', async () => {
		const r = await report('leave', s.hrAdmin, {
			companyId: w.companyId,
			...JUNE,
			groupBy: 'none'
		});
		expect(r.totals).toEqual({
			requests: 4,
			approved: 1,
			pending: 1,
			rejected: 1,
			cancelled: 1,
			approvedDays: '1.00'
		});
	});

	it('60. leave grouped by leave type (+ balances from the Leave module)', async () => {
		const r = await report('leave', s.hrAdmin, { companyId: w.companyId, ...JUNE });
		expect(r.context.groupBy).toBe('leaveType');
		expect(group(r, w.lt1)).toMatchObject({ requests: 1, approved: 1, approvedDays: '1.00' });
		expect(group(r, w.lt2)).toMatchObject({ requests: 3, approved: 0, approvedDays: '0.00' });
		expect(r.balances!.year).toBe(2025);
		const al = r.balances!.items.find((i) => i.leaveTypeId === w.lt1)!;
		expect(al).toMatchObject({
			allocated: '10.00',
			used: '1.00',
			reserved: '0.00',
			available: '9.00'
		});
		expect(r.balances!.items.some((i) => i.leaveTypeId === w.lt2)).toBe(false); // no balance tracked
	});

	it('61–64. overtime: request counts and the OT domain eligible minutes', async () => {
		const r = await report('overtime', s.hrAdmin, {
			companyId: w.companyId,
			...JUNE,
			groupBy: 'none'
		});
		expect(r.totals).toEqual({
			requests: 4,
			approved: 2,
			pending: 1,
			rejected: 1,
			cancelled: 0,
			eligibleMinutes: 120,
			approvedPlannedMinutes: 180,
			awaitingAttendance: 0
		});
	});

	it('65. rejected / pending OT never counts as approved time', async () => {
		const r = await report('overtime', s.hrAdmin, {
			companyId: w.companyId,
			...JUNE,
			groupBy: 'employee'
		});
		expect(group(r, w.emp.Dd.id)).toMatchObject({ rejected: 1, eligibleMinutes: 0, approved: 0 });
		expect(group(r, w.emp.Cp.id)).toMatchObject({ pending: 1, eligibleMinutes: 0 });
		expect(group(r, w.emp.A.id)).toMatchObject({ approved: 1, eligibleMinutes: 90 });
	});

	it('66. the data scope applies to leave and overtime', async () => {
		const leave = await report('leave', w.manager.cookie, { ...JUNE, groupBy: 'none' });
		expect(leave.totals).toMatchObject({ requests: 2, approved: 0, rejected: 1, cancelled: 1 });
		const ot = await report('overtime', w.manager.cookie, { ...JUNE, groupBy: 'none' });
		expect(ot.totals).toMatchObject({ requests: 2, approved: 2, eligibleMinutes: 120 });
	});
});

// =====================================================================================
// 91–99 input safety
// =====================================================================================
describe('reporting input safety', () => {
	it('91. invalid groupBy → REPORT_GROUP_BY_INVALID', async () => {
		const res = await get(`/reports/employees/summary?groupBy=salary`, s.hrAdmin);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe('REPORT_GROUP_BY_INVALID');
		expect(res.body.error.details.allowed).toEqual([
			'company',
			'branch',
			'department',
			'employmentType'
		]);
	});

	it('92. invalid date → 400', async () => {
		for (const bad of ['2025-13-01', '2025-02-30', 'yesterday']) {
			const res = await get(`/reports/attendance/summary?from=${bad}`, s.hrAdmin);
			expect(res.status, bad).toBe(400);
			expect(res.body.error.code).toBe('VALIDATION_ERROR');
		}
	});

	it('93. from > to → REPORT_DATE_RANGE_INVALID', async () => {
		for (const kind of ['attendance', 'leave', 'overtime']) {
			const res = await get(`/reports/${kind}/summary?from=${FRI}&to=${MON}`, s.hrAdmin);
			expect(res.body.error.code, kind).toBe('REPORT_DATE_RANGE_INVALID');
		}
		const acc = await get(
			`/reports/accounting/summary?companyId=${w.companyId}&from=${FRI}&to=${MON}`,
			s.hrAdmin
		);
		expect(acc.body.error.code).toBe('REPORT_DATE_RANGE_INVALID');
	});

	it('94. range too large → REPORT_DATE_RANGE_TOO_LARGE (attendance 93 days, leave / OT 366 days)', async () => {
		expect(
			(await get(`/reports/leave/summary?from=2024-01-01&to=2025-06-30`, s.hrAdmin)).body.error.code
		).toBe('REPORT_DATE_RANGE_TOO_LARGE');
		expect(
			(await get(`/reports/overtime/summary?from=2024-01-01&to=2025-06-30`, s.hrAdmin)).body.error
				.code
		).toBe('REPORT_DATE_RANGE_TOO_LARGE');
		expect(
			(await get(`/reports/attendance/summary?from=2025-03-01&to=2025-06-02`, s.hrAdmin)).body.error
				.code
		).toBe('REPORT_DATE_RANGE_TOO_LARGE');
	});

	it('95. unauthorized company → 403 for a team user, unknown company → 400 for company-wide users', async () => {
		const res = await get(`/dashboard/summary?companyId=${other.companyId}`, w.manager.cookie);
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('REPORT_FILTER_NOT_ALLOWED');
		// a well-formed id that names no company → REPORT_FILTER_INVALID; a malformed one → VALIDATION_ERROR
		const unknown = await get(`/dashboard/summary?companyId=2147483647`, s.hrAdmin);
		expect(unknown.status).toBe(400);
		expect(unknown.body.error.code).toBe('REPORT_FILTER_INVALID');
		const malformed = await get(`/dashboard/summary?companyId=nope`, s.hrAdmin);
		expect(malformed.status).toBe(400);
		expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
	});

	it('96. unauthorized branch → 403 REPORT_FILTER_NOT_ALLOWED', async () => {
		const res = await get(`/reports/leave/summary?branchId=${w.b2}`, w.manager.cookie);
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('REPORT_FILTER_NOT_ALLOWED');
	});

	it('97. unknown / mismatched department → 400 REPORT_FILTER_INVALID', async () => {
		const unknown = await get(`/reports/employees/summary?departmentId=2147483647`, s.hrAdmin);
		expect(unknown.status).toBe(400);
		expect(unknown.body.error).toMatchObject({
			code: 'REPORT_FILTER_INVALID',
			details: { field: 'departmentId' }
		});
		const malformed = await get(`/reports/employees/summary?departmentId=unknown-dept`, s.hrAdmin);
		expect(malformed.status).toBe(400);
		expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
		const mismatch = await get(
			`/reports/employees/summary?branchId=${w.b1}&departmentId=${other.d1}`,
			s.hrAdmin
		);
		expect(mismatch.body.error.code).toBe('REPORT_FILTER_INVALID');
	});

	it('98. groupBy injection attempts are rejected and change nothing', async () => {
		const before = await prisma.employee.count();
		for (const bad of [
			'department;DROP TABLE employees',
			'employee.salary',
			'baseSalary',
			'__proto__',
			'Department'
		]) {
			const res = await get(
				`/reports/attendance/summary?groupBy=${encodeURIComponent(bad)}`,
				s.hrAdmin
			);
			expect(res.status, bad).toBe(400);
			expect(res.body.error.code).toBe('REPORT_GROUP_BY_INVALID');
		}
		expect(await prisma.employee.count()).toBe(before);
	});

	it('99. unknown query parameters are ignored (project convention) and never echoed', async () => {
		const r = await report('employees', s.hrAdmin, {
			companyId: w.companyId,
			sneaky: 'x',
			sortBy: 'salary'
		});
		expect(r.totals.total).toBe(7);
		expect(JSON.stringify(r.context)).not.toMatch(/sneaky|sortBy/);
	});
});

// =====================================================================================
// query-cost guards (canonical per-day resolution — see the implementation report §Performance)
// =====================================================================================
describe('attendance query-cost guards', () => {
	it('— a report above 5,000 employee-days is refused BEFORE any resolution', async () => {
		const c = await createTestCompany();
		await prisma.employee.createMany({
			data: Array.from({ length: 55 }, (_, i) => ({
				employeeCode: `CAP_${c.code}_${i}`,
				firstNameLao: 'ຈຳກັດ',
				lastNameLao: String(i),
				startDate: D('2024-01-01'),
				companyId: c.id
			}))
		});
		const res = await get(
			`/reports/attendance/summary?companyId=${c.id}&from=2025-03-01&to=2025-06-01&groupBy=none`,
			s.hrAdmin
		);
		expect(res.status).toBe(400);
		expect(res.body.error).toMatchObject({
			code: 'REPORT_DATE_RANGE_TOO_LARGE',
			details: { maxEmployeeDays: 5000, requestedEmployeeDays: 55 * 93 }
		});
	});

	it('— the dashboard never fails on scope size: a 7-day trend above the cap degrades to the selected day', async () => {
		const small = await dash(s.hrAdmin, { companyId: w.companyId, date: WED });
		expect(small.attendance).toMatchObject({ trendLimited: false });
		const c = await createTestCompany();
		await prisma.employee.createMany({
			data: Array.from({ length: 720 }, (_, i) => ({
				employeeCode: `BIG_${c.code}_${i}`,
				firstNameLao: 'ໃຫຍ່',
				lastNameLao: String(i),
				startDate: D('2024-01-01'),
				companyId: c.id
			}))
		});
		const big = await dash(s.hrAdmin, { companyId: c.id, date: WED });
		expect(big.attendance).toMatchObject({ trendLimited: true });
		expect(big.attendance!.trend).toHaveLength(1);
		expect(big.attendance!.metrics.noSchedule).toBe(720);
		// keep the rest of the suite (company-wide dashboards) fast
		await prisma.employee.deleteMany({ where: { companyId: c.id } });
	}, 120_000);
});
