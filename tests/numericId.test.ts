import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { setServerClockForTests } from '../src/lib/clock.js';
import { idRef } from '../src/lib/idFormat.js';
import { ID_MAX, idParamSchema, idSchema, parseId } from '../src/validation/common.schema.js';
import {
	databaseNameOf,
	assertNumericIdMode,
	assertNumericSchemaShapeOf
} from '../src/config/numericIdMode.js';
import { idKey } from '../src/services/payrollApprovalSnapshot.js';
import { writeAuditEvent } from '../src/services/audit.service.js';
import { auditEntityIdAliases } from '../src/services/auditEntityAlias.js';
import { createNotifications } from '../src/services/notification.service.js';
import {
	MON,
	NOW,
	approve,
	at,
	correctionCase,
	fx,
	get,
	instanceOf,
	laos,
	leaveReq,
	otReq,
	perm,
	post,
	setupFixture,
	subject,
	threeStepLeave,
	uid,
	workflowOf
} from './phase10Fixture.js';
import { agent } from './helpers.js';

/**
 * Numeric-ID migration M6 — the numeric id contract and every derived-key / link / audit rule that
 * depends on the id representation. Pre-existing behaviour tests stay in their own files unchanged.
 */
beforeEach(() => at(NOW));
afterEach(() => setServerClockForTests(null));
beforeAll(setupFixture);

const CUID_LIKE = /c[a-z0-9]{24}/;
const fakeCuid = () => `c${randomBytes(12).toString('hex')}`; // 'c' + 24 hex chars = legacy shape

// ============================================================================================
describe('shared id parser (one strict rule for path, query and body)', () => {
	it('N1. accepts canonical positive INT ids only', () => {
		for (const v of ['1', '15', '2147483647', 1, 15, ID_MAX])
			expect(parseId(v), String(v)).toBe(Number(v));
		for (const v of [
			'0',
			'-1',
			'1.5',
			'1e3',
			'',
			' 15 ',
			'015',
			'+15',
			'0x10',
			'cmucegkak0001h26o89kl0q0p',
			'2147483648',
			0,
			-1,
			1.5,
			2147483648,
			null,
			undefined,
			{},
			[1]
		])
			expect(parseId(v), JSON.stringify(v)).toBeNull();
	});

	it('N2. zod schemas output numbers and reject everything else', () => {
		expect(idSchema.parse('42')).toBe(42);
		expect(idSchema.parse(42)).toBe(42);
		expect(idParamSchema.parse({ id: '7' })).toEqual({ id: 7 });
		for (const v of ['0', '1e3', ' 15 ', 'abc', '2147483648'])
			expect(idSchema.safeParse(v).success, v).toBe(false);
	});

	it('N3. idRef / idKey are deterministic, zero-padded and numeric-order preserving', () => {
		expect(idRef(15)).toBe('000015');
		expect(idRef(1234567)).toBe('1234567'); // never truncated
		expect(['10', '9', '100'].map(Number).sort((a, b) => (idKey(a) < idKey(b) ? -1 : 1))).toEqual([
			9, 10, 100
		]);
		expect(idKey(null)).toBe('');
	});

	it('N4. rehearsal-mode guard helpers', () => {
		expect(databaseNameOf('mysql://u:p@127.0.0.1:3306/hr_db_idmig_rehearsal')).toBe(
			'hr_db_idmig_rehearsal'
		);
		expect(databaseNameOf('not a url')).toBeUndefined();
		// canonical mode must never be pointed at the dual-column rehearsal copy
		expect(() => assertNumericIdMode('mysql://u:p@127.0.0.1:3306/hr_db_idmig_rehearsal')).toThrow(
			/NUMERIC_ID_REHEARSAL/
		);
		expect(() => assertNumericIdMode('mysql://u:p@127.0.0.1:3306/hr_test')).not.toThrow();
	});
});

