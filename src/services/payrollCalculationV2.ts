import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { serverNow } from '../lib/clock.js';
import { formatDateOnly } from '../lib/dates.js';
import { ZERO, calc, moneyString, roundMoney, sumMoney } from '../lib/money.js';
import { loadHistoryFor, placementAt } from './employeeAssignmentResolver.js';
import {
	issue,
	loadEligibleEmployees,
	t,
	type PeriodFacts,
	type PlanIssue,
	type PlanItem,
	type PlanResult,
	type PlanSegment,
	type RunFacts
} from './payrollCalculation.js';
import {
	computeAttendanceDeductions,
	dayKey,
	resolveDailyPayrollContexts,
	type DayContext
} from './payrollAttendance.service.js';
import { computeOvertimeCompensation, type OvertimeInput } from './payrollOvertime.service.js';
import {
	eachDay,
	makeCalendar,
	planSlices,
	prorate,
	prorateSlices,
	unitRate,
	unitsIn,
	type CompRow,
	type ProratedSegment,
	type RecurringRow,
	type Slice
} from './payrollProration.service.js';
import {
	resolveRuleAt,
	ruleConfigurationProblem,
	snapshotOf,
	type RuleSnapshot
} from './payrollRules.service.js';
import {
	cycleAllocationFactors,
	rowSpansOtherCycle,
	scaledAmount,
	type MonthAllocationContext
} from './payrollMonthContext.service.js';
import { monthlyCompensationAt } from './payrollOvertimeRate.service.js';

/**
 * PAYROLL CALCULATION ENGINE v2 — Phase 12A (calculationVersion = 2).
 *
 *   per employee:  covered days (employment ∩ period)  →  company / branch / salary / recurring segments
 *                  →  proration (CALENDAR_DAYS | WORKING_DAYS from the effective PayrollRuleSet)
 *                  →  day-level attendance / leave deductions  →  OT compensation  →  manual adjustments
 *
 * This file only ORCHESTRATES; the formulas live in payrollProration / payrollAttendance /
 * payrollOvertime and are documented there. One rule set applies to a whole run: the version effective
 * on the period end date (the Phase 11 snapshot date). Still BLOCKED (never guessed): missing salary,
 * missing / invalid payroll rule, incomplete OT rule, missing schedule for WORKING_DAYS, currency
 * mismatch, negative net pay. Not blocked any more: partial period, salary / component change,
 * company or branch change inside the period — they are segmented and calculated.
 * Deliberately absent: tax, social security, payslips, approval workflow.
 */
export const CALCULATION_VERSION_V2 = 2;
type Db = Prisma.TransactionClient | typeof prisma;

export interface EnginePlan {
	version: number;
	ruleSetId: number | null;
	ruleSnapshot: RuleSnapshot | null;
	results: PlanResult[];
}

const BASE_NAME: [string, string] = ['ເງິນເດືອນພື້ນຖານ', 'Base Salary'];
const PRORATED_BASE_NAME: [string, string] = [
	'ເງິນເດືອນພື້ນຖານ (ຄິດສັດສ່ວນ)',
	'Base Salary (prorated)'
];

/** one (amount, payable units) pair per segment that carries a base salary / recurring component */
interface Part {
	amount: Prisma.Decimal;
	payable: number;
}

/**
 * Segments that share the SAME amount are merged before rounding (amount × Σ payable ÷ period, one
 * HALF_UP rounding), so cutting a full period into pieces for an unrelated reason never drifts by a
 * cent. Different amounts are prorated separately and added.
 */
function groupedAmount(parts: readonly Part[], periodUnits: number): Prisma.Decimal {
	const byValue = new Map<string, number>();
	for (const p of parts)
		byValue.set(p.amount.toFixed(2), (byValue.get(p.amount.toFixed(2)) ?? 0) + p.payable);
	return sumMoney(
		[...byValue].map(([value, payable]) => prorate(new Prisma.Decimal(value), payable, periodUnits))
	);
}

