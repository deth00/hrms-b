import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Router } from 'express';
import { prisma } from '../src/config/prisma.js';
import { setServerClockForTests } from '../src/lib/clock.js';
import { v1Router } from '../src/routes/index.js';
import { ID_MAX } from '../src/validation/common.schema.js';
import {
	MON,
	NOW,
	at,
	correctionCase,
	fx,
	get,
	leaveReq,
	mkPerson,
	otReq,
	post,
	setupFixture,
	subject,
	type Person
} from './phase10Fixture.js';
import { agent } from './helpers.js';

/**
 * Numeric-ID migration M7 — full-surface regression of the numeric id contract:
 *  - EVERY parametrised route (enumerated from the live router, not a hand-kept list) rejects malformed
 *    and legacy-CUID ids with 400 before any lookup, and answers a valid-but-unknown id without a 5xx
 *    (GET → 404);
 *  - every id-named field of every list/detail response is a JSON number (never a numeric string);
 *  - sequential numeric ids cannot be used to reach another employee's self-service resources, and
 *    manager scope is unchanged.
 */
beforeEach(() => at(NOW));
afterEach(() => setServerClockForTests(null));

const CUID = 'cmucegkak0001h26o89kl0q0p';
// one of each rejection class per route; the parser's full edge-case table is numericId.test.ts N1/N5
const MALFORMED = [CUID, 'abc', '0', '2147483648'];
/** path params that are NOT numeric ids */
const NON_ID_PARAMS = new Set(['reportType']);

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface RouteDef {
	method: Method;
	path: string;
}

/** Every route of the v1 API, read from the Express 5 router stack (routers are mounted without prefix). */
function allRoutes(): RouteDef[] {
	const out: RouteDef[] = [];
	const walk = (router: Router) => {
		for (const layer of (router as unknown as { stack: Layer[] }).stack) {
			if (layer.route) {
				for (const m of Object.keys(layer.route.methods) as Method[])
					if (layer.route.methods[m]) out.push({ method: m, path: layer.route.path });
			} else if (layer.handle && 'stack' in layer.handle) walk(layer.handle as unknown as Router);
		}
	};
	walk(v1Router);
	return out;
}
interface Layer {
	route?: { path: string; methods: Record<string, boolean> };
	handle?: unknown;
}

const idParams = (path: string) =>
	[...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!).filter((p) => !NON_ID_PARAMS.has(p));
const fill = (path: string, value: (param: string) => string) =>
	path.replace(/:([A-Za-z]+)/g, (_, p: string) => (NON_ID_PARAMS.has(p) ? 'attendance' : value(p)));
/** routes whose query carries a REQUIRED id (validated before the lookup) */
const REQUIRED_QUERY_IDS: Record<string, string[]> = {
	'/payroll/payment-batches/:id/export-preview': ['bankExportProfileId']
};
const withQuery = (r: RouteDef, url: string, value: string) => {
	const q = REQUIRED_QUERY_IDS[r.path];
	return q ? `${url}?${q.map((k) => `${k}=${value}`).join('&')}` : url;
};
const send = (r: RouteDef, url: string, cookie: string) => {
	const req = agent()
		[r.method](`/api/v1${withQuery(r, url, String(ID_MAX))}`)
		.set('Cookie', cookie);
	return r.method === 'get' || r.method === 'delete' ? req : req.send({});
};

/** SUPER_ADMIN (every permission) AND linked to an employee, so self-service routes reach validation too */
let root: Person;
beforeAll(async () => {
	await setupFixture();
	root = await mkPerson({ roleCode: 'SUPER_ADMIN' });
});

// ============================================================================================
describe('route sweep: every numeric [id] route (enumerated from the router)', () => {
	const routes = allRoutes().filter((r) => idParams(r.path).length > 0);

	it('R0. the router exposes the audited parametrised routes (guards against an empty sweep)', () => {
		expect(routes.length).toBeGreaterThanOrEqual(150);
		const params = new Set(routes.flatMap((r) => idParams(r.path)));
		for (const p of ['id', 'employeeId', 'companyId', 'runId', 'itemId', 'rowId', 'accountId'])
			expect(params, p).toContain(p);
	});

	it('R1. malformed / legacy-CUID ids → 400 VALIDATION_ERROR on every route and method (no lookup, no 5xx)', async () => {
		const failures: string[] = [];
		for (const r of routes) {
			for (const bad of MALFORMED) {
				// one parameter malformed at a time, the others valid-but-unknown
				for (const target of idParams(r.path)) {
					const url = fill(r.path, (p) =>
						p === target ? encodeURIComponent(bad) : String(ID_MAX)
					);
					const res = await send(r, url, root.cookie);
					if (res.status !== 400 || res.body?.error?.code !== 'VALIDATION_ERROR')
						failures.push(
							`${r.method.toUpperCase()} ${url} → ${res.status} ${res.body?.error?.code}`
						);
				}
			}
		}
		// required query ids are held to the same rule
		for (const path of Object.keys(REQUIRED_QUERY_IDS)) {
			const url = `/api/v1${fill(path, () => String(ID_MAX))}?${REQUIRED_QUERY_IDS[path]![0]}=${CUID}`;
			const res = await agent().get(url).set('Cookie', root.cookie);
			if (res.status !== 400) failures.push(`GET ${url} → ${res.status}`);
		}
		expect(failures).toEqual([]);
	}, 120_000);

	it('R2. a valid but unknown id → GET 404; writes never 5xx and never 2xx', async () => {
		const failures: string[] = [];
		for (const r of routes) {
			const url = fill(r.path, () => String(ID_MAX));
			const res = await send(r, url, root.cookie);
			const ok = r.method === 'get' ? res.status === 404 : res.status >= 400 && res.status < 500;
			if (!ok)
				failures.push(`${r.method.toUpperCase()} ${url} → ${res.status} ${res.body?.error?.code}`);
		}
		expect(failures).toEqual([]);
	}, 120_000);
});

