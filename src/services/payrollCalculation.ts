import { Prisma } from '@prisma/client';
import type { PayComponentType, PayrollCalculationStatus, PayrollItemSource } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { ZERO, calc, roundMoney, sumMoney } from '../lib/money.js';
import { Errors } from '../utils/AppError.js';
import {
	branchesIn,
	companiesIn,
	loadHistoryFor,
	placementAt,
	segmentsWithin
} from './employeeAssignmentResolver.js';
import {
	cycleAllocationFactors,
	rowSpansOtherCycle,
	scaledAmount,
	type MonthAllocationContext
} from './payrollMonthContext.service.js';

/**
 * PAYROLL CALCULATION — LEGACY engine, Phase 11 (calculationVersion = 1). Phase 12A's engine (v2) lives in
 * payrollCalculationV2.ts; `payrollEngine.ts` picks one. This file also holds the shared eligibility /
 * persistence helpers both engines use.
 *
 *   Total Earnings   = Base Salary + recurring EARNING components + manual EARNING adjustments
 *   Total Deductions = recurring DEDUCTION components + manual DEDUCTION adjustments
 *   Net Pay          = Total Earnings − Total Deductions
 *
 * Everything is evaluated at ONE snapshot date, PayrollPeriod.endDate. This is NOT a proration
 * engine: whenever the period is not covered by a single, unchanged set of source rows the employee
 * result is BLOCKED (never silently paid a full month). Deliberately absent: attendance / late /
 * absent / leave deductions, OT pay, tax, social security — no such data is read here.
 * All arithmetic is Prisma.Decimal.
 */
export const CALCULATION_VERSION = 1;

type Db = Prisma.TransactionClient | typeof prisma;

export type IssueCode =
	| 'MISSING_COMPENSATION'
	| 'EMPLOYEE_PARTIAL_PERIOD'
	| 'COMPENSATION_CHANGE_WITHIN_PERIOD'
	| 'PAY_COMPONENT_CHANGE_WITHIN_PERIOD'
	| 'NEGATIVE_NET_PAY'
	| 'PAYROLL_CURRENCY_MISMATCH'
	| 'COMPANY_CHANGE_WITHIN_PERIOD'
	| 'BRANCH_CHANGE_WITHIN_PERIOD'
	// Phase 12A (calculationVersion 2)
	| 'MISSING_PAYROLL_RULE'
	| 'INVALID_RULE_CONFIGURATION'
	| 'OT_COMPENSATION_RULE_INCOMPLETE'
	| 'MISSING_SCHEDULE_FOR_WORKING_DAY'
	// Phase 12A.1 (calculationVersion 3)
	| 'PAYROLL_CYCLE_ALLOCATION_REQUIRED'
	// Phase 12B (calculationVersion 5)
	| 'MISSING_STATUTORY_RULE'
	| 'STATUTORY_CURRENCY_CONVERSION_REQUIRED'
	| 'STATUTORY_TREATMENT_REQUIRED'
	| 'STATUTORY_TRANSITION_REQUIRES_CONFIGURATION'
	// Phase 12B.1
	| 'MISSING_EMPLOYEE_STATUTORY_PROFILE';

