import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Response } from 'superagent';
import { prisma } from '../src/config/prisma.js';
import { unzipStore } from '../src/lib/bankFile.js';
import { REPORT_DEFINITIONS } from '../src/services/reporting/reportDefinitions.js';
import { resolveColumns } from '../src/services/reporting/reportDetail.service.js';
import { breakUnits, measureCell } from '../src/services/reporting/reportPdf.service.js';
import { buildReportCsv } from '../src/services/reporting/reportCsv.service.js';
import { agent, createTestCompany, createTestUser, loginAndGetCookie } from './helpers.js';
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
	reportingWorld,
	roleSessions,
	withPerms,
	type World
} from './phase17Fixture.js';
import { pdfAllText, pdfPages } from './pdfText.js';

/**
 * Phase 17B — detail reports, saved filters, CSV / XLSX / PDF exports for the non-financial reports
 * (tests 1–62, 98–168; the money reports are in reportingDetailFinance.test.ts).
 * World (phase17Fixture): company C, week Mon 2025-06-02 .. Fri 2025-06-06, 6 employees employed.
 */
let w: World;
let other: World;
let s: { superAdmin: string; hrAdmin: string };
let hr2: string;
const bulkCompanies: string[] = [];

beforeAll(async () => {
	s = await roleSessions();
	w = await reportingWorld();
	other = await reportingWorld();
	const u = await createTestUser({ roleCode: 'HR_ADMIN' });
	hr2 = await loginAndGetCookie(u.username, u.password);
}, 180_000);
afterAll(async () => {
	// keep later company-wide suites fast: remove the bulk employees created for the limit tests
	for (const c of bulkCompanies) await prisma.employee.deleteMany({ where: { companyId: c } });
});

const WEEK = { from: MON, to: FRI };
const JUNE = { from: '2025-06-01', to: '2025-06-30' };
const q = (p: Record<string, string | number | undefined>) =>
	'?' +
	Object.entries(p)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
		.join('&');

interface Detail {
	context: Record<string, unknown>;
	columns: { key: string }[];
	page: { number: number; size: number; totalRows: number; totalPages: number };
	rows: Record<string, string | number | boolean | null>[];
}
const detail = async (
	type: string,
	cookie: string,
	p: Record<string, string | number | undefined>
) => ok<Detail>(await get(`/reports/${type}/detail${q(p)}`, cookie));
/** every row of a filter (all pages, pageSize 100) */
async function allRows(
	type: string,
	cookie: string,
	p: Record<string, string | number | undefined>
) {
	const first = await detail(type, cookie, { ...p, pageSize: 100, page: 1 });
	const rows = [...first.rows];
	for (let page = 2; page <= first.page.totalPages; page++) {
		rows.push(...(await detail(type, cookie, { ...p, pageSize: 100, page })).rows);
	}
	return rows;
}
const summary = async (type: string, cookie: string, p: Record<string, string | undefined>) =>
	ok<{ totals: Record<string, unknown> }>(await get(`/reports/${type}/summary${q(p)}`, cookie));

const binaryParser = (res: Response, cb: (err: Error | null, body: Buffer) => void) => {
	const chunks: Buffer[] = [];
	res.on('data', (c: Buffer) => chunks.push(c));
	res.on('end', () => cb(null, Buffer.concat(chunks)));
};
async function exportReq(type: string, cookie: string, body: Record<string, unknown>) {
	const res = await agent()
		.post(`/api/v1/reports/${type}/export`)
		.set('Cookie', cookie)
		.send(body)
		.buffer(true)
		.parse(binaryParser as never);
	const bytes = res.body as Buffer;
	const json = () => JSON.parse(bytes.toString('utf8'));
	return { res, bytes, json };
}
/** a leading UTF-8 BOM (written for Excel) */
const BOM = new RegExp('^' + String.fromCharCode(0xfeff));
const csvLines = (b: Buffer) => b.toString('utf8').replace(BOM, '').split('\r\n').filter(Boolean);
const sheetOf = (b: Buffer) => {
	const wb = XLSX.read(b, { type: 'buffer', cellFormula: true, cellNF: true });
	return { wb, ws: wb.Sheets[wb.SheetNames[0]!]! };
};
const saved = {
	create: (cookie: string, body: Record<string, unknown>) =>
		agent().post('/api/v1/reports/saved-filters').set('Cookie', cookie).send(body),
	update: (cookie: string, id: string, body: Record<string, unknown>) =>
		agent().put(`/api/v1/reports/saved-filters/${id}`).set('Cookie', cookie).send(body),
	del: (cookie: string, id: string) =>
		agent().delete(`/api/v1/reports/saved-filters/${id}`).set('Cookie', cookie),
	one: (cookie: string, id: string) => get(`/reports/saved-filters/${id}`, cookie),
	list: (cookie: string, reportType: string) =>
		get(`/reports/saved-filters?reportType=${reportType}`, cookie)
};

/** bulk employees for limit tests (no schedule needed: only row COUNTS matter) */
async function bulkCompany(n: number) {
	const c = await createTestCompany();
	bulkCompanies.push(c.id);
	for (let i = 0; i < n; i += 5000) {
		await prisma.employee.createMany({
			data: Array.from({ length: Math.min(5000, n - i) }, (_, k) => ({
				employeeCode: `BULK_${c.code}_${i + k}`,
				firstNameLao: 'ຈຳນວນ',
				lastNameLao: String(i + k),
				startDate: D('2024-01-01'),
				companyId: c.id
			}))
		});
	}
	return c.id;
}

