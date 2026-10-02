import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma.js';
import { userWithPermissions } from './helpers.js';
import {
	D,
	approveI,
	approveOk,
	approvedWorld,
	approverUser,
	calc,
	cancelSub,
	ctx,
	employee,
	finalize,
	get,
	linkedUser,
	manualPeriod,
	moneyNeedles,
	newCompany,
	newRun,
	payrollWorkflow,
	permStep,
	post,
	profile,
	put,
	rejectI,
	reopen,
	ruleWorkflowWorld,
	runOf,
	setupPhase13,
	statutoryRule,
	submit,
	submitOk,
	twoCycleSchedule,
	uid,
	userStep,
	workflowWorld
} from './phase13Fixture.js';
import {
	cancelApprovalInstance,
	createApprovalInstance,
	ensureDefaultWorkflows,
	getLatestApprovalInstance
} from '../src/services/approvalInstance.service.js';

/**
 * PHASE 13 — payroll approval through the GENERIC approval engine (PAYROLL_RUN target, attempts,
 * requester exclusion, snapshot hash / stale protection, reopen) + generic-engine regression.
 */
beforeAll(async () => {
	await setupPhase13();
});

const instanceOfRun = (runId: string) =>
	getLatestApprovalInstance(prisma, 'PAYROLL_RUN', runId).then((i) => i!);
const candidatesOf = async (instanceId: string, stepOrder = 1) =>
	(
		await prisma.approvalStepCandidate.findMany({
			where: { step: { approvalInstanceId: instanceId, stepOrder } },
			select: { userId: true }
		})
	).map((c) => c.userId);

// =================================================================================================
// 1-2 permissions
// =================================================================================================
describe('permissions', () => {
	it('1. payroll.approve (and payslip.*) are seeded; SUPER_ADMIN + HR_ADMIN hold payroll.approve', async () => {
		for (const code of ['payroll.approve', 'payslip.view_self', 'payslip.generate']) {
			expect(await prisma.permission.findUnique({ where: { code } })).not.toBeNull();
		}
		for (const role of ['SUPER_ADMIN', 'HR_ADMIN']) {
			const n = await prisma.rolePermission.count({
				where: { role: { code: role }, permission: { code: 'payroll.approve' } }
			});
			expect(n, role).toBe(1);
		}
	});

	it('2. MANAGER and EMPLOYEE never get payroll.approve (EMPLOYEE gets payslip.view_self only)', async () => {
		const held = async (role: string) =>
			(
				await prisma.rolePermission.findMany({
					where: { role: { code: role } },
					select: { permission: { select: { code: true } } }
				})
			).map((r) => r.permission.code);
		const manager = await held('MANAGER');
		const emp = await held('EMPLOYEE');
		expect(manager).not.toContain('payroll.approve');
		expect(manager.some((c) => c.startsWith('payslip.'))).toBe(false);
		expect(emp).not.toContain('payroll.approve');
		expect(emp).toContain('payslip.view_self');
		expect(emp).not.toContain('payslip.generate');
	});
});

// =================================================================================================
// 3-4 mode + backward compatibility
// =================================================================================================
describe('approval mode', () => {
	it('3. DIRECT (default) keeps the old CALCULATED → FINALIZE flow; submit is refused', async () => {
		const companyId = await newCompany();
		await employee(companyId);
		const period = await manualPeriod(companyId);
		const run = await newRun(companyId, period.id);
		expect(run.approval.mode).toBe('DIRECT');
		expect(run.approval.state).toBe('NONE');
		await calc(run.id);
		const s = await submit(run.id);
		expect(s.status).toBe(409);
		expect(s.body.error.code).toBe('PAYROLL_APPROVAL_NOT_REQUIRED');
		const f = await finalize(run.id);
		expect(f.status, JSON.stringify(f.body)).toBe(200);
		expect(f.body.data.status).toBe('FINALIZED');
		expect(f.body.data.approval.state).toBe('NONE');
	});

	it('4. a WORKFLOW run snapshots the mode; changing the setting later never alters it', async () => {
		const companyId = await newCompany('WORKFLOW');
		await employee(companyId);
		const p1 = await manualPeriod(companyId);
		const run = await newRun(companyId, p1.id);
		expect(run.approval.mode).toBe('WORKFLOW');
		const res = await put(`/payroll/settings?companyId=${companyId}`, ctx.admin, {
			currencyCode: 'LAK',
			approvalMode: 'DIRECT'
		});
		expect(res.status).toBe(200);
		expect(res.body.data.approvalMode).toBe('DIRECT');
		expect((await runOf(run.id)).approval.mode).toBe('WORKFLOW');
		const p2 = await manualPeriod(companyId, '2025-10-01', '2025-10-31');
		expect((await newRun(companyId, p2.id)).approval.mode).toBe('DIRECT');
	});

	it('settings expose the payroll workflow status (Missing → Configured)', async () => {
		const companyId = await newCompany('WORKFLOW');
		const before = await get(`/payroll/settings?companyId=${companyId}`, ctx.admin);
		expect(before.body.data.payrollWorkflow.configured).toBe(false);
		await payrollWorkflow(companyId);
		const after = await get(`/payroll/settings?companyId=${companyId}`, ctx.admin);
		expect(after.body.data.payrollWorkflow.configured).toBe(true);
	});
});