const ISSUE_MESSAGE: Record<IssueCode, string> = {
	MISSING_COMPENSATION: 'ບໍ່ມີເງິນເດືອນພື້ນຖານທີ່ມີຜົນໃນວັນສິ້ນສຸດງວດ',
	EMPLOYEE_PARTIAL_PERIOD: 'ພະນັກງານເຮັດວຽກບໍ່ເຕັມງວດ (ຍັງບໍ່ຮອງຮັບການຄິດສັດສ່ວນ)',
	COMPENSATION_CHANGE_WITHIN_PERIOD: 'ເງິນເດືອນປ່ຽນໃນລະຫວ່າງງວດ (ຍັງບໍ່ຮອງຮັບການຄິດສັດສ່ວນ)',
	PAY_COMPONENT_CHANGE_WITHIN_PERIOD:
		'ລາຍຮັບ/ລາຍຈ່າຍປະຈຳປ່ຽນໃນລະຫວ່າງງວດ (ຍັງບໍ່ຮອງຮັບການຄິດສັດສ່ວນ)',
	NEGATIVE_NET_PAY: 'ລາຍຈ່າຍຫຼາຍກວ່າລາຍຮັບ (ເງິນສຸດທິຕິດລົບ)',
	PAYROLL_CURRENCY_MISMATCH: 'ສະກຸນເງິນຂອງເງິນເດືອນບໍ່ກົງກັບຮອບເງິນເດືອນ',
	COMPANY_CHANGE_WITHIN_PERIOD:
		'ພະນັກງານຍ້າຍບໍລິສັດໃນລະຫວ່າງງວດ (ຍັງບໍ່ຮອງຮັບການຄິດສັດສ່ວນຂ້າມບໍລິສັດ)',
	BRANCH_CHANGE_WITHIN_PERIOD: 'ພະນັກງານຍ້າຍສາຂາໃນລະຫວ່າງງວດ (ຍັງບໍ່ຮອງຮັບການຈັດກຸ່ມ/ຄິດສັດສ່ວນ)',
	MISSING_PAYROLL_RULE: 'ບໍ່ມີກົດການຄຳນວນເງິນເດືອນທີ່ມີຜົນໃນວັນສິ້ນສຸດງວດ',
	INVALID_RULE_CONFIGURATION: 'ກົດການຄຳນວນເງິນເດືອນຕັ້ງຄ່າບໍ່ຖືກຕ້ອງ',
	OT_COMPENSATION_RULE_INCOMPLETE: 'ກົດການຄຳນວນຄ່າລ່ວງເວລາບໍ່ຄົບຖ້ວນ (ຂາດຕົວຄູນ ຫຼື ຕົວຫານ)',
	MISSING_SCHEDULE_FOR_WORKING_DAY: 'ບໍ່ມີຕາຕະລາງເຮັດວຽກຄົບຖ້ວນ — ຄິດຕາມມື້ເຮັດວຽກບໍ່ໄດ້',
	PAYROLL_CYCLE_ALLOCATION_REQUIRED:
		'ຮອບການຈ່າຍນີ້ຈ່າຍ 2 ຄັ້ງ/ເດືອນ ແຕ່ຍັງບໍ່ໄດ້ຕັ້ງຄ່າວິທີແບ່ງເງິນເດືອນລາຍເດືອນ — ກະລຸນາຕັ້ງຄ່າກ່ອນຄຳນວນ',
	MISSING_STATUTORY_RULE: 'ບໍລິສັດເປີດໃຊ້ພາສີ/ປະກັນສັງຄົມແລ້ວ ແຕ່ບໍ່ມີກົດທີ່ໃຊ້ງານໄດ້ສຳລັບເດືອນນີ້',
	STATUTORY_CURRENCY_CONVERSION_REQUIRED:
		'ອາກອນ ແລະ ປະກັນສັງຄົມຄິດໄລ່ໄດ້ສະເພາະສະກຸນເງິນ LAK — ຍັງບໍ່ຮອງຮັບການແປງສະກຸນເງິນ',
	STATUTORY_TREATMENT_REQUIRED:
		'ລາຍການລາຍຮັບດ້ວຍມືຕ້ອງລະບຸລາຍການລາຍຮັບ/ລາຍຈ່າຍ (ເພື່ອຮູ້ການປະຕິບັດທາງພາສີ/ປະກັນສັງຄົມ)',
	STATUTORY_TRANSITION_REQUIRES_CONFIGURATION:
		'ກົດອາກອນ/ປະກັນສັງຄົມມີການປ່ຽນແປງໃນລະຫວ່າງເດືອນນີ້ — ຕ້ອງຕັ້ງຄ່າເດືອນເງິນເດືອນທີ່ມີຜົນຢ່າງຈະແຈ້ງ',
	MISSING_EMPLOYEE_STATUTORY_PROFILE: 'ຍັງບໍ່ໄດ້ກຳນົດສະຖານະພາສີ ແລະ ປະກັນສັງຄົມ'
};

