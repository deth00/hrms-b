import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { ZERO, moneyOrNull, moneyString } from '../lib/money.js';
import type { PlanResult } from './payrollCalculation.js';

/**
 * PAYROLL APPROVAL SNAPSHOT (Phase 13 §14-15).
 *
 * A deterministic, canonical description of everything that decides WHAT a payroll run pays: run
 * identity + versions, and per employee the status, totals, every result item, every proration segment
 * and the statutory (PIT / SSO) figures. Two builders feed ONE normalizer:
 *
 *  - `canonicalFromPlan`   — a FRESH PayrollPlan (built from the latest source data), and
 *  - `canonicalFromStored` — the CALCULATED rows stored in payroll_employee_results & co.
 *
 * Both produce byte-identical output for the same payroll, so SHA-256(canonical) is the approval hash:
 * hashed at submission from the stored result, and recomputed at finalization from a fresh plan — any
 * difference in money or calculation identity changes the hash (PAYROLL_APPROVAL_STALE).
 *
 * Deliberately NOT part of the snapshot: auto-generated row ids / createdAt (they change on every
 * recalculation), names / department / position labels (display snapshots, not money), and anything
 * outside the payroll tables.
 *
 * Normalization rules: money → fixed 2-decimal strings, ratios → fixed 10 decimals, dates → YYYY-MM-DD,
 * free JSON (item details, recurring breakdown) → JSON round-trip (what the DB actually stores), and
 * every collection sorted by stable business keys. Objects are serialized with sorted keys.
 *
 * CANONICAL VERSIONS (numeric-ID migration, M6). The version is PART of the hashed object and is stored on
 * the run (approvalCanonicalVersion) next to the hash:
 *  - 1 (NULL on pre-migration rows): CUID ids, implicit string sort. It can NEVER be recomputed after the
 *    numeric-ID migration (the ids changed), so a v1 approval that is not yet finalized must be re-approved
 *    (PAYROLL_APPROVAL_CANONICAL_OUTDATED). Finalized v1 runs are never re-hashed: their stored hash stays
 *    byte-for-byte.
 *  - 2: numeric ids; every id-based sort key is the explicit fixed-width decimal idKey(id), so ordering
 *    never depends on implicit JS number-vs-string comparison.
 */
export const CANONICAL_VERSION = 2 as const;

/** Explicit, total, numeric-order-preserving sort key of an id (10 digits = MySQL INT range). */
export const idKey = (id: number | null) => (id === null ? '' : String(id).padStart(10, '0'));

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const dec = (v: Prisma.Decimal | string | number, dp: number) => new Prisma.Decimal(v).toFixed(dp);
const money = (v: Prisma.Decimal | string | number) => moneyString(v);
const day = (d: Date) => d.toISOString().slice(0, 10);
/** what the DB stores for a JSON column (Decimal → string, Date → ISO, undefined dropped) */
const jsonRound = (v: unknown): Json =>
	v === undefined || v === null ? null : (JSON.parse(JSON.stringify(v)) as Json);

