import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { REQUIRED_SCOPE_PERMISSIONS, REVIEW_PERMISSION } from '../lib/approvalTargets.js';
import type { AuthContext } from '../types/express.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import {
	cancelApprovalInstance,
	createApprovalInstance,
	getActiveApprovalInstance,
	nextAttemptNo
} from './approvalInstance.service.js';
import { buildPayrollPlan } from './payrollEngine.js';
import {
	approvalSummary,
	canonicalFromPlan,
	hashCanonical,
	type ApprovalSnapshotSummary
} from './payrollApprovalSnapshot.js';
import {
	approvedLockedError,
	canonicalRunFromEngine,
	clearedApprovalPointer,
	pendingApprovalError
} from './payrollApprovalState.js';
import {
	assertPriorCycleFinalized,
	getRun,
	lockRun,
	storedApprovalCanonical
} from './payrollRun.service.js';

/**
 * PAYROLL APPROVAL (Phase 13) — a thin domain layer over the GENERIC approval engine (Phase 9). There is
 * no payroll-only engine: submission creates an ApprovalInstance(PAYROLL_RUN, attemptNo n) with the usual
 * step + candidate snapshots, approve / reject go through `/approvals/:id/approve|reject`, and the engine
 * calls back into `finalizePayrollApproval` / `finalizePayrollRejection` below (via the target adapter)
 * inside its own transaction.
 *
 * State machine (PayrollRun.approvalState, the CURRENT attempt only):
 *
 *   NONE ──submit──▶ PENDING ──(last step) approve──▶ APPROVED ──finalize──▶ (run FINALIZED)
 *    ▲                  │ reject / cancel                  │ reopen
 *    │                  ▼                                  ▼
 *    └──recalculate── REJECTED / CANCELLED ◀───────────── NONE (run back to DRAFT → recalculate)
 *
 * Every attempt's ApprovalInstance (steps, actors, notes) is kept forever; a resubmission is attempt n+1.
 */
const RUN_TARGET = 'PAYROLL_RUN' as const;

const notFound = () => Errors.notFound('ບໍ່ພົບຮອບເງິນເດືອນ');

async function loadLocked(tx: Prisma.TransactionClient, id: number) {
	await lockRun(tx, id);
	const run = await tx.payrollRun.findUnique({ where: { id }, include: { period: true } });
	if (!run) throw notFound();
	return run;
}

// ============================================================================================
// submit / cancel / reopen
// ============================================================================================