export interface PlanIssue {
	code: IssueCode;
	message: string;
	/** which recurring component (for PAY_COMPONENT_CHANGE_WITHIN_PERIOD) */
	componentCode?: string;
}

export interface PlanItem {
	code: string;
	nameLao: string;
	nameEnglish: string | null;
	type: PayComponentType;
	source: PayrollItemSource;
	amount: Prisma.Decimal;
	payComponentId: number | null;
	/** Phase 12A traceability (minutes, days, rate, multiplier, request ids) */
	details?: Record<string, unknown> | null;
}

export interface PlanSegment {
	segmentStart: Date;
	segmentEnd: Date;
	companyIdSnapshot: number;
	companyNameSnapshot: string;
	branchIdSnapshot: number | null;
	branchNameSnapshot: string | null;
	baseSalarySnapshot: Prisma.Decimal;
	currencyCode: string;
	prorationMethod: 'CALENDAR_DAYS' | 'WORKING_DAYS';
	periodUnits: number;
	payableUnits: number;
	prorationFactor: Prisma.Decimal;
	proratedBaseSalary: Prisma.Decimal;
	recurringJson: unknown[] | null;
}

export interface PlanResult {
	employeeId: number;
	employeeCodeSnapshot: string;
	employeeNameSnapshot: string;
	departmentIdSnapshot: number | null;
	departmentNameSnapshot: string | null;
	positionIdSnapshot: number | null;
	positionNameSnapshot: string | null;
	branchIdSnapshot: number | null;
	branchNameSnapshot: string | null;
	currencyCode: string;
	baseSalarySnapshot: Prisma.Decimal | null;
	totalEarnings: Prisma.Decimal;
	totalDeductions: Prisma.Decimal;
	netPay: Prisma.Decimal;
	calculationStatus: PayrollCalculationStatus;
	issues: PlanIssue[];
	items: PlanItem[];
	/** Phase 12A (v2 engine only) */
	calculationVersion?: number;
	segments?: PlanSegment[];
	attendanceSummary?: unknown;
	leaveSummary?: unknown;
	overtimeSummary?: unknown;
	/** Phase 12A.1 - the pre-cycle-allocation monthly amount, and the ratio actually applied to it */
	monthlyBaseSalarySnapshot?: Prisma.Decimal | null;
	cycleAllocationFactorSnapshot?: Prisma.Decimal | null;
	/** Phase 12B - this cycle's employer Social Security contribution (never affects totals above) */
	employerContributionTotal?: Prisma.Decimal | null;
	/** Phase 12B - present only when the company has opted into statutory payroll and it resolved */
	statutory?: StatutoryPlanData | null;
}

export interface StatutoryPlanData {
	statutoryRuleSetId: number;
	ruleVersion: number;
	payrollMonth: string;
	pitTaxableGross: Prisma.Decimal;
	pitExemptIncome: Prisma.Decimal;
	employeeSocialSecurity: Prisma.Decimal;
	employerSocialSecurity: Prisma.Decimal;
	pitTaxableBase: Prisma.Decimal;
	pitLiabilityMonthToDate: Prisma.Decimal;
	pitPriorWithheld: Prisma.Decimal;
	pitCurrentCycle: Prisma.Decimal;
	socialSecurityBaseMonthToDate: Prisma.Decimal;
	employeeSsoLiabilityMonthToDate: Prisma.Decimal;
	employeeSsoPrior: Prisma.Decimal;
	employeeSsoCurrentCycle: Prisma.Decimal;
	employerSsoLiabilityMonthToDate: Prisma.Decimal;
	employerSsoPrior: Prisma.Decimal;
	employerSsoCurrentCycle: Prisma.Decimal;
	ruleSnapshot: unknown;
	pitBracketBreakdown: unknown;
	otExemption: unknown;
}

