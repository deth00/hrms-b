import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { idCol } from '../lib/sqlIds.js';
import { Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { ZERO, moneyOrNull, moneyString } from '../lib/money.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { assertCodeNotReserved } from './payComponent.service.js';
import { requirePayrollSettings } from './payrollSettings.service.js';
import {
	CALCULATION_VERSION,
	loadEligibleEmployees,
	planTotals,
	replaceRunResults
} from './payrollCalculation.js';
import { buildPayrollPlan } from './payrollEngine.js';
import { cycleAllocationFactors } from './payrollMonthContext.service.js';
import {
	CANONICAL_VERSION,
	STORED_RESULT_INCLUDE,
	canonicalFromPlan,
	canonicalFromStored,
	hashCanonical
} from './payrollApprovalSnapshot.js';
import {
	assertApprovalAllowsChange,
	canonicalRunFromEngine,
	canonicalRunFromStored,
	clearedApprovalPointer
} from './payrollApprovalState.js';
import { createMissingPayslips } from './payslip.service.js';
import type {
	AdjustmentCreateInput,
	ResultListQuery,
	RunCreateInput,
	RunFinalizeInput,
	RunListQuery
} from '../validation/payroll.schema.js';

/**
 * PAYROLL RUNS.
 *
 *  DRAFT ──calculate──▶ CALCULATED ──finalize──▶ FINALIZED (immutable)
 *    ▲                       │
 *    └── manual adjustment ──┘   (adding an adjustment sends the run back to DRAFT: recalculation is explicit)
 *
 *  - calculate / recalculate REPLACES every result + item (never appends) in one transaction.
 *  - Master-data edits never touch a stored run; HR chooses when to recalculate.
 *  - finalize does NOT trust the stored results: inside its own transaction it rebuilds the plan from the
 *    latest source data, refuses if anything is BLOCKED (nothing changes), refuses if the net total moved
 *    away from what the user confirmed (`expectedNetPay`), then stores the fresh snapshot, marks the run
 *    FINALIZED and closes the period. After that nothing can change it (every mutating path re-checks
 *    the status under a row lock).
 *
 * Phase 13 — approval. A run snapshots the company's approval mode at creation:
 *  - DIRECT   → exactly the behaviour above (CALCULATED → FINALIZE).
 *  - WORKFLOW → CALCULATED → submit (PENDING) → APPROVED → FINALIZE (payrollApproval.service.ts). While
 *    PENDING or APPROVED, calculate / adjustments / period edits are refused. Finalize rebuilds the plan
 *    from the latest source data and compares its canonical hash with the APPROVED hash: any difference
 *    is PAYROLL_APPROVAL_STALE (nothing is written); an identical plan finalizes the EXACT approved rows
 *    (they are not replaced).
 *  - Every finalization issues the run's payslips in the same transaction (payslip.service.ts).
 */
const USER_BRIEF = { select: { id: true, displayName: true } } as const;
const RUN_INCLUDE = {
	company: { select: { id: true, code: true, nameLao: true } },
	schedule: {
		select: { id: true, code: true, nameLao: true, paymentsPerMonth: true, groupByBranch: true }
	},
	period: {
		select: {
			id: true,
			code: true,
			name: true,
			startDate: true,
			endDate: true,
			payDate: true,
			status: true,
			cycleNumber: true,
			payrollMonth: true,
			statutoryMonthEligible: true
		}
	},
	calculatedBy: USER_BRIEF,
	finalizedBy: USER_BRIEF,
	submittedBy: USER_BRIEF,
	approvedBy: USER_BRIEF,
	_count: { select: { payslips: true } }
} satisfies Prisma.PayrollRunInclude;
type RunRow = Prisma.PayrollRunGetPayload<{ include: typeof RUN_INCLUDE }>;

/** rule reference + immutable snapshot stored on the run by every calculation / finalization */
const ruleFields = (engine: Awaited<ReturnType<typeof buildPayrollPlan>>) => ({
	payrollRuleSetId: engine.ruleSetId,
	ruleSnapshotJson: engine.ruleSnapshot
		? (engine.ruleSnapshot as unknown as Prisma.InputJsonObject)
		: Prisma.DbNull
});

/**
 * Phase 12A.1 — cycle allocation snapshot (§8): stamped by every calculate / finalize so historical
 * display never depends on a later-edited PayrollSchedule. `monthlyAllocationFactor` stores the
 * schedule-level factor actually applied (exact for EQUAL_SPLIT / CALENDAR_DAYS PERIOD_UNITS); the
 * per-employee ratio ACTUALLY applied (which can differ under WORKING_DAYS PERIOD_UNITS) lives on
 * each PayrollEmployeeResult's own cycleAllocationFactorSnapshot.
 */
const monthContextFields = (engine: Awaited<ReturnType<typeof buildPayrollPlan>>) => ({
	payrollMonth: engine.monthContext.payrollMonth,
	cycleNumber: engine.monthContext.totalCycles > 1 ? engine.monthContext.cycleNumber : null,
	paymentsPerMonth:
		engine.monthContext.totalCycles > 1 ? engine.monthContext.paymentsPerMonth : null,
	monthlyAllocationMethod: engine.monthContext.allocationMethod,
	// the schedule-level factor actually applied (EQUAL_SPLIT: 1/totalCycles; PERIOD_UNITS: the
	// CALENDAR_DAYS-basis reference — WORKING_DAYS varies per employee and is not representable here;
	// see each employee's own cycleAllocationFactorSnapshot for the ratio actually used on their pay)
	monthlyAllocationFactor:
		engine.monthContext.totalCycles > 1
			? new Prisma.Decimal(cycleAllocationFactors(engine.monthContext).thisFactor.toFixed(10))
			: null
});

export async function lockRun(tx: Prisma.TransactionClient, id: number) {
	await tx.$queryRaw`SELECT ${idCol()} AS id FROM payroll_runs WHERE ${idCol()} = ${id} FOR UPDATE`;
}

const finalizedError = () =>
	Errors.conflict('PAYROLL_RUN_FINALIZED', 'ຮອບເງິນເດືອນນີ້ຖືກຢືນຢັນແລ້ວ ແລະ ແກ້ໄຂບໍ່ໄດ້');

// ============================================================================================
// presentation
// ============================================================================================

async function summaries(runIds: number[]) {
	const map = new Map<
		number,
		{
			employees: number;
			ready: number;
			blocked: number;
			totalEarnings: Prisma.Decimal;
			totalDeductions: Prisma.Decimal;
			netPay: Prisma.Decimal;
		}
	>();
	if (runIds.length === 0) return map;
	const groups = await prisma.payrollEmployeeResult.groupBy({
		by: ['payrollRunId', 'calculationStatus'],
		where: { payrollRunId: { in: runIds } },
		_count: { _all: true },
		_sum: { totalEarnings: true, totalDeductions: true, netPay: true }
	});
	for (const g of groups) {
		const s = map.get(g.payrollRunId) ?? {
			employees: 0,
			ready: 0,
			blocked: 0,
			totalEarnings: ZERO,
			totalDeductions: ZERO,
			netPay: ZERO
		};
		s.employees += g._count._all;
		if (g.calculationStatus === 'READY') s.ready += g._count._all;
		else s.blocked += g._count._all;
		s.totalEarnings = s.totalEarnings.plus(g._sum.totalEarnings ?? 0);
		s.totalDeductions = s.totalDeductions.plus(g._sum.totalDeductions ?? 0);
		s.netPay = s.netPay.plus(g._sum.netPay ?? 0);
		map.set(g.payrollRunId, s);
	}
	return map;
}

function presentRun(
	run: RunRow,
	s: Awaited<ReturnType<typeof summaries>> extends Map<number, infer V> ? V | undefined : never
) {
	const sum = s ?? {
		employees: 0,
		ready: 0,
		blocked: 0,
		totalEarnings: ZERO,
		totalDeductions: ZERO,
		netPay: ZERO
	};
	return {
		id: run.id,
		companyId: run.companyId,
		company: run.company,
		period: run.period,
		schedule: run.schedule,
		status: run.status,
		currencyCode: run.currencyCode,
		calculationVersion: run.calculationVersion,
		payrollRuleSetId: run.payrollRuleSetId,
		ruleSnapshot: run.ruleSnapshotJson ?? null,
		// Phase 12A.1 - cycle allocation snapshot (§8, §24)
		cycleAllocation: {
			payrollMonth: run.payrollMonth,
			cycleNumber: run.cycleNumber,
			paymentsPerMonth: run.paymentsPerMonth,
			monthlyAllocationMethod: run.monthlyAllocationMethod,
			monthlyAllocationFactor: run.monthlyAllocationFactor
				? run.monthlyAllocationFactor.toFixed(10)
				: null
		},
		calculatedAt: run.calculatedAt,
		calculatedBy: run.calculatedBy,
		finalizedAt: run.finalizedAt,
		finalizedBy: run.finalizedBy,
		// Phase 13 — the CURRENT approval attempt (history: GET /payroll/runs/:id/approval)
		approval: {
			mode: run.approvalModeSnapshot,
			state: run.approvalState,
			attemptNo: run.approvalAttemptNo,
			approvalInstanceId: run.approvalInstanceId,
			submittedAt: run.submittedAt,
			submittedBy: run.submittedBy,
			approvedAt: run.approvedAt,
			approvedBy: run.approvedBy
		},
		payslipCount: run._count.payslips,
		createdAt: run.createdAt,
		// a DRAFT run that still has results was edited (adjustment) after its last calculation
		needsRecalculation: run.status === 'DRAFT' && sum.employees > 0,
		summary: {
			employees: sum.employees,
			ready: sum.ready,
			blocked: sum.blocked,
			totalEarnings: moneyString(sum.totalEarnings),
			totalDeductions: moneyString(sum.totalDeductions),
			netPay: moneyString(sum.netPay)
		}
	};
}

async function loadRunOrThrow(id: number) {
	const run = await prisma.payrollRun.findUnique({ where: { id }, include: RUN_INCLUDE });
	if (!run) throw Errors.notFound('ບໍ່ພົບຮອບເງິນເດືອນ');
	return run;
}

// ============================================================================================
// runs
// ============================================================================================

export async function listRuns(query: RunListQuery) {
	const where: Prisma.PayrollRunWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.periodId ? { periodId: query.periodId } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.year
			? {
					period: {
						startDate: {
							gte: new Date(Date.UTC(query.year, 0, 1)),
							lt: new Date(Date.UTC(query.year + 1, 0, 1))
						}
					}
				}
			: {})
	};
	const [rows, total] = await Promise.all([
		prisma.payrollRun.findMany({
			where,
			include: RUN_INCLUDE,
			orderBy: { period: { startDate: 'desc' } },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.payrollRun.count({ where })
	]);
	const sums = await summaries(rows.map((r) => r.id));
	return {
		items: rows.map((r) => presentRun(r, sums.get(r.id))),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getRun(id: number) {
	const run = await loadRunOrThrow(id);
	const sums = await summaries([id]);
	return presentRun(run, sums.get(id));
}

export async function createRun(input: RunCreateInput, actorUserId: number) {
	const period = await prisma.payrollPeriod.findUnique({ where: { id: input.periodId } });
	if (!period || period.companyId !== input.companyId) {
		throw Errors.badRequest('INVALID_PERIOD', 'ບໍ່ພົບງວດເງິນເດືອນຂອງບໍລິສັດນີ້');
	}
	if (period.status !== 'OPEN') {
		throw Errors.conflict('PAYROLL_PERIOD_CLOSED', 'ງວດນີ້ຖືກປິດແລ້ວ');
	}
	const settings = await requirePayrollSettings(input.companyId);
	if (period.payrollScheduleId) {
		const schedule = await prisma.payrollSchedule.findUnique({
			where: { id: period.payrollScheduleId },
			select: { payBasis: true }
		});
		if (schedule && schedule.payBasis !== 'MONTHLY') {
			throw Errors.badRequest(
				'PAYROLL_BASIS_NOT_SUPPORTED',
				'ຍັງບໍ່ຮອງຮັບການຄຳນວນເງິນເດືອນແບບລາຍວັນ — ໃຊ້ໄດ້ສະເພາະລາຍເດືອນ'
			);
		}
	}
	try {
		const created = await prisma.$transaction(async (tx) => {
			const run = await tx.payrollRun.create({
				data: {
					companyId: input.companyId,
					periodId: input.periodId,
					// the schedule context travels with the run; the period dates stay the concrete snapshot
					payrollScheduleId: period.payrollScheduleId,
					status: 'DRAFT',
					currencyCode: settings.currencyCode,
					calculationVersion: CALCULATION_VERSION,
					// Phase 13 — frozen: changing the company setting later never alters this run
					approvalModeSnapshot: settings.approvalMode,
					createdByUserId: actorUserId
				}
			});
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_RUN_CREATED,
				entityType: AuditEntity.PAYROLL_RUN,
				entityId: run.id,
				companyId: run.companyId,
				actorUserId,
				metadata: {
					periodId: run.periodId,
					periodCode: period.code,
					currencyCode: run.currencyCode,
					approvalMode: run.approvalModeSnapshot
				}
			});
			return run;
		});
		return await getRun(created.id);
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict('PAYROLL_RUN_EXISTS', 'ງວດນີ້ມີຮອບເງິນເດືອນແລ້ວ');
		}
		throw err;
	}
}

