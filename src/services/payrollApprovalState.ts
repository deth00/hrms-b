import { Prisma } from '@prisma/client';
import type { PayrollApprovalState } from '@prisma/client';
import { Errors } from '../utils/AppError.js';
import type { buildPayrollPlan } from './payrollEngine.js';
import type { CanonicalRun } from './payrollApprovalSnapshot.js';

/**
 * Phase 13 — shared payroll-approval guards (used by the run, approval and period services).
 *
 * While an attempt is PENDING the submitted result must not change underneath the approvers; while it
 * is APPROVED it must not change either (finalize the exact approved payroll, or reopen it first).
 */
export const pendingApprovalError = () =>
	Errors.conflict(
		'PAYROLL_PENDING_APPROVAL',
		'ຮອບເງິນເດືອນນີ້ກຳລັງລໍຖ້າການອະນຸມັດ — ບໍ່ສາມາດແກ້ໄຂໄດ້ຈົນກວ່າຈະອະນຸມັດ, ປະຕິເສດ ຫຼື ຍົກເລີກການສົ່ງ'
	);

export const approvedLockedError = () =>
	Errors.conflict(
		'PAYROLL_APPROVED_LOCKED',
		'ຮອບເງິນເດືອນນີ້ໄດ້ຮັບການອະນຸມັດແລ້ວ — ຢືນຢັນ (Finalize) ຫຼື ເປີດຄືນ (Reopen) ກ່ອນຈຶ່ງແກ້ໄຂໄດ້'
	);

/** Calculate / adjustment / period changes are refused while an attempt is PENDING or APPROVED. */
export function assertApprovalAllowsChange(run: { approvalState: PayrollApprovalState }) {
	if (run.approvalState === 'PENDING') throw pendingApprovalError();
	if (run.approvalState === 'APPROVED') throw approvedLockedError();
}

/**
 * What a successful (re)calculation writes: the CURRENT attempt pointer is cleared and the state goes
 * back to NONE. Every earlier attempt stays in approval_instances — history is never deleted.
 */
export const clearedApprovalPointer = {
	approvalState: 'NONE',
	approvalAttemptNo: null,
	approvalInstanceId: null,
	submittedAt: null,
	submittedByUserId: null,
	approvedAt: null,
	approvedByUserId: null,
	approvalSnapshotHash: null,
	approvalCanonicalVersion: null,
	approvalSnapshotJson: Prisma.DbNull
} satisfies Prisma.PayrollRunUncheckedUpdateInput;

type EnginePlan = Awaited<ReturnType<typeof buildPayrollPlan>>;

/** Run-level identity of a FRESH plan (same mapping the run row stores — see monthContextFields). */
export const canonicalRunFromEngine = (
	run: { id: number; periodId: number },
	engine: EnginePlan
): CanonicalRun => ({
	runId: run.id,
	periodId: run.periodId,
	payrollMonth: engine.monthContext.payrollMonth,
	cycleNumber: engine.monthContext.totalCycles > 1 ? engine.monthContext.cycleNumber : null,
	calculationVersion: engine.version,
	payrollRuleSetId: engine.ruleSetId,
	payrollRuleVersion: engine.ruleSnapshot?.version ?? null
});

/** Run-level identity of the STORED calculation. */
export const canonicalRunFromStored = (run: {
	id: number;
	periodId: number;
	payrollMonth: string | null;
	cycleNumber: number | null;
	calculationVersion: number;
	payrollRuleSetId: number | null;
	ruleSnapshotJson: Prisma.JsonValue | null;
}): CanonicalRun => ({
	runId: run.id,
	periodId: run.periodId,
	payrollMonth: run.payrollMonth,
	cycleNumber: run.cycleNumber,
	calculationVersion: run.calculationVersion,
	payrollRuleSetId: run.payrollRuleSetId,
	payrollRuleVersion:
		run.ruleSnapshotJson && typeof run.ruleSnapshotJson === 'object'
			? (((run.ruleSnapshotJson as { version?: number }).version as number | undefined) ?? null)
			: null
});