// ============================================================================================
describe('API id contract', () => {
	it('N5. malformed path ids → 400 VALIDATION_ERROR; a valid but unknown id → 404', async () => {
		for (const bad of [
			'cmucegkak0001h26o89kl0q0p',
			'0',
			'-1',
			'1.5',
			'1e3',
			'%2015%20',
			'015',
			'2147483648'
		]) {
			const res = await get(`/employees/${bad}`, fx.admin);
			expect(res.status, bad).toBe(400);
			expect(res.body.error.code, bad).toBe('VALIDATION_ERROR');
		}
		expect((await get(`/employees/${ID_MAX}`, fx.admin)).status).toBe(404);
		expect((await get(`/organization/companies/${ID_MAX}`, fx.admin)).status).toBe(404);
	});

	it('N6. malformed query / body ids → 400, never a lookup', async () => {
		const q = await get(`/employees?companyId=${fakeCuid()}`, fx.admin);
		expect(q.status).toBe(400);
		expect(q.body.error.code).toBe('VALIDATION_ERROR');
		const report = await get(
			`/reports/attendance/summary?departmentId=does-not-exist&from=2026-09-21&to=2026-09-25`,
			fx.admin
		);
		expect(report.status).toBe(400);
		const body = await post('/leave/me/requests', fx.M.cookie, {
			leaveTypeId: fakeCuid(),
			startDate: MON,
			endDate: MON,
			reason: 'x'
		});
		expect(body.status).toBe(400);
		expect(body.body.error.code).toBe('VALIDATION_ERROR');
	});

	it('N7. entity ids in JSON responses are numbers', async () => {
		const res = await get(`/employees/${fx.M.employee.id}`, fx.admin);
		expect(res.status).toBe(200);
		expect(typeof res.body.data.id).toBe('number');
		expect(res.body.data.id).toBe(fx.M.employee.id);
		expect(typeof res.body.data.companyId).toBe('number');
		const list = await get(`/employees?companyId=${fx.companyId}`, fx.admin);
		for (const e of list.body.data.items) expect(typeof e.id).toBe('number');
		expect(JSON.stringify(list.body)).not.toMatch(CUID_LIKE);
	});
});

// ============================================================================================
describe('derived unique keys use numeric ids and still protect duplicates', () => {
	it('N8. leave activeKey = "<employeeId>:<date>" and an overlapping request is refused', async () => {
		const s = await subject();
		const first = await leaveReq(s);
		expect(first.status, JSON.stringify(first.body)).toBe(201);
		const day = await prisma.leaveRequestDay.findFirstOrThrow({
			where: { leaveRequestId: first.body.data.id }
		});
		expect(day.activeKey).toBe(`${s.employee.id}:${MON}`);
		const dup = await leaveReq(s);
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('LEAVE_DATE_OVERLAP');
	});

	it('N9. OT activeKey = "<employeeId>:<date>:<type>" and a duplicate is refused', async () => {
		const s = await subject();
		const first = await otReq(s);
		expect(first.status, JSON.stringify(first.body)).toBe(201);
		const row = await prisma.overtimeRequest.findUniqueOrThrow({
			where: { id: first.body.data.id }
		});
		expect(row.activeKey).toBe(`${s.employee.id}:${MON}:${row.type}`);
		const dup = await otReq(s);
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('OVERTIME_OVERLAP');
	});

	it('N10. correction pendingKey = "<employeeId>:<date>" and a second pending one is refused', async () => {
		const { s, id } = await correctionCase();
		const row = await prisma.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id } });
		expect(row.pendingKey).toBe(`${s.employee.id}:${MON}`);
		const dup = await post('/attendance/me/corrections', s.cookie, {
			workDate: MON,
			type: 'TIME_ADJUSTMENT',
			requestedCheckOutAt: laos(MON, '18:30'),
			reason: 'ຊ້ຳ'
		});
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('CORRECTION_ALREADY_PENDING');
	});

	it('N11. approval workflow activeKey = "<companyId>:<TARGET>" and a second ACTIVE workflow is refused', async () => {
		const wf = await workflowOf('LEAVE');
		const row = await prisma.approvalWorkflow.findUniqueOrThrow({ where: { id: wf.id } });
		expect(row.activeKey).toBe(`${fx.companyId}:LEAVE`);
		const second = await post('/approval-workflows', fx.admin, {
			companyId: fx.companyId,
			targetType: 'LEAVE',
			code: `WF_${uid()}`,
			nameLao: 'ຊ້ຳ',
			status: 'ACTIVE',
			steps: [perm('LEAVE')]
		});
		expect(second.status).toBe(409);
		expect(second.body.error.code).toBe('ACTIVE_WORKFLOW_EXISTS');
	});

	it('N12. notification dedupeKey is idempotent per user with numeric ids', async () => {
		const key = `numeric-test:${fx.M.employee.id}:${uid()}`;
		const item = {
			userId: fx.plain.user.id,
			type: 'REQUEST_APPROVED' as const,
			titleLao: 'x',
			dedupeKey: key
		};
		await createNotifications(prisma, [item]);
		await createNotifications(prisma, [item]);
		expect(
			await prisma.notification.count({ where: { userId: fx.plain.user.id, dedupeKey: key } })
		).toBe(1);
	});
});