/** Loads run + period under the run lock and applies the "still editable" rules. */
async function loadEditableRun(tx: Prisma.TransactionClient, id: number) {
	await lockRun(tx, id);
	const run = await tx.payrollRun.findUnique({ where: { id }, include: { period: true } });
	if (!run) throw Errors.notFound('ບໍ່ພົບຮອບເງິນເດືອນ');
	if (run.status === 'FINALIZED' || run.period.status === 'CLOSED') throw finalizedError();
	return run;
}

export async function calculateRun(id: number, actorUserId: number) {
	await prisma.$transaction(
		async (tx) => {
			const run = await loadEditableRun(tx, id);
			// Phase 13 — never recalculate underneath approvers (PENDING) or an approved payroll (APPROVED)
			assertApprovalAllowsChange(run);
			const settings = await requirePayrollSettings(run.companyId, tx as typeof prisma);
			if (settings.currencyCode !== run.currencyCode) {
				throw Errors.conflict(
					'PAYROLL_CURRENCY_MISMATCH',
					'ສະກຸນເງິນຂອງບໍລິສັດບໍ່ກົງກັບຮອບເງິນເດືອນນີ້'
				);
			}
			const engine = await buildPayrollPlan(tx, run, run.period);
			const plan = engine.results;
			await replaceRunResults(tx, id, plan);
			await tx.payrollRun.update({
				where: { id },
				data: {
					status: 'CALCULATED',
					calculationVersion: engine.version,
					...ruleFields(engine),
					...monthContextFields(engine),
					calculatedAt: serverNow(),
					calculatedByUserId: actorUserId,
					// a new result is a new approval candidate: the current attempt pointer is cleared
					// (NONE); rejected / cancelled attempts stay in the approval history
					...clearedApprovalPointer
				}
			});
			const totals = planTotals(plan);
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_RUN_CALCULATED,
				entityType: AuditEntity.PAYROLL_RUN,
				entityId: id,
				companyId: run.companyId,
				actorUserId,
				// counts only — no payroll amounts in the global audit trail
				metadata: {
					employees: totals.employees,
					ready: totals.ready,
					blocked: totals.blocked,
					calculationVersion: engine.version,
					ruleVersion: engine.ruleSnapshot?.version ?? null,
					payrollMonth: engine.monthContext.payrollMonth,
					cycleNumber: engine.monthContext.totalCycles > 1 ? engine.monthContext.cycleNumber : null,
					monthlyAllocationMethod: engine.monthContext.allocationMethod
				}
			});
		},
		{ timeout: 60_000, maxWait: 10_000 }
	);
	return getRun(id);
}