// =================================================================================================
// 5-14 submission
// =================================================================================================
describe('submit for approval', () => {
	it('5. no ACTIVE payroll workflow → APPROVAL_WORKFLOW_NOT_FOUND (nothing is created)', async () => {
		const w = await workflowWorld({ workflow: false });
		const res = await submit(w.run.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('APPROVAL_WORKFLOW_NOT_FOUND');
		expect(await getLatestApprovalInstance(prisma, 'PAYROLL_RUN', w.run.id)).toBeNull();
		expect((await runOf(w.run.id)).approval.state).toBe('NONE');
	});

	it('6. submission requires a CALCULATED run', async () => {
		const companyId = await newCompany('WORKFLOW');
		await payrollWorkflow(companyId);
		await employee(companyId);
		const period = await manualPeriod(companyId);
		const run = await newRun(companyId, period.id);
		const res = await submit(run.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_RUN_NOT_CALCULATED');
	});

	it('7. a BLOCKED employee prevents submission', async () => {
		const companyId = await newCompany('WORKFLOW');
		await payrollWorkflow(companyId);
		await employee(companyId);
		await employee(companyId, { salary: null }); // no compensation → BLOCKED
		const period = await manualPeriod(companyId);
		const run = await newRun(companyId, period.id);
		const calculated = await calc(run.id);
		expect(calculated.summary.blocked).toBe(1);
		const res = await submit(run.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('PAYROLL_HAS_BLOCKED_RESULTS');
	});

	it('8, 9, 11. submit creates a PAYROLL_RUN instance (attempt 1, no employee), excludes the requester, state PENDING', async () => {
		const w = await workflowWorld();
		const run = await submitOk(w.run.id);
		expect(run.approval.state).toBe('PENDING');
		expect(run.approval.attemptNo).toBe(1);
		expect(run.approval.submittedBy?.id).toBe(ctx.submitter.userId);
		const inst = await instanceOfRun(w.run.id);
		expect(inst.targetType).toBe('PAYROLL_RUN');
		expect(inst.employeeId).toBeNull();
		expect(inst.attemptNo).toBe(1);
		expect(inst.status).toBe('PENDING');
		expect(inst.id).toBe(run.approval.approvalInstanceId);
		const candidates = await candidatesOf(inst.id);
		expect(candidates).toContain(ctx.approver.userId);
		expect(candidates).not.toContain(ctx.submitter.userId); // requester exclusion
		// the snapshot hash + safe summary live on the run
		const row = await prisma.payrollRun.findUniqueOrThrow({ where: { id: w.run.id } });
		expect(row.approvalSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
		expect((row.approvalSnapshotJson as { employees: number }).employees).toBe(1);
	});

	it('10. a workflow whose only approver is the requester → APPROVER_NOT_FOUND (no self-approval)', async () => {
		const w = await workflowWorld({ workflow: false });
		await payrollWorkflow(w.companyId, [userStep(ctx.submitter.userId)]);
		const res = await submit(w.run.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('APPROVER_NOT_FOUND');
		expect((await runOf(w.run.id)).approval.state).toBe('NONE');
	});

	it('12-13. while PENDING: calculate, adjustments, period edits and a second submission are refused', async () => {
		const w = await workflowWorld();
		await submitOk(w.run.id);
		const recalc = await post(`/payroll/runs/${w.run.id}/calculate`, ctx.admin);
		expect(recalc.status).toBe(409);
		expect(recalc.body.error.code).toBe('PAYROLL_PENDING_APPROVAL');
		const adj = await post(
			`/payroll/runs/${w.run.id}/employees/${w.emps[0]!.id}/adjustments`,
			ctx.admin,
			{ type: 'EARNING', code: 'BONUS_P13', nameLao: 'ໂບນັດ', amount: '1000', reason: 'ທົດສອບ' }
		);
		expect(adj.status).toBe(409);
		expect(adj.body.error.code).toBe('PAYROLL_PENDING_APPROVAL');
		const period = await agent13Patch(`/payroll/periods/${w.period.id}`, { name: 'ປ່ຽນຊື່' });
		expect(period.status).toBe(409);
		expect(period.body.error.code).toBe('PAYROLL_PENDING_APPROVAL');
		const again = await submit(w.run.id);
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('PAYROLL_PENDING_APPROVAL');
	});

	it('14. two simultaneous submissions → exactly one attempt', async () => {
		const w = await workflowWorld();
		const results = await Promise.all([submit(w.run.id), submit(w.run.id)]);
		const codes = results.map((r) => r.status).sort();
		expect(codes).toEqual([200, 409]);
		expect(
			await prisma.approvalInstance.count({
				where: { targetType: 'PAYROLL_RUN', targetId: w.run.id }
			})
		).toBe(1);
	});
});

async function agent13Patch(path: string, body: Record<string, unknown>) {
	const { agent } = await import('./helpers.js');
	return agent().patch(`/api/v1${path}`).set('Cookie', ctx.admin).send(body);
}

// =================================================================================================
// 15-18 approve / reject / cancel
// =================================================================================================
describe('approve / reject / cancel', () => {
	it('15-16. an intermediate step keeps PENDING; the last step sets APPROVED (never FINALIZED)', async () => {
		const w = await workflowWorld({ workflow: false });
		await payrollWorkflow(w.companyId, [
			userStep(ctx.approver.userId, 'ຂັ້ນ 1'),
			userStep(ctx.approver2.userId, 'ຂັ້ນ 2')
		]);
		const submitted = await submitOk(w.run.id);
		const r1 = await approveI(submitted.approval.approvalInstanceId!, ctx.approver.cookie);
		expect(r1.status, JSON.stringify(r1.body)).toBe(200);
		expect((await runOf(w.run.id)).approval.state).toBe('PENDING');
		// the second-step candidate is only notified once step 1 is done
		expect(
			await prisma.notification.count({
				where: {
					userId: ctx.approver2.userId,
					metadataJson: { path: '$.targetId', equals: w.run.id }
				}
			})
		).toBe(1);
		const r2 = await approveI(submitted.approval.approvalInstanceId!, ctx.approver2.cookie);
		expect(r2.status, JSON.stringify(r2.body)).toBe(200);
		const run = await runOf(w.run.id);
		expect(run.approval.state).toBe('APPROVED');
		expect(run.approval.approvedBy?.id).toBe(ctx.approver2.userId);
		expect(run.approval.approvedAt).not.toBeNull();
		expect(run.status).toBe('CALCULATED'); // approval ≠ finalization
		expect(run.payslipCount).toBe(0);
	});

	it('17. a rejection sets REJECTED (a note is mandatory)', async () => {
		const w = await workflowWorld();
		const submitted = await submitOk(w.run.id);
		const noNote = await post(
			`/approvals/${submitted.approval.approvalInstanceId}/reject`,
			ctx.approver.cookie,
			{}
		);
		expect(noNote.status).toBe(400);
		const res = await rejectI(submitted.approval.approvalInstanceId!);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect((await runOf(w.run.id)).approval.state).toBe('REJECTED');
		expect((await instanceOfRun(w.run.id)).status).toBe('REJECTED');
	});

	it('18. cancelling a PENDING submission sets CANCELLED and keeps the attempt readable', async () => {
		const w = await workflowWorld();
		await submitOk(w.run.id);
		const res = await cancelSub(w.run.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data.approval.state).toBe('CANCELLED');
		const inst = await instanceOfRun(w.run.id);
		expect(inst.status).toBe('CANCELLED');
		const panel = await get(`/payroll/runs/${w.run.id}/approval`, ctx.admin);
		expect(panel.body.data.history).toHaveLength(1);
		expect(panel.body.data.history[0].status).toBe('CANCELLED');
		// nothing left to cancel
		expect((await cancelSub(w.run.id)).status).toBe(409);
	});
});

// =================================================================================================
// 19-26 attempts, reopen
// =================================================================================================
describe('attempts and reopen', () => {
	it('19-21. rejected → recalculate (NONE) → attempt 2; attempt 1 stays REJECTED with its note', async () => {
		const w = await workflowWorld();
		const s1 = await submitOk(w.run.id);
		await rejectI(s1.approval.approvalInstanceId!, ctx.approver.cookie, 'ຍອດ OT ບໍ່ຖືກ');
		const recalculated = await calc(w.run.id);
		expect(recalculated.approval.state).toBe('NONE');
		expect(recalculated.approval.approvalInstanceId).toBeNull();
		const s2 = await submitOk(w.run.id);
		expect(s2.approval.attemptNo).toBe(2);
		expect(s2.approval.approvalInstanceId).not.toBe(s1.approval.approvalInstanceId);
		const attempts = await prisma.approvalInstance.findMany({
			where: { targetType: 'PAYROLL_RUN', targetId: w.run.id },
			orderBy: { attemptNo: 'asc' },
			include: { steps: true }
		});
		expect(attempts.map((a) => [a.attemptNo, a.status])).toEqual([
			[1, 'REJECTED'],
			[2, 'PENDING']
		]);
		expect(attempts[0]!.steps[0]!.actionNote).toBe('ຍອດ OT ບໍ່ຖືກ');
		await approveOk(w.run.id);
		const panel = await get(`/payroll/runs/${w.run.id}/approval`, ctx.admin);
		expect(
			panel.body.data.history.map((h: { attemptNo: number; status: string }) => [
				h.attemptNo,
				h.status
			])
		).toEqual([
			[2, 'APPROVED'],
			[1, 'REJECTED']
		]);
	});

	it('22. an APPROVED run cannot be recalculated, adjusted or resubmitted', async () => {
		const w = await approvedWorld();
		const recalc = await post(`/payroll/runs/${w.run.id}/calculate`, ctx.admin);
		expect(recalc.status).toBe(409);
		expect(recalc.body.error.code).toBe('PAYROLL_APPROVED_LOCKED');
		const again = await submit(w.run.id);
		expect(again.status).toBe(409);
		expect(again.body.error.code).toBe('PAYROLL_APPROVED_LOCKED');
	});

	it('23-26. reopen → NONE + DRAFT, history kept, audited; recalculate; resubmit = attempt 2', async () => {
		const w = await approvedWorld();
		const res = await reopen(w.run.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data.approval.state).toBe('NONE');
		expect(res.body.data.status).toBe('DRAFT');
		expect((await instanceOfRun(w.run.id)).status).toBe('APPROVED'); // history untouched
		const audit = await prisma.auditEvent.findFirst({
			where: { action: 'PAYROLL.RUN_REOPENED', entityId: String(w.run.id) }
		});
		expect(audit).not.toBeNull();
		expect(await submit(w.run.id).then((r) => r.body.error.code)).toBe(
			'PAYROLL_RUN_NOT_CALCULATED'
		);
		await calc(w.run.id);
		const s2 = await submitOk(w.run.id);
		expect(s2.approval.attemptNo).toBe(2);
		expect(
			await prisma.approvalInstance.count({
				where: { targetType: 'PAYROLL_RUN', targetId: w.run.id }
			})
		).toBe(2);
		// reopen is only for APPROVED
		expect((await reopen(w.run.id)).status).toBe(409);
	});
});

// =================================================================================================
// 27-35 finalization + stale protection
// =================================================================================================
async function expectStale(runId: string) {
	const res = await finalize(runId);
	expect(res.status, JSON.stringify(res.body)).toBe(409);
	expect(res.body.error.code).toBe('PAYROLL_APPROVAL_STALE');
	const run = await runOf(runId);
	expect(run.status).toBe('CALCULATED');
	expect(run.approval.state).toBe('APPROVED');
	expect(await prisma.payslip.count({ where: { payrollRunId: runId } })).toBe(0);
}

describe('finalize approved payroll', () => {
	it('27. WORKFLOW finalize requires APPROVED (NONE and PENDING are refused)', async () => {
		const w = await workflowWorld();
		const none = await finalize(w.run.id);
		expect(none.status).toBe(409);
		expect(none.body.error.code).toBe('PAYROLL_APPROVAL_REQUIRED');
		await submitOk(w.run.id);
		const pending = await finalize(w.run.id);
		expect(pending.status).toBe(409);
		expect(['PAYROLL_APPROVAL_REQUIRED', 'PAYROLL_PENDING_APPROVAL']).toContain(
			pending.body.error.code
		);
	});

	it('28, 32. a compensation change after approval → PAYROLL_APPROVAL_STALE; approved rows untouched', async () => {
		const w = await approvedWorld();
		const before = await prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: w.run.id }
		});
		const r = await post(`/employees/${w.emps[0]!.id}/compensation`, ctx.admin, {
			baseSalary: '5100000',
			effectiveFrom: '2025-09-01'
		});
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		await expectStale(w.run.id);
		const after = await prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: w.run.id }
		});
		expect(after.map((x) => [x.id, x.netPay.toFixed(2)])).toEqual(
			before.map((x) => [x.id, x.netPay.toFixed(2)])
		);
	});

	it('32b. a recurring component change after approval → stale', async () => {
		const w = await approvedWorld();
		const comp = await post('/pay-components', ctx.admin, {
			companyId: w.companyId,
			code: `ALW_${uid()}`,
			nameLao: 'ເງິນອຸດໜູນ',
			type: 'EARNING',
			category: 'ALLOWANCE'
		});
		expect(comp.status, JSON.stringify(comp.body)).toBe(201);
		const assign = await post(`/employees/${w.emps[0]!.id}/recurring-pay-components`, ctx.admin, {
			payComponentId: comp.body.data.id,
			amount: '200000',
			effectiveFrom: '2025-01-01'
		});
		expect(assign.status, JSON.stringify(assign.body)).toBe(201);
		await expectStale(w.run.id);
	});

	it('29. an attendance change (a previously absent day now present) → stale', async () => {
		const absent = '2025-09-10';
		const w = await ruleWorkflowWorld([absent]);
		await submitOk(w.run.id);
		await approveOk(w.run.id);
		const { presentRow } = await import('./phase13Fixture.js');
		await prisma.attendanceRecord.create({ data: presentRow(w.emp.id, w.shiftId, absent) });
		await expectStale(w.run.id);
	});

	it('30. a leave change (new approved unpaid leave) → stale', async () => {
		const w = await ruleWorkflowWorld();
		await submitOk(w.run.id);
		await approveOk(w.run.id);
		const type = await prisma.leaveType.create({
			data: {
				companyId: w.companyId,
				code: `UL_${uid()}`,
				nameLao: 'ລາບໍ່ໄດ້ຮັບເງິນ',
				isPaid: false
			}
		});
		const reqRow = await prisma.leaveRequest.create({
			data: {
				employeeId: w.emp.id,
				leaveTypeId: type.id,
				startDate: D('2025-09-15'),
				endDate: D('2025-09-15'),
				totalDays: '1',
				reason: 'ທົດສອບ',
				status: 'APPROVED',
				requestedByUserId: ctx.adminUserId
			}
		});
		await prisma.leaveRequestDay.create({
			data: {
				leaveRequestId: reqRow.id,
				employeeId: w.emp.id,
				leaveDate: D('2025-09-15'),
				activeKey: `${w.emp.id}:2025-09-15:${uid()}`
			}
		});
		await expectStale(w.run.id);
	});

	it('31. an OT change (eligible minutes of an approved request) → stale', async () => {
		const w = await ruleWorkflowWorld();
		const ot = await prisma.overtimeRequest.create({
			data: {
				employeeId: w.emp.id,
				workDate: D('2025-09-11'),
				type: 'AFTER_SHIFT',
				requestedStartAt: new Date('2025-09-11T10:00:00Z'),
				requestedEndAt: new Date('2025-09-11T12:00:00Z'),
				plannedMinutes: 120,
				reason: 'ທົດສອບ',
				status: 'APPROVED',
				requestedByUserId: ctx.adminUserId,
				isWorkingDay: true,
				actualMinutes: 120,
				eligibleMinutes: 120,
				calculationStatus: 'CALCULATED',
				calculatedAt: new Date(),
				calculationVersion: 1
			}
		});
		await calc(w.run.id);
		await submitOk(w.run.id);
		await approveOk(w.run.id);
		await prisma.overtimeRequest.update({ where: { id: ot.id }, data: { eligibleMinutes: 60 } });
		await expectStale(w.run.id);
	});

	it('33. a statutory PROFILE change after approval → stale; a new statutory RULE → stale', async () => {
		// profile
		const a = await workflowWorld({ workflow: true });
		await statutoryRule(a.companyId);
		await profile(a.emps[0]!.id);
		await calc(a.run.id);
		expect((await runOf(a.run.id)).calculationVersion).toBe(5);
		await submitOk(a.run.id);
		await approveOk(a.run.id);
		await profile(a.emps[0]!.id, { socialSecurityApplicable: false });
		await expectStale(a.run.id);
		// rule: a newer version tagged for this payroll month takes over
		const b = await workflowWorld();
		await statutoryRule(b.companyId);
		await profile(b.emps[0]!.id);
		await calc(b.run.id);
		await submitOk(b.run.id);
		await approveOk(b.run.id);
		await statutoryRule(b.companyId, {
			effectiveFrom: '2025-06-01',
			brackets: [
				{ order: 1, lowerBound: '0', upperBound: '1000000', rate: '0' },
				{ order: 2, lowerBound: '1000000', upperBound: null, rate: '0.2' }
			]
		});
		await expectStale(b.run.id);
	});

	it('34. an unchanged approved payroll finalizes the EXACT approved rows (+ payslips), state stays APPROVED', async () => {
		const w = await approvedWorld({ employees: 2 });
		const before = await prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: w.run.id },
			orderBy: { id: 'asc' }
		});
		const res = await finalize(w.run.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.data.status).toBe('FINALIZED');
		expect(res.body.data.approval.state).toBe('APPROVED');
		expect(res.body.data.payslipCount).toBe(2);
		const after = await prisma.payrollEmployeeResult.findMany({
			where: { payrollRunId: w.run.id },
			orderBy: { id: 'asc' }
		});
		expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id)); // not replaced
		expect((await finalize(w.run.id)).status).toBe(409); // immutable
	});

	it('35. cycle 2 cannot be submitted before cycle 1 is FINALIZED (PRIOR_PAYROLL_CYCLE_NOT_FINALIZED)', async () => {
		const companyId = await newCompany('WORKFLOW');
		await payrollWorkflow(companyId);
		await employee(companyId);
		const [c1, c2] = await twoCycleSchedule(companyId);
		const run1 = await newRun(companyId, c1!.id);
		const run2 = await newRun(companyId, c2!.id);
		await calc(run1.id);
		await calc(run2.id);
		const early = await submit(run2.id);
		expect(early.status).toBe(409);
		expect(early.body.error.code).toBe('PRIOR_PAYROLL_CYCLE_NOT_FINALIZED');
		await submitOk(run1.id);
		await approveOk(run1.id);
		expect((await finalize(run1.id)).status).toBe(200);
		await calc(run2.id);
		expect((await submit(run2.id)).status).toBe(200);
	});
});