export interface RunFacts {
	id: number;
	companyId: number;
	currencyCode: string;
	/** schedule context copied onto the run at creation (null for manual periods) */
	payrollScheduleId?: number | null;
}
export interface PeriodFacts {
	startDate: Date;
	endDate: Date;
	/** Phase 12A.1 - cycle-allocation identity; undefined/null for a manual period with no derived month */
	payrollMonth?: string | null;
	cycleNumber?: number | null;
}

export interface EligibleEmployee {
	id: number;
	employeeCode: string;
	firstNameLao: string;
	lastNameLao: string;
	startDate: Date;
	endDate: Date | null;
	companyId: number;
	branchId: number | null;
	departmentId: number | null;
	divisionId: number | null;
	unitId: number | null;
	positionId: number | null;
	/** constant-placement slices of the employment-clipped period (historical assignment) */
	segments: ReturnType<typeof segmentsWithin>;
}

/**
 * Who belongs in a run. Employment dates must OVERLAP the period (historical dates, not today's
 * status) AND the employee must have belonged to the run's company during the period according to
 * EmployeeAssignmentHistory (via the shared resolver — NOT Employee.companyId alone). A SELECTED
 * schedule additionally requires membership; membership never bypasses the company check.
 * An employee who also belonged to ANOTHER company inside the period is still returned (so the run
 * can show them as BLOCKED instead of silently dropping or paying them).
 */
export async function loadEligibleEmployees(
	db: Db,
	run: RunFacts,
	period: PeriodFacts,
	onlyEmployeeId?: number
): Promise<{ employees: EligibleEmployee[]; schedule: ScheduleFacts | null }> {
	const schedule = await loadScheduleFacts(db, run.payrollScheduleId);
	const rows = await db.employee.findMany({
		where: {
			...(onlyEmployeeId ? { id: onlyEmployeeId } : {}),
			...(schedule?.memberIds ? { id: { in: schedule.memberIds } } : {}),
			startDate: { lte: period.endDate },
			AND: [
				{ OR: [{ endDate: null }, { endDate: { gte: period.startDate } }] },
				{
					// ever placed in this company, or (legacy row without any history) currently in it
					OR: [
						{ history: { some: { companyId: run.companyId } } },
						{ AND: [{ companyId: run.companyId }, { history: { none: {} } }] }
					]
				}
			]
		},
		select: {
			id: true,
			employeeCode: true,
			firstNameLao: true,
			lastNameLao: true,
			startDate: true,
			endDate: true,
			companyId: true,
			branchId: true,
			departmentId: true,
			divisionId: true,
			unitId: true,
			positionId: true
		},
		orderBy: { employeeCode: 'asc' }
	});
	const history = await loadHistoryFor(
		db,
		rows.map((r) => r.id)
	);
	const employees: EligibleEmployee[] = [];
	for (const r of rows) {
		const from = t(r.startDate) > t(period.startDate) ? r.startDate : period.startDate;
		const to = r.endDate && t(r.endDate) < t(period.endDate) ? r.endDate : period.endDate;
		const segments = segmentsWithin(history.get(r.id) ?? [], r, from, to);
		if (!companiesIn(segments).includes(run.companyId)) continue;
		employees.push({ ...r, segments });
	}
	return { employees, schedule };
}

export interface ScheduleFacts {
	id: number;
	groupByBranch: boolean;
	/** null = every eligible employee (scope ALL) */
	memberIds: number[] | null;
}

async function loadScheduleFacts(
	db: Db,
	scheduleId?: number | null
): Promise<ScheduleFacts | null> {
	if (!scheduleId) return null;
	const schedule = await db.payrollSchedule.findUnique({
		where: { id: scheduleId },
		include: { employees: { select: { employeeId: true } } }
	});
	if (!schedule) return null;
	if (schedule.payBasis !== 'MONTHLY') {
		throw Errors.badRequest(
			'PAYROLL_BASIS_NOT_SUPPORTED',
			'ຍັງບໍ່ຮອງຮັບການຄຳນວນເງິນເດືອນແບບລາຍວັນ — ໃຊ້ໄດ້ສະເພາະລາຍເດືອນ'
		);
	}
	return {
		id: schedule.id,
		groupByBranch: schedule.groupByBranch,
		memberIds:
			schedule.employeeScope === 'SELECTED' ? schedule.employees.map((e) => e.employeeId) : null
	};
}