/**
 * Phase 12A.1 §18 (reused by Phase 13 submit-approval §24) — a TWO/month schedule's cycle N must not
 * finalize (or be submitted for approval) before cycle N-1 of the SAME company + schedule + payroll month
 * is FINALIZED: the monthly PIT / SSO accumulation of cycle N reads cycle N-1's frozen snapshot.
 */
export async function assertPriorCycleFinalized(
	tx: Prisma.TransactionClient,
	run: {
		payrollScheduleId: number | null;
		period: { payrollMonth: string | null; cycleNumber: number | null };
	}
) {
	if (
		run.payrollScheduleId &&
		run.period.payrollMonth &&
		run.period.cycleNumber &&
		run.period.cycleNumber > 1
	) {
		const priorPeriod = await tx.payrollPeriod.findFirst({
			where: {
				payrollScheduleId: run.payrollScheduleId,
				payrollMonth: run.period.payrollMonth,
				cycleNumber: run.period.cycleNumber - 1
			},
			include: { run: { select: { status: true } } }
		});
		if (priorPeriod && priorPeriod.run?.status !== 'FINALIZED') {
			throw Errors.conflict(
				'PRIOR_PAYROLL_CYCLE_NOT_FINALIZED',
				`ຮອບທີ ${run.period.cycleNumber - 1} ຂອງເດືອນນີ້ຍັງບໍ່ໄດ້ຢືນຢັນ — ຕ້ອງຢືນຢັນຮອບກ່ອນໜ້າກ່ອນ`,
				{ priorCycleNumber: run.period.cycleNumber - 1 }
			);
		}
	}
}