// =====================================================================================
// 1–17 saved filters
// =====================================================================================
describe('saved report filters', () => {
	const view = () => ({
		reportType: 'attendance',
		name: 'QA view',
		filters: { companyId: w.companyId, branchId: w.b1, from: MON, to: FRI },
		groupBy: 'department',
		sortBy: 'lateMinutes',
		sortDir: 'desc',
		columns: ['date', 'employeeCode', 'status', 'lateMinutes']
	});
	let mineId = '';

	it('1. create a saved filter (state only, re-validated, usable)', async () => {
		const res = await saved.create(s.hrAdmin, view());
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		mineId = res.body.data.id;
		expect(res.body.data).toMatchObject({
			reportType: 'attendance',
			name: 'QA view',
			filters: { companyId: w.companyId, branchId: w.b1, from: MON, to: FRI },
			groupBy: 'department',
			sortBy: 'lateMinutes',
			sortDir: 'desc',
			columns: ['date', 'employeeCode', 'status', 'lateMinutes'],
			isDefault: false,
			usable: true,
			problem: null
		});
	});

	it('2. list returns only my own saved filters', async () => {
		await saved.create(hr2, { ...view(), name: 'someone else' });
		const mine = ok<{ items: { id: string; name: string }[] }>(
			await saved.list(s.hrAdmin, 'attendance')
		);
		expect(mine.items.map((i) => i.name)).toContain('QA view');
		expect(mine.items.map((i) => i.name)).not.toContain('someone else');
	});

	it('3–5. another user cannot read, update or delete my filter (404, unchanged)', async () => {
		expect((await saved.one(hr2, mineId)).status).toBe(404);
		expect((await saved.update(hr2, mineId, { name: 'hijack' })).status).toBe(404);
		expect((await saved.del(hr2, mineId)).status).toBe(404);
		const row = await prisma.savedReportFilter.findUniqueOrThrow({ where: { id: mineId } });
		expect(row.name).toBe('QA view');
	});

	it('6. duplicate name for the same report → 409', async () => {
		const res = await saved.create(s.hrAdmin, view());
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('REPORT_SAVED_FILTER_NAME_TAKEN');
	});

	it('7. the same name for another report is allowed', async () => {
		const res = await saved.create(s.hrAdmin, {
			reportType: 'leave',
			name: 'QA view',
			filters: { companyId: w.companyId, ...JUNE }
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
	});

	it('8. at most 25 saved filters per user and report', async () => {
		const u = await createTestUser({ roleCode: 'HR_ADMIN' });
		const c = await loginAndGetCookie(u.username, u.password);
		for (let i = 0; i < 25; i++) {
			expect(
				(await saved.create(c, { reportType: 'overtime', name: `f${i}`, filters: {} })).status
			).toBe(201);
		}
		const res = await saved.create(c, { reportType: 'overtime', name: 'f25', filters: {} });
		expect(res.status).toBe(409);
		expect(res.body.error).toMatchObject({
			code: 'REPORT_SAVED_FILTER_LIMIT',
			details: { max: 25 }
		});
		expect((await saved.create(c, { reportType: 'leave', name: 'f25', filters: {} })).status).toBe(
			201
		);
	});

	it('9–10. one default per user/report; a new default unsets the old one', async () => {
		const u = await createTestUser({ roleCode: 'HR_ADMIN' });
		const c = await loginAndGetCookie(u.username, u.password);
		const a = (
			await saved.create(c, { reportType: 'employees', name: 'A', filters: {}, isDefault: true })
		).body.data;
		const b = (
			await saved.create(c, { reportType: 'employees', name: 'B', filters: {}, isDefault: true })
		).body.data;
		const defaults = () =>
			prisma.savedReportFilter.findMany({ where: { userId: u.user.id, isDefault: true } });
		expect((await defaults()).map((d) => d.id)).toEqual([b.id]);
		const up = await saved.update(c, a.id, { isDefault: true });
		expect(up.status).toBe(200);
		expect((await defaults()).map((d) => d.id)).toEqual([a.id]);
		const list = ok<{ items: { id: string; isDefault: boolean }[] }>(
			await saved.list(c, 'employees')
		);
		expect(list.items[0]).toMatchObject({ id: a.id, isDefault: true });
	});

	it('10b. set-default and rename keep the saved state (regression: filters were wiped)', async () => {
		const f = (await saved.create(s.hrAdmin, { ...view(), name: 'keep state' })).body.data;
		const def = ok<{ filters: Record<string, string>; sortBy: string; columns: string[] }>(
			await saved.update(s.hrAdmin, f.id, { isDefault: true })
		);
		expect(def.filters).toEqual(view().filters);
		const ren = ok<{ filters: Record<string, string>; sortBy: string; columns: string[] }>(
			await saved.update(s.hrAdmin, f.id, { name: 'keep state 2' })
		);
		expect(ren).toMatchObject({
			filters: view().filters,
			sortBy: 'lateMinutes',
			columns: view().columns
		});
		expect((await saved.update(s.hrAdmin, f.id, { isDefault: false })).status).toBe(200);
	});

	it('11. the schema is validated on save AND re-validated on every read', async () => {
		const bad = await saved.create(s.hrAdmin, {
			...view(),
			name: 'bad date',
			filters: { from: '2025-13-01' }
		});
		expect(bad.status).toBe(400);
		const good = (await saved.create(s.hrAdmin, { ...view(), name: 'tampered' })).body.data;
		await prisma.savedReportFilter.update({
			where: { id: good.id },
			data: { filtersJson: { from: 'not-a-date' } }
		});
		const back = ok<{ usable: boolean; problem: string }>(await saved.one(s.hrAdmin, good.id));
		expect(back).toMatchObject({ usable: false, problem: 'REPORT_SAVED_FILTER_INVALID' });
	});

	describe('stale scope (a team member whose scope changes after saving)', () => {
		let mgr: { cookie: string; userId: string; employeeId: string };
		beforeAll(async () => {
			const u = await createTestUser({ roleCode: 'MANAGER' });
			const e = await prisma.employee.create({
				data: {
					employeeCode: `STALE_${Date.now()}`,
					firstNameLao: 'ສະໂຄບ',
					lastNameLao: 'ເກົ່າ',
					startDate: D('2024-01-01'),
					companyId: w.companyId,
					branchId: w.b1,
					departmentId: w.d1,
					userId: u.user.id
				}
			});
			mgr = {
				cookie: await loginAndGetCookie(u.username, u.password),
				userId: u.user.id,
				employeeId: e.id
			};
		});

		it('13. branch: a filter saved for branch A is unusable after the scope moves to branch B', async () => {
			const f = await saved.create(mgr.cookie, {
				reportType: 'employees',
				name: 'my branch',
				filters: { branchId: w.b1 }
			});
			expect(f.status, JSON.stringify(f.body)).toBe(201);
			await prisma.employee.update({
				where: { id: mgr.employeeId },
				data: { branchId: w.b2, departmentId: w.d2 }
			});
			const back = ok<{ usable: boolean; problem: string }>(
				await saved.one(mgr.cookie, f.body.data.id)
			);
			expect(back).toMatchObject({ usable: false, problem: 'REPORT_FILTER_NOT_ALLOWED' });
			// applying the stale filter never loads branch A data
			const res = await get(`/reports/employees/detail?branchId=${w.b1}`, mgr.cookie);
			expect(res.status).toBe(403);
			// … and can still be edited / deleted by its owner
			expect((await saved.update(mgr.cookie, f.body.data.id, { filters: {} })).status).toBe(200);
		});

		it('12. company: a filter saved for company C is unusable after moving to another company', async () => {
			const f = await saved.create(mgr.cookie, {
				reportType: 'employees',
				name: 'my company',
				filters: { companyId: w.companyId }
			});
			expect(f.status).toBe(201);
			await prisma.employee.update({
				where: { id: mgr.employeeId },
				data: { companyId: other.companyId, branchId: null, departmentId: null }
			});
			const back = ok<{ usable: boolean; problem: string }>(
				await saved.one(mgr.cookie, f.body.data.id)
			);
			expect(back).toMatchObject({ usable: false, problem: 'REPORT_FILTER_NOT_ALLOWED' });
			expect(
				(await get(`/reports/employees/detail?companyId=${w.companyId}`, mgr.cookie)).status
			).toBe(403);
			expect((await saved.del(mgr.cookie, f.body.data.id)).status).toBe(200);
		});
	});

	it('14. a removed report permission cannot be bypassed through a saved filter', async () => {
		const role = await prisma.role.create({
			data: {
				code: `T17B_${Date.now()}`,
				name: 'T17B',
				permissions: {
					create: (
						await prisma.permission.findMany({
							where: {
								code: {
									in: ['reports.view', 'attendance.view', 'employees.view', 'employees.view_all']
								}
							}
						})
					).map((p) => ({ permissionId: p.id }))
				}
			}
		});
		const u = await createTestUser();
		await prisma.userRole.create({ data: { userId: u.user.id, roleId: role.id } });
		const c = await loginAndGetCookie(u.username, u.password);
		const f = await saved.create(c, {
			reportType: 'attendance',
			name: 'x',
			filters: { companyId: w.companyId }
		});
		expect(f.status).toBe(201);
		const att = await prisma.permission.findUniqueOrThrow({ where: { code: 'attendance.view' } });
		await prisma.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: att.id } });
		expect((await saved.one(c, f.body.data.id)).status).toBe(403);
		expect((await saved.list(c, 'attendance')).status).toBe(403);
		expect((await get(`/reports/attendance/detail?companyId=${w.companyId}`, c)).status).toBe(403);
	});

	it('15. unknown report type → 400', async () => {
		expect(
			(await saved.create(s.hrAdmin, { reportType: 'salary', name: 'x', filters: {} })).status
		).toBe(400);
		expect((await saved.list(s.hrAdmin, 'salary')).status).toBe(400);
	});

	it('16. unknown / unsafe columns and filter keys are rejected', async () => {
		const col = await saved.create(s.hrAdmin, { ...view(), name: 'cols', columns: ['nationalId'] });
		expect(col.body.error.code).toBe('REPORT_COLUMN_INVALID');
		const key = await saved.create(s.hrAdmin, {
			...view(),
			name: 'keys',
			filters: { salary: '1' }
		});
		expect(key.body.error).toMatchObject({
			code: 'REPORT_SAVED_FILTER_INVALID',
			details: { field: 'salary' }
		});
		const sort = await saved.create(s.hrAdmin, { ...view(), name: 'sort', sortBy: 'checkInAt' });
		expect(sort.body.error.code).toBe('REPORT_SORT_INVALID');
	});

	it('17. the page number is never persisted', async () => {
		expect((await saved.create(s.hrAdmin, { ...view(), name: 'p', page: 2 })).status).toBe(400);
		const inFilters = await saved.create(s.hrAdmin, {
			...view(),
			name: 'p2',
			filters: { page: '2' }
		});
		expect(inFilters.body.error.code).toBe('REPORT_SAVED_FILTER_INVALID');
		const row = await prisma.savedReportFilter.findUniqueOrThrow({ where: { id: mineId } });
		expect(JSON.stringify(row)).not.toMatch(/"page"/);
	});
});