/** POST /payroll/runs/:id/submit-approval */
export async function submitForApproval(id: number, actorUserId: number) {
	try {
		await prisma.$transaction(
			async (tx) => {
				// the run row lock serializes concurrent submissions: the loser sees PENDING below
				const run = await loadLocked(tx, id);
				if (run.status === 'FINALIZED' || run.period.status === 'CLOSED') {
					throw Errors.conflict(
						'PAYROLL_RUN_FINALIZED',
						'ຮອບເງິນເດືອນນີ້ຖືກຢືນຢັນແລ້ວ ແລະ ແກ້ໄຂບໍ່ໄດ້'
					);
				}
				if (run.approvalModeSnapshot !== 'WORKFLOW') {
					throw Errors.conflict(
						'PAYROLL_APPROVAL_NOT_REQUIRED',
						'ຮອບເງິນເດືອນນີ້ໃຊ້ການຢືນຢັນໂດຍກົງ (Direct) — ບໍ່ຕ້ອງສົ່ງອະນຸມັດ'
					);
				}
				if (run.approvalState === 'PENDING') throw pendingApprovalError();
				if (run.approvalState === 'APPROVED') throw approvedLockedError();
				if (run.status !== 'CALCULATED') {
					throw Errors.conflict(
						'PAYROLL_RUN_NOT_CALCULATED',
						'ຕ້ອງຄຳນວນເງິນເດືອນ (ຄຳນວນໃໝ່) ກ່ອນສົ່ງອະນຸມັດ'
					);
				}
				// §24 — cycle N's statutory month-to-date depends on cycle N-1 being FINALIZED
				await assertPriorCycleFinalized(tx, run);

				const stored = await storedApprovalCanonical(tx, run);
				if (stored.employees.length === 0) {
					throw Errors.conflict('PAYROLL_RUN_EMPTY', 'ບໍ່ມີພະນັກງານໃນຮອບເງິນເດືອນນີ້');
				}
				const blocked = stored.employees.filter((e) => e.status !== 'READY').length;
				if (blocked > 0) {
					throw Errors.conflict(
						'PAYROLL_HAS_BLOCKED_RESULTS',
						`ມີພະນັກງານ ${blocked} ຄົນທີ່ຕ້ອງກວດສອບ — ບໍ່ສາມາດສົ່ງອະນຸມັດໄດ້`,
						{ blockedCount: blocked }
					);
				}
				// the approvers must see the CURRENT payroll: the stored result has to equal a fresh plan
				const hash = hashCanonical(stored);
				const engine = await buildPayrollPlan(tx, run, run.period);
				const fresh = canonicalFromPlan(canonicalRunFromEngine(run, engine), engine.results);
				if (hashCanonical(fresh) !== hash) {
					throw Errors.conflict(
						'PAYROLL_RESULT_STALE',
						'ຂໍ້ມູນຕົ້ນທາງປ່ຽນແປງຫຼັງການຄຳນວນຄັ້ງລ່າສຸດ — ກະລຸນາຄຳນວນໃໝ່ກ່ອນສົ່ງອະນຸມັດ'
					);
				}

				const attemptNo = await nextAttemptNo(tx, RUN_TARGET, id);
				// generic engine: ACTIVE workflow (APPROVAL_WORKFLOW_NOT_FOUND otherwise), step + candidate
				// snapshots, requester excluded (APPROVER_NOT_FOUND when nobody is left), PAYROLL.RUN_SUBMITTED
				// audit + notification to the step-1 candidates — all in THIS transaction
				const instance = await createApprovalInstance(tx, {
					targetType: RUN_TARGET,
					targetId: id,
					companyId: run.companyId,
					employeeId: null,
					requesterUserId: actorUserId,
					attemptNo
				});
				await tx.payrollRun.update({
					where: { id },
					data: {
						approvalState: 'PENDING',
						approvalAttemptNo: attemptNo,
						approvalInstanceId: instance.id,
						submittedAt: serverNow(),
						submittedByUserId: actorUserId,
						approvedAt: null,
						approvedByUserId: null,
						approvalSnapshotHash: hash,
						approvalCanonicalVersion: stored.canonicalVersion,
						approvalSnapshotJson: approvalSummary(stored) as unknown as Prisma.InputJsonObject
					}
				});
			},
			{ timeout: 60_000, maxWait: 15_000 }
		);
	} catch (err) {
		// unique (targetType, targetId, attemptNo) backstop: a concurrent submission won the attempt
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw pendingApprovalError();
		}
		throw err;
	}
	return getRun(id);
}

/** POST /payroll/runs/:id/cancel-approval — the requester or an authorized payroll manager. */
export async function cancelSubmission(id: number, actorUserId: number) {
	await prisma.$transaction(async (tx) => {
		const run = await loadLocked(tx, id);
		if (run.approvalState !== 'PENDING') {
			throw Errors.conflict(
				'PAYROLL_NOT_PENDING_APPROVAL',
				'ຮອບເງິນເດືອນນີ້ບໍ່ໄດ້ຢູ່ໃນສະຖານະລໍຖ້າການອະນຸມັດ'
			);
		}
		// existing engine cancellation: current + waiting steps cancelled, acted steps kept, the
		// current candidates told, PAYROLL.RUN_APPROVAL_CANCELLED audited with the real actor
		const cancelled = await cancelApprovalInstance(tx, RUN_TARGET, id, actorUserId);
		if (!cancelled) {
			throw Errors.conflict('APPROVAL_ALREADY_COMPLETED', 'ຄຳຂໍນີ້ສຳເລັດການພິຈາລະນາແລ້ວ');
		}
		await tx.payrollRun.update({ where: { id }, data: { approvalState: 'CANCELLED' } });
	});
	return getRun(id);
}

/**
 * POST /payroll/runs/:id/reopen — an APPROVED (not yet finalized) run goes back to NONE + DRAFT: HR must
 * recalculate and submit a NEW attempt. The approved attempt stays in the history.
 */