/** JSON with object keys sorted recursively — the canonical serialization. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const byKey =
	<T>(key: (t: T) => string) =>
	(a: T, b: T) => {
		const ka = key(a);
		const kb = key(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	};

// ---------- the shared normalized shape ----------

interface NormalItem {
	code: string;
	type: string;
	source: string;
	amount: string;
	payComponentId: number | null;
	details: Json;
}
interface NormalSegment {
	start: string;
	end: string;
	companyId: number;
	branchId: number | null;
	baseSalary: string;
	currencyCode: string;
	prorationMethod: string;
	periodUnits: string;
	payableUnits: string;
	prorationFactor: string;
	proratedBaseSalary: string;
	recurring: Json;
}
interface NormalStatutory {
	statutoryRuleSetId: number;
	ruleVersion: number;
	payrollMonth: string;
	amounts: Record<string, string>;
}
export interface NormalEmployee {
	employeeId: number;
	employeeCode: string;
	status: string;
	issues: string[];
	currencyCode: string;
	baseSalary: string | null;
	monthlyBaseSalary: string | null;
	cycleAllocationFactor: string | null;
	totalEarnings: string;
	totalDeductions: string;
	netPay: string;
	employerContributionTotal: string | null;
	items: NormalItem[];
	segments: NormalSegment[];
	statutory: NormalStatutory | null;
}
export interface CanonicalRun {
	runId: number;
	periodId: number;
	payrollMonth: string | null;
	cycleNumber: number | null;
	calculationVersion: number;
	payrollRuleSetId: number | null;
	payrollRuleVersion: number | null;
}
export interface CanonicalPayroll {
	canonicalVersion: typeof CANONICAL_VERSION;
	run: CanonicalRun;
	employees: NormalEmployee[];
}

const STATUTORY_AMOUNT_KEYS = [
	'pitTaxableGross',
	'pitExemptIncome',
	'employeeSocialSecurity',
	'employerSocialSecurity',
	'pitTaxableBase',
	'pitLiabilityMonthToDate',
	'pitPriorWithheld',
	'pitCurrentCycle',
	'socialSecurityBaseMonthToDate',
	'employeeSsoLiabilityMonthToDate',
	'employeeSsoPrior',
	'employeeSsoCurrentCycle',
	'employerSsoLiabilityMonthToDate',
	'employerSsoPrior',
	'employerSsoCurrentCycle'
] as const;

type StatutoryLike = {
	statutoryRuleSetId: number;
	ruleVersion: number;
	payrollMonth: string;
} & Record<(typeof STATUTORY_AMOUNT_KEYS)[number], Prisma.Decimal>;

function normalStatutory(s: StatutoryLike | null | undefined): NormalStatutory | null {
	if (!s) return null;
	return {
		statutoryRuleSetId: s.statutoryRuleSetId,
		ruleVersion: s.ruleVersion,
		payrollMonth: s.payrollMonth,
		amounts: Object.fromEntries(STATUTORY_AMOUNT_KEYS.map((k) => [k, money(s[k])]))
	};
}

function finish(e: NormalEmployee): NormalEmployee {
	return {
		...e,
		issues: [...e.issues].sort(),
		items: [...e.items].sort(
			byKey((i) =>
				stableStringify([i.source, i.code, i.type, i.amount, idKey(i.payComponentId), i.details])
			)
		),
		segments: [...e.segments].sort(
			byKey((s) => `${s.start}|${s.end}|${idKey(s.companyId)}|${idKey(s.branchId)}`)
		)
	};
}

const issueKeys = (issues: unknown) =>
	((issues as { code: string; componentCode?: string }[] | null) ?? []).map(
		(i) => `${i.code}${i.componentCode ? `:${i.componentCode}` : ''}`
	);

// ---------- builders ----------

/** From a FRESH plan (calculate / finalize time). `run` carries the engine's run-level identity. */
export function canonicalFromPlan(run: CanonicalRun, plan: PlanResult[]): CanonicalPayroll {
	const employees = plan.map((r) =>
		finish({
			employeeId: r.employeeId,
			employeeCode: r.employeeCodeSnapshot,
			status: r.calculationStatus,
			issues: issueKeys(r.issues),
			currencyCode: r.currencyCode,
			baseSalary: moneyOrNull(r.baseSalarySnapshot),
			monthlyBaseSalary: moneyOrNull(r.monthlyBaseSalarySnapshot),
			cycleAllocationFactor: r.cycleAllocationFactorSnapshot
				? dec(r.cycleAllocationFactorSnapshot, 10)
				: null,
			totalEarnings: money(r.totalEarnings),
			totalDeductions: money(r.totalDeductions),
			netPay: money(r.netPay),
			employerContributionTotal: moneyOrNull(r.employerContributionTotal),
			items: r.items.map((i) => ({
				code: i.code,
				type: i.type,
				source: i.source,
				amount: money(i.amount),
				payComponentId: i.payComponentId,
				details: jsonRound(i.details)
			})),
			segments: (r.segments ?? []).map((sg) => ({
				start: day(sg.segmentStart),
				end: day(sg.segmentEnd),
				companyId: sg.companyIdSnapshot,
				branchId: sg.branchIdSnapshot,
				baseSalary: money(sg.baseSalarySnapshot),
				currencyCode: sg.currencyCode,
				prorationMethod: sg.prorationMethod,
				periodUnits: dec(sg.periodUnits, 2),
				payableUnits: dec(sg.payableUnits, 2),
				prorationFactor: dec(sg.prorationFactor, 10),
				proratedBaseSalary: money(sg.proratedBaseSalary),
				recurring: jsonRound(sg.recurringJson)
			})),
			statutory: normalStatutory(r.statutory ?? null)
		})
	);
	return {
		canonicalVersion: CANONICAL_VERSION,
		run,
		employees: employees.sort(byKey((e) => idKey(e.employeeId)))
	};
}