// ============================================================================================
/** keys that are ids by name but are NOT numeric entity ids by contract (M6 report §3.3) */
const STRING_ID_KEYS = new Set(['requestId', 'nationalId', 'legacyId', 'entityId']);
const isIdKey = (k: string) => k === 'id' || /[a-z]Id$/.test(k);
const isIdListKey = (k: string) => /[a-z]Ids$/.test(k);

function idTypeViolations(value: unknown, path = '$', out: string[] = []): string[] {
	if (Array.isArray(value)) value.forEach((v, i) => idTypeViolations(v, `${path}[${i}]`, out));
	else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) {
			const p = `${path}.${k}`;
			if (isIdKey(k) && !STRING_ID_KEYS.has(k)) {
				if (v !== null && typeof v !== 'number') out.push(`${p} = ${JSON.stringify(v)}`);
				else if (typeof v === 'number' && !(Number.isInteger(v) && v > 0 && v <= ID_MAX))
					out.push(`${p} = ${v} (not a positive INT)`);
			} else if (isIdListKey(k) && Array.isArray(v)) {
				v.forEach((x, i) => {
					if (typeof x !== 'number') out.push(`${p}[${i}] = ${JSON.stringify(x)}`);
				});
			}
			idTypeViolations(v, p, out);
		}
	}
	return out;
}
const firstId = (body: { data?: unknown }): number | undefined => {
	const d = body?.data as { items?: { id?: unknown }[] } | { id?: unknown }[] | undefined;
	const list = Array.isArray(d) ? d : d?.items;
	const id = list?.[0]?.id;
	return typeof id === 'number' ? id : undefined;
};

describe('response id types (every GET list route + its detail route)', () => {
	it('R3. every id-named field in every response is a positive INT number — never a numeric string', async () => {
		// data for the walk: leave, OT, correction, approvals, notifications
		const s = await subject();
		expect((await leaveReq(s)).status).toBe(201);
		expect((await otReq(s, '2026-09-22')).status).toBe(201);
		await correctionCase();

		const gets = allRoutes().filter((r) => r.method === 'get');
		const lists = gets.filter((r) => idParams(r.path).length === 0 && !r.path.includes(':'));
		const details = new Map(
			gets
				.filter((r) => /\/:id$/.test(r.path) && idParams(r.path).length === 1)
				.map((r) => [r.path.slice(0, -'/:id'.length), r])
		);
		const violations: string[] = [];
		let walked = 0;
		for (const r of lists) {
			const cookie = r.path.includes('/me') ? s.cookie : root.cookie;
			const res = await agent().get(`/api/v1${r.path}`).set('Cookie', cookie);
			if (res.status !== 200 || !res.type.includes('json')) continue;
			walked++;
			violations.push(...idTypeViolations(res.body).map((v) => `GET ${r.path} ${v}`));
			const detail = details.get(r.path);
			const id = firstId(res.body);
			if (detail && id !== undefined) {
				const d = await agent().get(`/api/v1${r.path}/${id}`).set('Cookie', cookie);
				expect(d.status, `GET ${r.path}/${id}`).toBe(200);
				walked++;
				violations.push(...idTypeViolations(d.body).map((v) => `GET ${r.path}/${id} ${v}`));
			}
		}
		expect(walked).toBeGreaterThanOrEqual(40);
		expect(violations).toEqual([]);
	}, 120_000);
});

