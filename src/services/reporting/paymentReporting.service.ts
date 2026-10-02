import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import type { AuthContext } from '../../types/express.js';
import type { PaymentReportQuery } from '../../validation/reporting.schema.js';
import {
	ATTEMPT_SELECT,
	buildObligations,
	resolveObligations,
	type ObligationStatus
} from '../paymentObligation.service.js';
import {
	finalizedRuns,
	latestFinalizedMonth,
	snapshotResultWhere
} from './payrollReporting.service.js';
import { resolveCompanyContext } from './reportingScope.service.js';
import {
	UNASSIGNED_KEY,
	UNASSIGNED_LABEL,
	isoDate,
	moneyText,
	parseGroupBy,
	type ReportGroup,
	groupKey
} from './reportingCommon.js';

/**
 * Phase 17A — PAYMENT settlement analytics. One OBLIGATION = one finalized PayrollEmployeeResult of a
 * FINALIZED run of the payroll month. Its status comes from the Phase 15 settlement resolver
 * (`resolveObligations`, paymentObligation.service): the status of the LATEST live attempt of the lineage
 * chain — so "original FAILED → retry PAID" counts ONCE, as PAID, and a PAID-then-REVERSED item counts as
 * REVERSED. Status is never read from the original item alone.
 *
 *   paid / failed / reversed / inProgress / unpaid — obligations per resolved status
 *   retried            — obligations with more than one live attempt
 *   paidAmount         — Σ finalized netPay of PAID obligations (the attempt amount IS the finalized netPay)
 *   outstandingAmount  — Σ finalized netPay (> 0) of obligations that are not PAID
 * No bank account, bank / transfer / instruction reference or employee bank data is read or returned.
 * Company is REQUIRED; branch / department filters and grouping use the RESULT SNAPSHOTS.
 */
const ZERO = new Prisma.Decimal(0);
export const PAYMENT_GROUP_BY = ['none', 'run', 'branch', 'department'] as const;

interface Acc {
	obligations: number;
	paid: number;
	failed: number;
	reversed: number;
	inProgress: number;
	unpaid: number;
	retried: number;
	paidAmount: Prisma.Decimal;
	outstandingAmount: Prisma.Decimal;
}
const emptyAcc = (): Acc => ({
	obligations: 0,
	paid: 0,
	failed: 0,
	reversed: 0,
	inProgress: 0,
	unpaid: 0,
	retried: 0,
	paidAmount: ZERO,
	outstandingAmount: ZERO
});
const FIELD: Record<ObligationStatus, 'paid' | 'failed' | 'reversed' | 'inProgress' | 'unpaid'> = {
	PAID: 'paid',
	FAILED: 'failed',
	REVERSED: 'reversed',
	IN_PROGRESS: 'inProgress',
	UNPAID: 'unpaid'
};

function add(a: Acc, status: ObligationStatus, netPay: Prisma.Decimal, attempts: number) {
	a.obligations++;
	a[FIELD[status]]++;
	if (attempts > 1) a.retried++;
	if (status === 'PAID') a.paidAmount = a.paidAmount.plus(netPay);
	else if (netPay.greaterThan(0)) a.outstandingAmount = a.outstandingAmount.plus(netPay);
}
const counts = (a: Acc) => ({
	obligations: a.obligations,
	paid: a.paid,
	failed: a.failed,
	reversed: a.reversed,
	inProgress: a.inProgress,
	unpaid: a.unpaid,
	retried: a.retried
});
const withAmounts = (a: Acc) => ({
	...counts(a),
	paidAmount: moneyText(a.paidAmount),
	outstandingAmount: moneyText(a.outstandingAmount)
});

async function obligationsOf(where: Prisma.PayrollEmployeeResultWhereInput) {
	const results = await prisma.payrollEmployeeResult.findMany({
		where,
		select: {
			id: true,
			payrollRunId: true,
			netPay: true,
			branchIdSnapshot: true,
			branchNameSnapshot: true,
			departmentIdSnapshot: true,
			departmentNameSnapshot: true
		}
	});
	const map = await resolveObligations(
		prisma,
		results.map((r) => r.id)
	);
	return results.map((r) => {
		const o = map.get(r.id);
		return { ...r, status: o?.status ?? ('UNPAID' as const), attempts: o?.attempts.length ?? 0 };
	});
}

/** Dashboard payments widget — counts only (no amount), latest finalized payroll month. */
export async function paymentOperational(companyId?: number) {
	const payrollMonth = await latestFinalizedMonth(companyId);
	if (!payrollMonth) return { payrollMonth: null, ...counts(emptyAcc()) };
	const rows = await obligationsOf({
		run: { status: 'FINALIZED', payrollMonth, ...(companyId ? { companyId } : {}) }
	});
	const acc = emptyAcc();
	for (const r of rows) add(acc, r.status, r.netPay, r.attempts);
	return { payrollMonth, ...counts(acc) };
}

