import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, userWithPermissions } from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import { setServerClockForTests } from '../src/lib/clock.js';
import { backfillPendingApprovals } from '../src/services/approval.service.js';
import { createNotifications } from '../src/services/notification.service.js';
import {
	CORRECTION_REASON,
	LEAVE_REASON,
	NOW,
	OT_REASON,
	approve,
	at,
	correctionCase,
	fx,
	get,
	instanceOf,
	leaveReq,
	mgr,
	otReq,
	perm,
	post,
	reject,
	role,
	setSteps,
	setupFixture,
	subject,
	threeStepLeave,
	uid
} from './phase10Fixture.js';

beforeEach(() => at(NOW));
afterEach(() => setServerClockForTests(null));
beforeAll(setupFixture);

const notesOf = (userId: string, where: Record<string, unknown> = {}) =>
	prisma.notification.findMany({ where: { userId, ...where }, orderBy: { createdAt: 'asc' } });
// a numeric id is not globally unique, so match the approver link exactly (not `contains`)
const instanceLink = (instanceId: string | number) => `/app/approvals/${instanceId}`;
const forInstance = (userId: string, instanceId: string) =>
	prisma.notification.findMany({
		where: { userId, link: instanceLink(instanceId) }
	});
const byInstanceMeta = async (userId: string, instanceId: string, type?: string) =>
	(await notesOf(userId, type ? { type } : {})).filter(
		(n) =>
			(n.metadataJson as { approvalInstanceId?: string } | null)?.approvalInstanceId === instanceId
	);

