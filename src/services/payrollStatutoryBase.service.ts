import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { ZERO, calc, roundMoney, sumMoney } from '../lib/money.js';
import { parsePayrollMonth } from '../lib/payrollCycles.js';
import {
	issue,
	type PlanIssue,
	type PlanItem,
	type PlanResult,
	type RunFacts
} from './payrollCalculation.js';
import type { MonthAllocationContext } from './payrollMonthContext.service.js';
import {
	companyHasStatutoryRules,
	resolveStatutoryRuleForMonth,
	snapshotOf as ruleSnapshotOf,
	type StatutoryRuleSnapshot
} from './payrollStatutoryRule.service.js';
import { calculateProgressivePit, type PitBracketInput } from './payrollPit.service.js';
import { calculateSocialSecurity } from './payrollSocialSecurity.service.js';

/**
 * PHASE 12B — THE ONE STATUTORY ORCHESTRATOR (§14, §37). Runs AFTER the v1/v2 engine has built its
 * normal `PlanResult[]` (base salary, recurring, attendance/leave deductions, OT already computed and
 * itemized) — this file adds PIT / Social Security on top, never re-derives payroll:
 *
 *   MONTHLY AMOUNT -> CYCLE ALLOCATION -> segment proration -> attendance/leave -> OT -> STATUTORY -> result
 *                                                                                    ↑ this file
 *
 * A company that has NEVER created a PayrollStatutoryRuleSet is completely unaffected (§35) - old v1-v4
 * behaviour is preserved byte for byte. Once a company has (any status), `applied` is true and every
 * otherwise-READY employee either gets a full PIT/SSO breakdown or a specific BLOCK issue - never a
 * silent skip.
 */
type Db = Prisma.TransactionClient | typeof prisma;

export interface StatutoryEngineResult {
	applied: boolean;
	results: PlanResult[];
}

interface OtRequestDetail {
	requestId: number;
	workDate: string;
	eligibleMinutes: number;
	monthlyBaseSalary: string;
	amount: string;
}

const SALARY_REDUCTION_SOURCES = new Set([
	'ATTENDANCE_DEDUCTION',
	'UNPAID_LEAVE',
	'LATE_DEDUCTION',
	'EARLY_LEAVE_DEDUCTION'
]);

function isOtExempt(
	monthlyBaseSalary: Prisma.Decimal,
	rule: {
		overtimePitTreatmentEnabled: boolean;
		overtimePitExemptionBaseSalaryThreshold: Prisma.Decimal | null;
		overtimePitThresholdComparison: string | null;
	}
): boolean {
	if (!rule.overtimePitTreatmentEnabled || rule.overtimePitExemptionBaseSalaryThreshold === null) {
		return false;
	}
	const threshold = rule.overtimePitExemptionBaseSalaryThreshold;
	const comparison = rule.overtimePitThresholdComparison ?? 'LESS_THAN';
	if (comparison === 'LESS_THAN') return monthlyBaseSalary.lessThan(threshold);
	return false;
}