/** GET /reports/payments/summary */
export async function getPaymentSummary(auth: AuthContext, query: PaymentReportQuery) {
	const groupBy = parseGroupBy(query.groupBy, PAYMENT_GROUP_BY, 'run');
	const ctx = await resolveCompanyContext(auth, {
		companyId: query.companyId,
		branchId: query.branchId,
		departmentId: query.departmentId
	});
	const payrollMonth = query.payrollMonth ?? (await latestFinalizedMonth(ctx.companyId));
	const runs = await finalizedRuns(ctx.companyId, payrollMonth, undefined);
	const rows = runs.length ? await obligationsOf(snapshotResultWhere(runs, ctx.filter)) : [];

	const totals = emptyAcc();
	const byGroup = new Map<string, Acc>();
	const names = new Map<string, { code: string | null; label: string }>();
	for (const run of runs)
		names.set(String(run.id), { code: run.period.code, label: run.period.name });
	for (const r of rows) {
		add(totals, r.status, r.netPay, r.attempts);
		if (groupBy === 'none') continue;
		const key =
			groupBy === 'run'
				? groupKey(r.payrollRunId)
				: groupBy === 'branch'
					? groupKey(r.branchIdSnapshot)
					: groupKey(r.departmentIdSnapshot);
		if (groupBy === 'branch' && r.branchIdSnapshot && r.branchNameSnapshot) {
			names.set(key, { code: null, label: r.branchNameSnapshot });
		}
		if (groupBy === 'department' && r.departmentIdSnapshot && r.departmentNameSnapshot) {
			names.set(key, { code: null, label: r.departmentNameSnapshot });
		}
		let g = byGroup.get(key);
		if (!g) byGroup.set(key, (g = emptyAcc()));
		add(g, r.status, r.netPay, r.attempts);
	}
	const groups: ReportGroup<ReturnType<typeof withAmounts>>[] = [...byGroup.entries()].map(
		([key, acc]) => ({
			key,
			code: names.get(key)?.code ?? null,
			label: key === UNASSIGNED_KEY ? UNASSIGNED_LABEL : (names.get(key)?.label ?? key),
			metrics: withAmounts(acc)
		})
	);

	return {
		generatedAt: new Date(),
		context: {
			companyId: ctx.companyId,
			payrollMonth,
			branchId: ctx.filter.branchId ?? null,
			departmentId: ctx.filter.departmentId ?? null,
			groupBy,
			currencyCode: runs[0]?.currencyCode ?? null,
			source: 'PAYMENT_OBLIGATION_RESOLVER'
		},
		totals: withAmounts(totals),
		groups
	};
}

// ============================================================================================
// Phase 17B — DETAIL: one row per OBLIGATION (not per attempt)
// ============================================================================================

export interface PaymentDetailFilters {
	companyId?: number;
	branchId?: number;
	departmentId?: number;
	payrollMonth?: string;
	status?: ObligationStatus;
}

/** ATTEMPT_SELECT (the resolver's own fields) + the few display facts of an attempt. No bank data. */
const DETAIL_ATTEMPT_SELECT = {
	...ATTEMPT_SELECT,
	paidAt: true,
	reversal: { select: { effectiveDate: true } }
} satisfies Prisma.PayrollPaymentItemSelect;

/**
 * Obligations of the FINALIZED results of the month (same population as the summary) resolved with the
 * Phase 15 chain builder (`buildObligations`): status / method / paidAt / reversal date are those of the
 * LATEST live attempt; attemptCount = live attempts of the chain (original FAILED → retry PAID = ONE row,
 * PAID, 2 attempts). amount = the finalized netPay. Account numbers (encrypted / last 4), bank names and
 * every bank / payment / transfer / instruction reference are never selected.
 */
export async function paymentDetailRows(
	auth: AuthContext,
	q: PaymentDetailFilters,
	guard: (count: number) => void
) {
	const ctx = await resolveCompanyContext(auth, q);
	const payrollMonth = q.payrollMonth ?? (await latestFinalizedMonth(ctx.companyId));
	const runs = await finalizedRuns(ctx.companyId, payrollMonth, undefined);
	const where = snapshotResultWhere(runs, ctx.filter);
	const results = runs.length
		? await prisma.payrollEmployeeResult.findMany({
				where,
				select: {
					id: true,
					payrollRunId: true,
					employeeCodeSnapshot: true,
					employeeNameSnapshot: true,
					branchNameSnapshot: true,
					departmentNameSnapshot: true,
					currencyCode: true,
					netPay: true
				}
			})
		: [];
	const items = results.length
		? await prisma.payrollPaymentItem.findMany({
				where: { payrollEmployeeResultId: { in: results.map((r) => r.id) } },
				select: DETAIL_ATTEMPT_SELECT
			})
		: [];
	const chains = buildObligations(items);
	const runOf = new Map(runs.map((r) => [r.id, r]));
	const rows = results
		.map((r) => {
			const o = chains.get(r.id);
			const latest = o?.latest ?? null;
			const status: ObligationStatus = o?.status ?? 'UNPAID';
			const attempts = o?.attempts.length ?? 0;
			return {
				payrollMonth: runOf.get(r.payrollRunId)!.payrollMonth,
				periodCode: runOf.get(r.payrollRunId)!.period.code,
				employeeCode: r.employeeCodeSnapshot,
				employeeName: r.employeeNameSnapshot,
				branch: r.branchNameSnapshot,
				department: r.departmentNameSnapshot,
				settlementStatus: status as string,
				paymentMethod: (latest?.paymentMethod as string | null) ?? null,
				attemptCount: attempts,
				retried: attempts > 1,
				paidAt: status === 'PAID' ? (latest?.paidAt?.toISOString() ?? null) : null,
				reversedOn:
					status === 'REVERSED' && latest?.reversal ? isoDate(latest.reversal.effectiveDate) : null,
				amount: moneyText(r.netPay),
				currencyCode: r.currencyCode
			};
		})
		.filter((row) => !q.status || row.settlementStatus === q.status);
	guard(rows.length);
	return {
		context: {
			companyId: ctx.companyId,
			payrollMonth,
			branchId: ctx.filter.branchId ?? null,
			departmentId: ctx.filter.departmentId ?? null,
			status: q.status ?? null,
			currencyCode: runs[0]?.currencyCode ?? null,
			source: 'PAYMENT_OBLIGATION_RESOLVER'
		},
		rows
	};
}