// ============================================================================================
describe('notification links and dedupe keys are numeric', () => {
	it('N13. approval / leave / overtime / correction links carry numeric ids only', async () => {
		const { s, id, inst } = await threeStepLeave();
		const approverLinks = await prisma.notification.findMany({
			where: { metadataJson: { path: '$.approvalInstanceId', equals: inst.id } }
		});
		expect(approverLinks.length).toBeGreaterThan(0);
		for (const n of approverLinks) {
			expect(n.link).toBe(`/app/approvals/${inst.id}`);
			expect(n.dedupeKey).toMatch(/^approval:\d+:step:\d+:candidate:\d+$/);
		}
		for (const step of inst.steps) {
			const actor = [fx.M, fx.HR1, fx.DIR][step.stepOrder - 1]!;
			expect((await approve(actor, inst.id)).status).toBe(200);
		}
		const done = await prisma.notification.findFirstOrThrow({
			where: { userId: s.user.id, type: 'REQUEST_APPROVED' },
			orderBy: { id: 'desc' }
		});
		expect(done.link).toBe(`/app/my-leave?focus=${id}`);
		expect(done.dedupeKey).toBe(`final:${inst.id}:approved:${s.user.id}`);

		const ot = await subject();
		const otRes = await otReq(ot);
		const otInst = await instanceOf('OVERTIME', otRes.body.data.id);
		const otLinks = await prisma.notification.findMany({
			where: { metadataJson: { path: '$.approvalInstanceId', equals: otInst.id } }
		});
		for (const n of otLinks) expect(n.link).toMatch(/^\/app\/approvals\/\d+$/);

		const corr = await correctionCase();
		const cLinks = await prisma.notification.findMany({
			where: { metadataJson: { path: '$.approvalInstanceId', equals: corr.instanceId } }
		});
		for (const n of cLinks) expect(n.link).toBe(`/app/approvals/${corr.instanceId}`);

		const all = await prisma.notification.findMany({
			select: { link: true, dedupeKey: true, metadataJson: true }
		});
		for (const n of all) expect(JSON.stringify(n)).not.toMatch(CUID_LIKE);
	});
});

// ============================================================================================
describe('audit: numeric entity ids + M9 dual lookup (legacy CUID history)', () => {
	it('N14. new events store String(id); one entity history spans legacy and numeric events', async () => {
		const s = await subject();
		const legacy = fakeCuid();
		await prisma.employee.update({ where: { id: s.employee.id }, data: { legacyId: legacy } });
		// a PRE-migration event (entityId = the CUID, as frozen history stores it)
		await writeAuditEvent(prisma, {
			action: 'TEST.LEGACY',
			entityType: 'EMPLOYEE',
			entityId: legacy,
			companyId: fx.companyId
		});
		// a POST-migration event (numeric id → stored as its decimal string)
		const created = await writeAuditEvent(prisma, {
			action: 'TEST.NUMERIC',
			entityType: 'EMPLOYEE',
			entityId: s.employee.id,
			companyId: fx.companyId
		});
		const row = await prisma.auditEvent.findUniqueOrThrow({ where: { id: created.id } });
		expect(row.entityId).toBe(String(s.employee.id));

		for (const q of [String(s.employee.id), legacy]) {
			const res = await get(
				`/audit-events?entityType=EMPLOYEE&entityId=${q}&pageSize=100`,
				fx.admin
			);
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			const actions = res.body.data.items.map((i: { action: string }) => i.action);
			expect(actions, q).toEqual(expect.arrayContaining(['TEST.LEGACY', 'TEST.NUMERIC']));
		}
	});

	it('N15. ambiguous entity types match a numeric id literally; a CUID still resolves; report keys pass through', async () => {
		expect(await auditEntityIdAliases(String(fx.companyId), 'ORGANIZATION')).toEqual([
			String(fx.companyId)
		]);
		const legacy = fakeCuid();
		await prisma.company.update({ where: { id: fx.companyId }, data: { legacyId: legacy } });
		expect(await auditEntityIdAliases(legacy, 'ORGANIZATION')).toEqual([
			legacy,
			String(fx.companyId)
		]);
		expect(await auditEntityIdAliases('attendance', 'REPORT')).toEqual(['attendance']);
		await prisma.company.update({ where: { id: fx.companyId }, data: { legacyId: null } });
	});
});