/** This cycle's OWN (not month-to-date) gross figures, built purely from the already-computed items. */
function buildCycleBases(
	items: readonly PlanItem[],
	componentTreatment: Map<number, { pitTreatment: string; socialSecurityTreatment: string }>,
	rule: {
		overtimePitTreatmentEnabled: boolean;
		overtimePitExemptionBaseSalaryThreshold: Prisma.Decimal | null;
		overtimePitThresholdComparison: string | null;
	},
	pitApplicable: boolean,
	socialSecurityApplicable: boolean
): {
	pitTaxableGross: Prisma.Decimal;
	pitExemptIncome: Prisma.Decimal;
	ssoBase: Prisma.Decimal;
	otExemption: {
		requestId: number;
		workDate: string;
		monthlyBaseSalary: string;
		exempt: boolean;
	}[];
	treatmentRequired: boolean;
} {
	let taxable = calc(0);
	let exempt = calc(0);
	let sso = calc(0);
	let reductions = calc(0);
	const otExemption: {
		requestId: number;
		workDate: string;
		monthlyBaseSalary: string;
		exempt: boolean;
	}[] = [];
	let treatmentRequired = false;

	for (const item of items) {
		if (item.source === 'BASE_SALARY' || item.source === 'PRORATED_BASE_SALARY') {
			taxable = taxable.plus(item.amount);
			sso = sso.plus(item.amount);
		} else if (item.source === 'RECURRING' || item.source === 'PRORATED_RECURRING') {
			const t = item.payComponentId ? componentTreatment.get(item.payComponentId) : undefined;
			if (t?.pitTreatment === 'EXEMPT') exempt = exempt.plus(item.amount);
			else taxable = taxable.plus(item.amount);
			if (t?.socialSecurityTreatment !== 'EXCLUDED') sso = sso.plus(item.amount);
		} else if (item.source === 'MANUAL' && item.type === 'EARNING') {
			if (!item.payComponentId) {
				treatmentRequired = true;
				continue;
			}
			const t = componentTreatment.get(item.payComponentId);
			if (t?.pitTreatment === 'EXEMPT') exempt = exempt.plus(item.amount);
			else taxable = taxable.plus(item.amount);
			if (t?.socialSecurityTreatment !== 'EXCLUDED') sso = sso.plus(item.amount);
		} else if (item.source === 'OVERTIME') {
			const requests = (item.details as { requests?: OtRequestDetail[] } | null | undefined)
				?.requests;
			if (requests && requests.length > 0) {
				for (const r of requests) {
					const monthly = new Prisma.Decimal(r.monthlyBaseSalary);
					const exemptThis = isOtExempt(monthly, rule);
					otExemption.push({
						requestId: r.requestId,
						workDate: r.workDate,
						monthlyBaseSalary: r.monthlyBaseSalary,
						exempt: exemptThis
					});
					const amt = new Prisma.Decimal(r.amount);
					if (exemptThis) exempt = exempt.plus(amt);
					else taxable = taxable.plus(amt);
					sso = sso.plus(amt);
				}
			} else {
				// no per-request detail available (should not happen for a real OT line) - taxable by default
				taxable = taxable.plus(item.amount);
				sso = sso.plus(item.amount);
			}
		} else if (SALARY_REDUCTION_SOURCES.has(item.source)) {
			reductions = reductions.plus(item.amount);
		}
		// MANUAL DEDUCTION and anything else (PIT / SOCIAL_SECURITY_EMPLOYEE from an earlier pass) is
		// ignored here - post-tax by default (§13's last line) / not yet computed.
	}
	const clampedTaxable = taxable.minus(reductions);
	const clampedSso = sso.minus(reductions);
	return {
		pitTaxableGross: new Prisma.Decimal(
			(pitApplicable ? (clampedTaxable.isNegative() ? calc(0) : clampedTaxable) : calc(0)).toFixed(
				2
			)
		),
		pitExemptIncome: new Prisma.Decimal((pitApplicable ? exempt : calc(0)).toFixed(2)),
		ssoBase: new Prisma.Decimal(
			(socialSecurityApplicable
				? clampedSso.isNegative()
					? calc(0)
					: clampedSso
				: calc(0)
			).toFixed(2)
		),
		otExemption,
		treatmentRequired
	};
}

interface PriorStatutoryRow {
	pitTaxableGross: Prisma.Decimal;
	pitCurrentCycle: Prisma.Decimal;
	employeeSsoCurrentCycle: Prisma.Decimal;
	employerSsoCurrentCycle: Prisma.Decimal;
	socialSecurityBaseMonthToDate: Prisma.Decimal;
}

/** Prior FINALIZED cycles' statutory results of the SAME company + schedule + payroll month, per employee. */
async function loadPriorStatutory(
	db: Db,
	companyId: number,
	payrollScheduleId: number | null | undefined,
	payrollMonth: string,
	cycleNumber: number,
	employeeIds: number[]
): Promise<Map<number, PriorStatutoryRow[]>> {
	const map = new Map<number, PriorStatutoryRow[]>();
	if (cycleNumber <= 1 || !payrollScheduleId || employeeIds.length === 0) return map;
	const runs = await db.payrollRun.findMany({
		where: {
			companyId,
			payrollScheduleId,
			payrollMonth,
			cycleNumber: { lt: cycleNumber },
			status: 'FINALIZED'
		},
		orderBy: { cycleNumber: 'asc' },
		include: {
			results: {
				where: { employeeId: { in: employeeIds } },
				include: { statutoryResult: true }
			}
		}
	});
	for (const run of runs) {
		for (const res of run.results) {
			if (!res.statutoryResult) continue;
			const arr = map.get(res.employeeId) ?? [];
			arr.push(res.statutoryResult);
			map.set(res.employeeId, arr);
		}
	}
	return map;
}