// =================================================================================================
// 36-38 who may approve
// =================================================================================================
describe('approver eligibility', () => {
	it('36. the requester cannot approve their own attempt (even holding payroll.approve)', async () => {
		const w = await workflowWorld();
		const s = await submitOk(w.run.id); // HR_ADMIN submitter holds payroll.approve
		const res = await approveI(s.approval.approvalInstanceId!, ctx.submitter.cookie);
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
	});

	it('37. a candidate needs payroll.approve (payroll.view alone is not enough)', async () => {
		const viewer = await userWithPermissions(['payroll.view', 'employees.view_all']);
		const w = await workflowWorld();
		const s = await submitOk(w.run.id);
		expect(await candidatesOf(s.approval.approvalInstanceId!)).not.toContain(viewer.user.id);
		expect((await approveI(s.approval.approvalInstanceId!, viewer.cookie)).status).toBe(403);
	});

	it('38. a candidate needs the broad payroll scope (employees.view_all) — no manager-tree approval', async () => {
		const narrow = await userWithPermissions(['payroll.approve', 'payroll.view']);
		const w = await workflowWorld({ workflow: false });
		await payrollWorkflow(w.companyId, [userStep(narrow.user.id)]);
		const res = await submit(w.run.id);
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('APPROVER_NOT_FOUND');
		// MANAGER steps are rejected for payroll workflows
		const bad = await post('/approval-workflows', ctx.admin, {
			companyId: w.companyId,
			targetType: 'PAYROLL_RUN',
			code: `PAY_M_${uid()}`,
			nameLao: 'x',
			status: 'INACTIVE',
			steps: [{ nameLao: 'ຫົວໜ້າ', approverType: 'MANAGER', managerLevel: 1 }]
		});
		expect(bad.status).toBe(400);
		expect(bad.body.error.code).toBe('MANAGER_STEP_NOT_ALLOWED');
	});
});