export async function reopenRun(id: number, actorUserId: number) {
	await prisma.$transaction(async (tx) => {
		const run = await loadLocked(tx, id);
		if (run.status === 'FINALIZED') {
			throw Errors.conflict(
				'PAYROLL_RUN_FINALIZED',
				'ຮອບເງິນເດືອນນີ້ຖືກຢືນຢັນແລ້ວ ແລະ ແກ້ໄຂບໍ່ໄດ້'
			);
		}
		if (run.approvalState !== 'APPROVED') {
			throw Errors.conflict(
				'PAYROLL_NOT_APPROVED',
				'ເປີດຄືນໄດ້ສະເພາະຮອບເງິນເດືອນທີ່ໄດ້ຮັບການອະນຸມັດແລ້ວ (ຍັງບໍ່ໄດ້ຢືນຢັນ)'
			);
		}
		await tx.payrollRun.update({
			where: { id },
			// DRAFT = "needs recalculation"; the pointer is cleared (history stays in approval_instances)
			data: { status: 'DRAFT', ...clearedApprovalPointer }
		});
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_RUN_REOPENED,
			entityType: AuditEntity.PAYROLL_RUN,
			entityId: id,
			companyId: run.companyId,
			actorUserId,
			// identifiers only — never amounts
			metadata: {
				runId: id,
				periodId: run.periodId,
				attemptNo: run.approvalAttemptNo,
				approvalInstanceId: run.approvalInstanceId,
				calculationVersion: run.calculationVersion
			}
		});
	});
	return getRun(id);
}

// ============================================================================================
// domain finalizers — called by the GENERIC engine (approvalTargetAdapter) inside ITS transaction
// ============================================================================================

/** The run must still be PENDING on exactly the instance being actioned — otherwise roll back. */
async function lockPendingRun(tx: Prisma.TransactionClient, runId: number) {
	const run = await loadLocked(tx, runId);
	const active = await getActiveApprovalInstance(tx, RUN_TARGET, runId);
	if (run.approvalState !== 'PENDING' || !active || run.approvalInstanceId !== active.id) {
		throw Errors.conflict(
			'PAYROLL_APPROVAL_STATE_CHANGED',
			'ສະຖານະການອະນຸມັດຂອງຮອບເງິນເດືອນນີ້ປ່ຽນແປງແລ້ວ — ກະລຸນາໂຫຼດໃໝ່'
		);
	}
	return run;
}

/** LAST step approved → APPROVED. Never finalizes: approval and finalization are separate controls. */
export async function finalizePayrollApproval(
	tx: Prisma.TransactionClient,
	runId: number,
	actorUserId: number
) {
	await lockPendingRun(tx, runId);
	await tx.payrollRun.update({
		where: { id: runId },
		data: { approvalState: 'APPROVED', approvedAt: serverNow(), approvedByUserId: actorUserId }
	});
}

/** Any step rejected → REJECTED (HR may recalculate and submit a new attempt). */
export async function finalizePayrollRejection(tx: Prisma.TransactionClient, runId: number) {
	await lockPendingRun(tx, runId);
	await tx.payrollRun.update({ where: { id: runId }, data: { approvalState: 'REJECTED' } });
}

// ============================================================================================
// read model: the Approval panel + attempt history (GET /payroll/runs/:id/approval)
// ============================================================================================

const holds = (auth: AuthContext, code: string) => auth.permissions.includes(code);