export const STORED_RESULT_INCLUDE = {
	items: true,
	segments: true,
	statutoryResult: true
} satisfies Prisma.PayrollEmployeeResultInclude;
export type StoredResult = Prisma.PayrollEmployeeResultGetPayload<{
	include: typeof STORED_RESULT_INCLUDE;
}>;

/** From the stored CALCULATED rows (submission time). */
export function canonicalFromStored(run: CanonicalRun, rows: StoredResult[]): CanonicalPayroll {
	const employees = rows.map((r) =>
		finish({
			employeeId: r.employeeId,
			employeeCode: r.employeeCodeSnapshot,
			status: r.calculationStatus,
			issues: issueKeys(r.issuesJson),
			currencyCode: r.currencyCode,
			baseSalary: moneyOrNull(r.baseSalarySnapshot),
			monthlyBaseSalary: moneyOrNull(r.monthlyBaseSalarySnapshot),
			cycleAllocationFactor: r.cycleAllocationFactorSnapshot
				? dec(r.cycleAllocationFactorSnapshot, 10)
				: null,
			totalEarnings: money(r.totalEarnings),
			totalDeductions: money(r.totalDeductions),
			netPay: money(r.netPay),
			employerContributionTotal: moneyOrNull(r.employerContributionTotal),
			items: r.items.map((i) => ({
				code: i.code,
				type: i.type,
				source: i.source,
				amount: money(i.amount),
				payComponentId: i.payComponentId,
				details: jsonRound(i.detailsJson)
			})),
			segments: r.segments.map((sg) => ({
				start: day(sg.segmentStart),
				end: day(sg.segmentEnd),
				companyId: sg.companyIdSnapshot,
				branchId: sg.branchIdSnapshot,
				baseSalary: money(sg.baseSalarySnapshot),
				currencyCode: sg.currencyCode,
				prorationMethod: sg.prorationMethod,
				periodUnits: dec(sg.periodUnits, 2),
				payableUnits: dec(sg.payableUnits, 2),
				prorationFactor: dec(sg.prorationFactor, 10),
				proratedBaseSalary: money(sg.proratedBaseSalary),
				recurring: jsonRound(sg.recurringJson)
			})),
			statutory: normalStatutory(r.statutoryResult)
		})
	);
	return {
		canonicalVersion: CANONICAL_VERSION,
		run,
		employees: employees.sort(byKey((e) => idKey(e.employeeId)))
	};
}

/** SHA-256 (hex) of the canonical serialization. */
export const hashCanonical = (c: CanonicalPayroll) =>
	createHash('sha256').update(stableStringify(c), 'utf8').digest('hex');

/**
 * The SAFE summary stored on the run next to the hash (`approvalSnapshotJson`): counts, totals and
 * versions for the approval panel. It stays in the payroll tables — it is never copied into audit
 * metadata or notifications.
 */
export function approvalSummary(c: CanonicalPayroll) {
	const sum = (pick: (e: NormalEmployee) => string | null) =>
		money(c.employees.reduce((acc, e) => acc.plus(pick(e) ?? 0), ZERO));
	return {
		employees: c.employees.length,
		ready: c.employees.filter((e) => e.status === 'READY').length,
		blocked: c.employees.filter((e) => e.status !== 'READY').length,
		totalEarnings: sum((e) => e.totalEarnings),
		totalDeductions: sum((e) => e.totalDeductions),
		netPay: sum((e) => e.netPay),
		employerContributionTotal: sum((e) => e.employerContributionTotal),
		calculationVersion: c.run.calculationVersion,
		payrollRuleVersion: c.run.payrollRuleVersion,
		statutoryRuleVersions: [
			...new Set(
				c.employees.map((e) => e.statutory?.ruleVersion).filter((v): v is number => v != null)
			)
		].sort((a, b) => a - b)
	};
}
export type ApprovalSnapshotSummary = ReturnType<typeof approvalSummary>;