// =================================================================================================
// 39-43 privacy + concurrency
// =================================================================================================
describe('notification / audit privacy and concurrency', () => {
	it('39-41, 97-98. submit / approve / reject notifications and audit carry NO amount', async () => {
		const w = await workflowWorld({ salary: '7345678' });
		const s = await submitOk(w.run.id);
		const run = await runOf(w.run.id);
		const needles = [...moneyNeedles(run.summary.netPay), ...moneyNeedles('7345678.00')];
		const approverNote = await prisma.notification.findFirstOrThrow({
			where: { userId: ctx.approver.userId, metadataJson: { path: '$.targetId', equals: w.run.id } }
		});
		expect(approverNote.titleLao).toContain('ລໍຖ້າການອະນຸມັດ');
		expect(approverNote.link).toBe(`/app/payroll/runs/${w.run.id}`);
		await rejectI(s.approval.approvalInstanceId!);
		const requesterNote = await prisma.notification.findFirstOrThrow({
			where: {
				userId: ctx.submitter.userId,
				type: 'REQUEST_REJECTED',
				metadataJson: { path: '$.targetId', equals: w.run.id }
			}
		});
		const audits = await prisma.auditEvent.findMany({
			where: {
				// numeric entity ids are unique per entity type only
				OR: [
					{ entityType: 'PAYROLL_RUN', entityId: String(w.run.id) },
					{
						entityType: 'APPROVAL_INSTANCE',
						entityId: String(s.approval.approvalInstanceId!)
					}
				]
			}
		});
		expect(audits.map((a) => a.action)).toEqual(
			expect.arrayContaining(['PAYROLL.RUN_SUBMITTED', 'PAYROLL.RUN_REJECTED'])
		);
		const submittedAudit = audits.find((a) => a.action === 'PAYROLL.RUN_SUBMITTED')!;
		expect(submittedAudit.metadataJson).toMatchObject({ runId: w.run.id, attemptNo: 1 });
		const blob = JSON.stringify([approverNote, requesterNote, audits]);
		for (const n of needles) expect(blob, n).not.toContain(n);
		for (const key of ['netPay', 'totalEarnings', 'gross', 'salary', 'pit', 'sso']) {
			expect(JSON.stringify(audits.map((a) => a.metadataJson)).toLowerCase()).not.toContain(
				`"${key.toLowerCase()}"`
			);
		}
	});

	it('42. two simultaneous final approvals → exactly one transition', async () => {
		const w = await workflowWorld();
		const s = await submitOk(w.run.id);
		const res = await Promise.all([
			approveI(s.approval.approvalInstanceId!, ctx.approver.cookie),
			approveI(s.approval.approvalInstanceId!, ctx.approver2.cookie)
		]);
		expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
		expect((await runOf(w.run.id)).approval.state).toBe('APPROVED');
		expect(
			await prisma.auditEvent.count({
				where: { action: 'PAYROLL.RUN_APPROVED', entityId: String(w.run.id) }
			})
		).toBe(1);
	});

	it('43. two simultaneous finalizations → one succeeds; one payslip per employee, no duplicate notifications', async () => {
		const w = await approvedWorld({ employees: 2 });
		const res = await Promise.all([finalize(w.run.id), finalize(w.run.id)]);
		expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(await prisma.payslip.count({ where: { payrollRunId: w.run.id } })).toBe(2);
		expect(
			await prisma.auditEvent.count({
				where: { action: 'PAYSLIP.BATCH_CREATED', entityId: String(w.run.id) }
			})
		).toBe(1);
	});
});