/** true when one unchanged amount is payable for the whole period (nothing is actually prorated) */
function coversWholePeriod(parts: readonly Part[], periodUnits: number): boolean {
	return (
		new Set(parts.map((p) => p.amount.toFixed(2))).size === 1 &&
		parts.reduce((n, p) => n + p.payable, 0) === periodUnits
	);
}

const nameIn = (list: { id: number; nameLao: string }[], id: number | null) =>
	id ? (list.find((x) => x.id === id)?.nameLao ?? null) : null;

export async function buildPayrollPlanV2(
	db: Db,
	run: RunFacts,
	period: PeriodFacts,
	monthContext: MonthAllocationContext
): Promise<EnginePlan> {
	const { startDate: start, endDate: end } = period;
	const ruleRow = await resolveRuleAt(db, run.companyId, end);
	const rule = ruleRow ? snapshotOf(ruleRow) : null;
	const ruleProblem = rule ? ruleConfigurationProblem(rule) : null;
	const { employees, schedule } = await loadEligibleEmployees(db, run, period);
	const plan = (results: PlanResult[]): EnginePlan => ({
		version: CALCULATION_VERSION_V2,
		ruleSetId: rule?.ruleSetId ?? null,
		ruleSnapshot: rule,
		results
	});
	if (employees.length === 0) return plan([]);

	const ids = employees.map((e) => e.id);
	const history = await loadHistoryFor(db, ids);
	const snapshotOf_ = new Map(
		employees.map((e) => {
			const snapDate = e.endDate && t(e.endDate) < t(end) ? e.endDate : end;
			return [e.id, placementAt(history.get(e.id) ?? [], e, snapDate)] as const;
		})
	);
	const placements = [...snapshotOf_.values()];
	const idsOf = (pick: (p: (typeof placements)[number]) => number | null) => [
		...new Set(placements.map(pick).filter((v): v is number => v !== null))
	];
	const allBranchIds = [
		...new Set([
			...idsOf((p) => p.branchId),
			...employees.flatMap((e) =>
				e.segments.map((s) => s.branchId).filter((b): b is number => b !== null)
			)
		])
	];
	const overlapsPeriod = {
		effectiveFrom: { lte: end },
		OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }]
	};
	const [
		company,
		branchNames,
		departmentNames,
		positionNames,
		rawComps,
		rawRecurring,
		adjustments,
		schedules
	] = await Promise.all([
		db.company.findUnique({ where: { id: run.companyId }, select: { id: true, nameLao: true } }),
		db.branch.findMany({
			where: { id: { in: allBranchIds } },
			select: { id: true, nameLao: true }
		}),
		db.department.findMany({
			where: { id: { in: idsOf((p) => p.departmentId) } },
			select: { id: true, nameLao: true }
		}),
		db.position.findMany({
			where: { id: { in: idsOf((p) => p.positionId) } },
			select: { id: true, nameLao: true }
		}),
		db.employeeCompensation.findMany({
			where: { employeeId: { in: ids }, ...overlapsPeriod },
			orderBy: { effectiveFrom: 'asc' }
		}),
		db.employeeRecurringPayComponent.findMany({
			where: { employeeId: { in: ids }, ...overlapsPeriod },
			include: {
				payComponent: {
					select: { id: true, code: true, nameLao: true, nameEnglish: true, type: true }
				}
			},
			orderBy: { effectiveFrom: 'asc' }
		}),
		db.payrollManualAdjustment.findMany({
			where: { payrollRunId: run.id, employeeId: { in: ids } },
			orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
		}),
		rule?.prorationMethod === 'WORKING_DAYS'
			? db.employeeScheduleAssignment.findMany({
					where: { employeeId: { in: ids }, effectiveFrom: { lte: end } },
					include: { shift: { include: { workDays: true } } }
				})
			: Promise.resolve([])
	]);
	const companyName = company?.nameLao ?? '';

	// ---------- employee working-day calendars (WORKING_DAYS proration AND/OR PERIOD_UNITS cycle
	// allocation both need the same per-employee calendar - built ONCE, ahead of both) ----------
	const calendarByEmployee = new Map<number, ReturnType<typeof makeCalendar>>();
	if (rule?.prorationMethod === 'WORKING_DAYS') {
		for (const emp of employees) {
			calendarByEmployee.set(
				emp.id,
				makeCalendar(
					schedules
						.filter((a) => a.employeeId === emp.id)
						.map((a) => ({
							effectiveFrom: a.effectiveFrom,
							effectiveTo: a.effectiveTo,
							workingDays: new Set(
								a.shift.workDays.filter((w) => w.isWorkingDay).map((w) => w.dayOfWeek)
							)
						}))
				)
			);
		}
	}

	// ---------- MONTHLY AMOUNT -> CYCLE ALLOCATION (Phase 12A.1), before segmentation/proration.
	// PERIOD_UNITS uses the effective PayrollRuleSet's prorationMethod (§4): CALENDAR_DAYS is a
	// schedule-level ratio (monthContext.calendarFactor); WORKING_DAYS is per-employee, using the SAME
	// calendar the proration engine already builds. ONE/month leaves every row unchanged. ----------
	function factorsFor(employeeId: number) {
		if (
			monthContext.allocationMethod === 'PERIOD_UNITS' &&
			rule?.prorationMethod === 'WORKING_DAYS' &&
			monthContext.thisRange &&
			monthContext.otherRanges[0]
		) {
			const cal = calendarByEmployee.get(employeeId);
			if (cal) {
				const thisUnits = unitsIn(
					'WORKING_DAYS',
					monthContext.thisRange.start,
					monthContext.thisRange.end,
					cal
				);
				const otherUnits = unitsIn(
					'WORKING_DAYS',
					monthContext.otherRanges[0].start,
					monthContext.otherRanges[0].end,
					cal
				);
				return cycleAllocationFactors(monthContext, {
					thisCycle: thisUnits,
					otherCycle: otherUnits
				});
			}
		}
		return cycleAllocationFactors(monthContext);
	}
	const originalBaseSalaryOf = new Map(rawComps.map((c) => [c.id, c.baseSalary]));
	const comps = rawComps.map((c) => ({
		...c,
		baseSalary: scaledAmount(
			c.baseSalary,
			monthContext,
			factorsFor(c.employeeId),
			rowSpansOtherCycle(c, monthContext)
		)
	}));
	const recurring = rawRecurring.map((r) => ({
		...r,
		amount: scaledAmount(
			r.amount,
			monthContext,
			factorsFor(r.employeeId),
			rowSpansOtherCycle(r, monthContext)
		)
	}));

	// ---------- pass 1: segment every employee (pure) ----------
	interface Prepared {
		emp: (typeof employees)[number];
		slices: Slice[];
		calendar: ReturnType<typeof makeCalendar> | null;
		issues: PlanIssue[];
		usable: (Slice & { comp: CompRow })[];
	}
	const prepared = employees.map((emp): Prepared => {
		const issues: PlanIssue[] = [];
		const from = t(emp.startDate) > t(start) ? emp.startDate : start;
		const to = emp.endDate && t(emp.endDate) < t(end) ? emp.endDate : end;
		const slices = planSlices({
			coverage: { from, to },
			timeline: emp.segments,
			companyId: run.companyId,
			groupByBranch: schedule?.groupByBranch ?? false,
			comps: comps.filter((c) => c.employeeId === emp.id),
			recurring: recurring.filter((r) => r.employeeId === emp.id) as RecurringRow[]
		});
		const usable = slices.filter((s): s is Slice & { comp: CompRow } => s.comp !== null);
		if (usable.length < slices.length || slices.length === 0)
			issues.push(issue('MISSING_COMPENSATION'));
		if (usable.some((s) => s.comp.currencyCode !== run.currencyCode)) {
			issues.push(issue('PAYROLL_CURRENCY_MISMATCH'));
		}
		const calendar = calendarByEmployee.get(emp.id) ?? null;
		if (rule?.prorationMethod === 'WORKING_DAYS') {
			const gap = usable.some((s) =>
				eachDay(s.from, s.to).some((d) => !calendar!.hasAssignment(d))
			);
			if (calendar!.isEmpty || gap) issues.push(issue('MISSING_SCHEDULE_FOR_WORKING_DAY'));
		}
		return { emp, slices, calendar, issues, usable };
	});

	// ---------- one bulk resolve of the daily payroll context ----------
	const datesByEmployee = new Map<number, Date[]>();
	if (rule && !ruleProblem && !monthContext.blocked) {
		for (const p of prepared) {
			if (p.issues.some((i) => i.code === 'MISSING_SCHEDULE_FOR_WORKING_DAY')) continue;
			datesByEmployee.set(
				p.emp.id,
				p.usable.flatMap((s) => eachDay(s.from, s.to))
			);
		}
	}
	const contexts = await resolveDailyPayrollContexts(datesByEmployee, serverNow());

	// ---------- pass 2: money ----------
	const results = prepared.map(({ emp, calendar, issues, usable }): PlanResult => {
		if (monthContext.blocked) {
			return {
				employeeId: emp.id,
				employeeCodeSnapshot: emp.employeeCode,
				employeeNameSnapshot: `${emp.firstNameLao} ${emp.lastNameLao}`.trim(),
				departmentIdSnapshot: null,
				departmentNameSnapshot: null,
				positionIdSnapshot: null,
				positionNameSnapshot: null,
				branchIdSnapshot: null,
				branchNameSnapshot: null,
				currencyCode: run.currencyCode,
				baseSalarySnapshot: null,
				totalEarnings: ZERO,
				totalDeductions: ZERO,
				netPay: ZERO,
				calculationStatus: 'BLOCKED',
				issues: [issue('PAYROLL_CYCLE_ALLOCATION_REQUIRED')],
				items: [],
				calculationVersion: CALCULATION_VERSION_V2,
				segments: [],
				attendanceSummary: null,
				leaveSummary: null,
				overtimeSummary: null,
				monthlyBaseSalarySnapshot: null,
				cycleAllocationFactorSnapshot: null
			};
		}
		const items: PlanItem[] = [];
		const placement = snapshotOf_.get(emp.id)!;
		const segments: PlanSegment[] = [];
		let attendanceSummary: unknown = null;
		let leaveSummary: unknown = null;
		let overtimeSummary: unknown = null;
		const lastUsable = usable.length ? usable[usable.length - 1]! : null;
		// the exact (possibly > 2dp) cycle-allocated value drives the displayed ratio precisely;
		// `baseSalary` (the stored snapshot) is rounded to money precision (§8's per-employee snapshot)
		const exactBaseSalary: Prisma.Decimal | null = lastUsable ? lastUsable.comp.baseSalary : null;
		const baseSalary: Prisma.Decimal | null = exactBaseSalary ? roundMoney(exactBaseSalary) : null;
		const monthlyBaseSalarySnapshot: Prisma.Decimal | null = lastUsable
			? (originalBaseSalaryOf.get(lastUsable.comp.id) ?? null)
			: null;
		const cycleAllocationFactorSnapshot: Prisma.Decimal | null =
			exactBaseSalary && monthlyBaseSalarySnapshot && !monthlyBaseSalarySnapshot.isZero()
				? new Prisma.Decimal(calc(exactBaseSalary).div(monthlyBaseSalarySnapshot).toFixed(10))
				: exactBaseSalary
					? factorsFor(emp.id).thisFactor.toDecimalPlaces(10)
					: null;

		if (!rule) {
			issues.push(issue('MISSING_PAYROLL_RULE'));
		} else if (ruleProblem) {
			issues.push(issue('INVALID_RULE_CONFIGURATION'));
		} else if (
			usable.length > 0 &&
			!issues.some((i) => i.code === 'MISSING_SCHEDULE_FOR_WORKING_DAY')
		) {
			const { periodUnits, segments: prorated } = prorateSlices({
				slices: usable,
				method: rule.prorationMethod,
				period: { from: start, to: end },
				calendar
			});
			if (periodUnits <= 0) {
				issues.push(issue('MISSING_SCHEDULE_FOR_WORKING_DAY'));
			} else {
				const unprorated = coversWholePeriod(
					prorated.map((s) => ({ amount: s.baseSalary, payable: s.payableUnits })),
					periodUnits
				);
				buildSegmentsAndItems({ prorated, unprorated });
				computeDayLevel(prorated);
			}
		}

		function buildSegmentsAndItems(args: { prorated: ProratedSegment[]; unprorated: boolean }) {
			const { prorated, unprorated } = args;
			for (const sg of prorated) {
				segments.push({
					segmentStart: sg.slice.from,
					segmentEnd: sg.slice.to,
					companyIdSnapshot: run.companyId,
					companyNameSnapshot: companyName,
					branchIdSnapshot: sg.slice.branchId,
					branchNameSnapshot: nameIn(branchNames, sg.slice.branchId),
					// Phase 12A.1 - sg.baseSalary is the cycle-allocated amount, possibly carrying extra
					// precision (10dp) from the allocation factor; round it for this DISPLAY snapshot —
					// the internal proration math above (sg.proratedBase) already used the exact value.
					baseSalarySnapshot: roundMoney(sg.baseSalary),
					currencyCode: sg.slice.comp.currencyCode,
					prorationMethod: rule!.prorationMethod,
					periodUnits: sg.periodUnits,
					payableUnits: sg.payableUnits,
					prorationFactor: sg.factor,
					proratedBaseSalary: sg.proratedBase,
					recurringJson: sg.recurring.map((r) => ({
						code: r.row.payComponent.code,
						nameLao: r.row.payComponent.nameLao,
						type: r.row.payComponent.type,
						amount: moneyString(r.row.amount),
						prorated: moneyString(r.prorated)
					}))
				});
			}
			const baseTotal = groupedAmount(
				prorated.map((s) => ({ amount: s.baseSalary, payable: s.payableUnits })),
				prorated[0]!.periodUnits
			);
			items.push({
				code: 'BASE_SALARY',
				nameLao: (unprorated ? BASE_NAME : PRORATED_BASE_NAME)[0],
				nameEnglish: (unprorated ? BASE_NAME : PRORATED_BASE_NAME)[1],
				type: 'EARNING',
				source: unprorated ? 'BASE_SALARY' : 'PRORATED_BASE_SALARY',
				amount: baseTotal,
				payComponentId: null,
				details: unprorated
					? null
					: {
							method: rule!.prorationMethod,
							segments: prorated.map((s) => ({
								from: formatDateOnly(s.slice.from),
								to: formatDateOnly(s.slice.to),
								baseSalary: moneyString(s.baseSalary),
								payableUnits: s.payableUnits,
								periodUnits: s.periodUnits,
								amount: moneyString(s.proratedBase)
							}))
						}
			});
			const byComponent = new Map<number, { row: RecurringRow; parts: Part[] }>();
			for (const sg of prorated) {
				for (const r of sg.recurring) {
					const acc = byComponent.get(r.row.payComponentId) ?? { row: r.row, parts: [] };
					acc.parts.push({ amount: r.row.amount, payable: sg.payableUnits });
					byComponent.set(r.row.payComponentId, acc);
				}
			}
			for (const { row, parts } of byComponent.values()) {
				items.push({
					code: row.payComponent.code,
					nameLao: row.payComponent.nameLao,
					nameEnglish: row.payComponent.nameEnglish,
					type: row.payComponent.type,
					source: coversWholePeriod(parts, prorated[0]!.periodUnits)
						? 'RECURRING'
						: 'PRORATED_RECURRING',
					amount: groupedAmount(parts, prorated[0]!.periodUnits),
					payComponentId: row.payComponentId,
					details: null
				});
			}
		}

		function computeDayLevel(prorated: ProratedSegment[]) {
			const contextOf = (d: Date): DayContext | undefined => contexts.get(dayKey(emp.id, d));
			const deductions = computeAttendanceDeductions({
				ranges: prorated.map((s) => ({
					from: s.slice.from,
					to: s.slice.to,
					dayRate: unitRate(s.baseSalary, s.periodUnits)
				})),
				contextOf,
				rule: rule!
			});
			attendanceSummary = deductions.attendance;
			leaveSummary = deductions.leave;
			for (const l of deductions.lines) {
				items.push({
					code: l.code,
					nameLao: l.nameLao,
					nameEnglish: l.nameEnglish,
					type: 'DEDUCTION',
					source: l.source,
					amount: l.amount,
					payComponentId: null,
					details: l.details
				});
			}
			// Phase 12A.2 - the OT rate basis branches from the MONTHLY salary effective on the OT's OWN
			// work date (rawComps = unscaled, pre-cycle-allocation rows) - never `sg.baseSalary`, which
			// is this employee's CYCLE-allocated / segment-prorated amount for normal salary purposes.
			const myMonthlyComps = rawComps.filter((c) => c.employeeId === emp.id);
			const otInputs: OvertimeInput[] = [];
			for (const sg of prorated) {
				for (const day of eachDay(sg.slice.from, sg.slice.to)) {
					for (const summary of contextOf(day)?.overtime ?? []) {
						otInputs.push({
							summary,
							monthlyBaseSalary:
								monthlyCompensationAt(myMonthlyComps, summary.workDate)?.baseSalary ?? null
						});
					}
				}
			}
			const ot = computeOvertimeCompensation({ requests: otInputs, rule: rule! });
			overtimeSummary = ot.summary;
			if (ot.incomplete) issues.push(issue('OT_COMPENSATION_RULE_INCOMPLETE'));
			for (const l of ot.lines) {
				items.push({
					code: l.code,
					nameLao: l.nameLao,
					nameEnglish: l.nameEnglish,
					type: 'EARNING',
					source: 'OVERTIME',
					amount: l.amount,
					payComponentId: null,
					details: l.details
				});
			}
		}

		// ----- manual adjustments (append-only, replayed on every calculation) -----
		for (const a of adjustments.filter((x) => x.employeeId === emp.id)) {
			items.push({
				code: a.code,
				nameLao: a.nameLao,
				nameEnglish: null,
				type: a.type,
				source: 'MANUAL',
				amount: a.amount,
				payComponentId: a.payComponentId
			});
		}

		const totalEarnings = sumMoney(items.filter((i) => i.type === 'EARNING').map((i) => i.amount));
		const totalDeductions = sumMoney(
			items.filter((i) => i.type === 'DEDUCTION').map((i) => i.amount)
		);
		const netPay = totalEarnings.minus(totalDeductions);
		if (totalDeductions.greaterThan(totalEarnings)) issues.push(issue('NEGATIVE_NET_PAY'));

		return {
			employeeId: emp.id,
			employeeCodeSnapshot: emp.employeeCode,
			employeeNameSnapshot: `${emp.firstNameLao} ${emp.lastNameLao}`.trim(),
			departmentIdSnapshot: placement.departmentId,
			departmentNameSnapshot: nameIn(departmentNames, placement.departmentId),
			positionIdSnapshot: placement.positionId,
			positionNameSnapshot: nameIn(positionNames, placement.positionId),
			branchIdSnapshot: placement.branchId,
			branchNameSnapshot: nameIn(branchNames, placement.branchId),
			currencyCode: run.currencyCode,
			baseSalarySnapshot: baseSalary,
			totalEarnings,
			totalDeductions,
			netPay,
			calculationStatus: issues.length > 0 ? 'BLOCKED' : 'READY',
			issues,
			items,
			calculationVersion: CALCULATION_VERSION_V2,
			segments,
			attendanceSummary,
			leaveSummary,
			overtimeSummary,
			monthlyBaseSalarySnapshot,
			cycleAllocationFactorSnapshot
		};
	});
	return plan(results);
}
