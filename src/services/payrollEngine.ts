import type { Prisma } from '@prisma/client';
import type { prisma } from '../config/prisma.js';
import {
	CALCULATION_VERSION as LEGACY_VERSION,
	buildPayrollPlanV1,
	type PeriodFacts,
	type RunFacts
} from './payrollCalculation.js';
import { buildPayrollPlanV2, type EnginePlan } from './payrollCalculationV2.js';
import { companyHasRules } from './payrollRules.service.js';
import {
	resolvePayrollMonthContext,
	type MonthAllocationContext
} from './payrollMonthContext.service.js';
import { applyStatutoryCalculation } from './payrollStatutoryBase.service.js';

/**
 * Picks the calculation engine for a run, and — Phase 12A.1 — resolves the payroll-month / cycle
 * allocation context EVERY run now goes through first (§13's calculation order: MONTHLY AMOUNT ->
 * CYCLE ALLOCATION -> segment proration -> attendance/leave -> OT -> result), regardless of which
 * money formula runs underneath:
 *
 *  - A company that has configured at least one PayrollRuleSet uses the Phase 12A engine (proration,
 *    deductions, OT). If none of its versions is effective on the period end date, every employee is
 *    BLOCKED with MISSING_PAYROLL_RULE — never silently paid.
 *  - A company that has NEVER configured a rule keeps the Phase 11 formula (base + recurring + manual,
 *    partial periods blocked) — but its base salary / recurring amounts are still cycle-allocated first.
 *
 * calculationVersion is bumped ONLY when cycle allocation actually applies (a TWO/month schedule cycle —
 * allocated or still BLOCKED pending configuration). A ONE/month schedule or a manual period has exactly
 * one cycle: `scaledAmount` is then a no-op and the run keeps stamping the ORIGINAL version (1 legacy /
 * 2 rule-based) — Phase 11 / 11.1 / 12A payroll is therefore bit-for-bit unchanged, and every
 * pre-existing test / finalized run stays valid. A FINALIZED run's stored version is never rewritten (it
 * is simply never recalculated again).
 *
 * Phase 12A.1 introduced version 3 (cycle allocation). Phase 12A.2 corrects the OT rate basis (it must
 * branch from the MONTHLY salary, never the cycle-allocated one — see payrollOvertimeRate.service.ts)
 * and every FRESH multi-cycle calculation now stamps version 4 instead — 3 is a frozen, historical
 * version number no new calculation produces again; a FINALIZED v3 run is never rewritten or
 * recalculated, but a non-finalized v3 run recalculates under the corrected v4 semantics the next time
 * someone presses "recalculate". ONE/month runs are unaffected either way: for `totalCycles <= 1` the
 * cycle-allocated amount already equals the monthly amount, so the OT rate basis fix changes nothing
 * there and the version stays at its original 1/2.
 *
 * Phase 12B adds Lao PIT + Social Security (`payrollStatutoryBase.service.ts`'s ONE statutory
 * orchestrator, run AFTER v1/v2 have built their normal plan). A company that has NEVER created a
 * PayrollStatutoryRuleSet is completely unaffected — v1-v4 behaviour is preserved byte for byte (§35).
 * Once a company HAS (any status, mirroring `companyHasRules`), every fresh calculation stamps version
 * 5 instead, regardless of the underlying engine or cycle count — exactly like the 3→4 bump, this
 * overrides whatever version v1/v2/the cycle-allocation step chose. FINALIZED v1-v4 runs are never
 * rewritten (the generic FINALIZED-is-immutable guard, not a version-specific one, protects them).
 */
export const CALCULATION_VERSION_V4 = 4;
export const CALCULATION_VERSION_V5 = 5;
type Db = Prisma.TransactionClient | typeof prisma;

async function loadScheduleForAllocation(db: Db, payrollScheduleId: number | null | undefined) {
	if (!payrollScheduleId) return null;
	return db.payrollSchedule.findUnique({
		where: { id: payrollScheduleId },
		select: { paymentsPerMonth: true, splitDay: true, monthlyAllocationMethod: true }
	});
}

export async function buildPayrollPlan(
	db: Db,
	run: RunFacts,
	period: PeriodFacts
): Promise<EnginePlan & { monthContext: MonthAllocationContext }> {
	const scheduleRow = await loadScheduleForAllocation(db, run.payrollScheduleId);
	const monthContext = resolvePayrollMonthContext({
		schedule: scheduleRow,
		period: { payrollMonth: period.payrollMonth ?? null, cycleNumber: period.cycleNumber ?? null }
	});
	const base = (await companyHasRules(db, run.companyId))
		? await buildPayrollPlanV2(db, run, period, monthContext)
		: {
				version: LEGACY_VERSION,
				ruleSetId: null,
				ruleSnapshot: null,
				results: await buildPayrollPlanV1(db, run, period, monthContext)
			};
	const cycleVersion = monthContext.totalCycles > 1 ? CALCULATION_VERSION_V4 : base.version;
	const statutory = await applyStatutoryCalculation(db, run, monthContext, base.results);
	const version = statutory.applied ? CALCULATION_VERSION_V5 : cycleVersion;
	// buildPayrollPlanV1 / V2 each stamp their own per-employee PlanResult.calculationVersion with their
	// OWN base version (1 / 2) — they have no notion of cycle allocation OR statutory calculation. The
	// run-level bump (4 for multi-cycle, 5 for statutory) must be propagated onto every result row too,
	// or the two disagree (the bug this comment prevents: a multi-cycle run correctly stamped 4 at the
	// run level while every employee snapshot still read 2).
	const results =
		version === base.version
			? statutory.results
			: statutory.results.map((r) => ({ ...r, calculationVersion: version }));
	return { ...base, version, results, monthContext };
}