// ============================================================================================
describe('no sequential-id enumeration across employees (self-service)', () => {
	it("R4. employee A cannot read / cancel B's leave, OT or correction by guessing the numeric id", async () => {
		const a = await subject();
		const b = await subject();
		const leave = await leaveReq(b);
		const ot = await otReq(b, '2026-09-22');
		expect(leave.status).toBe(201);
		expect(ot.status).toBe(201);
		const corrB = await correctionCase();

		const cases: [string, number, string][] = [
			['/leave/me/requests', leave.body.data.id, 'leave'],
			['/overtime/me/requests', ot.body.data.id, 'ot']
		];
		for (const [base, id, what] of cases) {
			// B sees it; A — whose own ids are adjacent integers — gets the same 404 as a missing id
			expect((await get(`${base}/${id}`, b.cookie)).status, what).toBe(200);
			for (const guess of [id, id - 1, id + 1]) {
				const res = await get(`${base}/${guess}`, a.cookie);
				expect(res.status, `${what} ${guess}`).toBe(404);
			}
			expect((await post(`${base}/${id}/cancel`, a.cookie)).status, what).toBe(404);
		}
		expect((await get(`/attendance/me/corrections/${corrB.id}`, a.cookie)).status).toBe(404);
		expect((await post(`/attendance/me/corrections/${corrB.id}/cancel`, a.cookie)).status).toBe(
			404
		);

		// nothing was cancelled by A's attempts
		expect(
			(await prisma.leaveRequest.findUniqueOrThrow({ where: { id: leave.body.data.id } })).status
		).toBe('PENDING');
		expect(
			(await prisma.overtimeRequest.findUniqueOrThrow({ where: { id: ot.body.data.id } })).status
		).toBe('PENDING');
		expect(
			(await prisma.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id: corrB.id } }))
				.status
		).toBe('PENDING');
	});

	it("R5. a user cannot mark another user's notification read by guessing its id", async () => {
		const a = await subject();
		const b = await subject();
		await leaveReq(b); // notifies B's approvers; give B one of their own too
		const mine = await prisma.notification.create({
			data: { userId: b.user.id, type: 'REQUEST_APPROVED', titleLao: 'B' }
		});
		const res = await post(`/notifications/${mine.id}/read`, a.cookie);
		expect(res.status).toBe(404);
		expect(
			(await prisma.notification.findUniqueOrThrow({ where: { id: mine.id } })).readAt
		).toBeNull();
		expect((await post(`/notifications/${mine.id}/read`, b.cookie)).status).toBe(200);
	});

	it('R6. an EMPLOYEE cannot use HR / approval / payroll id routes at all', async () => {
		const a = await subject();
		const b = await subject();
		for (const url of [
			`/employees/${b.employee.id}`,
			`/leave/requests/${1}`,
			`/payroll/runs/${1}`,
			`/payroll/results/${1}`,
			`/payslips/${1}`,
			`/payroll/payment-batches/${1}`,
			`/payroll/accounting/journals/${1}`,
			`/audit-events/${1}`
		]) {
			const res = await get(url, a.cookie);
			expect([403, 404], url).toContain(res.status);
			expect(JSON.stringify(res.body), url).not.toContain(b.employee.employeeCode);
		}
	});
});

// ============================================================================================
describe('manager scope unchanged by numeric ids', () => {
	it('R7. a manager reads their tree only; a numeric neighbour outside the tree is not reachable', async () => {
		// fixture chain: G ← M ← subject
		const s = await subject();
		expect((await get(`/employees/${s.employee.id}`, fx.M.cookie)).status).toBe(200);
		expect((await get(`/employees/${s.employee.id}`, fx.G.cookie)).status).toBe(200);
		const outsider = await mkPerson({ roleCode: 'EMPLOYEE' });
		for (const id of [outsider.employee.id, fx.G.employee.id, fx.HR1.employee.id]) {
			const res = await get(`/employees/${id}`, fx.M.cookie);
			expect([403, 404], String(id)).toContain(res.status);
		}
		const list = await get(`/employees?pageSize=100`, fx.M.cookie);
		expect(list.status).toBe(200);
		const ids = list.body.data.items.map((e: { id: number }) => e.id);
		expect(ids).toContain(s.employee.id);
		expect(ids).not.toContain(outsider.employee.id);
		expect(ids).not.toContain(fx.G.employee.id);
	});

	it('R8. a manager has no payroll / payment / accounting access by id or list', async () => {
		for (const url of [
			'/payroll/runs',
			`/payroll/runs/${1}`,
			`/payroll/results/${1}`,
			`/payslips/${1}`,
			'/payroll/payment-batches',
			`/payroll/payment-batches/${1}`,
			'/payroll/accounting/journals',
			`/payroll/accounting/journals/${1}`
		]) {
			const res = await get(url, fx.M.cookie);
			expect(res.status, url).toBe(403);
		}
		for (const url of [
			`/payroll/payment-reversals/${1}/accounting-journal`,
			`/payroll/runs/${1}/accounting-journal`,
			`/payroll/runs/${1}/finalize`
		]) {
			const res = await post(url, fx.M.cookie);
			expect(res.status, `POST ${url}`).toBe(403);
		}
	});

	it('R9. a leave request on day MON by a subordinate is visible to the manager in team scope', async () => {
		const s = await subject();
		const r = await leaveReq(s, MON, MON);
		expect(r.status).toBe(201);
		const team = await get(`/leave/requests?pageSize=100`, fx.M.cookie);
		expect(team.status).toBe(200);
		expect(team.body.data.items.map((x: { id: number }) => x.id)).toContain(r.body.data.id);
		const notTeam = await get(`/leave/requests?pageSize=100`, fx.HR2.cookie);
		// HR2 holds employees.view_all → company scope, still numeric ids
		for (const x of notTeam.body.data.items) expect(typeof x.id).toBe('number');
	});
});