// =================================================================================================
// 44-47 generic approval regression (Leave / OT / Attendance Correction)
// =================================================================================================
describe('generic engine regression', () => {
	it('44. every non-payroll instance is attempt 1; a new LEAVE instance defaults to attempt 1', async () => {
		expect(
			await prisma.approvalInstance.count({
				where: { targetType: { not: 'PAYROLL_RUN' }, attemptNo: { not: 1 } }
			})
		).toBe(0);
		const companyId = await newCompany();
		const requester = await linkedUser('EMPLOYEE');
		const emp = await employee(companyId, { userId: requester.userId, salary: null });
		await ensureDefaultWorkflows(companyId);
		const leaveType = await prisma.leaveType.create({
			data: { companyId, code: `LV_${uid()}`, nameLao: 'ລາພັກ', isPaid: true }
		});
		const req = await prisma.leaveRequest.create({
			data: {
				employeeId: emp.id,
				leaveTypeId: leaveType.id,
				startDate: D('2025-09-15'),
				endDate: D('2025-09-15'),
				totalDays: '1',
				reason: 'ທົດສອບ',
				status: 'PENDING',
				requestedByUserId: requester.userId
			}
		});
		const inst = await prisma.$transaction((tx) =>
			createApprovalInstance(tx, {
				targetType: 'LEAVE',
				targetId: req.id,
				companyId,
				employeeId: emp.id,
				requesterUserId: requester.userId
			})
		);
		expect(inst.attemptNo).toBe(1);
		expect(inst.employeeId).toBe(emp.id);
		// 46. the normal domain cancellation still works through the latest-attempt helper
		const cancelled = await prisma.$transaction((tx) =>
			cancelApprovalInstance(tx, 'LEAVE', req.id)
		);
		expect(cancelled?.status).toBe('CANCELLED');
		// 47. the leave audit keeps its pre-Phase-13 shape (no attemptNo key for attempt 1)
		const audit = await prisma.auditEvent.findFirstOrThrow({
			where: { action: 'LEAVE.CANCELLED', entityId: String(req.id) }
		});
		expect(audit.actorUserId).toBe(requester.userId);
		expect(audit.metadataJson).not.toHaveProperty('attemptNo');
	});

	it('45. default workflows are unchanged: Leave / OT / Correction auto-created, Payroll never', async () => {
		const companyId = await newCompany();
		await ensureDefaultWorkflows(companyId);
		const types = (
			await prisma.approvalWorkflow.findMany({ where: { companyId }, select: { targetType: true } })
		).map((w) => w.targetType);
		expect(types.sort()).toEqual(['ATTENDANCE_CORRECTION', 'LEAVE', 'OVERTIME']);
	});
});