export async function finalizeRun(id: number, input: RunFinalizeInput, actorUserId: number) {
	await prisma.$transaction(
		async (tx) => {
			const run = await loadEditableRun(tx, id);
			if (run.status !== 'CALCULATED') {
				throw Errors.conflict(
					'PAYROLL_RUN_NOT_CALCULATED',
					'ຕ້ອງຄຳນວນເງິນເດືອນ (ຄຳນວນໃໝ່) ກ່ອນຢືນຢັນ'
				);
			}
			const workflow = run.approvalModeSnapshot === 'WORKFLOW';
			if (workflow && run.approvalState !== 'APPROVED') {
				throw Errors.conflict(
					'PAYROLL_APPROVAL_REQUIRED',
					'ຮອບເງິນເດືອນນີ້ຕ້ອງໄດ້ຮັບການອະນຸມັດກ່ອນຈຶ່ງຢືນຢັນໄດ້',
					{ approvalState: run.approvalState }
				);
			}
			await assertPriorCycleFinalized(tx, run);
			// re-validate against the LATEST source data — the stored results may be stale
			const engine = await buildPayrollPlan(tx, run, run.period);
			const plan = engine.results;
			if (workflow && (run.approvalCanonicalVersion ?? 1) !== CANONICAL_VERSION) {
				// numeric-ID migration — this approval was hashed with canonical v1 (pre-migration CUID ids), which
				// can never be recomputed. Explicitly NOT "stale data": the stored hash is left untouched and HR
				// re-approves (reopen → recalculate → submit), which hashes with the current version.
				throw Errors.conflict(
					'PAYROLL_APPROVAL_CANONICAL_OUTDATED',
					'ການອະນຸມັດນີ້ເຮັດກ່ອນການປ່ຽນລະບົບເລກລະຫັດ — ກະລຸນາເປີດຄືນ (Reopen), ຄຳນວນໃໝ່ ແລະ ສົ່ງອະນຸມັດອີກຄັ້ງ',
					{
						approvalCanonicalVersion: run.approvalCanonicalVersion ?? 1,
						requiredCanonicalVersion: CANONICAL_VERSION
					}
				);
			}
			if (workflow) {
				// §22-23 — the fresh plan must be EXACTLY the approved payroll. ANY difference (attendance,
				// leave, OT, compensation, recurring, rules, statutory rule / profile … — including one that
				// would now BLOCK an employee) → stale: nothing is written, the approved result stays as it
				// is, and HR must reopen → recalculate → submit a new attempt.
				const freshHash = hashCanonical(
					canonicalFromPlan(canonicalRunFromEngine(run, engine), plan)
				);
				if (!run.approvalSnapshotHash || freshHash !== run.approvalSnapshotHash) {
					throw Errors.conflict(
						'PAYROLL_APPROVAL_STALE',
						'ຂໍ້ມູນເງິນເດືອນປ່ຽນແປງຫຼັງຈາກໄດ້ຮັບການອະນຸມັດ — ກະລຸນາເປີດຄືນ (Reopen), ຄຳນວນໃໝ່ ແລະ ສົ່ງອະນຸມັດອີກຄັ້ງ'
					);
				}
			}
			const totals = planTotals(plan);
			if (totals.employees === 0) {
				throw Errors.conflict('PAYROLL_RUN_EMPTY', 'ບໍ່ມີພະນັກງານໃນຮອບເງິນເດືອນນີ້');
			}
			if (totals.blocked > 0) {
				throw Errors.conflict(
					'PAYROLL_HAS_BLOCKED_RESULTS',
					`ມີພະນັກງານ ${totals.blocked} ຄົນທີ່ຕ້ອງກວດສອບ — ບໍ່ສາມາດຢືນຢັນໄດ້`,
					{ blockedCount: totals.blocked }
				);
			}
			if (
				input.expectedNetPay !== undefined &&
				input.expectedNetPay !== moneyString(totals.netPay)
			) {
				throw Errors.conflict(
					'PAYROLL_RESULT_CHANGED',
					'ຂໍ້ມູນເງິນເດືອນປ່ຽນແປງຫຼັງຈາກການຄຳນວນຄັ້ງລ່າສຸດ — ກະລຸນາຄຳນວນໃໝ່ ແລະ ກວດສອບອີກຄັ້ງ',
					{ netPay: moneyString(totals.netPay) }
				);
			}
			const now = serverNow();
			if (workflow) {
				// identical to the approved hash (checked above) → finalize the EXACT approved rows
				// (no replacement: result ids / payroll figures stay those the approvers saw)
				await tx.payrollRun.update({
					where: { id },
					data: { status: 'FINALIZED', finalizedAt: now, finalizedByUserId: actorUserId }
				});
			} else {
				await replaceRunResults(tx, id, plan);
				await tx.payrollRun.update({
					where: { id },
					data: {
						status: 'FINALIZED',
						calculationVersion: engine.version,
						...ruleFields(engine),
						...monthContextFields(engine),
						calculatedAt: now,
						calculatedByUserId: actorUserId,
						finalizedAt: now,
						finalizedByUserId: actorUserId
					}
				});
			}
			await tx.payrollPeriod.update({ where: { id: run.periodId }, data: { status: 'CLOSED' } });
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_RUN_FINALIZED,
				entityType: AuditEntity.PAYROLL_RUN,
				entityId: id,
				companyId: run.companyId,
				actorUserId,
				metadata: {
					periodId: run.periodId,
					employees: totals.employees,
					calculationVersion: engine.version,
					ruleVersion: engine.ruleSnapshot?.version ?? null,
					payrollMonth: engine.monthContext.payrollMonth,
					cycleNumber: engine.monthContext.totalCycles > 1 ? engine.monthContext.cycleNumber : null,
					monthlyAllocationMethod: engine.monthContext.allocationMethod,
					approvalMode: run.approvalModeSnapshot,
					approvalAttemptNo: run.approvalAttemptNo
				}
			});
			// Phase 13 §34 — one immutable payslip per finalized result, in THIS transaction (no PDF bytes
			// here: PDFs are rendered on demand from the stored snapshot)
			await createMissingPayslips(tx, id, actorUserId, 'FINALIZE');
		},
		{ timeout: 60_000, maxWait: 10_000 }
	);
	return getRun(id);
}