// ============================================================================================
describe('saved report filters store numeric ids', () => {
	const create = (body: Record<string, unknown>) =>
		agent().post('/api/v1/reports/saved-filters').set('Cookie', fx.admin).send(body);

	it('N16. a numeric-string or number id is stored as a JSON number; a CUID or malformed id is refused', async () => {
		const asString = await create({
			reportType: 'employees',
			name: `S_${uid()}`,
			filters: { companyId: String(fx.companyId) }
		});
		expect(asString.status, JSON.stringify(asString.body)).toBe(201);
		expect(asString.body.data.filters.companyId).toBe(fx.companyId);
		const stored = await prisma.savedReportFilter.findUniqueOrThrow({
			where: { id: asString.body.data.id }
		});
		expect(stored.filtersJson).toEqual({ companyId: fx.companyId });
		expect(stored.defaultKey).toBeNull();

		const asNumber = await create({
			reportType: 'employees',
			name: `N_${uid()}`,
			filters: { companyId: fx.companyId },
			isDefault: true
		});
		expect(asNumber.status).toBe(201);
		const def = await prisma.savedReportFilter.findUniqueOrThrow({
			where: { id: asNumber.body.data.id }
		});
		expect(def.defaultKey).toBe(`${(await get('/auth/me', fx.admin)).body.data.user.id}:EMPLOYEES`);
		expect(asNumber.body.data.usable).toBe(true);

		for (const bad of [fakeCuid(), '0', 'x']) {
			const res = await create({
				reportType: 'employees',
				name: `B_${uid()}`,
				filters: { companyId: bad }
			});
			expect(res.status, bad).toBe(400);
		}
	});
});

// ============================================================================================
describe('physical schema-shape guard (assertNumericSchemaShapeOf)', () => {
	/** A stub client that records every call and returns whatever rows the test wants. */
	function stubClient(rows: { COLUMN_NAME: string; DATA_TYPE: string }[]) {
		const calls: { query: string; values: unknown[] }[] = [];
		return {
			calls,
			$queryRawUnsafe: async (query: string, ...values: unknown[]) => {
				calls.push({ query, values });
				return rows;
			}
		};
	}

	it('N17. passes when employees.id is INT, and sends no bound parameter (the production regression)', async () => {
		const client = stubClient([{ COLUMN_NAME: 'id', DATA_TYPE: 'int' }]);
		await expect(assertNumericSchemaShapeOf(client)).resolves.toBeUndefined();
		// the real defect: a `?` placeholder on COLUMN_NAME matched a literal `mysql` client query but
		// returned zero rows through Prisma's $queryRawUnsafe on production MariaDB — the fix removes the
		// bound parameter entirely for this lookup, which this assertion locks in.
		expect(client.calls).toHaveLength(1);
		expect(client.calls[0]?.values).toEqual([]);
		expect(client.calls[0]?.query).toMatch(/COLUMN_NAME IN \('id', 'id_new'\)/);
	});

	it("N18. throws 'missing' when the column is absent from the result (pre-M8 shape, or a stub returning zero rows)", async () => {
		await expect(assertNumericSchemaShapeOf(stubClient([]))).rejects.toThrow(
			/employees\.id is "missing"/
		);
		// the other candidate column alone (e.g. only id_new exists) must not satisfy the canonical check
		await expect(
			assertNumericSchemaShapeOf(stubClient([{ COLUMN_NAME: 'id_new', DATA_TYPE: 'int' }]))
		).rejects.toThrow(/employees\.id is "missing"/);
	});

	it('N19. throws the actual type when the column exists but is not INT (pre-M8 VARCHAR)', async () => {
		const client = stubClient([{ COLUMN_NAME: 'id', DATA_TYPE: 'varchar' }]);
		await expect(assertNumericSchemaShapeOf(client)).rejects.toThrow(/employees\.id is "varchar"/);
	});
});