// =====================================================================================
// 18–27 pagination / sorting
// =====================================================================================
describe('detail pagination and sorting', () => {
	const base = () => ({ companyId: w.companyId, ...WEEK });

	it('18, 20–21. default page 1 / size 25, totals and pages', async () => {
		const d = await detail('attendance', s.hrAdmin, base());
		expect(d.page).toEqual({ number: 1, size: 25, totalRows: 30, totalPages: 2 });
		expect(d.rows).toHaveLength(25);
	});

	it('19. page size whitelist 10 / 25 / 50 / 100', async () => {
		for (const size of [10, 25, 50, 100]) {
			expect((await detail('attendance', s.hrAdmin, { ...base(), pageSize: size })).page.size).toBe(
				size
			);
		}
		for (const bad of [20, 0, 101, 1000]) {
			expect(
				(await get(`/reports/attendance/detail${q({ ...base(), pageSize: bad })}`, s.hrAdmin))
					.status
			).toBe(400);
		}
	});

	it('22–23. stable ordering; page 2 has no duplicates of page 1', async () => {
		const p1 = await detail('attendance', s.hrAdmin, base());
		const again = await detail('attendance', s.hrAdmin, base());
		expect(again.rows).toEqual(p1.rows);
		const p2 = await detail('attendance', s.hrAdmin, { ...base(), page: 2 });
		const key = (r: Detail['rows'][number]) => `${r.date}|${r.employeeCode}`;
		const keys = [...p1.rows, ...p2.rows].map(key);
		expect(new Set(keys).size).toBe(30);
		// default: date desc, then employeeCode asc
		expect(p1.rows[0]!.date).toBe(FRI);
		const fri = p1.rows.filter((r) => r.date === FRI).map((r) => r.employeeCode as string);
		expect(fri).toEqual([...fri].sort());
	});

	it('24. an out-of-range page is safely empty', async () => {
		const d = await detail('attendance', s.hrAdmin, { ...base(), page: 99 });
		expect(d.rows).toEqual([]);
		expect(d.page.totalRows).toBe(30);
	});

	it('25–27. invalid sortBy / sortDir and injection attempts are rejected', async () => {
		for (const sortBy of [
			'checkInAt',
			'salary',
			'employeeCode;DROP TABLE employees',
			'__proto__'
		]) {
			const res = await get(`/reports/attendance/detail${q({ ...base(), sortBy })}`, s.hrAdmin);
			expect(res.status, sortBy).toBe(400);
			expect(res.body.error.code).toBe('REPORT_SORT_INVALID');
		}
		expect(
			(await get(`/reports/attendance/detail${q({ ...base(), sortDir: 'up' })}`, s.hrAdmin)).status
		).toBe(400);
		const byLate = await detail('attendance', s.hrAdmin, {
			...base(),
			sortBy: 'lateMinutes',
			sortDir: 'desc'
		});
		expect(byLate.rows[0]).toMatchObject({ employeeCode: w.emp.B.code, lateMinutes: 15 });
	});
});