/** Phase 13 — the canonical approval snapshot of the STORED calculation (used by submit-approval). */
export async function storedApprovalCanonical(
	tx: Prisma.TransactionClient,
	run: Parameters<typeof canonicalRunFromStored>[0]
) {
	const rows = await tx.payrollEmployeeResult.findMany({
		where: { payrollRunId: run.id },
		include: STORED_RESULT_INCLUDE
	});
	return canonicalFromStored(canonicalRunFromStored(run), rows);
}

// ============================================================================================
// results
// ============================================================================================

const presentResult = (r: Prisma.PayrollEmployeeResultGetPayload<Record<string, never>>) => ({
	id: r.id,
	payrollRunId: r.payrollRunId,
	employee: {
		id: r.employeeId,
		employeeCode: r.employeeCodeSnapshot,
		name: r.employeeNameSnapshot
	},
	department: r.departmentIdSnapshot
		? { id: r.departmentIdSnapshot, nameLao: r.departmentNameSnapshot }
		: null,
	position: r.positionIdSnapshot
		? { id: r.positionIdSnapshot, nameLao: r.positionNameSnapshot }
		: null,
	branch: r.branchIdSnapshot ? { id: r.branchIdSnapshot, nameLao: r.branchNameSnapshot } : null,
	currencyCode: r.currencyCode,
	baseSalary: moneyOrNull(r.baseSalarySnapshot),
	totalEarnings: moneyString(r.totalEarnings),
	totalDeductions: moneyString(r.totalDeductions),
	netPay: moneyString(r.netPay),
	calculationStatus: r.calculationStatus,
	issues: (r.issuesJson as unknown[] | null) ?? []
});