export const issue = (code: IssueCode, componentCode?: string): PlanIssue => ({
	code,
	message: ISSUE_MESSAGE[code],
	...(componentCode ? { componentCode } : {})
});

export const t = (d: Date) => d.getTime();

/** Pure-ish: reads master data through `db`, returns the plan; writes nothing. */
export async function buildPayrollPlanV1(
	db: Db,
	run: RunFacts,
	period: PeriodFacts,
	monthContext: MonthAllocationContext
): Promise<PlanResult[]> {
	const { startDate: start, endDate: end } = period;
	const { employees, schedule } = await loadEligibleEmployees(db, run, period);
	if (employees.length === 0) return [];
	const ids = employees.map((e) => e.id);
	const history = await loadHistoryFor(db, ids);
	// the placement each employee had on the snapshot date (end of the period, or the last employed day)
	const snapshotOf = new Map(
		employees.map((e) => {
			const snapDate = e.endDate && t(e.endDate) < t(end) ? e.endDate : end;
			return [e.id, placementAt(history.get(e.id) ?? [], e, snapDate)] as const;
		})
	);
	const placements = [...snapshotOf.values()];
	const idsOf = (pick: (p: (typeof placements)[number]) => number | null) => [
		...new Set(placements.map(pick).filter((v): v is number => v !== null))
	];
	const [branchNames, departmentNames, positionNames] = await Promise.all([
		db.branch.findMany({
			where: { id: { in: idsOf((p) => p.branchId) } },
			select: { id: true, nameLao: true }
		}),
		db.department.findMany({
			where: { id: { in: idsOf((p) => p.departmentId) } },
			select: { id: true, nameLao: true }
		}),
		db.position.findMany({
			where: { id: { in: idsOf((p) => p.positionId) } },
			select: { id: true, nameLao: true }
		})
	]);
	const nameIn = (list: { id: number; nameLao: string }[], id: number | null) =>
		id ? (list.find((x) => x.id === id)?.nameLao ?? null) : null;
	const overlapsPeriod = {
		effectiveFrom: { lte: end },
		OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }]
	};
	const [rawComps, rawRecurring, adjustments] = await Promise.all([
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
		})
	]);
	// MONTHLY AMOUNT -> CYCLE ALLOCATION (Phase 12A.1), before any of Phase 11's per-employee logic below.
	// ONE/month (or a manual period) leaves every row byte-for-byte unchanged. Unlike v2 (which prorates
	// the scaled amount further and rounds only at that final step), v1 has NO further proration step —
	// the scaled amount IS the money line, so it is rounded to 2dp HERE (a no-op when totalCycles <= 1,
	// since a stored compensation amount already has at most 2 decimal places).
	const v1Factors = cycleAllocationFactors(monthContext);
	const originalBaseSalaryOf = new Map(rawComps.map((c) => [c.id, c.baseSalary]));
	const comps = rawComps.map((c) => ({
		...c,
		baseSalary: roundMoney(
			scaledAmount(c.baseSalary, monthContext, v1Factors, rowSpansOtherCycle(c, monthContext))
		)
	}));
	const recurring = rawRecurring.map((r) => ({
		...r,
		amount: roundMoney(
			scaledAmount(r.amount, monthContext, v1Factors, rowSpansOtherCycle(r, monthContext))
		)
	}));

	return employees.map((emp): PlanResult => {
		const issues: PlanIssue[] = [];
		const items: PlanItem[] = [];
		const coverStart = t(emp.startDate) > t(start) ? emp.startDate : start;

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
				items: []
			};
		}

		if (t(emp.startDate) > t(start) || (emp.endDate && t(emp.endDate) < t(end))) {
			issues.push(issue('EMPLOYEE_PARTIAL_PERIOD'));
		}
		// no cross-company / cross-branch proration yet: never pay the whole period in one place silently
		if (companiesIn(emp.segments).length > 1) issues.push(issue('COMPANY_CHANGE_WITHIN_PERIOD'));
		if (schedule?.groupByBranch && branchesIn(emp.segments).length > 1) {
			issues.push(issue('BRANCH_CHANGE_WITHIN_PERIOD'));
		}
		const placement = snapshotOf.get(emp.id)!;

		// ----- base salary: the row effective on period.endDate -----
		const myComps = comps.filter((c) => c.employeeId === emp.id);
		const covering = myComps.find(
			(c) => t(c.effectiveFrom) <= t(end) && (c.effectiveTo === null || t(c.effectiveTo) >= t(end))
		);
		let baseSalary: Prisma.Decimal | null = null;
		let monthlyBaseSalarySnapshot: Prisma.Decimal | null = null;
		let cycleAllocationFactorSnapshot: Prisma.Decimal | null = null;
		if (!covering) {
			issues.push(issue('MISSING_COMPENSATION'));
		} else {
			baseSalary = covering.baseSalary;
			monthlyBaseSalarySnapshot = originalBaseSalaryOf.get(covering.id) ?? null;
			cycleAllocationFactorSnapshot =
				monthlyBaseSalarySnapshot && !monthlyBaseSalarySnapshot.isZero()
					? new Prisma.Decimal(calc(baseSalary).div(monthlyBaseSalarySnapshot).toFixed(10))
					: v1Factors.thisFactor.toDecimalPlaces(10);
			if (myComps.length > 1 || t(covering.effectiveFrom) > t(coverStart)) {
				issues.push(issue('COMPENSATION_CHANGE_WITHIN_PERIOD'));
			}
			if (covering.currencyCode !== run.currencyCode)
				issues.push(issue('PAYROLL_CURRENCY_MISMATCH'));
			items.push({
				code: 'BASE_SALARY',
				nameLao: 'ເງິນເດືອນພື້ນຖານ',
				nameEnglish: 'Base Salary',
				type: 'EARNING',
				source: 'BASE_SALARY',
				amount: covering.baseSalary,
				payComponentId: null
			});
		}

		// ----- recurring components: rows effective on period.endDate -----
		const groups = new Map<number, typeof recurring>();
		for (const r of recurring.filter((x) => x.employeeId === emp.id)) {
			groups.set(r.payComponentId, [...(groups.get(r.payComponentId) ?? []), r]);
		}
		for (const rows of groups.values()) {
			const cover = rows.find(
				(r) =>
					t(r.effectiveFrom) <= t(end) && (r.effectiveTo === null || t(r.effectiveTo) >= t(end))
			);
			// several rows in the period, a start after the period start, or one that ended inside it
			const changed = rows.length > 1 || !cover || t(cover.effectiveFrom) > t(coverStart);
			if (changed)
				issues.push(issue('PAY_COMPONENT_CHANGE_WITHIN_PERIOD', rows[0]!.payComponent.code));
			if (cover) {
				items.push({
					code: cover.payComponent.code,
					nameLao: cover.payComponent.nameLao,
					nameEnglish: cover.payComponent.nameEnglish,
					type: cover.payComponent.type,
					source: 'RECURRING',
					amount: cover.amount,
					payComponentId: cover.payComponentId
				});
			}
		}

		// ----- manual adjustments (append-only records, replayed on every calculation) -----
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
			monthlyBaseSalarySnapshot,
			cycleAllocationFactorSnapshot
		};
	});
}