// =====================================================================================
// 28–36 employee detail
// =====================================================================================
describe('employee detail', () => {
	it('28. CURRENT detail rows reconcile with the summary headcount', async () => {
		const sum = await summary('employees', s.hrAdmin, { companyId: w.companyId });
		const d = await detail('employees', s.hrAdmin, { companyId: w.companyId });
		expect(d.page.totalRows).toBe(sum.totals.total);
		expect(d.page.totalRows).toBe(7);
		expect(d.context.status).toBe('CURRENT');
	});

	it('29. manager scope', async () => {
		const d = await detail('employees', w.manager.cookie, {});
		expect(d.rows.map((r) => r.employeeCode).sort()).toEqual(
			[w.emp.MGR.code, w.emp.A.code, w.emp.B.code].sort()
		);
	});

	it('30–32. branch / department / status filters', async () => {
		expect((await detail('employees', s.hrAdmin, { branchId: w.b1 })).page.totalRows).toBe(4);
		expect((await detail('employees', s.hrAdmin, { departmentId: w.d2 })).page.totalRows).toBe(2);
		expect(
			(await detail('employees', s.hrAdmin, { departmentId: w.d2, status: 'ALL' })).page.totalRows
		).toBe(3);
		const prob = await detail('employees', s.hrAdmin, {
			companyId: w.companyId,
			status: 'PROBATION'
		});
		expect(prob.rows.map((r) => r.employeeCode)).toEqual([w.emp.Cp.code]);
	});

	it('33. a future hire is visible with its start date', async () => {
		const d = await detail('employees', s.hrAdmin, { companyId: w.companyId, pageSize: 50 });
		expect(d.rows.find((r) => r.employeeCode === w.emp.G.code)).toMatchObject({
			startDate: '2025-06-10',
			employmentStatus: 'ACTIVE'
		});
	});

	it('34–36. no national id, passport, bank, salary or personal contact data', async () => {
		const d = await detail('employees', s.hrAdmin, {
			companyId: w.companyId,
			status: 'ALL',
			pageSize: 50
		});
		const keys = Object.keys(d.rows[0]!);
		expect(keys.sort()).toEqual(REPORT_DEFINITIONS.employees.columns.map((c) => c.key).sort());
		expect(JSON.stringify(d)).not.toMatch(/nationalId|passport|bank|salary|phone|email|address/i);
	});
});

// =====================================================================================
// 37–51 attendance detail
// =====================================================================================
describe('attendance detail', () => {
	const base = () => ({ companyId: w.companyId, ...WEEK });

	it('37. one row per employee-day', async () => {
		const rows = await allRows('attendance', s.hrAdmin, base());
		expect(rows).toHaveLength(30);
		expect(new Set(rows.map((r) => `${r.date}|${r.employeeCode}`)).size).toBe(30);
	});

	it('38. the status is the Attendance module’s own daily result', async () => {
		const daily = ok<{ items: { employee: { employeeCode: string }; result: string }[] }>(
			await get(`/attendance/daily?date=${WED}&companyId=${w.companyId}&pageSize=100`, s.hrAdmin)
		);
		const rows = await allRows('attendance', s.hrAdmin, {
			companyId: w.companyId,
			from: WED,
			to: WED
		});
		const byCode = new Map(rows.map((r) => [r.employeeCode, r.status]));
		for (const i of daily.items) expect(byCode.get(i.employee.employeeCode)).toBe(i.result);
	});

	it('39–43. present / late / early / worked / leave rows', async () => {
		const rows = await allRows('attendance', s.hrAdmin, base());
		const present = [
			'PRESENT',
			'LATE',
			'EARLY_LEAVE',
			'LATE_AND_EARLY',
			'IN_PROGRESS',
			'INCOMPLETE'
		];
		expect(rows.filter((r) => present.includes(r.status as string))).toHaveLength(18);
		const at = (code: string, date: string) =>
			rows.find((r) => r.employeeCode === code && r.date === date)!;
		expect(at(w.emp.B.code, WED)).toMatchObject({
			status: 'LATE',
			lateMinutes: 15,
			workedMinutes: 465
		});
		expect(at(w.emp.B.code, TUE)).toMatchObject({ status: 'EARLY_LEAVE', earlyLeaveMinutes: 30 });
		expect(rows.reduce((n, r) => n + (r.workedMinutes as number), 0)).toBe(8595);
		expect(at(w.emp.Dd.code, WED)).toMatchObject({
			status: 'LEAVE',
			checkInAt: null,
			workedMinutes: 0
		});
		expect(at(w.emp.Cp.code, WED)).toMatchObject({ status: 'ABSENT' });
		expect(at(w.emp.A.code, MON).checkInAt).toBe(`${MON}T01:00:00.000Z`);
	});

	it('44–45. off-day and holiday rows are never absent', async () => {
		const sat = await allRows('attendance', s.hrAdmin, {
			companyId: w.companyId,
			from: SAT,
			to: SAT
		});
		expect(sat.filter((r) => r.status === 'OFF_DAY')).toHaveLength(5);
		const thu = await allRows('attendance', s.hrAdmin, {
			companyId: w.companyId,
			from: THU,
			to: THU
		});
		expect(thu.filter((r) => r.status === 'HOLIDAY')).toHaveLength(5);
		expect([...sat, ...thu].some((r) => r.status === 'ABSENT')).toBe(false);
	});

	it('46–48. no raw punches, GPS, selfie or device data', async () => {
		const d = await detail('attendance', s.hrAdmin, { ...base(), pageSize: 100 });
		expect(Object.keys(d.rows[0]!).sort()).toEqual(
			REPORT_DEFINITIONS.attendance.columns.map((c) => c.key).sort()
		);
		expect(JSON.stringify(d)).not.toMatch(
			/punch|latitude|longitude|gps|selfie|device|userAgent|ipAddress|firstCheckIn/i
		);
	});

	it('49–50. 93 days and 5,000 employee-days guards apply to detail AND export', async () => {
		const range = await get(`/reports/attendance/detail?from=2025-01-01&to=2025-06-30`, s.hrAdmin);
		expect(range.body.error.code).toBe('REPORT_DATE_RANGE_TOO_LARGE');
		const c = await bulkCompany(55);
		const big = { companyId: c, from: '2025-03-01', to: '2025-06-01' };
		const d = await get(`/reports/attendance/detail${q(big)}`, s.hrAdmin);
		expect(d.body.error).toMatchObject({
			code: 'REPORT_DATE_RANGE_TOO_LARGE',
			details: { maxEmployeeDays: 5000 }
		});
		const ex = await exportReq('attendance', s.hrAdmin, { format: 'CSV', filters: big });
		expect(ex.res.status).toBe(400);
		expect(ex.json().error.code).toBe('REPORT_DATE_RANGE_TOO_LARGE');
	});

	it('51. aggregating the detail rows gives exactly the summary totals', async () => {
		const rows = await allRows('attendance', s.hrAdmin, base());
		const sum = await summary('attendance', s.hrAdmin, { ...base(), groupBy: 'none' });
		const count = (st: string[]) => rows.filter((r) => st.includes(r.status as string)).length;
		const total = (k: string) => rows.reduce((n, r) => n + (r[k] as number), 0);
		expect(sum.totals).toMatchObject({
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
			holiday: count(['HOLIDAY']),
			noSchedule: count(['NO_SCHEDULE']),
			lateMinutes: total('lateMinutes'),
			earlyLeaveMinutes: total('earlyLeaveMinutes'),
			workedMinutes: total('workedMinutes')
		});
	});
});