// ============================================================================================
describe('approval notifications — who is told, and when', () => {
	it('1. submission notifies ONLY the step-1 candidates (Manager), not HR / Director', async () => {
		const { instanceId } = await threeStepLeave();
		expect(await byInstanceMeta(fx.M.user.id, instanceId, 'APPROVAL_ACTION_REQUIRED')).toHaveLength(
			1
		);
		expect(await byInstanceMeta(fx.HR1.user.id, instanceId)).toHaveLength(0);
		expect(await byInstanceMeta(fx.HR2.user.id, instanceId)).toHaveLength(0);
		expect(await byInstanceMeta(fx.DIR.user.id, instanceId)).toHaveLength(0);
	});

	it('2. steps that are still WAITING never produce a notification', async () => {
		const { instanceId } = await threeStepLeave();
		const all = await prisma.notification.count({
			where: { link: instanceLink(instanceId), userId: { not: fx.M.user.id } }
		});
		expect(all).toBe(0);
	});

	it('3. approving step 1 notifies step-2 candidates (HR) and does not re-notify the Manager', async () => {
		const { instanceId } = await threeStepLeave();
		expect((await approve(fx.M, instanceId)).status).toBe(200);
		expect(
			await byInstanceMeta(fx.HR1.user.id, instanceId, 'APPROVAL_ACTION_REQUIRED')
		).toHaveLength(1);
		expect(
			await byInstanceMeta(fx.HR2.user.id, instanceId, 'APPROVAL_ACTION_REQUIRED')
		).toHaveLength(1);
		expect(await byInstanceMeta(fx.M.user.id, instanceId)).toHaveLength(1); // still only the original
		expect(await byInstanceMeta(fx.DIR.user.id, instanceId)).toHaveLength(0);
	});

	it('4. step 1 → 2 → 3 advances the notification one step at a time', async () => {
		const { instanceId } = await threeStepLeave();
		await approve(fx.M, instanceId);
		expect(await byInstanceMeta(fx.DIR.user.id, instanceId)).toHaveLength(0);
		expect((await approve(fx.HR1, instanceId)).status).toBe(200);
		const dir = await byInstanceMeta(fx.DIR.user.id, instanceId, 'APPROVAL_ACTION_REQUIRED');
		expect(dir).toHaveLength(1);
		expect(dir[0]!.metadataJson).toMatchObject({ stepOrder: 3 });
	});

	it('5. final approval notifies the requester with a link to THEIR OWN page', async () => {
		const { s, id, instanceId } = await threeStepLeave();
		for (const p of [fx.M, fx.HR1, fx.DIR]) expect((await approve(p, instanceId)).status).toBe(200);
		const notes = await byInstanceMeta(s.user.id, instanceId, 'REQUEST_APPROVED');
		expect(notes).toHaveLength(1);
		expect(notes[0]!.link).toBe(`/app/my-leave?focus=${id}`);
		expect(notes[0]!.link).not.toContain('/settings');
		expect(notes[0]!.link).not.toContain('/app/approvals');
		expect(await byInstanceMeta(s.user.id, instanceId, 'APPROVAL_ACTION_REQUIRED')).toHaveLength(0);
	});

	it('6. a rejection at any step notifies the requester and never leaks the rejection note', async () => {
		const { s, instanceId } = await threeStepLeave();
		await approve(fx.M, instanceId);
		expect((await reject(fx.HR1, instanceId, 'ເຫດຜົນປະຕິເສດລັບ-XYZ')).status).toBe(200);
		const notes = await byInstanceMeta(s.user.id, instanceId, 'REQUEST_REJECTED');
		expect(notes).toHaveLength(1);
		expect(JSON.stringify(notes[0])).not.toContain('XYZ');
		// the DIRECTOR (never active) is not notified
		expect(await byInstanceMeta(fx.DIR.user.id, instanceId)).toHaveLength(0);
	});

	it('7. cancellation notifies the CURRENT-step candidates, not WAITING ones', async () => {
		const { s, id, instanceId } = await threeStepLeave();
		expect((await post(`/leave/me/requests/${id}/cancel`, s.cookie)).status).toBe(200);
		const m = await byInstanceMeta(fx.M.user.id, instanceId, 'REQUEST_CANCELLED');
		expect(m).toHaveLength(1);
		expect(m[0]!.link).toBe(`/app/approvals/${instanceId}`);
		expect(await byInstanceMeta(fx.HR1.user.id, instanceId)).toHaveLength(0);
		expect(await byInstanceMeta(fx.DIR.user.id, instanceId)).toHaveLength(0);
	});

	it('8. cancelling after step 1 notifies the step-2 candidates (now current), not the Manager again', async () => {
		const { s, id, instanceId } = await threeStepLeave();
		await approve(fx.M, instanceId);
		await post(`/leave/me/requests/${id}/cancel`, s.cookie);
		expect(await byInstanceMeta(fx.HR1.user.id, instanceId, 'REQUEST_CANCELLED')).toHaveLength(1);
		expect(await byInstanceMeta(fx.M.user.id, instanceId, 'REQUEST_CANCELLED')).toHaveLength(0);
	});

	it('9. reassignment notifies the newly assigned user (link to the approval)', async () => {
		const { instanceId } = await threeStepLeave();
		const extra = await userWithPermissions(['leave.review', VIEW_ALL_CODE]);
		const res = await post(`/approvals/${instanceId}/current-step/reassign`, fx.admin, {
			userId: extra.user.id
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const notes = await byInstanceMeta(extra.user.id, instanceId, 'APPROVAL_STEP_REASSIGNED');
		expect(notes).toHaveLength(1);
		expect(notes[0]!.link).toBe(`/app/approvals/${instanceId}`);
	});

	it('10. approver notifications link to /app/approvals/{instanceId} and the approver can open it', async () => {
		const { instanceId } = await threeStepLeave();
		const [note] = await byInstanceMeta(fx.M.user.id, instanceId, 'APPROVAL_ACTION_REQUIRED');
		expect(note!.link).toBe(`/app/approvals/${instanceId}`);
		const id = note!.link!.split('/').pop()!;
		expect((await get(`/approvals/${id}`, fx.M.cookie)).status).toBe(200);
		expect(note!.metadataJson).toMatchObject({
			approvalInstanceId: instanceId,
			targetType: 'LEAVE',
			stepOrder: 1
		});
	});

	it('11. a single-step default workflow notifies every review-permission holder in scope', async () => {
		await setSteps('OVERTIME', [perm('OVERTIME')]);
		const s = await subject();
		const created = await otReq(s);
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const inst = await instanceOf('OVERTIME', created.body.data.id);
		expect(await byInstanceMeta(fx.HR1.user.id, inst.id, 'APPROVAL_ACTION_REQUIRED')).toHaveLength(
			1
		);
		expect(await byInstanceMeta(fx.DIR.user.id, inst.id, 'APPROVAL_ACTION_REQUIRED')).toHaveLength(
			1
		);
		expect(await byInstanceMeta(s.user.id, inst.id)).toHaveLength(0); // never the requester
	});

	it('12. an Overtime request goes through the same lifecycle (approved → requester)', async () => {
		await setSteps('OVERTIME', [mgr(1), role(fx.hrRoleId, 'HR')]);
		const s = await subject();
		const created = await otReq(s);
		const inst = await instanceOf('OVERTIME', created.body.data.id);
		expect(await byInstanceMeta(fx.HR1.user.id, inst.id)).toHaveLength(0);
		await approve(fx.M, inst.id);
		expect(await byInstanceMeta(fx.HR1.user.id, inst.id, 'APPROVAL_ACTION_REQUIRED')).toHaveLength(
			1
		);
		await approve(fx.HR1, inst.id);
		const done = await byInstanceMeta(s.user.id, inst.id, 'REQUEST_APPROVED');
		expect(done).toHaveLength(1);
		expect(done[0]!.link).toBe(`/app/my-overtime?focus=${created.body.data.id}`);
	});

	it('13. an Attendance Correction goes through the same lifecycle', async () => {
		const { s, id, instanceId } = await correctionCase();
		expect(await byInstanceMeta(fx.M.user.id, instanceId, 'APPROVAL_ACTION_REQUIRED')).toHaveLength(
			1
		);
		expect(await byInstanceMeta(fx.HR1.user.id, instanceId)).toHaveLength(0);
		await approve(fx.M, instanceId);
		await approve(fx.HR1, instanceId);
		const done = await byInstanceMeta(s.user.id, instanceId, 'REQUEST_APPROVED');
		expect(done[0]!.link).toBe(`/app/my-attendance?focus=${id}`);
	});
});

const VIEW_ALL_CODE = 'employees.view_all';

// ============================================================================================
describe('transactional behaviour and deduplication', () => {
	it('14. notifications are created inside the transition transaction (refused final approval → none)', async () => {
		const { s, instanceId } = await threeStepLeave();
		await approve(fx.M, instanceId);
		await approve(fx.HR1, instanceId);
		// the balance disappears before the LAST approval → the domain finalizer refuses → rollback
		await prisma.leaveBalance.updateMany({
			where: { employeeId: s.employee.id },
			data: { entitlementDays: '0.00' }
		});
		const res = await approve(fx.DIR, instanceId);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(await byInstanceMeta(s.user.id, instanceId, 'REQUEST_APPROVED')).toHaveLength(0);
		expect(
			await prisma.auditEvent.count({
				where: {
					action: 'LEAVE.APPROVED',
					metadataJson: { path: '$.approvalInstanceId', equals: instanceId }
				}
			})
		).toBe(0);
		const inst = await instanceOf(
			'LEAVE',
			(await prisma.leaveRequest.findFirstOrThrow({ where: { employeeId: s.employee.id } })).id
		);
		expect(inst.status).toBe('PENDING');
	});

	it('15. a submission that cannot resolve an approver rolls back — no notification, no audit', async () => {
		const empty = await prisma.role.create({ data: { code: `EMPTY_${uid()}`, name: 'ວ່າງ' } });
		await setSteps('LEAVE', [mgr(1), role(empty.id, 'ບໍ່ມີຄົນ')]);
		const s = await subject();
		const before = await prisma.notification.count({ where: { userId: fx.M.user.id } });
		const res = await leaveReq(s);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('APPROVER_NOT_FOUND');
		expect(await prisma.notification.count({ where: { userId: fx.M.user.id } })).toBe(before);
		expect(
			await prisma.auditEvent.count({
				where: { action: 'LEAVE.REQUESTED', employeeId: s.employee.id }
			})
		).toBe(0);
	});

	it('16. createNotifications is idempotent per (user, dedupeKey)', async () => {
		const key = `test:${uid()}`;
		const item = {
			userId: fx.plain.user.id,
			type: 'APPROVAL_ACTION_REQUIRED' as const,
			titleLao: 'ທົດສອບ',
			dedupeKey: key
		};
		expect(await createNotifications(prisma, [item])).toBe(1);
		expect(await createNotifications(prisma, [item, item])).toBe(0);
		expect(
			await prisma.notification.count({ where: { userId: fx.plain.user.id, dedupeKey: key } })
		).toBe(1);
	});

	it('17. the same dedupeKey for a DIFFERENT user is a different notification', async () => {
		const key = `test:${uid()}`;
		const other = await userWithPermissions(['dashboard.view']);
		const n = await createNotifications(prisma, [
			{ userId: fx.plain.user.id, type: 'REQUEST_APPROVED', titleLao: 'a', dedupeKey: key },
			{ userId: other.user.id, type: 'REQUEST_APPROVED', titleLao: 'a', dedupeKey: key }
		]);
		expect(n).toBe(2);
	});

	it('18. notifications without a dedupeKey may repeat', async () => {
		const item = { userId: fx.plain.user.id, type: 'REQUEST_APPROVED' as const, titleLao: 'x' };
		expect(await createNotifications(prisma, [item, item])).toBe(2);
	});

	it('19. dedupe keys are deterministic (approval:{instance}:step:{n}:candidate:{user})', async () => {
		const { instanceId } = await threeStepLeave();
		const [note] = await byInstanceMeta(fx.M.user.id, instanceId);
		expect(note!.dedupeKey).toBe(`approval:${instanceId}:step:1:candidate:${fx.M.user.id}`);
	});

	it('20. concurrent approvals of one step notify the next step exactly once', async () => {
		const { instanceId } = await threeStepLeave();
		await approve(fx.M, instanceId);
		const results = await Promise.all([approve(fx.HR1, instanceId), approve(fx.HR2, instanceId)]);
		expect(results.filter((r) => r.status === 200)).toHaveLength(1);
		expect(
			await byInstanceMeta(fx.DIR.user.id, instanceId, 'APPROVAL_ACTION_REQUIRED')
		).toHaveLength(1);
	});

	it('21. a repeated final approval cannot notify the requester twice', async () => {
		const { s, instanceId } = await threeStepLeave();
		for (const p of [fx.M, fx.HR1, fx.DIR]) await approve(p, instanceId);
		const again = await approve(fx.DIR, instanceId);
		expect(again.status).toBeGreaterThanOrEqual(400);
		expect(await byInstanceMeta(s.user.id, instanceId, 'REQUEST_APPROVED')).toHaveLength(1);
	});

	it('22. the legacy backfill of pending requests sends no notification', async () => {
		await setSteps('LEAVE', [mgr(1)]);
		const s = await subject();
		const legacy = await prisma.leaveRequest.create({
			data: {
				employeeId: s.employee.id,
				leaveTypeId: fx.leaveTypeId,
				startDate: new Date('2026-09-23T00:00:00Z'),
				endDate: new Date('2026-09-23T00:00:00Z'),
				totalDays: '1.00',
				reason: 'ເກົ່າ',
				status: 'PENDING',
				requestedByUserId: s.user.id
			}
		});
		const before = await prisma.notification.count();
		await backfillPendingApprovals();
		expect(await prisma.approvalInstance.count({ where: { targetId: legacy.id } })).toBe(1);
		expect(await prisma.notification.count()).toBe(before);
		expect(
			await prisma.auditEvent.count({
				where: { action: 'LEAVE.REQUESTED', entityId: String(legacy.id) }
			})
		).toBe(0);
	});
});

// ============================================================================================
describe('notification API — owner-only', () => {
	async function userWithNotes(n = 3) {
		const u = await userWithPermissions(['dashboard.view']);
		await prisma.notification.createMany({
			data: Array.from({ length: n }, (_, i) => ({
				userId: u.user.id,
				type: i % 2 === 0 ? 'APPROVAL_ACTION_REQUIRED' : 'REQUEST_APPROVED',
				titleLao: `ແຈ້ງເຕືອນ ${i}`,
				createdAt: new Date(Date.now() - i * 60_000)
			}))
		});
		return u;
	}

	it('23. every notification endpoint needs authentication', async () => {
		expect((await agent().get('/api/v1/notifications')).status).toBe(401);
		expect((await agent().get('/api/v1/notifications/unread-count')).status).toBe(401);
		expect((await agent().post('/api/v1/notifications/read-all')).status).toBe(401);
		expect((await agent().post('/api/v1/notifications/abc/read')).status).toBe(401);
	});

	it('24. a user lists only their own notifications, newest first', async () => {
		const a = await userWithNotes(3);
		const b = await userWithNotes(2);
		const res = await get('/notifications', a.cookie);
		expect(res.status).toBe(200);
		expect(res.body.data.total).toBe(3);
		expect(res.body.data.items.map((i: { titleLao: string }) => i.titleLao)).toEqual([
			'ແຈ້ງເຕືອນ 0',
			'ແຈ້ງເຕືອນ 1',
			'ແຈ້ງເຕືອນ 2'
		]);
		expect((await get('/notifications', b.cookie)).body.data.total).toBe(2);
	});

	it('25. a userId / employeeId query parameter cannot widen access', async () => {
		const a = await userWithNotes(2);
		const b = await userWithNotes(4);
		const res = await get(`/notifications?userId=${b.user.id}&employeeId=xyz`, a.cookie);
		expect(res.status).toBe(200);
		expect(res.body.data.total).toBe(2);
	});

	it("26. another user's notification cannot be marked read (404, unchanged)", async () => {
		const a = await userWithNotes(1);
		const b = await userWithNotes(1);
		const target = await prisma.notification.findFirstOrThrow({ where: { userId: b.user.id } });
		const res = await post(`/notifications/${target.id}/read`, a.cookie);
		expect(res.status).toBe(404);
		expect(
			(await prisma.notification.findUniqueOrThrow({ where: { id: target.id } })).readAt
		).toBeNull();
		// indistinguishable from a missing id
		expect((await post('/notifications/2147483647/read', a.cookie)).status).toBe(404);
		expect((await post('/notifications/does-not-exist/read', a.cookie)).status).toBe(400);
	});

	it('27. marking your own notification read is idempotent (readAt does not move)', async () => {
		const a = await userWithNotes(1);
		const n = await prisma.notification.findFirstOrThrow({ where: { userId: a.user.id } });
		const first = await post(`/notifications/${n.id}/read`, a.cookie);
		expect(first.status).toBe(200);
		expect(first.body.data.isRead).toBe(true);
		const readAt = (await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt!;
		const second = await post(`/notifications/${n.id}/read`, a.cookie);
		expect(second.status).toBe(200);
		expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).toEqual(
			readAt
		);
	});

	it('28. unread-count reflects reads and read-all', async () => {
		const a = await userWithNotes(3);
		expect((await get('/notifications/unread-count', a.cookie)).body.data).toEqual({
			unreadCount: 3
		});
		const first = await prisma.notification.findFirstOrThrow({ where: { userId: a.user.id } });
		await post(`/notifications/${first.id}/read`, a.cookie);
		expect((await get('/notifications/unread-count', a.cookie)).body.data.unreadCount).toBe(2);
		const all = await post('/notifications/read-all', a.cookie);
		expect(all.status).toBe(200);
		expect((await get('/notifications/unread-count', a.cookie)).body.data.unreadCount).toBe(0);
	});

	it("29. read-all touches only the caller's notifications", async () => {
		const a = await userWithNotes(2);
		const b = await userWithNotes(2);
		await post('/notifications/read-all', a.cookie);
		expect((await get('/notifications/unread-count', b.cookie)).body.data.unreadCount).toBe(2);
	});

	it('30. unreadOnly / type filters and pagination', async () => {
		const a = await userWithNotes(5);
		const one = await prisma.notification.findFirstOrThrow({ where: { userId: a.user.id } });
		await post(`/notifications/${one.id}/read`, a.cookie);
		expect((await get('/notifications?unreadOnly=true', a.cookie)).body.data.total).toBe(4);
		expect((await get('/notifications?unreadOnly=false', a.cookie)).body.data.total).toBe(5);
		expect((await get('/notifications?type=REQUEST_APPROVED', a.cookie)).body.data.total).toBe(2);
		const page2 = await get('/notifications?page=2&pageSize=2', a.cookie);
		expect(page2.body.data.items).toHaveLength(2);
		expect(page2.body.data.totalPages).toBe(3);
		expect((await get('/notifications?type=NOPE', a.cookie)).status).toBe(400);
	});

	it('31. there is no DELETE / PATCH for notifications', async () => {
		const a = await userWithNotes(1);
		const n = await prisma.notification.findFirstOrThrow({ where: { userId: a.user.id } });
		expect(
			(await agent().delete(`/api/v1/notifications/${n.id}`).set('Cookie', a.cookie)).status
		).toBe(404);
		expect(
			(await agent().patch(`/api/v1/notifications/${n.id}`).set('Cookie', a.cookie)).status
		).toBe(404);
		expect(await prisma.notification.count({ where: { id: n.id } })).toBe(1);
	});

	it('32. the list response exposes only safe fields (no userId / dedupeKey)', async () => {
		const a = await userWithNotes(1);
		const item = (await get('/notifications', a.cookie)).body.data.items[0];
		expect(Object.keys(item).sort()).toEqual(
			[
				'bodyLao',
				'createdAt',
				'id',
				'isRead',
				'link',
				'metadata',
				'readAt',
				'titleLao',
				'type'
			].sort()
		);
	});
});

// ============================================================================================
describe('integration and privacy', () => {
	it('33. the approver flow: unread badge → open → approve → next approver sees it', async () => {
		const { instanceId } = await threeStepLeave();
		expect(
			(await get('/notifications/unread-count', fx.M.cookie)).body.data.unreadCount
		).toBeGreaterThan(0);
		const list = await get('/notifications?unreadOnly=true', fx.M.cookie);
		const mine = list.body.data.items.find(
			(i: { link: string }) => i.link === `/app/approvals/${instanceId}`
		);
		expect(mine).toBeTruthy();
		await post(`/notifications/${mine.id}/read`, fx.M.cookie);
		expect((await approve(fx.M, instanceId)).status).toBe(200);
		const hr = await get('/notifications?unreadOnly=true', fx.HR1.cookie);
		expect(
			hr.body.data.items.some((i: { link: string }) => i.link === `/app/approvals/${instanceId}`)
		).toBe(true);
	});

	it('34. notifications never contain the leave reason, rejection note or approval note', async () => {
		const { s, instanceId } = await threeStepLeave();
		await approve(fx.M, instanceId, 'ໝາຍເຫດອະນຸມັດລັບ');
		await reject(fx.HR1, instanceId, 'ໝາຍເຫດປະຕິເສດລັບ');
		const rows = await prisma.notification.findMany({
			where: { userId: { in: [s.user.id, fx.M.user.id, fx.HR1.user.id, fx.HR2.user.id] } }
		});
		const blob = JSON.stringify(rows);
		for (const secret of [LEAVE_REASON, 'ໝາຍເຫດອະນຸມັດລັບ', 'ໝາຍເຫດປະຕິເສດລັບ']) {
			expect(blob).not.toContain(secret);
		}
	});

	it('35. Overtime and Correction reasons never appear in notifications either', async () => {
		await setSteps('OVERTIME', [mgr(1)]);
		const s = await subject();
		const ot = await otReq(s);
		const { id: correctionId, s: cs } = await correctionCase();
		const rows = await prisma.notification.findMany({
			where: { userId: { in: [fx.M.user.id, s.user.id, cs.user.id] } }
		});
		const blob = JSON.stringify(rows);
		expect(blob).not.toContain(OT_REASON);
		expect(blob).not.toContain(CORRECTION_REASON);
		expect(ot.status).toBe(201);
		expect(correctionId).toBeTruthy();
	});

	it('36. notification text is Lao and mentions the module, not medical details', async () => {
		const { instanceId } = await threeStepLeave();
		const [n] = await byInstanceMeta(fx.M.user.id, instanceId);
		expect(n!.titleLao).toContain('ການລາ');
		expect(n!.titleLao).toContain('ລໍຖ້າການອະນຸມັດ');
	});

	it('37. a requester never receives approver-style notifications for their own request', async () => {
		const { s, instanceId } = await threeStepLeave();
		for (const p of [fx.M, fx.HR1, fx.DIR]) await approve(p, instanceId);
		const types = (await byInstanceMeta(s.user.id, instanceId)).map((n) => n.type);
		expect(types).toEqual(['REQUEST_APPROVED']);
	});

	it('38. audit events and notifications are separate stores', async () => {
		const { instanceId } = await threeStepLeave();
		const [n] = await byInstanceMeta(fx.M.user.id, instanceId);
		expect(await prisma.auditEvent.count({ where: { id: n!.id } })).toBe(0);
		// marking a notification read is not an audited business action
		const before = await prisma.auditEvent.count();
		await post(`/notifications/${n!.id}/read`, fx.M.cookie);
		expect(await prisma.auditEvent.count()).toBe(before);
	});

	it('39. the requester can open their own request through the approval progress link target', async () => {
		const { s, instanceId } = await threeStepLeave();
		expect((await get(`/approvals/${instanceId}`, s.cookie)).status).toBe(200);
		expect(await forInstance(s.user.id, instanceId)).toHaveLength(0);
	});

	it('40. laos wording constants: titles for approved/rejected differ', async () => {
		const a = await threeStepLeave();
		for (const p of [fx.M, fx.HR1, fx.DIR]) await approve(p, a.instanceId);
		const b = await threeStepLeave();
		await reject(fx.M, b.instanceId);
		const approved = (await byInstanceMeta(a.s.user.id, a.instanceId, 'REQUEST_APPROVED'))[0]!;
		const rejected = (await byInstanceMeta(b.s.user.id, b.instanceId, 'REQUEST_REJECTED'))[0]!;
		expect(approved.titleLao).not.toBe(rejected.titleLao);
	});
});