export async function getRunApproval(id: number, auth: AuthContext) {
	const run = await prisma.payrollRun.findUnique({
		where: { id },
		select: {
			id: true,
			companyId: true,
			status: true,
			approvalModeSnapshot: true,
			approvalState: true,
			approvalAttemptNo: true,
			approvalInstanceId: true,
			submittedAt: true,
			approvedAt: true,
			approvalSnapshotJson: true,
			submittedBy: { select: { id: true, displayName: true } },
			approvedBy: { select: { id: true, displayName: true } }
		}
	});
	if (!run) throw notFound();

	const [workflow, attempts] = await Promise.all([
		prisma.approvalWorkflow.findFirst({
			where: { companyId: run.companyId, targetType: RUN_TARGET, status: 'ACTIVE' },
			select: { id: true, nameLao: true, version: true, _count: { select: { steps: true } } }
		}),
		prisma.approvalInstance.findMany({
			where: { targetType: RUN_TARGET, targetId: id },
			orderBy: { attemptNo: 'desc' },
			include: {
				requester: { select: { id: true, displayName: true } },
				workflow: { select: { nameLao: true } },
				steps: {
					orderBy: { stepOrder: 'asc' },
					include: {
						actedBy: { select: { id: true, displayName: true } },
						candidates: { select: { userId: true } }
					}
				}
			}
		})
	]);

	const userId = auth.user.id;
	const active = attempts.find((a) => a.status === 'PENDING') ?? null;
	const currentStep = active?.steps.find((s) => s.status === 'PENDING') ?? null;
	const currentApprovers = currentStep
		? await prisma.user.findMany({
				where: { id: { in: currentStep.candidates.map((c) => c.userId) } },
				select: { id: true, displayName: true, status: true },
				orderBy: { displayName: 'asc' }
			})
		: [];
	const canApprove =
		!!active &&
		!!currentStep &&
		active.requesterUserId !== userId &&
		holds(auth, REVIEW_PERMISSION[RUN_TARGET]) &&
		REQUIRED_SCOPE_PERMISSIONS[RUN_TARGET].every((p) => holds(auth, p)) &&
		currentStep.candidates.some((c) => c.userId === userId);
	const manage = holds(auth, 'payroll.manage') && holds(auth, 'employees.view_all');
	const workflowMode = run.approvalModeSnapshot === 'WORKFLOW';
	const open = run.status !== 'FINALIZED';

	return {
		runId: run.id,
		mode: run.approvalModeSnapshot,
		state: run.approvalState,
		attemptNo: run.approvalAttemptNo,
		approvalInstanceId: run.approvalInstanceId,
		submittedAt: run.submittedAt,
		submittedBy: run.submittedBy,
		approvedAt: run.approvedAt,
		approvedBy: run.approvedBy,
		/** counts / totals / versions of the submitted result (payroll-authorized screens only) */
		snapshot: (run.approvalSnapshotJson as ApprovalSnapshotSummary | null) ?? null,
		workflow: workflow
			? {
					id: workflow.id,
					nameLao: workflow.nameLao,
					version: workflow.version,
					steps: workflow._count.steps
				}
			: null,
		currentStep: currentStep
			? {
					stepOrder: currentStep.stepOrder,
					nameLao: currentStep.nameLao,
					totalSteps: active!.steps.length,
					approvers: currentApprovers.map((u) => ({
						id: u.id,
						displayName: u.displayName,
						active: u.status === 'ACTIVE'
					}))
				}
			: null,
		/** what THIS viewer may do right now (the API re-checks every action) */
		actions: {
			submit:
				workflowMode &&
				open &&
				manage &&
				run.status === 'CALCULATED' &&
				['NONE', 'REJECTED', 'CANCELLED'].includes(run.approvalState),
			cancel: workflowMode && open && manage && run.approvalState === 'PENDING',
			approve: open && canApprove,
			reject: open && canApprove,
			reopen: workflowMode && open && manage && run.approvalState === 'APPROVED',
			finalize:
				open &&
				holds(auth, 'payroll.finalize') &&
				run.status === 'CALCULATED' &&
				(!workflowMode || run.approvalState === 'APPROVED')
		},
		isRequester: !!active && active.requesterUserId === userId,
		history: attempts.map((a) => ({
			attemptNo: a.attemptNo,
			approvalInstanceId: a.id,
			status: a.status,
			workflowName: a.workflow?.nameLao ?? null,
			workflowVersion: a.workflowVersion,
			submittedAt: a.submittedAt,
			submittedBy: a.requester,
			completedAt: a.completedAt,
			steps: a.steps.map((s) => ({
				stepOrder: s.stepOrder,
				nameLao: s.nameLao,
				status: s.status,
				actedBy: s.actedBy,
				actedAt: s.actedAt,
				note: s.actionNote
			}))
		}))
	};
}

// ============================================================================================
// generic-engine adapter support (approvals inbox / detail) — no money, ever
// ============================================================================================

export async function payrollRunSummaries(ids: number[]) {
	const rows = await prisma.payrollRun.findMany({
		where: { id: { in: ids } },
		select: {
			id: true,
			companyId: true,
			status: true,
			approvalState: true,
			payrollMonth: true,
			cycleNumber: true,
			submittedAt: true,
			company: { select: { id: true, code: true, nameLao: true } },
			period: {
				select: { code: true, name: true, startDate: true, endDate: true, payrollMonth: true }
			},
			submittedBy: { select: { id: true, displayName: true } }
		}
	});
	return rows;
}