// =====================================================================================
// 52–62 leave / OT detail
// =====================================================================================
describe('leave and overtime detail', () => {
	it('52–55. leave rows, approved days, status filters', async () => {
		const rows = await allRows('leave', s.hrAdmin, { companyId: w.companyId, ...JUNE });
		expect(rows).toHaveLength(4);
		expect(rows.find((r) => r.employeeCode === w.emp.Dd.code)).toMatchObject({
			status: 'APPROVED',
			approvedDays: '1.00',
			requestedDays: '1.00'
		});
		expect(rows.find((r) => r.employeeCode === w.emp.Cp.code)).toMatchObject({
			status: 'PENDING',
			approvedDays: '0.00'
		});
		const pending = await allRows('leave', s.hrAdmin, {
			companyId: w.companyId,
			...JUNE,
			status: 'PENDING'
		});
		expect(pending.map((r) => r.employeeCode)).toEqual([w.emp.Cp.code]);
		const rejected = await allRows('leave', s.hrAdmin, {
			companyId: w.companyId,
			...JUNE,
			status: 'REJECTED'
		});
		expect(rejected.map((r) => r.employeeCode)).toEqual([w.emp.A.code]);
	});

	it('56–57, 60. no private reason or approval notes (leave and OT)', async () => {
		const leave = await detail('leave', s.hrAdmin, { companyId: w.companyId, ...JUNE });
		const ot = await detail('overtime', s.hrAdmin, { companyId: w.companyId, ...JUNE });
		for (const d of [leave, ot]) {
			expect(JSON.stringify(d)).not.toMatch(/QA reporting|reason|reviewNote|note/i);
		}
	});

	it('58–59. OT eligible minutes from the OT domain; rejected / pending are not eligible', async () => {
		const rows = await allRows('overtime', s.hrAdmin, { companyId: w.companyId, ...JUNE });
		const by = (code: string) => rows.find((r) => r.employeeCode === code)!;
		expect(by(w.emp.A.code)).toMatchObject({
			status: 'APPROVED',
			eligibleMinutes: 90,
			plannedMinutes: 120
		});
		expect(by(w.emp.Dd.code)).toMatchObject({ status: 'REJECTED', eligibleMinutes: null });
		expect(by(w.emp.Cp.code)).toMatchObject({ status: 'PENDING', eligibleMinutes: null });
	});

	it('61. detail totals reconcile with both summaries', async () => {
		const leaveRows = await allRows('leave', s.hrAdmin, { companyId: w.companyId, ...JUNE });
		const leaveSum = await summary('leave', s.hrAdmin, {
			companyId: w.companyId,
			...JUNE,
			groupBy: 'none'
		});
		const st = (rows: typeof leaveRows, v: string) => rows.filter((r) => r.status === v).length;
		expect(leaveSum.totals).toMatchObject({
			requests: leaveRows.length,
			approved: st(leaveRows, 'APPROVED'),
			pending: st(leaveRows, 'PENDING'),
			rejected: st(leaveRows, 'REJECTED'),
			cancelled: st(leaveRows, 'CANCELLED'),
			approvedDays: leaveRows.reduce((n, r) => n + Number(r.approvedDays), 0).toFixed(2)
		});
		const otRows = await allRows('overtime', s.hrAdmin, { companyId: w.companyId, ...JUNE });
		const otSum = await summary('overtime', s.hrAdmin, {
			companyId: w.companyId,
			...JUNE,
			groupBy: 'none'
		});
		expect(otSum.totals).toMatchObject({
			requests: otRows.length,
			approved: st(otRows, 'APPROVED'),
			eligibleMinutes: otRows.reduce((n, r) => n + ((r.eligibleMinutes as number | null) ?? 0), 0)
		});
	});

	it('62. manager scope applies to both', async () => {
		expect((await detail('leave', w.manager.cookie, JUNE)).page.totalRows).toBe(2);
		expect((await detail('overtime', w.manager.cookie, JUNE)).page.totalRows).toBe(2);
	});
});

