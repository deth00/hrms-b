import { Prisma, type AccountingEventType, type PayrollJournalStatus } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import type { AuthContext } from '../../types/express.js';
import type { AccountingReportQuery } from '../../validation/reporting.schema.js';
import { reversalAccountingState, sourceKey } from '../payrollAccounting.service.js';
import { resolveCompanyContext } from './reportingScope.service.js';
import {
	ReportErrors,
	isoDate,
	moneyText,
	parseGroupBy,
	type ReportGroup
} from './reportingCommon.js';

/**
 * Phase 17A — ACCOUNTING analytics, from the Phase 16 journals themselves (PayrollJournal status and its
 * stored totalDebit / totalCredit). Nothing is derived from payroll again and nothing is written.
 *
 *   draft / validated / posted / cancelled — journals per status (optionally in an accounting-date range)
 *   postedDebit / postedCredit — Σ of POSTED journals' stored totals (Decimal → fixed-2 strings)
 *   pendingSettlement — PAID payment items with no LIVE settlement journal source (same source keys as
 *       the batch accounting status)
 *   pendingReversal   — payment reversals in state PENDING per `reversalAccountingState` (their item's
 *       settlement journal is POSTED and no reversal journal exists yet)
 * Journal lines (employee codes) are never read here; responses carry counts and totals only.
 */
const ZERO = new Prisma.Decimal(0);
export const ACCOUNTING_GROUP_BY = ['none', 'journalType'] as const;
const STATUSES: PayrollJournalStatus[] = ['DRAFT', 'VALIDATED', 'POSTED', 'CANCELLED'];

interface Acc {
	draft: number;
	validated: number;
	posted: number;
	cancelled: number;
	postedDebit: Prisma.Decimal;
	postedCredit: Prisma.Decimal;
}
const emptyAcc = (): Acc => ({
	draft: 0,
	validated: 0,
	posted: 0,
	cancelled: 0,
	postedDebit: ZERO,
	postedCredit: ZERO
});
const FIELD: Record<PayrollJournalStatus, 'draft' | 'validated' | 'posted' | 'cancelled'> = {
	DRAFT: 'draft',
	VALIDATED: 'validated',
	POSTED: 'posted',
	CANCELLED: 'cancelled'
};
const counts = (a: Acc) => ({
	draft: a.draft,
	validated: a.validated,
	posted: a.posted,
	cancelled: a.cancelled
});
const withTotals = (a: Acc) => ({
	...counts(a),
	postedDebit: moneyText(a.postedDebit),
	postedCredit: moneyText(a.postedCredit),
	postedBalanced: a.postedDebit.equals(a.postedCredit)
});

export const JOURNAL_TYPE_LABEL: Record<AccountingEventType, string> = {
	PAYROLL_ACCRUAL: 'ບັນທຶກຄ້າງຈ່າຍເງິນເດືອນ',
	PAYMENT_SETTLEMENT: 'ບັນທຶກການຈ່າຍເງິນ',
	PAYMENT_REVERSAL: 'ບັນທຶກຍົກເລີກການຈ່າຍ'
};

/** PAID-but-unaccounted items and reversals awaiting their reversal journal (optionally one company). */
export async function accountingPending(companyId?: number) {
	const [paidItems, reversals] = await Promise.all([
		prisma.payrollPaymentItem.findMany({
			where: { status: 'PAID', ...(companyId ? { batch: { companyId } } : {}) },
			select: { id: true }
		}),
		prisma.payrollPaymentReversal.findMany({
			where: companyId ? { companyId } : {},
			select: { id: true, paymentItemId: true }
		})
	]);
	const keys = [
		...paidItems.map((i) => sourceKey.settlement(i.id)),
		...reversals.map((r) => sourceKey.settlement(r.paymentItemId)),
		...reversals.map((r) => sourceKey.reversal(r.id))
	];
	const live = keys.length
		? await prisma.payrollJournalSource.findMany({
				where: { activeKey: { in: [...new Set(keys)] } },
				select: { activeKey: true, journal: { select: { status: true } } }
			})
		: [];
	const byKey = new Map(live.map((s) => [s.activeKey as string, s.journal]));
	return {
		pendingSettlement: paidItems.filter((i) => !byKey.has(sourceKey.settlement(i.id))).length,
		pendingReversal: reversals.filter(
			(r) =>
				reversalAccountingState(
					byKey.get(sourceKey.settlement(r.paymentItemId)) ?? null,
					byKey.get(sourceKey.reversal(r.id)) ?? null
				) === 'PENDING'
		).length
	};
}

/** Dashboard accounting widget — journal counts per status + pending work (no amounts). */
export async function accountingOperational(companyId?: number) {
	const [groups, pending] = await Promise.all([
		prisma.payrollJournal.groupBy({
			by: ['status'],
			where: companyId ? { companyId } : {},
			_count: { _all: true }
		}),
		accountingPending(companyId)
	]);
	const acc = emptyAcc();
	for (const g of groups) acc[FIELD[g.status]] += g._count._all;
	return { ...counts(acc), ...pending };
}