const json = (v: unknown) =>
	v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue);

/** Replaces ALL results + items of a (non-finalized) run with the plan — never appends. */
export async function replaceRunResults(
	tx: Prisma.TransactionClient,
	runId: number,
	plan: PlanResult[]
) {
	await tx.payrollEmployeeResult.deleteMany({ where: { payrollRunId: runId } }); // items cascade
	for (const r of plan) {
		await tx.payrollEmployeeResult.create({
			data: {
				payrollRunId: runId,
				employeeId: r.employeeId,
				employeeCodeSnapshot: r.employeeCodeSnapshot,
				employeeNameSnapshot: r.employeeNameSnapshot,
				departmentIdSnapshot: r.departmentIdSnapshot,
				departmentNameSnapshot: r.departmentNameSnapshot,
				positionIdSnapshot: r.positionIdSnapshot,
				positionNameSnapshot: r.positionNameSnapshot,
				branchIdSnapshot: r.branchIdSnapshot,
				branchNameSnapshot: r.branchNameSnapshot,
				currencyCode: r.currencyCode,
				baseSalarySnapshot: r.baseSalarySnapshot,
				totalEarnings: r.totalEarnings,
				totalDeductions: r.totalDeductions,
				netPay: r.netPay,
				calculationStatus: r.calculationStatus,
				issuesJson:
					r.issues.length > 0 ? (r.issues as unknown as Prisma.InputJsonArray) : Prisma.DbNull,
				calculationVersion: r.calculationVersion ?? 1,
				attendanceSummaryJson: json(r.attendanceSummary),
				leaveSummaryJson: json(r.leaveSummary),
				overtimeSummaryJson: json(r.overtimeSummary),
				monthlyBaseSalarySnapshot: r.monthlyBaseSalarySnapshot ?? null,
				cycleAllocationFactorSnapshot: r.cycleAllocationFactorSnapshot ?? null,
				employerContributionTotal: r.employerContributionTotal ?? null,
				segments: {
					create: (r.segments ?? []).map((sg) => ({
						...sg,
						recurringJson: json(sg.recurringJson)
					}))
				},
				items: {
					create: r.items.map((i) => ({
						code: i.code,
						nameLao: i.nameLao,
						nameEnglish: i.nameEnglish,
						type: i.type,
						source: i.source,
						amount: i.amount,
						payComponentId: i.payComponentId,
						detailsJson: json(i.details)
					}))
				},
				statutoryResult: r.statutory
					? {
							create: {
								statutoryRuleSetId: r.statutory.statutoryRuleSetId,
								ruleVersion: r.statutory.ruleVersion,
								payrollMonth: r.statutory.payrollMonth,
								pitTaxableGross: r.statutory.pitTaxableGross,
								pitExemptIncome: r.statutory.pitExemptIncome,
								employeeSocialSecurity: r.statutory.employeeSocialSecurity,
								employerSocialSecurity: r.statutory.employerSocialSecurity,
								pitTaxableBase: r.statutory.pitTaxableBase,
								pitLiabilityMonthToDate: r.statutory.pitLiabilityMonthToDate,
								pitPriorWithheld: r.statutory.pitPriorWithheld,
								pitCurrentCycle: r.statutory.pitCurrentCycle,
								socialSecurityBaseMonthToDate: r.statutory.socialSecurityBaseMonthToDate,
								employeeSsoLiabilityMonthToDate: r.statutory.employeeSsoLiabilityMonthToDate,
								employeeSsoPrior: r.statutory.employeeSsoPrior,
								employeeSsoCurrentCycle: r.statutory.employeeSsoCurrentCycle,
								employerSsoLiabilityMonthToDate: r.statutory.employerSsoLiabilityMonthToDate,
								employerSsoPrior: r.statutory.employerSsoPrior,
								employerSsoCurrentCycle: r.statutory.employerSsoCurrentCycle,
								ruleSnapshotJson: r.statutory.ruleSnapshot as Prisma.InputJsonValue,
								pitBracketBreakdownJson: json(r.statutory.pitBracketBreakdown),
								otExemptionJson: json(r.statutory.otExemption)
							}
						}
					: undefined
			}
		});
	}
}

export const planTotals = (plan: PlanResult[]) => ({
	employees: plan.length,
	ready: plan.filter((r) => r.calculationStatus === 'READY').length,
	blocked: plan.filter((r) => r.calculationStatus === 'BLOCKED').length,
	totalEarnings: plan.reduce((acc, r) => acc.plus(r.totalEarnings), ZERO),
	totalDeductions: plan.reduce((acc, r) => acc.plus(r.totalDeductions), ZERO),
	netPay: plan.reduce((acc, r) => acc.plus(r.netPay), ZERO)
});