// =====================================================================================
// 98–109 export security
// =====================================================================================
describe('export security', () => {
	it('98. reports.export is required on top of the report permissions', async () => {
		const noExport = await withPerms(['reports.view', 'employees.view', 'employees.view_all']);
		expect(
			(await exportReq('employees', noExport, { format: 'CSV', filters: {} })).res.status
		).toBe(403);
		const withExport = await withPerms([
			'reports.view',
			'reports.export',
			'employees.view',
			'employees.view_all'
		]);
		expect(
			(
				await exportReq('employees', withExport, {
					format: 'CSV',
					filters: { companyId: w.companyId }
				})
			).res.status
		).toBe(200);
		const exportOnly = await withPerms(['reports.export', 'employees.view', 'employees.view_all']);
		expect(
			(await exportReq('employees', exportOnly, { format: 'CSV', filters: {} })).res.status
		).toBe(403);
	});

	it('99. an employee cannot export anything', async () => {
		for (const t of [
			'employees',
			'attendance',
			'leave',
			'overtime',
			'payroll',
			'payments',
			'accounting'
		]) {
			expect(
				(await exportReq(t, w.employeeUser.cookie, { format: 'CSV', filters: {} })).res.status
			).toBe(403);
		}
	});

	it('100–101. a manager exports employees / attendance for the team only', async () => {
		const emp = await exportReq('employees', w.manager.cookie, { format: 'CSV', filters: {} });
		expect(emp.res.status).toBe(200);
		expect(emp.res.headers['x-report-rows']).toBe('3');
		const att = await exportReq('attendance', w.manager.cookie, { format: 'CSV', filters: WEEK });
		const codes = new Set(
			csvLines(att.bytes)
				.slice(1)
				.map((l) => l.split(',')[1])
		);
		expect([...codes].sort()).toEqual([w.emp.MGR.code, w.emp.A.code, w.emp.B.code].sort());
		for (const t of ['leave', 'overtime']) {
			expect(
				(await exportReq(t, w.manager.cookie, { format: 'CSV', filters: JUNE })).res.status
			).toBe(200);
		}
	});

	it('102–104. a manager can never export payroll, payments or accounting', async () => {
		for (const t of ['payroll', 'payments', 'accounting']) {
			const r = await exportReq(t, w.manager.cookie, {
				format: 'CSV',
				filters: { companyId: w.companyId }
			});
			expect(r.res.status, t).toBe(403);
		}
	});

	it('105–106. cross-company and out-of-scope branch exports are blocked', async () => {
		const co = await exportReq('employees', w.manager.cookie, {
			format: 'CSV',
			filters: { companyId: other.companyId }
		});
		expect(co.res.status).toBe(403);
		expect(co.json().error.code).toBe('REPORT_FILTER_NOT_ALLOWED');
		const br = await exportReq('attendance', w.manager.cookie, {
			format: 'XLSX',
			filters: { ...WEEK, branchId: w.b2 }
		});
		expect(br.res.status).toBe(403);
	});

	it('107–109. unknown, non-exportable and zero columns are rejected', async () => {
		const unknown = await exportReq('employees', s.hrAdmin, {
			format: 'CSV',
			filters: {},
			columns: ['nationalId']
		});
		expect(unknown.json().error.code).toBe('REPORT_COLUMN_INVALID');
		const none = await exportReq('employees', s.hrAdmin, {
			format: 'CSV',
			filters: {},
			columns: []
		});
		expect(none.json().error.code).toBe('REPORT_COLUMNS_REQUIRED');
		// the catalogue guard refuses a column flagged non-exportable
		const def = {
			...REPORT_DEFINITIONS.employees,
			columns: REPORT_DEFINITIONS.employees.columns.map((c) =>
				c.key === 'position' ? { ...c, exportable: false } : c
			)
		};
		expect(() => resolveColumns(def, ['position'], { forExport: true })).toThrow(/ຄໍລຳບໍ່ຖືກຕ້ອງ/);
		expect(resolveColumns(def, ['position'], { forExport: false })).toHaveLength(1);
	});
});

// =====================================================================================
// 110–125 CSV
// =====================================================================================
describe('CSV export', () => {
	let formulaCompany = '';
	beforeAll(async () => {
		const c = await createTestCompany();
		formulaCompany = c.id;
		// fullName is trimmed, so TAB / CR prefixes are covered by the writer test (121)
		const names = ['=HYPERLINK("x")', '+SUM(1)', '-2+3', '@cmd', 'ກ, "ຂ"\nຄ'];
		await prisma.employee.createMany({
			data: names.map((n, i) => ({
				employeeCode: i === 0 ? `00123${c.code}` : `F${i}_${c.code}`,
				firstNameLao: n,
				lastNameLao: 'ທົດສອບ',
				startDate: D('2024-01-01'),
				companyId: c.id
			}))
		});
	});
	const att = () => ({ format: 'CSV', filters: { companyId: w.companyId, ...WEEK } });

	it('110–114. content type, safe file name, row / hash headers, UTF-8 BOM + Lao', async () => {
		const { res, bytes } = await exportReq('attendance', s.hrAdmin, att());
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
		expect(res.headers['content-disposition']).toBe(
			'attachment; filename="REPORT-ATTENDANCE-20250602-20250606.csv"'
		);
		expect(res.headers['x-report-rows']).toBe('30');
		expect(res.headers['x-report-hash']).toBe(createHash('sha256').update(bytes).digest('hex'));
		expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		expect(csvLines(bytes)[0]).toContain('ລະຫັດພະນັກງານ');
		expect(csvLines(bytes)).toHaveLength(31);
	});

	it('115–120. RFC 4180 quoting, CRLF, and = + - @ neutralised (API)', async () => {
		const { bytes } = await exportReq('employees', s.hrAdmin, {
			format: 'CSV',
			filters: { companyId: formulaCompany },
			columns: ['employeeCode', 'fullName']
		});
		const text = bytes.toString('utf8').replace(BOM, '');
		expect(text.endsWith('\r\n')).toBe(true);
		expect(text).toContain(`"'=HYPERLINK(""x"") ທົດສອບ"`);
		expect(text).toContain(`'+SUM(1) ທົດສອບ`);
		expect(text).toContain(`'-2+3 ທົດສອບ`);
		expect(text).toContain(`'@cmd ທົດສອບ`);
		expect(text).toContain(`"ກ, ""ຂ""\nຄ ທົດສອບ"`);
		expect(text).toContain('00123'); // leading zeros kept in the CSV bytes
		// every record ends with CRLF: 1 header + 5 rows (one quoted field contains a bare LF)
		expect(text.match(/\r\n/g)).toHaveLength(6);
	});

	it('121. TAB / CR at the start of a text cell are neutralised too (writer)', () => {
		const cols = REPORT_DEFINITIONS.employees.columns.filter((c) => c.key === 'fullName');
		const text = buildReportCsv(cols, [
			{ fullName: '\tTAB' },
			{ fullName: '\rCR' },
			{ fullName: '=1+1' }
		])
			.toString('utf8')
			.slice(1); // BOM
		expect(text).toBe(`ຊື່ ແລະ ນາມສະກຸນ\r\n'\tTAB\r\n"'\rCR"\r\n'=1+1\r\n`);
	});

	it('123. minutes stay integers', async () => {
		const { bytes } = await exportReq('attendance', s.hrAdmin, {
			...att(),
			columns: ['date', 'employeeCode', 'lateMinutes', 'workedMinutes']
		});
		const late = csvLines(bytes).find((l) => l.startsWith(`${WED},${w.emp.B.code}`));
		expect(late).toBe(`${WED},${w.emp.B.code},15,465`);
	});

	it('124–125. the CSV holds exactly the filtered rows in the requested order', async () => {
		const filters = { companyId: w.companyId, ...WEEK, branchId: w.b1 };
		const rows = await allRows('attendance', s.hrAdmin, {
			...filters,
			sortBy: 'workedMinutes',
			sortDir: 'asc'
		});
		const { bytes } = await exportReq('attendance', s.hrAdmin, {
			format: 'CSV',
			filters,
			sortBy: 'workedMinutes',
			sortDir: 'asc',
			columns: ['date', 'employeeCode', 'workedMinutes']
		});
		expect(csvLines(bytes).slice(1)).toEqual(
			rows.map((r) => `${r.date},${r.employeeCode},${r.workedMinutes}`)
		);
	});
});