/** GET /reports/accounting/summary */
export async function getAccountingSummary(auth: AuthContext, query: AccountingReportQuery) {
	const groupBy = parseGroupBy(query.groupBy, ACCOUNTING_GROUP_BY, 'journalType');
	if (query.from && query.to && query.from.getTime() > query.to.getTime()) {
		throw ReportErrors.rangeInvalid('ວັນທີເລີ່ມຕ້ອງບໍ່ຫຼັງວັນທີສິ້ນສຸດ');
	}
	const ctx = await resolveCompanyContext(auth, { companyId: query.companyId });
	const where: Prisma.PayrollJournalWhereInput = {
		companyId: ctx.companyId,
		...(query.journalType ? { journalType: query.journalType } : {}),
		...(query.from || query.to
			? {
					accountingDate: {
						...(query.from ? { gte: query.from } : {}),
						...(query.to ? { lte: query.to } : {})
					}
				}
			: {})
	};
	const [rows, pending, settings] = await Promise.all([
		prisma.payrollJournal.groupBy({
			by: ['journalType', 'status'],
			where,
			_count: { _all: true },
			_sum: { totalDebit: true, totalCredit: true }
		}),
		accountingPending(ctx.companyId),
		prisma.payrollSettings.findUnique({
			where: { companyId: ctx.companyId },
			select: { currencyCode: true }
		})
	]);

	const totals = emptyAcc();
	const byType = new Map<AccountingEventType, Acc>();
	for (const r of rows) {
		const n = r._count._all;
		const targets = [totals];
		if (groupBy === 'journalType') {
			let g = byType.get(r.journalType);
			if (!g) byType.set(r.journalType, (g = emptyAcc()));
			targets.push(g);
		}
		for (const t of targets) {
			t[FIELD[r.status]] += n;
			if (r.status === 'POSTED') {
				t.postedDebit = t.postedDebit.plus(r._sum.totalDebit ?? 0);
				t.postedCredit = t.postedCredit.plus(r._sum.totalCredit ?? 0);
			}
		}
	}
	const groups: ReportGroup<ReturnType<typeof withTotals>>[] = [...byType.entries()].map(
		([key, acc]) => ({ key, code: key, label: JOURNAL_TYPE_LABEL[key], metrics: withTotals(acc) })
	);

	return {
		generatedAt: new Date(),
		context: {
			companyId: ctx.companyId,
			from: isoDate(query.from ?? null),
			to: isoDate(query.to ?? null),
			journalType: query.journalType ?? null,
			groupBy,
			currencyCode: settings?.currencyCode ?? null,
			statuses: STATUSES,
			source: 'PAYROLL_JOURNALS'
		},
		totals: { ...withTotals(totals), ...pending },
		groups
	};
}

// ============================================================================================
// Phase 17B — DETAIL: one row per JOURNAL LINE
// ============================================================================================

export interface AccountingDetailFilters {
	companyId?: number;
	from?: Date;
	to?: Date;
	journalType?: AccountingEventType;
	status?: PayrollJournalStatus;
}

/**
 * Journal lines exactly as stored (Phase 16 snapshots: account code / name, dimension codes, debit /
 * credit). The line's `sourceReferenceSnapshot` (which can hold a payment instruction reference) and the
 * source ids are NEVER selected; there is no bank data on journals. Σ debit / credit of POSTED lines
 * equals the summary's posted totals (a journal's totals are the sums of its lines).
 */
export async function accountingDetailRows(
	auth: AuthContext,
	q: AccountingDetailFilters,
	guard: (count: number) => void
) {
	if (q.from && q.to && q.from.getTime() > q.to.getTime()) {
		throw ReportErrors.rangeInvalid('ວັນທີເລີ່ມຕ້ອງບໍ່ຫຼັງວັນທີສິ້ນສຸດ');
	}
	const ctx = await resolveCompanyContext(auth, { companyId: q.companyId });
	const journalWhere: Prisma.PayrollJournalWhereInput = {
		companyId: ctx.companyId,
		...(q.journalType ? { journalType: q.journalType } : {}),
		...(q.status ? { status: q.status } : {}),
		...(q.from || q.to
			? {
					accountingDate: {
						...(q.from ? { gte: q.from } : {}),
						...(q.to ? { lte: q.to } : {})
					}
				}
			: {})
	};
	const where: Prisma.PayrollJournalLineWhereInput = { journal: journalWhere };
	guard(await prisma.payrollJournalLine.count({ where }));
	const [lines, settings] = await Promise.all([
		prisma.payrollJournalLine.findMany({
			where,
			select: {
				lineNo: true,
				accountCodeSnapshot: true,
				accountNameSnapshot: true,
				description: true,
				employeeCodeSnapshot: true,
				branchCodeSnapshot: true,
				departmentCodeSnapshot: true,
				debit: true,
				credit: true,
				journal: {
					select: {
						journalNumber: true,
						journalType: true,
						accountingDate: true,
						status: true,
						currencyCode: true
					}
				}
			}
		}),
		prisma.payrollSettings.findUnique({
			where: { companyId: ctx.companyId },
			select: { currencyCode: true }
		})
	]);
	return {
		context: {
			companyId: ctx.companyId,
			from: isoDate(q.from ?? null),
			to: isoDate(q.to ?? null),
			journalType: q.journalType ?? null,
			status: q.status ?? null,
			currencyCode: settings?.currencyCode ?? null,
			source: 'PAYROLL_JOURNAL_LINES'
		},
		rows: lines.map((l) => ({
			journalNumber: l.journal.journalNumber,
			journalType: l.journal.journalType as string,
			accountingDate: isoDate(l.journal.accountingDate),
			journalStatus: l.journal.status as string,
			lineNo: l.lineNo,
			accountCode: l.accountCodeSnapshot,
			accountName: l.accountNameSnapshot,
			description: l.description,
			employeeCode: l.employeeCodeSnapshot,
			branchCode: l.branchCodeSnapshot,
			departmentCode: l.departmentCodeSnapshot,
			debit: moneyText(l.debit),
			credit: moneyText(l.credit),
			currencyCode: l.journal.currencyCode
		}))
	};
}