export async function applyStatutoryCalculation(
	db: Db,
	run: RunFacts,
	monthContext: MonthAllocationContext,
	results: PlanResult[]
): Promise<StatutoryEngineResult> {
	const hasStatutory = await companyHasStatutoryRules(db, run.companyId);
	if (!hasStatutory || !monthContext.payrollMonth) return { applied: false, results };

	const { year, month } = parsePayrollMonth(monthContext.payrollMonth);
	const monthStart = new Date(Date.UTC(year, month - 1, 1));
	const monthEnd = new Date(Date.UTC(year, month, 0));

	const blockAll = (
		code:
			| 'STATUTORY_CURRENCY_CONVERSION_REQUIRED'
			| 'MISSING_STATUTORY_RULE'
			| 'STATUTORY_TRANSITION_REQUIRES_CONFIGURATION'
	) =>
		results.map((r) =>
			r.calculationStatus === 'READY'
				? { ...r, calculationStatus: 'BLOCKED' as const, issues: [...r.issues, issue(code)] }
				: r
		);

	if (run.currencyCode !== 'LAK') {
		return { applied: true, results: blockAll('STATUTORY_CURRENCY_CONVERSION_REQUIRED') };
	}

	const resolution = await resolveStatutoryRuleForMonth(
		db,
		run.companyId,
		monthContext.payrollMonth,
		monthStart,
		monthEnd
	);
	if (resolution.outcome === 'MISSING') {
		return { applied: true, results: blockAll('MISSING_STATUTORY_RULE') };
	}
	if (resolution.outcome === 'TRANSITION_AMBIGUOUS') {
		return { applied: true, results: blockAll('STATUTORY_TRANSITION_REQUIRES_CONFIGURATION') };
	}
	const rule = resolution.rule;
	const brackets: PitBracketInput[] = rule.pitBrackets.map((b) => ({
		order: b.order,
		lowerBound: b.lowerBound,
		upperBound: b.upperBound,
		rate: b.rate
	}));
	const snapshot: StatutoryRuleSnapshot = ruleSnapshotOf(rule);

	const readyIds = results.filter((r) => r.calculationStatus === 'READY').map((r) => r.employeeId);
	if (readyIds.length === 0) return { applied: true, results };

	const [profiles, componentRows, priorMap] = await Promise.all([
		db.employeeStatutoryProfile.findMany({ where: { employeeId: { in: readyIds } } }),
		db.payComponent.findMany({
			where: {
				id: {
					in: [
						...new Set(
							results.flatMap((r) =>
								r.items.map((i) => i.payComponentId).filter((v): v is number => v !== null)
							)
						)
					]
				}
			},
			select: { id: true, pitTreatment: true, socialSecurityTreatment: true }
		}),
		loadPriorStatutory(
			db,
			run.companyId,
			run.payrollScheduleId,
			monthContext.payrollMonth,
			monthContext.cycleNumber,
			readyIds
		)
	]);
	const profileOf = new Map(profiles.map((p) => [p.employeeId, p]));
	const componentTreatment = new Map(
		componentRows.map((c) => [
			c.id,
			{ pitTreatment: c.pitTreatment, socialSecurityTreatment: c.socialSecurityTreatment }
		])
	);

	const updated = results.map((r): PlanResult => {
		if (r.calculationStatus !== 'READY') return r;
		const profile = profileOf.get(r.employeeId);
		// Phase 12B.1 - once a company has opted into statutory payroll (any rule set exists, checked
		// above via `hasStatutory`), an employee who participates in payroll MUST have an explicit
		// EmployeeStatutoryProfile row. A missing row is NEVER treated as "applicable = true" (nor
		// false) - that would be a silent guess about someone's tax/SSO status. It BLOCKS instead.
		if (!profile) {
			return {
				...r,
				calculationStatus: 'BLOCKED',
				issues: [...r.issues, issue('MISSING_EMPLOYEE_STATUTORY_PROFILE')]
			};
		}
		const pitApplicable = profile.pitApplicable;
		let socialSecurityApplicable = profile.socialSecurityApplicable;
		if (socialSecurityApplicable) {
			if (profile.socialSecurityEffectiveFrom && monthEnd < profile.socialSecurityEffectiveFrom) {
				socialSecurityApplicable = false;
			}
			if (profile.socialSecurityEffectiveTo && monthStart > profile.socialSecurityEffectiveTo) {
				socialSecurityApplicable = false;
			}
		}
		if (!pitApplicable && !socialSecurityApplicable) return r;

		const base = buildCycleBases(
			r.items,
			componentTreatment,
			rule,
			rule.pitEnabled && pitApplicable,
			rule.socialSecurityEnabled && socialSecurityApplicable
		);
		if (base.treatmentRequired) {
			const issues: PlanIssue[] = [...r.issues, issue('STATUTORY_TREATMENT_REQUIRED')];
			return { ...r, calculationStatus: 'BLOCKED', issues };
		}

		const priors = priorMap.get(r.employeeId) ?? [];
		const items: PlanItem[] = [...r.items];
		let totalEarnings = r.totalEarnings;
		let totalDeductions = r.totalDeductions;

		// ---------- PIT (§22-26, §28) ----------
		let pitTaxableBase = ZERO;
		let pitLiabilityMonthToDate = ZERO;
		let pitPriorWithheld = ZERO;
		let pitCurrentCycle = ZERO;
		let pitBracketBreakdownJson: unknown = null;
		if (rule.pitEnabled && pitApplicable) {
			const priorGrossSum = sumMoney(priors.map((p) => p.pitTaxableGross));
			pitPriorWithheld = sumMoney(priors.map((p) => p.pitCurrentCycle));
			const mtdGross = priorGrossSum.plus(base.pitTaxableGross);
			const employeeSsoDeductible =
				rule.socialSecurityRule?.employeeContributionPitDeductible ?? false;
			// computed AFTER the SSO block below sets `employeeSsoLiabilityMonthToDate` — see there.
			pitTaxableBase = mtdGross; // placeholder; SSO-deductible portion subtracted below
			void employeeSsoDeductible;
		}

		// ---------- Social Security (§19-21, §27-28) ----------
		let socialSecurityBaseMonthToDate = ZERO;
		let employeeSsoLiabilityMonthToDate = ZERO;
		let employeeSsoPrior = ZERO;
		let employeeSsoCurrentCycle = ZERO;
		let employerSsoLiabilityMonthToDate = ZERO;
		let employerSsoPrior = ZERO;
		let employerSsoCurrentCycle = ZERO;
		if (rule.socialSecurityEnabled && socialSecurityApplicable && rule.socialSecurityRule) {
			const priorRawBase =
				priors.length > 0 ? priors[priors.length - 1]!.socialSecurityBaseMonthToDate : ZERO;
			socialSecurityBaseMonthToDate = priorRawBase.plus(base.ssoBase);
			const sso = calculateSocialSecurity(socialSecurityBaseMonthToDate, rule.socialSecurityRule);
			employeeSsoLiabilityMonthToDate = sso.employeeContribution;
			employerSsoLiabilityMonthToDate = sso.employerContribution;
			employeeSsoPrior = sumMoney(priors.map((p) => p.employeeSsoCurrentCycle));
			employerSsoPrior = sumMoney(priors.map((p) => p.employerSsoCurrentCycle));
			employeeSsoCurrentCycle = employeeSsoLiabilityMonthToDate.minus(employeeSsoPrior);
			employerSsoCurrentCycle = employerSsoLiabilityMonthToDate.minus(employerSsoPrior);
		}

		// ---------- finish PIT now that the SSO deduction (if configured) is known ----------
		if (rule.pitEnabled && pitApplicable) {
			const deductible = rule.socialSecurityRule?.employeeContributionPitDeductible ?? false;
			const afterSso =
				deductible && rule.socialSecurityEnabled
					? pitTaxableBase.minus(employeeSsoLiabilityMonthToDate)
					: pitTaxableBase;
			const pit = calculateProgressivePit(afterSso.isNegative() ? ZERO : afterSso, brackets);
			pitTaxableBase = pit.taxableBase;
			pitLiabilityMonthToDate = pit.totalPit;
			pitCurrentCycle = pitLiabilityMonthToDate.minus(pitPriorWithheld);
			pitBracketBreakdownJson = pit.breakdown;
		}

		// ---------- items (§28, §31): DEDUCTION when a positive liability, EARNING when a CREDIT ----------
		if (!pitCurrentCycle.isZero()) {
			const amt = roundMoney(pitCurrentCycle.abs());
			if (amt.greaterThan(0)) {
				items.push({
					code: 'PIT',
					nameLao: pitCurrentCycle.isNegative() ? 'ພາສີເງິນໄດ້ (ຄືນ)' : 'ພາສີເງິນໄດ້',
					nameEnglish: pitCurrentCycle.isNegative() ? 'PIT (credit)' : 'PIT',
					type: pitCurrentCycle.isNegative() ? 'EARNING' : 'DEDUCTION',
					source: 'PIT',
					amount: amt,
					payComponentId: null,
					details: {
						payrollMonth: monthContext.payrollMonth,
						pitTaxableBase: pitTaxableBase.toFixed(2),
						pitLiabilityMonthToDate: pitLiabilityMonthToDate.toFixed(2),
						pitPriorWithheld: pitPriorWithheld.toFixed(2),
						pitCurrentCycle: pitCurrentCycle.toFixed(2),
						breakdown: pitBracketBreakdownJson
					}
				});
				if (pitCurrentCycle.isNegative()) totalEarnings = totalEarnings.plus(amt);
				else totalDeductions = totalDeductions.plus(amt);
			}
		}
		if (!employeeSsoCurrentCycle.isZero()) {
			const amt = roundMoney(employeeSsoCurrentCycle.abs());
			if (amt.greaterThan(0)) {
				items.push({
					code: 'SOCIAL_SECURITY_EMPLOYEE',
					nameLao: employeeSsoCurrentCycle.isNegative()
						? 'ປະກັນສັງຄົມ (ຄືນ)'
						: 'ປະກັນສັງຄົມ (ພະນັກງານ)',
					nameEnglish: employeeSsoCurrentCycle.isNegative()
						? 'Social Security (credit)'
						: 'Social Security (Employee)',
					type: employeeSsoCurrentCycle.isNegative() ? 'EARNING' : 'DEDUCTION',
					source: 'SOCIAL_SECURITY_EMPLOYEE',
					amount: amt,
					payComponentId: null,
					details: {
						payrollMonth: monthContext.payrollMonth,
						socialSecurityBaseMonthToDate: socialSecurityBaseMonthToDate.toFixed(2),
						employeeSsoLiabilityMonthToDate: employeeSsoLiabilityMonthToDate.toFixed(2),
						employeeSsoPrior: employeeSsoPrior.toFixed(2),
						employeeSsoCurrentCycle: employeeSsoCurrentCycle.toFixed(2)
					}
				});
				if (employeeSsoCurrentCycle.isNegative()) totalEarnings = totalEarnings.plus(amt);
				else totalDeductions = totalDeductions.plus(amt);
			}
		}

		const netPay = totalEarnings.minus(totalDeductions);
		const issues: PlanIssue[] =
			totalDeductions.greaterThan(totalEarnings) &&
			!r.issues.some((i) => i.code === 'NEGATIVE_NET_PAY')
				? [...r.issues, issue('NEGATIVE_NET_PAY')]
				: r.issues;

		return {
			...r,
			items,
			totalEarnings,
			totalDeductions,
			netPay,
			issues,
			calculationStatus: issues.length > 0 ? 'BLOCKED' : 'READY',
			employerContributionTotal: employerSsoCurrentCycle,
			statutory: {
				statutoryRuleSetId: rule.id,
				ruleVersion: rule.version,
				payrollMonth: monthContext.payrollMonth!,
				pitTaxableGross: base.pitTaxableGross,
				pitExemptIncome: base.pitExemptIncome,
				employeeSocialSecurity: employeeSsoCurrentCycle,
				employerSocialSecurity: employerSsoCurrentCycle,
				pitTaxableBase,
				pitLiabilityMonthToDate,
				pitPriorWithheld,
				pitCurrentCycle,
				socialSecurityBaseMonthToDate,
				employeeSsoLiabilityMonthToDate,
				employeeSsoPrior,
				employeeSsoCurrentCycle,
				employerSsoLiabilityMonthToDate,
				employerSsoPrior,
				employerSsoCurrentCycle,
				ruleSnapshot: snapshot,
				pitBracketBreakdown: pitBracketBreakdownJson,
				otExemption: base.otExemption
			}
		};
	});

	return { applied: true, results: updated };
}