// =================================================================================================
// 93-94, 96 security
// =================================================================================================
describe('security', () => {
	it('93-94. MANAGER / EMPLOYEE cannot read the run, its results or the payroll approval (API)', async () => {
		const w = await workflowWorld();
		const s = await submitOk(w.run.id);
		const manager = await linkedUser('MANAGER');
		const emp = await linkedUser('EMPLOYEE');
		const result = await prisma.payrollEmployeeResult.findFirstOrThrow({
			where: { payrollRunId: w.run.id }
		});
		for (const u of [manager, emp]) {
			expect((await get(`/payroll/runs/${w.run.id}`, u.cookie)).status).toBe(403);
			expect((await get(`/payroll/results/${result.id}`, u.cookie)).status).toBe(403);
			expect((await get(`/payroll/runs/${w.run.id}/approval`, u.cookie)).status).toBe(403);
			expect((await get(`/approvals/${s.approval.approvalInstanceId}`, u.cookie)).status).toBe(403);
			expect((await approveI(s.approval.approvalInstanceId!, u.cookie)).status).toBe(403);
			const inbox = await get('/approvals/inbox?targetType=PAYROLL_RUN', u.cookie);
			expect(inbox.body.data?.items ?? []).toHaveLength(0);
		}
		// the approver (payroll.approve + view_all) CAN read the run they approve
		expect((await get(`/payroll/runs/${w.run.id}`, ctx.approver.cookie)).status).toBe(200);
		expect((await get(`/payroll/results/${result.id}`, ctx.approver.cookie)).status).toBe(200);
	});

	it('96. the generic Approvals inbox / detail never carry payroll money', async () => {
		const w = await workflowWorld({ salary: '6123456' });
		const s = await submitOk(w.run.id);
		const run = await runOf(w.run.id);
		const inbox = await get(
			'/approvals/inbox?targetType=PAYROLL_RUN&pageSize=100',
			ctx.approver.cookie
		);
		expect(inbox.status).toBe(200);
		const item = inbox.body.data.items.find((i: { targetId: string }) => i.targetId === w.run.id);
		expect(item).toBeDefined();
		expect(item.employee).toBeNull();
		expect(item.summary.details.periodName).toBe(w.period.name);
		const detail = await get(`/approvals/${s.approval.approvalInstanceId}`, ctx.approver.cookie);
		expect(detail.status).toBe(200);
		expect(detail.body.data.canAct).toBe(true);
		const blob = JSON.stringify([item, detail.body.data]);
		for (const n of [...moneyNeedles(run.summary.netPay), ...moneyNeedles('6123456.00')]) {
			expect(blob, n).not.toContain(n);
		}
		// the approval panel (payroll-authorized) shows the approver as current approver
		const panel = await get(`/payroll/runs/${w.run.id}/approval`, ctx.approver.cookie);
		expect(panel.body.data.actions.approve).toBe(true);
		expect(panel.body.data.currentStep.approvers.map((a: { id: string }) => a.id)).toContain(
			ctx.approver.userId
		);
		const mine = await get(`/payroll/runs/${w.run.id}/approval`, ctx.submitter.cookie);
		expect(mine.body.data.actions.approve).toBe(false);
		expect(mine.body.data.actions.cancel).toBe(true);
	});

	it('approver with only payroll.approve (+ view_all) is a valid candidate and can act', async () => {
		const only = await approverUser();
		const w = await workflowWorld({ workflow: false });
		await payrollWorkflow(w.companyId, [permStep()]);
		const s = await submitOk(w.run.id);
		expect(await candidatesOf(s.approval.approvalInstanceId!)).toContain(only.userId);
	});
});