export async function listResults(runId: number, query: ResultListQuery) {
	const run = await prisma.payrollRun.findUnique({ where: { id: runId }, select: { id: true } });
	if (!run) throw Errors.notFound('ບໍ່ພົບຮອບເງິນເດືອນ');
	const where: Prisma.PayrollEmployeeResultWhereInput = {
		payrollRunId: runId,
		...(query.calculationStatus ? { calculationStatus: query.calculationStatus } : {}),
		...(query.departmentId ? { departmentIdSnapshot: query.departmentId } : {}),
		...(query.search
			? {
					OR: [
						{ employeeCodeSnapshot: { contains: query.search } },
						{ employeeNameSnapshot: { contains: query.search } }
					]
				}
			: {})
	};
	const [rows, total] = await Promise.all([
		prisma.payrollEmployeeResult.findMany({
			where,
			orderBy: { employeeCodeSnapshot: 'asc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.payrollEmployeeResult.count({ where })
	]);
	return {
		items: rows.map(presentResult),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getResult(id: number) {
	const row = await prisma.payrollEmployeeResult.findUnique({
		where: { id },
		include: {
			items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
			segments: { orderBy: { segmentStart: 'asc' } },
			run: { include: RUN_INCLUDE },
			statutoryResult: true
		}
	});
	if (!row) throw Errors.notFound('ບໍ່ພົບຜົນການຄຳນວນເງິນເດືອນ');
	const adjustments = await listAdjustments(row.payrollRunId, row.employeeId);
	const order = {
		BASE_SALARY: 0,
		PRORATED_BASE_SALARY: 0,
		RECURRING: 1,
		PRORATED_RECURRING: 1,
		OVERTIME: 2,
		UNPAID_LEAVE: 3,
		ATTENDANCE_DEDUCTION: 3,
		LATE_DEDUCTION: 3,
		EARLY_LEAVE_DEDUCTION: 3,
		MANUAL: 4,
		PIT: 5,
		SOCIAL_SECURITY_EMPLOYEE: 5
	} as const;
	return {
		...presentResult(row),
		run: {
			id: row.run.id,
			status: row.run.status,
			currencyCode: row.run.currencyCode,
			calculatedAt: row.run.calculatedAt,
			period: row.run.period,
			company: row.run.company,
			needsRecalculation: row.run.status === 'DRAFT',
			cycleAllocation: {
				payrollMonth: row.run.payrollMonth,
				cycleNumber: row.run.cycleNumber,
				paymentsPerMonth: row.run.paymentsPerMonth,
				monthlyAllocationMethod: row.run.monthlyAllocationMethod
			}
		},
		calculationVersion: row.calculationVersion,
		ruleSnapshot: row.run.ruleSnapshotJson ?? null,
		// Phase 12A.1 - §23: monthly amount before cycle allocation, and the ratio actually applied
		monthlyBaseSalary: moneyOrNull(row.monthlyBaseSalarySnapshot),
		cycleAllocationFactor: row.cycleAllocationFactorSnapshot
			? row.cycleAllocationFactorSnapshot.toFixed(10)
			: null,
		segments: row.segments.map((sg) => ({
			id: sg.id,
			segmentStart: sg.segmentStart,
			segmentEnd: sg.segmentEnd,
			company: { id: sg.companyIdSnapshot, nameLao: sg.companyNameSnapshot },
			branch: sg.branchIdSnapshot
				? { id: sg.branchIdSnapshot, nameLao: sg.branchNameSnapshot }
				: null,
			baseSalary: moneyString(sg.baseSalarySnapshot),
			currencyCode: sg.currencyCode,
			prorationMethod: sg.prorationMethod,
			periodUnits: sg.periodUnits.toString(),
			payableUnits: sg.payableUnits.toString(),
			prorationFactor: sg.prorationFactor.toFixed(10),
			proratedBaseSalary: moneyString(sg.proratedBaseSalary),
			recurring: sg.recurringJson ?? []
		})),
		attendanceSummary: row.attendanceSummaryJson ?? null,
		leaveSummary: row.leaveSummaryJson ?? null,
		overtimeSummary: row.overtimeSummaryJson ?? null,
		// Phase 12B (§31, §44-47) - null when the company has not opted into statutory payroll
		employerContributionTotal: moneyOrNull(row.employerContributionTotal),
		totalEmployerCost: row.employerContributionTotal
			? moneyString(row.totalEarnings.plus(row.employerContributionTotal))
			: null,
		statutory: row.statutoryResult
			? {
					statutoryRuleSetId: row.statutoryResult.statutoryRuleSetId,
					ruleVersion: row.statutoryResult.ruleVersion,
					payrollMonth: row.statutoryResult.payrollMonth,
					pit: {
						taxableGross: moneyString(row.statutoryResult.pitTaxableGross),
						exemptIncome: moneyString(row.statutoryResult.pitExemptIncome),
						taxableBase: moneyString(row.statutoryResult.pitTaxableBase),
						liabilityMonthToDate: moneyString(row.statutoryResult.pitLiabilityMonthToDate),
						priorWithheld: moneyString(row.statutoryResult.pitPriorWithheld),
						currentCycle: moneyString(row.statutoryResult.pitCurrentCycle),
						breakdown: row.statutoryResult.pitBracketBreakdownJson ?? []
					},
					socialSecurity: {
						baseMonthToDate: moneyString(row.statutoryResult.socialSecurityBaseMonthToDate),
						employeeLiabilityMonthToDate: moneyString(
							row.statutoryResult.employeeSsoLiabilityMonthToDate
						),
						employeePrior: moneyString(row.statutoryResult.employeeSsoPrior),
						employeeCurrentCycle: moneyString(row.statutoryResult.employeeSsoCurrentCycle),
						employerLiabilityMonthToDate: moneyString(
							row.statutoryResult.employerSsoLiabilityMonthToDate
						),
						employerPrior: moneyString(row.statutoryResult.employerSsoPrior),
						employerCurrentCycle: moneyString(row.statutoryResult.employerSsoCurrentCycle)
					},
					otExemption: row.statutoryResult.otExemptionJson ?? [],
					ruleSnapshot: row.statutoryResult.ruleSnapshotJson
				}
			: null,
		items: [...row.items]
			.sort((a, b) => order[a.source] - order[b.source])
			.map((i) => ({
				id: i.id,
				code: i.code,
				nameLao: i.nameLao,
				nameEnglish: i.nameEnglish,
				type: i.type,
				source: i.source,
				amount: moneyString(i.amount),
				payComponentId: i.payComponentId,
				details: i.detailsJson ?? null
			})),
		manualAdjustments: adjustments.items
	};
}

// ============================================================================================
// manual adjustments (append-only)
// ============================================================================================

export async function listAdjustments(runId: number, employeeId: number) {
	const run = await prisma.payrollRun.findUnique({ where: { id: runId }, select: { id: true } });
	if (!run) throw Errors.notFound('ບໍ່ພົບຮອບເງິນເດືອນ');
	const rows = await prisma.payrollManualAdjustment.findMany({
		where: { payrollRunId: runId, employeeId },
		include: { createdBy: USER_BRIEF },
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
	});
	return {
		items: rows.map((a) => ({
			id: a.id,
			payrollRunId: a.payrollRunId,
			employeeId: a.employeeId,
			payComponentId: a.payComponentId,
			type: a.type,
			code: a.code,
			nameLao: a.nameLao,
			amount: moneyString(a.amount),
			reason: a.reason,
			createdBy: a.createdBy,
			createdAt: a.createdAt
		}))
	};
}

export async function addAdjustment(
	runId: number,
	employeeId: number,
	input: AdjustmentCreateInput,
	actorUserId: number
) {
	assertCodeNotReserved(input.code);
	const created = await prisma.$transaction(async (tx) => {
		const run = await loadEditableRun(tx, runId);
		// Phase 13 — no adjustment underneath approvers / on an approved payroll
		assertApprovalAllowsChange(run);
		// eligibility = the same historical-company / schedule-scope rules the calculation uses
		const eligible = await loadEligibleEmployees(tx, run, run.period, employeeId);
		const employee = eligible.employees[0];
		if (!employee) {
			throw Errors.badRequest('EMPLOYEE_NOT_IN_RUN', 'ພະນັກງານຄົນນີ້ບໍ່ຢູ່ໃນຮອບເງິນເດືອນນີ້');
		}
		if (input.payComponentId) {
			const component = await tx.payComponent.findUnique({ where: { id: input.payComponentId } });
			if (!component || component.companyId !== run.companyId) {
				throw Errors.badRequest('INVALID_PAY_COMPONENT', 'ບໍ່ພົບລາຍການລາຍຮັບ/ລາຍຈ່າຍຂອງບໍລິສັດນີ້');
			}
			if (component.status !== 'ACTIVE') {
				throw Errors.badRequest('PAY_COMPONENT_INACTIVE', 'ລາຍການນີ້ປິດການນຳໃຊ້ແລ້ວ');
			}
			if (component.type !== input.type) {
				throw Errors.badRequest(
					'PAY_COMPONENT_TYPE_MISMATCH',
					'ປະເພດລາຍການບໍ່ກົງກັບລາຍການທີ່ເລືອກ'
				);
			}
		}
		const adjustment = await tx.payrollManualAdjustment.create({
			data: {
				payrollRunId: runId,
				employeeId,
				payComponentId: input.payComponentId ?? null,
				type: input.type,
				code: input.code,
				nameLao: input.nameLao,
				amount: input.amount,
				reason: input.reason,
				createdByUserId: actorUserId
			}
		});
		// results are now stale: the run goes back to DRAFT so that recalculation is an explicit step
		if (run.status !== 'DRAFT') {
			await tx.payrollRun.update({ where: { id: runId }, data: { status: 'DRAFT' } });
		}
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_MANUAL_ADJUSTMENT_ADDED,
			entityType: AuditEntity.PAYROLL_ADJUSTMENT,
			entityId: adjustment.id,
			companyId: run.companyId,
			employeeId,
			actorUserId,
			// type only: the amount and the free-text reason stay in the payroll tables
			changes: { amount: { changed: true } },
			metadata: { payrollRunId: runId, adjustmentId: adjustment.id, type: input.type }
		});
		return adjustment;
	});
	const list = await listAdjustments(runId, employeeId);
	return {
		adjustment: list.items.find((a) => a.id === created.id)!,
		run: await getRun(runId)
	};
}