// =====================================================================================
// 126–138 XLSX
// =====================================================================================
describe('XLSX export', () => {
	it('126–133. valid workbook: sheet, selected columns, Lao, text codes, numeric minutes, ISO dates', async () => {
		const { res, bytes } = await exportReq('attendance', s.hrAdmin, {
			format: 'XLSX',
			filters: { companyId: w.companyId, ...WEEK },
			columns: ['date', 'employeeCode', 'employeeName', 'status', 'lateMinutes']
		});
		expect(res.headers['content-type']).toBe(
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
		);
		const { wb, ws } = sheetOf(bytes);
		expect(wb.SheetNames).toEqual(['Attendance']);
		const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
		expect(rows[0]).toEqual(['ວັນທີ', 'ລະຫັດພະນັກງານ', 'ຊື່ພະນັກງານ', 'ຜົນ', 'ມາຊ້າ (ນາທີ)']);
		expect(rows).toHaveLength(31);
		const bRow = rows.findIndex((r) => r[0] === WED && r[1] === w.emp.B.code) + 1;
		expect(ws[`B${bRow}`]).toMatchObject({ t: 's', v: w.emp.B.code });
		expect(ws[`C${bRow}`].v).toContain('ລາຍງານ');
		expect(ws[`E${bRow}`]).toMatchObject({ t: 'n', v: 15 });
		expect(ws[`A${bRow}`].v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('130. employee codes with leading zeros stay text', async () => {
		const c = await createTestCompany();
		const zeroCode = `000${String(Date.now()).slice(-9)}`; // all digits: a number if typed wrongly
		await prisma.employee.create({
			data: {
				employeeCode: zeroCode,
				firstNameLao: 'ສູນ',
				lastNameLao: 'ນຳໜ້າ',
				startDate: D('2024-01-01'),
				companyId: c.id
			}
		});
		const { bytes } = await exportReq('employees', s.hrAdmin, {
			format: 'XLSX',
			filters: { companyId: c.id }
		});
		const { ws } = sheetOf(bytes);
		expect(ws.A2).toMatchObject({ t: 's', v: zeroCode });
	});

	it('134–136. no formulas, no macros, no hidden columns, only the selected columns', async () => {
		const { bytes } = await exportReq('employees', s.hrAdmin, {
			format: 'XLSX',
			filters: { companyId: w.companyId },
			columns: ['employeeCode', 'fullName']
		});
		const files = unzipStore(bytes);
		expect(Object.keys(files).some((f) => /vba|macro/i.test(f))).toBe(false);
		expect(files['[Content_Types].xml']).not.toMatch(/macroEnabled/);
		const sheet = files['xl/worksheets/sheet1.xml']!;
		expect(sheet).not.toMatch(/<f>|<f |hidden="1"|hyperlink/);
		const { ws } = sheetOf(bytes);
		expect(ws['!ref']).toBe('A1:B8');
		expect(Object.values(ws).some((c) => typeof c === 'object' && c && 'f' in c)).toBe(false);
	});

	it('137–138. filters and sort are exactly the detail table’s', async () => {
		const filters = { companyId: w.companyId, ...WEEK, departmentId: w.d2 };
		const rows = await allRows('attendance', s.hrAdmin, {
			...filters,
			sortBy: 'employeeName',
			sortDir: 'desc'
		});
		const { bytes } = await exportReq('attendance', s.hrAdmin, {
			format: 'XLSX',
			filters,
			sortBy: 'employeeName',
			sortDir: 'desc',
			columns: ['date', 'employeeCode']
		});
		const out = XLSX.utils.sheet_to_json<string[]>(sheetOf(bytes).ws, { header: 1 }).slice(1);
		expect(out).toEqual(rows.map((r) => [r.date, r.employeeCode]));
	});
});

// =====================================================================================
// 139–154 PDF
// =====================================================================================
describe('PDF export', () => {
	it('139–148. %PDF, file name, Lao font, title, filters, timestamp, pages, columns, repeated header', async () => {
		const { res, bytes } = await exportReq('attendance', s.hrAdmin, {
			format: 'PDF',
			filters: { companyId: w.companyId, ...WEEK },
			columns: ['date', 'employeeCode', 'employeeName', 'status', 'lateMinutes', 'workedMinutes']
		});
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toBe('application/pdf');
		expect(res.headers['content-disposition']).toMatch(
			/filename="REPORT-ATTENDANCE-20250602-20250606\.pdf"/
		);
		expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
		const pages = pdfPages(bytes);
		expect(pages.length).toBeGreaterThanOrEqual(2);
		expect(pages[0]!.fonts.some((f) => f.includes('NotoSansLao'))).toBe(true);
		const p1 = pages[0]!.text.join('');
		expect(p1).toContain('ລາຍງານການເຂົ້າ-ອອກວຽກ');
		expect(p1).toContain('ຊ່ວງວັນທີ: 02/06/2025 – 06/06/2025');
		expect(p1).toMatch(/ສ້າງເມື່ອ \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
		expect(p1).toContain(`Page 1 / ${pages.length}`);
		expect(p1).toContain('ມາຊ້າ (ນາທີ)');
		expect(p1).not.toContain('ເຂົ້າວຽກ'); // checkInAt was not selected
		expect(pdfAllText(bytes)).toContain('ມາຊ້າ'); // Lao status label
		const p2 = pages[1]!.text.join('');
		expect(p2).toContain('ລະຫັດພະນັກງານ'); // header repeated on page 2
		expect(p2).toContain(`Page 2 / ${pages.length}`);
		expect(pdfAllText(bytes)).toContain('465'); // B on Wednesday: 465 minutes (whole minutes, as labelled)
		expect(pdfAllText(bytes)).not.toContain('7h 45m');
	});

	it('151. long Lao / Latin values wrap inside their column (no overlap)', () => {
		const long =
			'ບັນທຶກຄ່າໃຊ້ຈ່າຍເງິນເດືອນປະຈຳເດືອນມັງກອນ PAYROLL-ACCRUAL-2027-01-QA17 ສຳລັບພະແນກລາຍງານ';
		for (const width of [40, 60, 120]) {
			const lines = measureCell(long, width);
			expect(lines.length).toBeGreaterThan(1);
			for (const lw of lines) expect(lw).toBeLessThanOrEqual(width + 0.01);
		}
		expect(measureCell('5,552,250.00', 60)).toHaveLength(1);
	});

	it('151b. a wrapped header never breaks right after "(" or right before ")"', () => {
		const units = breakUnits('ອອກກ່ອນ (ນາທີ)');
		expect(units.some((u) => u.trim() === '(' || u.trimEnd().endsWith('('))).toBe(false);
		expect(units.some((u) => u.startsWith('(ນາທີ'))).toBe(true);
		expect(units.some((u) => u.startsWith(')'))).toBe(false);
	});

	it('152. more than 10 PDF columns → REPORT_PDF_TOO_MANY_COLUMNS', async () => {
		const all = REPORT_DEFINITIONS.attendance.columns.map((c) => c.key);
		const r = await exportReq('attendance', s.hrAdmin, {
			format: 'PDF',
			filters: { companyId: w.companyId, ...WEEK },
			columns: all
		});
		expect(r.res.status).toBe(400);
		expect(r.json().error).toMatchObject({
			code: 'REPORT_PDF_TOO_MANY_COLUMNS',
			details: { maxColumns: 10, selected: 12 }
		});
	});

	it('154. no sensitive fields in the PDF', async () => {
		const { bytes } = await exportReq('employees', s.hrAdmin, {
			format: 'PDF',
			filters: { companyId: w.companyId }
		});
		expect(pdfAllText(bytes)).not.toMatch(/nationalId|passport|salary|bank/i);
	});
});

// =====================================================================================
// 153, 155–160 limits
// =====================================================================================
describe('export limits (never truncated)', () => {
	let big = '';
	beforeAll(async () => {
		big = await bulkCompany(25_001);
	}, 180_000);

	it('155–158, 160. CSV / XLSX above 25,000 and PDF above 5,000 rows are refused with the estimate', async () => {
		for (const format of ['CSV', 'XLSX'] as const) {
			const r = await exportReq('employees', s.hrAdmin, { format, filters: { companyId: big } });
			expect(r.res.status, format).toBe(400);
			expect(r.json().error).toMatchObject({
				code: 'REPORT_EXPORT_TOO_LARGE',
				details: { format, estimatedRows: 25_001, maxRows: 25_000 }
			});
		}
		const pdf = await exportReq('employees', s.hrAdmin, {
			format: 'PDF',
			filters: { companyId: big }
		});
		expect(pdf.json().error).toMatchObject({
			code: 'REPORT_EXPORT_TOO_LARGE',
			details: { format: 'PDF', estimatedRows: 25_001, maxRows: 5_000 }
		});
		// the detail table refuses the same set instead of loading it
		const d = await get(`/reports/employees/detail?companyId=${big}`, s.hrAdmin);
		expect(d.body.error).toMatchObject({
			code: 'REPORT_DETAIL_TOO_LARGE',
			details: { estimatedRows: 25_001 }
		});
	}, 120_000);

	it('153. PDF between 5,000 and 25,000 rows: refused for PDF, allowed for CSV (no truncation)', async () => {
		const mid = await bulkCompany(5_001);
		const pdf = await exportReq('employees', s.hrAdmin, {
			format: 'PDF',
			filters: { companyId: mid }
		});
		expect(pdf.json().error).toMatchObject({
			code: 'REPORT_EXPORT_TOO_LARGE',
			details: { estimatedRows: 5_001 }
		});
		const csv = await exportReq('employees', s.hrAdmin, {
			format: 'CSV',
			filters: { companyId: mid },
			columns: ['employeeCode']
		});
		expect(csv.res.status).toBe(200);
		expect(csv.res.headers['x-report-rows']).toBe('5001');
		expect(csvLines(csv.bytes)).toHaveLength(5_002);
	}, 120_000);
});

// =====================================================================================
// 161–168 audit / privacy
// =====================================================================================
describe('export audit and privacy', () => {
	it('161–162, 164–166. REPORT.EXPORTED with format / rows / hash / columns — no names or sensitive data', async () => {
		const { res } = await exportReq('attendance', s.hrAdmin, {
			format: 'XLSX',
			filters: { companyId: w.companyId, ...WEEK },
			columns: ['date', 'employeeCode', 'employeeName', 'status']
		});
		const ev = await prisma.auditEvent.findFirstOrThrow({
			where: { action: 'REPORT.EXPORTED', entityId: 'attendance' },
			orderBy: { createdAt: 'desc' }
		});
		expect(ev.companyId).toBe(w.companyId);
		expect(ev.metadataJson).toMatchObject({
			reportType: 'attendance',
			format: 'XLSX',
			rowCount: 30,
			columnKeys: ['date', 'employeeCode', 'employeeName', 'status'],
			fileHash: res.headers['x-report-hash']
		});
		const meta = JSON.stringify(ev.metadataJson);
		expect(meta).toMatch(/normalizedFilterHash/);
		expect(meta).not.toMatch(/ລາຍງານ|bank|account|\btin\b|\bssn\b|salary|netPay|amount/i);
		for (const e of Object.values(w.emp)) expect(meta).not.toContain(e.code);
	});

	it('167. a saved filter stores state only (no rows, amounts or names)', async () => {
		const rows = await prisma.savedReportFilter.findMany({ take: 50 });
		for (const r of rows) {
			const text = JSON.stringify({ f: r.filtersJson, c: r.columnsJson });
			expect(text).not.toMatch(/rows|netPay|amount|salary|ລາຍງານ/);
			for (const k of Object.keys((r.filtersJson ?? {}) as object)) {
				expect([
					'companyId',
					'branchId',
					'departmentId',
					'employeeId',
					'leaveTypeId',
					'from',
					'to',
					'status',
					'payrollMonth',
					'scheduleId',
					'journalType'
				]).toContain(k);
			}
		}
	});

	it('168. global scan of detail responses and exports for sensitive markers', async () => {
		const surfaces: string[] = [];
		for (const t of ['employees', 'attendance', 'leave', 'overtime']) {
			const p =
				t === 'employees'
					? { companyId: w.companyId }
					: { companyId: w.companyId, ...(t === 'attendance' ? WEEK : JUNE) };
			surfaces.push(JSON.stringify(await detail(t, s.hrAdmin, p)));
			surfaces.push(
				(await exportReq(t, s.hrAdmin, { format: 'CSV', filters: p })).bytes.toString('utf8')
			);
		}
		for (const text of surfaces) {
			expect(text).not.toMatch(
				/nationalId|passport|latitude|longitude|selfie|bankAccount|accountNumber|taxNumber|reviewNote|QA reporting/i
			);
		}
	});
});
