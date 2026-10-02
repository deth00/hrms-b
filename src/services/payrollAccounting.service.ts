import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
	AccountingDimension,
	AccountingEventType,
	GLAccount,
	PayrollAccountingMapping,
	PayrollJournal,
	JournalSourceEntity,
	PayrollJournalLine
} from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { idCol } from '../lib/sqlIds.js';
import { Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { laosDateOf } from '../lib/dates.js';
import { moneyString, ZERO } from '../lib/money.js';
import { buildCsv, buildXlsx, type Cell } from '../lib/bankFile.js';
import {
	ACCOUNTING_TEXT_CODE_FIELDS,
	ACCRUAL_SIDE,
	ACCRUAL_SOURCES,
	accrualSourceOfItem,
	itemSign,
	PAYMENT_SIDE,
	SOURCE_LABEL,
	type AccountingExportField,
	type AccrualSource,
	type NaturalSide,
	type PaymentSource
} from '../lib/accountingSources.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import {
	applicableRuleSet,
	profileConfigOf,
	type AccountingProfileConfig
} from './accountingSettings.service.js';
import type { JournalListQuery } from '../validation/accounting.schema.js';

/**
 * PAYROLL ACCOUNTING JOURNALS (Phase 16) — an internal payroll sub-ledger inside LaoHR.
 *
 *   FINALIZED payroll run ──▶ PAYROLL_ACCRUAL journal   (expense / withholdings / net payable)
 *   PAID payment items    ──▶ PAYMENT_SETTLEMENT journal (Dr payroll payable / Cr bank or cash clearing)
 *   payment reversal      ──▶ PAYMENT_REVERSAL journal   (the ORIGINAL posted settlement lines, swapped)
 *
 *   DRAFT ──validate──▶ VALIDATED ──post──▶ POSTED (immutable)        DRAFT / VALIDATED ──cancel──▶ CANCELLED
 *
 *  - NEVER calculates payroll and NEVER writes a payroll / payslip / payment table: it only re-groups the
 *    immutable finalized result items, statutory results and payment items into accounting lines.
 *  - Balanced by construction and re-checked with Decimal arithmetic (ACCOUNTING_JOURNAL_UNBALANCED).
 *    Zero lines are omitted; a negative amount swaps the side — no negative debit / credit is stored.
 *  - Duplicate protection: every accounted source (run / payment item / reversal) holds a UNIQUE
 *    PayrollJournalSource.activeKey while its journal is not CANCELLED, taken under the source's row lock.
 *  - POSTING only locks the journal in LaoHR. Nothing is sent to an ERP / accounting system / bank.
 *  - Audit metadata carries ids, counts and statuses only — never amounts.
 */
type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;

const TX_OPTIONS = { timeout: 60_000, maxWait: 15_000 };
const isoDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

type MappingRow = PayrollAccountingMapping & {
	debitAccount: GLAccount | null;
	creditAccount: GLAccount | null;
};

const JOURNAL_LABEL: Record<AccountingEventType, string> = {
	PAYROLL_ACCRUAL: 'ບັນທຶກຄ່າໃຊ້ຈ່າຍເງິນເດືອນ',
	PAYMENT_SETTLEMENT: 'ບັນທຶກການຈ່າຍເງິນເດືອນ',
	PAYMENT_REVERSAL: 'ບັນທຶກຍົກເລີກການຈ່າຍ'
};

// ============================================================================================
// shared helpers
// ============================================================================================

export const sourceKey = {
	accrual: (runId: number) => `ACCRUAL:${runId}`,
	settlement: (itemId: number) => `SETTLEMENT:${itemId}`,
	reversal: (reversalId: number) => `REVERSAL:${reversalId}`
};

/** Journal numbers are unique per company; a collision (e.g. after a cancel) gets a stable "-2", "-3"… */
async function uniqueJournalNumber(tx: Tx, companyId: number, base: string) {
	const safe =
		base
			.replace(/[^A-Za-z0-9-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 70) || 'PAYGL';
	const taken = await tx.payrollJournal.findMany({
		where: { companyId, journalNumber: { startsWith: safe } },
		select: { journalNumber: true }
	});
	const used = new Set(taken.map((t) => t.journalNumber));
	if (!used.has(safe)) return safe;
	for (let n = 2; ; n++) if (!used.has(`${safe}-${n}`)) return `${safe}-${n}`;
}

function missingMappingError(
	missing: {
		eventType: AccountingEventType;
		sourceType: string;
		dimension: string | null;
		affectedCount: number;
	}[]
) {
	const labels = missing.map((m) => SOURCE_LABEL[m.sourceType]?.lo ?? m.sourceType).join(', ');
	const first = missing[0]!;
	return Errors.conflict(
		'MISSING_ACCOUNTING_MAPPING',
		`ຍັງບໍ່ໄດ້ຕັ້ງຄ່າບັນຊີສຳລັບ ${labels} — ກະລຸນາຕັ້ງຄ່າໃນ ການຕັ້ງຄ່າ › ບັນຊີເງິນເດືອນ`,
		{
			sourceType: first.sourceType,
			eventType: first.eventType,
			dimension: first.dimension,
			affectedCount: first.affectedCount,
			missing
		}
	);
}

function inactiveAccountError(codes: string[]) {
	return Errors.conflict(
		'ACCOUNTING_ACCOUNT_INACTIVE',
		`ບັນຊີ ${codes.join(', ')} ຖືກປິດການໃຊ້ງານແລ້ວ — ກະລຸນາແກ້ໄຂການຕັ້ງຄ່າບັນຊີ`,
		{ accountCodes: codes }
	);
}

interface DraftLine {
	account: GLAccount;
	debit: Dec;
	credit: Dec;
	description: string;
	employeeId?: number | null;
	employeeCode?: string | null;
	branchId?: number | null;
	branchCode?: string | null;
	departmentId?: number | null;
	departmentCode?: string | null;
	sourceType: string;
	/**
	 * WHICH record the line comes from. Numeric ids collide across tables (a run and a payroll result can
	 * both be 7), so the id is always stored WITH its entity (PayrollJournalLine.sourceEntity).
	 */
	source: { entity: JournalSourceEntity; id: number } | null;
	sourceReference?: string | null;
}

/** Signed amount → one line on the natural side, or the opposite side when negative; zero → none. */
function linesFor(
	side: 'DEBIT' | 'CREDIT',
	account: GLAccount,
	signed: Dec,
	base: Omit<DraftLine, 'account' | 'debit' | 'credit'>
): DraftLine[] {
	if (signed.isZero()) return [];
	const abs = signed.abs();
	const onDebit = (side === 'DEBIT') === signed.greaterThan(0);
	return [{ ...base, account, debit: onDebit ? abs : ZERO, credit: onDebit ? ZERO : abs }];
}

function assertBalanced(lines: { debit: Dec; credit: Dec }[]) {
	const debit = lines.reduce((s, l) => s.plus(l.debit), ZERO);
	const credit = lines.reduce((s, l) => s.plus(l.credit), ZERO);
	const oneSided = lines.every(
		(l) =>
			(l.debit.greaterThan(0) && l.credit.isZero()) || (l.credit.greaterThan(0) && l.debit.isZero())
	);
	if (!debit.equals(credit) || !oneSided) {
		throw Errors.conflict(
			'ACCOUNTING_JOURNAL_UNBALANCED',
			'ບັນທຶກບັນຊີບໍ່ສົມດຸນ (ຍອດໜີ້ ບໍ່ເທົ່າກັບ ຍອດມີ) — ບໍ່ສາມາດບັນທຶກໄດ້'
		);
	}
	return { debit, credit };
}

function fillTemplate(
	template: string | null,
	vars: Record<string, string | null | undefined>,
	fallback: string
) {
	if (!template) return fallback;
	const out = template.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '');
	return out.trim().slice(0, 300) || fallback;
}

async function insertJournal(
	tx: Tx,
	header: {
		companyId: number;
		journalNumberBase: string;
		journalType: AccountingEventType;
		sourceType: 'PAYROLL_RUN' | 'PAYMENT_BATCH' | 'PAYMENT_REVERSAL';
		sourceId: number;
		accountingDate: Date;
		currencyCode: string;
		ruleSetId: number | null;
		ruleSetVersion: number | null;
		description: string;
		reversedJournalId?: number | null;
	},
	lines: DraftLine[],
	sources: {
		sourceType: 'PAYROLL_RUN' | 'PAYMENT_ITEM' | 'PAYMENT_REVERSAL';
		sourceId: number;
		key: string;
	}[],
	actorUserId: number
) {
	if (lines.length === 0) {
		throw Errors.conflict('ACCOUNTING_NOTHING_TO_ACCOUNT', 'ບໍ່ມີຍອດເງິນທີ່ຈະບັນທຶກບັນຊີ');
	}
	const totals = assertBalanced(lines);
	const journalNumber = await uniqueJournalNumber(tx, header.companyId, header.journalNumberBase);
	const j = await tx.payrollJournal.create({
		data: {
			companyId: header.companyId,
			journalNumber,
			journalType: header.journalType,
			sourceType: header.sourceType,
			sourceId: header.sourceId,
			accountingDate: header.accountingDate,
			currencyCode: header.currencyCode,
			status: 'DRAFT',
			ruleSetId: header.ruleSetId,
			ruleSetVersion: header.ruleSetVersion,
			totalDebit: totals.debit,
			totalCredit: totals.credit,
			lineCount: lines.length,
			description: header.description.slice(0, 300),
			reversedJournalId: header.reversedJournalId ?? null,
			createdByUserId: actorUserId
		}
	});
	await tx.payrollJournalLine.createMany({
		data: lines.map((l, i) => ({
			journalId: j.id,
			lineNo: i + 1,
			accountId: l.account.id,
			accountCodeSnapshot: l.account.code,
			accountNameSnapshot: l.account.name,
			debit: l.debit,
			credit: l.credit,
			description: l.description.slice(0, 300),
			employeeId: l.employeeId ?? null,
			employeeCodeSnapshot: l.employeeCode ?? null,
			branchId: l.branchId ?? null,
			branchCodeSnapshot: l.branchCode ?? null,
			departmentId: l.departmentId ?? null,
			departmentCodeSnapshot: l.departmentCode ?? null,
			sourceType: l.sourceType,
			sourceEntity: l.source?.entity ?? null,
			sourceId: l.source?.id ?? null,
			sourceReferenceSnapshot: l.sourceReference?.slice(0, 150) ?? null
		}))
	});
	// the UNIQUE activeKey makes a second live journal for the same source impossible (P2002)
	await tx.payrollJournalSource.createMany({
		data: sources.map((s) => ({
			journalId: j.id,
			journalType: header.journalType,
			sourceType: s.sourceType,
			sourceId: s.sourceId,
			activeKey: s.key
		}))
	});
	await writeAuditEvent(tx, {
		action: AuditAction.PAYROLL_ACCOUNTING_JOURNAL_CREATED,
		entityType: AuditEntity.PAYROLL_JOURNAL,
		entityId: j.id,
		companyId: j.companyId,
		actorUserId,
		metadata: {
			journalId: j.id,
			journalNumber: j.journalNumber,
			journalType: j.journalType,
			sourceType: j.sourceType,
			sourceId: j.sourceId,
			ruleSetId: j.ruleSetId,
			ruleSetVersion: j.ruleSetVersion,
			reversedJournalId: j.reversedJournalId,
			lineCount: lines.length,
			sourceCount: sources.length,
			status: 'DRAFT'
		}
	});
	return j;
}

const isUniqueViolation = (err: unknown) =>
	err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// ============================================================================================
// PAYROLL ACCRUAL
// ============================================================================================

const DIMENSION_NONE = '∅';

/**
 * POST /payroll/runs/:id/accounting-journal — ONE live accrual journal per FINALIZED run. Dimensions
 * come from the RESULT snapshots (the assignment at calculation time), never the current employee.
 */
export async function createAccrualJournal(runId: number, actorUserId: number) {
	try {
		const journalId = await prisma.$transaction(async (tx) => {
			// row lock FIRST (before any plain read) — concurrent requests queue here
			const locked = await tx.$queryRaw<{ id: number }[]>`
				SELECT ${idCol()} AS id FROM payroll_runs WHERE ${idCol()} = ${runId} FOR UPDATE`;
			if (locked.length === 0) throw Errors.notFound('ບໍ່ພົບການຄິດໄລ່ເງິນເດືອນ');
			const live = await tx.payrollJournalSource.findUnique({
				where: { activeKey: sourceKey.accrual(runId) },
				select: { journalId: true }
			});
			if (live) {
				throw Errors.conflict(
					'PAYROLL_ACCRUAL_JOURNAL_ALREADY_EXISTS',
					'ມີບັນທຶກບັນຊີຂອງງວດເງິນເດືອນນີ້ແລ້ວ — ຍົກເລີກບັນທຶກເດີມກ່ອນ ຖ້າຕ້ອງການສ້າງໃໝ່',
					{ journalId: live.journalId }
				);
			}
			const run = await tx.payrollRun.findUnique({
				where: { id: runId },
				include: {
					period: true,
					results: {
						include: { items: true, statutoryResult: true },
						orderBy: { employeeCodeSnapshot: 'asc' }
					}
				}
			});
			if (!run) throw Errors.notFound('ບໍ່ພົບການຄິດໄລ່ເງິນເດືອນ');
			if (run.status !== 'FINALIZED') {
				throw Errors.conflict(
					'PAYROLL_RUN_NOT_FINALIZED',
					'ສ້າງບັນທຶກບັນຊີໄດ້ສະເພາະການຄິດໄລ່ເງິນເດືອນທີ່ FINALIZED ແລ້ວ'
				);
			}
			const accountingDate = run.period.endDate;
			const ruleSet = await applicableRuleSet(tx, run.companyId, accountingDate);
			if (!ruleSet) {
				throw Errors.conflict(
					'ACCOUNTING_RULESET_NOT_FOUND',
					`ບໍ່ມີກົດການບັນທຶກບັນຊີທີ່ເປີດໃຊ້ງານສຳລັບວັນທີ ${isoDate(accountingDate)} — ກະລຸນາຕັ້ງຄ່າໃນ ການຕັ້ງຄ່າ › ບັນຊີເງິນເດືອນ`
				);
			}
			const lines = await buildAccrualLines(tx, run, ruleSet.mappings);
			const j = await insertJournal(
				tx,
				{
					companyId: run.companyId,
					journalNumberBase: `PAYGL-${run.period.code}`,
					journalType: 'PAYROLL_ACCRUAL',
					sourceType: 'PAYROLL_RUN',
					sourceId: run.id,
					accountingDate,
					currencyCode: run.currencyCode,
					ruleSetId: ruleSet.id,
					ruleSetVersion: ruleSet.version,
					description: `${JOURNAL_LABEL.PAYROLL_ACCRUAL} ${run.period.name} (${run.period.code})`
				},
				lines,
				[{ sourceType: 'PAYROLL_RUN', sourceId: run.id, key: sourceKey.accrual(run.id) }],
				actorUserId
			);
			return j.id;
		}, TX_OPTIONS);
		return getJournal(journalId);
	} catch (err) {
		if (isUniqueViolation(err)) {
			throw Errors.conflict(
				'PAYROLL_ACCRUAL_JOURNAL_ALREADY_EXISTS',
				'ມີບັນທຶກບັນຊີຂອງງວດເງິນເດືອນນີ້ແລ້ວ'
			);
		}
		throw err;
	}
}

type RunForAccrual = Prisma.PayrollRunGetPayload<{
	include: { period: true; results: { include: { items: true; statutoryResult: true } } };
}>;

async function buildAccrualLines(tx: Tx, run: RunForAccrual, mappings: MappingRow[]) {
	// 1. per result, the signed amount of every accrual source (from the immutable finalized data only)
	type Contribution = {
		source: AccrualSource;
		amount: Dec;
		result: RunForAccrual['results'][number];
	};
	const contributions: Contribution[] = [];
	for (const r of run.results) {
		if (r.currencyCode !== run.currencyCode) {
			throw Errors.conflict(
				'ACCOUNTING_CURRENCY_MISMATCH',
				'ຜົນເງິນເດືອນມີຫຼາຍສະກຸນເງິນ — ບັນທຶກບັນຊີໜຶ່ງໃຊ້ໄດ້ສະກຸນເງິນດຽວ'
			);
		}
		const signed = new Map<AccrualSource, Dec>();
		const add = (s: AccrualSource, v: Dec) => signed.set(s, (signed.get(s) ?? ZERO).plus(v));
		let derivedNet = ZERO;
		for (const item of r.items) {
			const src = accrualSourceOfItem(item.source, item.type);
			add(src, item.amount.times(itemSign(src, item.type)));
			derivedNet =
				item.type === 'EARNING' ? derivedNet.plus(item.amount) : derivedNet.minus(item.amount);
		}
		// legacy / incomplete data: the itemization must explain the finalized net pay exactly
		if (!derivedNet.equals(r.netPay)) {
			throw Errors.conflict(
				'ACCOUNTING_SOURCE_DATA_UNAVAILABLE',
				'ຂໍ້ມູນລາຍການເງິນເດືອນບໍ່ຄົບຖ້ວນສຳລັບການບັນທຶກບັນຊີ (ລາຍການບໍ່ກົງກັບເງິນສຸດທິ) — ບໍ່ສາມາດສ້າງບັນທຶກໄດ້',
				{ resultId: r.id, employeeCode: r.employeeCodeSnapshot }
			);
		}
		add('NET_PAYABLE', r.netPay);
		const employerSso = r.statutoryResult?.employerSsoCurrentCycle ?? ZERO;
		add('EMPLOYER_SSO', employerSso);
		if (r.employerContributionTotal)
			add('EMPLOYER_CONTRIBUTION', r.employerContributionTotal.minus(employerSso));
		for (const [source, amount] of signed) {
			if (!amount.isZero()) contributions.push({ source, amount, result: r });
		}
	}

	// 2. every source with an amount needs an ACTIVE mapping with ACTIVE account(s)
	const mappingOf = new Map(
		mappings
			.filter((m) => m.eventType === 'PAYROLL_ACCRUAL' && m.status === 'ACTIVE')
			.map((m) => [m.sourceType, m])
	);
	const missing = new Map<AccrualSource, Set<number>>();
	for (const c of contributions) {
		const m = mappingOf.get(c.source);
		const side = ACCRUAL_SIDE[c.source];
		const ok = m && (side === 'CREDIT' || m.debitAccount) && (side === 'DEBIT' || m.creditAccount);
		if (!ok) missing.set(c.source, (missing.get(c.source) ?? new Set()).add(c.result.employeeId));
	}
	if (missing.size > 0) {
		throw missingMappingError(
			ACCRUAL_SOURCES.filter((s) => missing.has(s)).map((s) => ({
				eventType: 'PAYROLL_ACCRUAL' as const,
				sourceType: s,
				dimension: mappingOf.get(s)?.groupingDimension ?? null,
				affectedCount: missing.get(s)!.size
			}))
		);
	}
	const inactive = new Set<string>();
	for (const s of new Set(contributions.map((c) => c.source))) {
		const m = mappingOf.get(s)!;
		for (const a of [m.debitAccount, m.creditAccount])
			if (a && a.status !== 'ACTIVE') inactive.add(a.code);
	}
	if (inactive.size > 0) throw inactiveAccountError([...inactive].sort());

	// 3. dimension codes (looked up by the SNAPSHOT ids of the calculation-time assignment)
	const branchIds = [
		...new Set(run.results.map((r) => r.branchIdSnapshot).filter((x): x is number => x !== null))
	];
	const deptIds = [
		...new Set(
			run.results.map((r) => r.departmentIdSnapshot).filter((x): x is number => x !== null)
		)
	];
	const [branches, departments] = await Promise.all([
		tx.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, code: true } }),
		tx.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, code: true } })
	]);
	const branchCode = new Map(branches.map((b) => [b.id, b.code]));
	const deptCode = new Map(departments.map((d) => [d.id, d.code]));

	// 4. group by (source, dimension value)
	interface Group {
		source: AccrualSource;
		dimension: AccountingDimension;
		key: number | string;
		amount: Dec;
		employees: Set<number>;
		sample: RunForAccrual['results'][number];
	}
	const groups = new Map<string, Group>();
	const dimValue = (dim: AccountingDimension, r: RunForAccrual['results'][number]) => {
		switch (dim) {
			case 'BRANCH':
				return r.branchIdSnapshot ?? DIMENSION_NONE;
			case 'DEPARTMENT':
				return r.departmentIdSnapshot ?? DIMENSION_NONE;
			case 'EMPLOYEE':
				return r.employeeId;
			default:
				return 'COMPANY';
		}
	};
	for (const c of contributions) {
		const m = mappingOf.get(c.source)!;
		const key = `${c.source}|${dimValue(m.groupingDimension, c.result)}`;
		const g = groups.get(key) ?? {
			source: c.source,
			dimension: m.groupingDimension,
			key: dimValue(m.groupingDimension, c.result),
			amount: ZERO,
			employees: new Set<number>(),
			sample: c.result
		};
		g.amount = g.amount.plus(c.amount);
		g.employees.add(c.result.employeeId);
		groups.set(key, g);
	}

	// 5. deterministic order: source order, then the dimension code
	const dimCode = (g: Group) => {
		switch (g.dimension) {
			case 'BRANCH':
				return typeof g.key === 'number' ? (branchCode.get(g.key) ?? null) : null;
			case 'DEPARTMENT':
				return typeof g.key === 'number' ? (deptCode.get(g.key) ?? null) : null;
			case 'EMPLOYEE':
				return g.sample.employeeCodeSnapshot;
			default:
				return null;
		}
	};
	const ordered = [...groups.values()].sort(
		(a, b) =>
			ACCRUAL_SOURCES.indexOf(a.source) - ACCRUAL_SOURCES.indexOf(b.source) ||
			(dimCode(a) ?? '~').localeCompare(dimCode(b) ?? '~')
	);
	const lines: DraftLine[] = [];
	for (const g of ordered) {
		const m = mappingOf.get(g.source)!;
		const code = dimCode(g);
		const base = {
			employeeId: g.dimension === 'EMPLOYEE' ? g.sample.employeeId : null,
			employeeCode: g.dimension === 'EMPLOYEE' ? g.sample.employeeCodeSnapshot : null,
			branchId: g.dimension === 'BRANCH' && typeof g.key === 'number' ? g.key : null,
			branchCode: g.dimension === 'BRANCH' ? code : null,
			departmentId: g.dimension === 'DEPARTMENT' && typeof g.key === 'number' ? g.key : null,
			departmentCode: g.dimension === 'DEPARTMENT' ? code : null,
			sourceType: g.source,
			source:
				g.dimension === 'EMPLOYEE'
					? { entity: 'PAYROLL_RESULT' as const, id: g.sample.id }
					: { entity: 'PAYROLL_RUN' as const, id: run.id },
			sourceReference: run.period.code,
			description: fillTemplate(
				m.descriptionTemplate,
				{
					period: run.period.code,
					periodName: run.period.name,
					source: SOURCE_LABEL[g.source]?.lo,
					employee: g.dimension === 'EMPLOYEE' ? g.sample.employeeCodeSnapshot : null,
					branch: g.dimension === 'BRANCH' ? code : null,
					department: g.dimension === 'DEPARTMENT' ? code : null
				},
				`${SOURCE_LABEL[g.source]?.lo ?? g.source} ${run.period.code}${code ? ` · ${code}` : ''}`
			)
		};
		const side: NaturalSide = ACCRUAL_SIDE[g.source];
		if (side === 'DEBIT') lines.push(...linesFor('DEBIT', m.debitAccount!, g.amount, base));
		else if (side === 'CREDIT') lines.push(...linesFor('CREDIT', m.creditAccount!, g.amount, base));
		else {
			lines.push(...linesFor('DEBIT', m.debitAccount!, g.amount, base));
			lines.push(...linesFor('CREDIT', m.creditAccount!, g.amount, base));
		}
	}
	return lines;
}

// ============================================================================================
// PAYMENT SETTLEMENT
// ============================================================================================

/**
 * POST /payroll/payment-batches/:id/accounting-journal — PAID items of the batch not yet in a live
 * settlement journal (separate from the payment confirmation transaction). One line pair PER ITEM with
 * the EXACT paid amount: Dr PAYROLL_PAYABLE / Cr BANK_CLEARING (bank transfer) or CASH_CLEARING (cash).
 * Items paid later go into another settlement journal of the same batch.
 */
export async function createSettlementJournal(batchId: number, actorUserId: number) {
	try {
		const journalId = await prisma.$transaction(async (tx) => {
			const locked = await tx.$queryRaw<{ id: number }[]>`
				SELECT ${idCol()} AS id FROM payroll_payment_batches WHERE ${idCol()} = ${batchId} FOR UPDATE`;
			if (locked.length === 0) throw Errors.notFound('ບໍ່ພົບຊຸດການຈ່າຍ');
			const batch = await tx.payrollPaymentBatch.findUnique({
				where: { id: batchId },
				include: {
					items: {
						where: { status: 'PAID' },
						include: {
							result: {
								select: {
									id: true,
									branchIdSnapshot: true,
									departmentIdSnapshot: true,
									currencyCode: true
								}
							}
						},
						orderBy: { employeeCodeSnapshot: 'asc' }
					}
				}
			});
			if (!batch) throw Errors.notFound('ບໍ່ພົບຊຸດການຈ່າຍ');
			if (batch.items.length === 0) {
				throw Errors.conflict(
					'ACCOUNTING_NOTHING_TO_ACCOUNT',
					'ຊຸດການຈ່າຍນີ້ຍັງບໍ່ມີລາຍການທີ່ຈ່າຍແລ້ວ (PAID) ສຳລັບບັນທຶກບັນຊີ'
				);
			}
			const accounted = await tx.payrollJournalSource.findMany({
				where: { activeKey: { in: batch.items.map((i) => sourceKey.settlement(i.id)) } },
				select: { sourceId: true }
			});
			const done = new Set(accounted.map((a) => a.sourceId));
			const items = batch.items.filter((i) => !done.has(i.id));
			if (items.length === 0) {
				throw Errors.conflict(
					'PAYMENT_SETTLEMENT_ALREADY_ACCOUNTED',
					'ທຸກລາຍການທີ່ຈ່າຍແລ້ວຂອງຊຸດນີ້ ມີບັນທຶກບັນຊີແລ້ວ'
				);
			}
			if (items.some((i) => i.currencyCode !== batch.currencyCode)) {
				throw Errors.conflict(
					'ACCOUNTING_CURRENCY_MISMATCH',
					'ລາຍການຈ່າຍມີຫຼາຍສະກຸນເງິນ — ບັນທຶກບັນຊີໜຶ່ງໃຊ້ໄດ້ສະກຸນເງິນດຽວ'
				);
			}
			if (items.some((i) => !i.paymentMethod)) {
				throw Errors.conflict(
					'ACCOUNTING_SOURCE_DATA_UNAVAILABLE',
					'ລາຍການຈ່າຍບາງລາຍການບໍ່ມີວິທີຈ່າຍ — ບໍ່ສາມາດບັນທຶກບັນຊີໄດ້'
				);
			}
			// accounting date = the latest (Laos) paid date of the included items
			const accountingDate = items
				.map((i) => (i.paidAt ? laosDateOf(i.paidAt) : batch.paymentDate))
				.reduce((a, b) => (b > a ? b : a));
			const ruleSet = await applicableRuleSet(tx, batch.companyId, accountingDate);
			if (!ruleSet) {
				throw Errors.conflict(
					'ACCOUNTING_RULESET_NOT_FOUND',
					`ບໍ່ມີກົດການບັນທຶກບັນຊີທີ່ເປີດໃຊ້ງານສຳລັບວັນທີ ${isoDate(accountingDate)} — ກະລຸນາຕັ້ງຄ່າໃນ ການຕັ້ງຄ່າ › ບັນຊີເງິນເດືອນ`
				);
			}
			const mappingOf = new Map(
				ruleSet.mappings
					.filter((m) => m.eventType === 'PAYMENT_SETTLEMENT' && m.status === 'ACTIVE')
					.map((m) => [m.sourceType, m])
			);
			const clearingOf = (method: string): PaymentSource =>
				method === 'CASH' ? 'CASH_CLEARING' : 'BANK_CLEARING';
			const need = new Map<PaymentSource, number>();
			for (const i of items) {
				for (const s of ['PAYROLL_PAYABLE', clearingOf(i.paymentMethod!)] as PaymentSource[]) {
					const m = mappingOf.get(s);
					const acct = PAYMENT_SIDE[s] === 'DEBIT' ? m?.debitAccount : m?.creditAccount;
					if (!acct) need.set(s, (need.get(s) ?? 0) + 1);
				}
			}
			if (need.size > 0) {
				throw missingMappingError(
					[...need].map(([s, n]) => ({
						eventType: 'PAYMENT_SETTLEMENT' as const,
						sourceType: s,
						dimension: mappingOf.get(s)?.groupingDimension ?? null,
						affectedCount: n
					}))
				);
			}
			const used = new Set(['PAYROLL_PAYABLE', ...items.map((i) => clearingOf(i.paymentMethod!))]);
			const inactive = [...used]
				.map((s) => {
					const m = mappingOf.get(s)!;
					return PAYMENT_SIDE[s as PaymentSource] === 'DEBIT' ? m.debitAccount! : m.creditAccount!;
				})
				.filter((a) => a.status !== 'ACTIVE')
				.map((a) => a.code);
			if (inactive.length > 0) throw inactiveAccountError([...new Set(inactive)].sort());

			const [branches, departments] = await Promise.all([
				tx.branch.findMany({
					where: {
						id: {
							in: items.map((i) => i.result.branchIdSnapshot).filter((x): x is number => x !== null)
						}
					},
					select: { id: true, code: true }
				}),
				tx.department.findMany({
					where: {
						id: {
							in: items
								.map((i) => i.result.departmentIdSnapshot)
								.filter((x): x is number => x !== null)
						}
					},
					select: { id: true, code: true }
				})
			]);
			const branchCode = new Map(branches.map((b) => [b.id, b.code]));
			const deptCode = new Map(departments.map((d) => [d.id, d.code]));

			const lines: DraftLine[] = [];
			for (const i of items) {
				const reference = i.instructionReference ?? i.transferReference;
				for (const s of ['PAYROLL_PAYABLE', clearingOf(i.paymentMethod!)] as PaymentSource[]) {
					const m = mappingOf.get(s)!;
					const dim = m.groupingDimension;
					const bId = i.result.branchIdSnapshot;
					const dId = i.result.departmentIdSnapshot;
					const code =
						dim === 'EMPLOYEE'
							? i.employeeCodeSnapshot
							: dim === 'BRANCH'
								? bId
									? branchCode.get(bId)
									: null
								: dim === 'DEPARTMENT'
									? dId
										? deptCode.get(dId)
										: null
									: null;
					const side = PAYMENT_SIDE[s] as 'DEBIT' | 'CREDIT';
					lines.push(
						...linesFor(side, side === 'DEBIT' ? m.debitAccount! : m.creditAccount!, i.amount, {
							employeeId: dim === 'EMPLOYEE' ? i.employeeId : null,
							employeeCode: dim === 'EMPLOYEE' ? i.employeeCodeSnapshot : null,
							branchId: dim === 'BRANCH' ? bId : null,
							branchCode: dim === 'BRANCH' ? (code ?? null) : null,
							departmentId: dim === 'DEPARTMENT' ? dId : null,
							departmentCode: dim === 'DEPARTMENT' ? (code ?? null) : null,
							sourceType: s,
							source: { entity: 'PAYMENT_ITEM', id: i.id },
							sourceReference: reference,
							description: fillTemplate(
								m.descriptionTemplate,
								{
									batch: batch.batchNumber,
									reference,
									source: SOURCE_LABEL[s]?.lo,
									employee: dim === 'EMPLOYEE' ? i.employeeCodeSnapshot : null,
									branch: dim === 'BRANCH' ? code : null,
									department: dim === 'DEPARTMENT' ? code : null
								},
								`${SOURCE_LABEL[s]?.lo ?? s} ${batch.batchNumber}${code ? ` · ${code}` : ''}`
							)
						})
					);
				}
			}
			const seq = await tx.payrollJournal.count({
				where: { sourceType: 'PAYMENT_BATCH', sourceId: batchId, journalType: 'PAYMENT_SETTLEMENT' }
			});
			const j = await insertJournal(
				tx,
				{
					companyId: batch.companyId,
					journalNumberBase: `PAYST-${batch.batchNumber}-${seq + 1}`,
					journalType: 'PAYMENT_SETTLEMENT',
					sourceType: 'PAYMENT_BATCH',
					sourceId: batch.id,
					accountingDate,
					currencyCode: batch.currencyCode,
					ruleSetId: ruleSet.id,
					ruleSetVersion: ruleSet.version,
					description: `${JOURNAL_LABEL.PAYMENT_SETTLEMENT} ${batch.batchNumber} (${items.length} ລາຍການ)`
				},
				lines,
				items.map((i) => ({
					sourceType: 'PAYMENT_ITEM' as const,
					sourceId: i.id,
					key: sourceKey.settlement(i.id)
				})),
				actorUserId
			);
			return j.id;
		}, TX_OPTIONS);
		return getJournal(journalId);
	} catch (err) {
		if (isUniqueViolation(err)) {
			throw Errors.conflict(
				'PAYMENT_SETTLEMENT_ALREADY_ACCOUNTED',
				'ລາຍການຈ່າຍນີ້ມີບັນທຶກບັນຊີແລ້ວ'
			);
		}
		throw err;
	}
}

// ============================================================================================
// PAYMENT REVERSAL
// ============================================================================================

/**
 * POST /payroll/payment-reversals/:id/accounting-journal — reverses EXACTLY the lines of the POSTED
 * settlement journal that accounted the reversed item (debit ↔ credit, same accounts / snapshots, no
 * remapping). No posted settlement → nothing is created (ACCOUNTING_SETTLEMENT_NOT_POSTED).
 */
export async function createReversalJournal(reversalId: number, actorUserId: number) {
	try {
		const journalId = await prisma.$transaction(async (tx) => {
			const locked = await tx.$queryRaw<{ payment_batch_id: number }[]>`
				SELECT ${idCol('payment_batch_id')} AS payment_batch_id FROM payroll_payment_reversals WHERE ${idCol()} = ${reversalId} FOR UPDATE`;
			if (locked.length === 0) throw Errors.notFound('ບໍ່ພົບການຍົກເລີກການຈ່າຍ');
			await tx.$queryRaw`SELECT ${idCol()} AS id FROM payroll_payment_batches WHERE ${idCol()} = ${locked[0]!.payment_batch_id} FOR UPDATE`;
			const live = await tx.payrollJournalSource.findUnique({
				where: { activeKey: sourceKey.reversal(reversalId) },
				select: { journalId: true }
			});
			if (live) {
				throw Errors.conflict(
					'PAYMENT_REVERSAL_JOURNAL_ALREADY_EXISTS',
					'ການຍົກເລີກການຈ່າຍນີ້ມີບັນທຶກບັນຊີແລ້ວ',
					{ journalId: live.journalId }
				);
			}
			const reversal = await tx.payrollPaymentReversal.findUnique({
				where: { id: reversalId },
				include: { batch: { select: { id: true, batchNumber: true } }, item: true }
			});
			if (!reversal) throw Errors.notFound('ບໍ່ພົບການຍົກເລີກການຈ່າຍ');
			const settlementSource = await tx.payrollJournalSource.findUnique({
				where: { activeKey: sourceKey.settlement(reversal.paymentItemId) },
				include: { journal: true }
			});
			const original = settlementSource?.journal;
			if (!original || original.status !== 'POSTED') {
				throw Errors.conflict(
					'ACCOUNTING_SETTLEMENT_NOT_POSTED',
					original
						? `ບັນທຶກການຈ່າຍ ${original.journalNumber} ຍັງບໍ່ໄດ້ Post — ຍົກເລີກບັນທຶກນັ້ນ ແລະ ສ້າງໃໝ່ (ບໍ່ຕ້ອງບັນທຶກການຍົກເລີກ)`
						: 'ລາຍການນີ້ບໍ່ມີບັນທຶກການຈ່າຍທີ່ Post ແລ້ວ — ບໍ່ຕ້ອງສ້າງບັນທຶກຍົກເລີກ',
					{ settlementJournalId: original?.id ?? null }
				);
			}
			const originalLines = await tx.payrollJournalLine.findMany({
				where: {
					journalId: original.id,
					sourceEntity: 'PAYMENT_ITEM',
					sourceId: reversal.paymentItemId
				},
				include: { account: true },
				orderBy: { lineNo: 'asc' }
			});
			if (originalLines.length === 0) {
				throw Errors.conflict(
					'ACCOUNTING_SOURCE_DATA_UNAVAILABLE',
					'ບໍ່ພົບແຖວບັນຊີຂອງລາຍການນີ້ໃນບັນທຶກການຈ່າຍເດີມ'
				);
			}
			const lines: DraftLine[] = originalLines.map((l) => ({
				// exact swap on the SAME account; the snapshots are copied, never re-read or remapped
				account: { ...l.account, code: l.accountCodeSnapshot, name: l.accountNameSnapshot },
				debit: l.credit,
				credit: l.debit,
				description: `ຍົກເລີກ: ${l.description}`,
				employeeId: l.employeeId,
				employeeCode: l.employeeCodeSnapshot,
				branchId: l.branchId,
				branchCode: l.branchCodeSnapshot,
				departmentId: l.departmentId,
				departmentCode: l.departmentCodeSnapshot,
				sourceType: l.sourceType,
				source:
					l.sourceEntity !== null && l.sourceId !== null
						? { entity: l.sourceEntity, id: l.sourceId }
						: null,
				sourceReference: reversal.bankReference ?? l.sourceReferenceSnapshot
			}));
			const seq = await tx.payrollJournal.count({
				where: { journalType: 'PAYMENT_REVERSAL', reversedJournalId: original.id }
			});
			const j = await insertJournal(
				tx,
				{
					companyId: reversal.companyId,
					journalNumberBase: `PAYRV-${reversal.batch.batchNumber}-${seq + 1}`,
					journalType: 'PAYMENT_REVERSAL',
					sourceType: 'PAYMENT_REVERSAL',
					sourceId: reversal.id,
					accountingDate: reversal.effectiveDate,
					currencyCode: original.currencyCode,
					ruleSetId: null,
					ruleSetVersion: null,
					reversedJournalId: original.id,
					description: `${JOURNAL_LABEL.PAYMENT_REVERSAL} ${reversal.item.employeeCodeSnapshot} (${original.journalNumber})`
				},
				lines,
				[
					{
						sourceType: 'PAYMENT_REVERSAL',
						sourceId: reversal.id,
						key: sourceKey.reversal(reversal.id)
					}
				],
				actorUserId
			);
			return j.id;
		}, TX_OPTIONS);
		return getJournal(journalId);
	} catch (err) {
		if (isUniqueViolation(err)) {
			throw Errors.conflict(
				'PAYMENT_REVERSAL_JOURNAL_ALREADY_EXISTS',
				'ການຍົກເລີກການຈ່າຍນີ້ມີບັນທຶກບັນຊີແລ້ວ'
			);
		}
		throw err;
	}
}

// ============================================================================================
// validate / post / cancel
// ============================================================================================

async function lockJournal(tx: Tx, id: number) {
	const rows = await tx.$queryRaw<{ id: number }[]>`
		SELECT ${idCol()} AS id FROM payroll_journals WHERE ${idCol()} = ${id} FOR UPDATE`;
	if (rows.length === 0) throw Errors.notFound('ບໍ່ພົບບັນທຶກບັນຊີ');
	const j = await tx.payrollJournal.findUnique({
		where: { id },
		include: { lines: { include: { account: true }, orderBy: { lineNo: 'asc' } }, sources: true }
	});
	if (!j) throw Errors.notFound('ບໍ່ພົບບັນທຶກບັນຊີ');
	return j;
}

type JournalFull = Awaited<ReturnType<typeof lockJournal>>;

const postedImmutable = () =>
	Errors.conflict(
		'ACCOUNTING_JOURNAL_POSTED_IMMUTABLE',
		'ບັນທຶກບັນຊີນີ້ Post ແລ້ວ — ບໍ່ສາມາດແກ້ໄຂ ຫຼື ຍົກເລີກໄດ້'
	);

/** Every integrity rule of a journal against its CURRENT sources / accounts / mappings. */
async function checkJournal(tx: Tx, j: JournalFull) {
	// balanced, one-sided lines, header totals consistent
	const totals = assertBalanced(j.lines);
	if (!totals.debit.equals(j.totalDebit) || !totals.credit.equals(j.totalCredit)) {
		throw Errors.conflict('ACCOUNTING_JOURNAL_UNBALANCED', 'ຍອດລວມຂອງບັນທຶກບັນຊີບໍ່ຖືກຕ້ອງ');
	}
	if (j.lines.length === 0) {
		throw Errors.conflict('ACCOUNTING_NOTHING_TO_ACCOUNT', 'ບັນທຶກບັນຊີນີ້ບໍ່ມີແຖວ');
	}
	// accounts ACTIVE
	const inactive = [
		...new Set(j.lines.filter((l) => l.account.status !== 'ACTIVE').map((l) => l.account.code))
	];
	if (inactive.length > 0) throw inactiveAccountError(inactive.sort());
	// duplicate source: each source still holds its live key
	if (j.sources.length === 0 || j.sources.some((s) => !s.activeKey)) {
		throw Errors.conflict(
			'ACCOUNTING_DUPLICATE_SOURCE',
			'ແຫຼ່ງຂໍ້ມູນຂອງບັນທຶກນີ້ຖືກບັນທຶກໃນບັນທຶກອື່ນແລ້ວ'
		);
	}
	const sourceChanged = (msg: string) => Errors.conflict('ACCOUNTING_SOURCE_CHANGED', msg);
	if (j.journalType === 'PAYROLL_ACCRUAL') {
		const run = await tx.payrollRun.findUnique({
			where: { id: j.sourceId },
			select: { status: true, currencyCode: true }
		});
		if (!run || run.status !== 'FINALIZED') {
			throw sourceChanged('ການຄິດໄລ່ເງິນເດືອນບໍ່ແມ່ນ FINALIZED ແລ້ວ — ບໍ່ສາມາດໃຊ້ບັນທຶກນີ້ໄດ້');
		}
		if (run.currencyCode !== j.currencyCode) {
			throw Errors.conflict('ACCOUNTING_CURRENCY_MISMATCH', 'ສະກຸນເງິນບໍ່ກົງກັບການຄິດໄລ່ເງິນເດືອນ');
		}
	} else if (j.journalType === 'PAYMENT_SETTLEMENT') {
		const items = await tx.payrollPaymentItem.findMany({
			where: { id: { in: j.sources.map((s) => s.sourceId) } },
			select: { status: true, currencyCode: true }
		});
		if (items.length !== j.sources.length || items.some((i) => i.status !== 'PAID')) {
			throw sourceChanged(
				'ມີລາຍການຈ່າຍໃນບັນທຶກນີ້ທີ່ບໍ່ແມ່ນ PAID ແລ້ວ (ເຊັ່ນ ຖືກຍົກເລີກການຈ່າຍ) — ຍົກເລີກບັນທຶກນີ້ ແລະ ສ້າງໃໝ່'
			);
		}
		if (items.some((i) => i.currencyCode !== j.currencyCode)) {
			throw Errors.conflict('ACCOUNTING_CURRENCY_MISMATCH', 'ສະກຸນເງິນບໍ່ກົງກັບລາຍການຈ່າຍ');
		}
	} else {
		const original = j.reversedJournalId
			? await tx.payrollJournal.findUnique({
					where: { id: j.reversedJournalId },
					select: { status: true, currencyCode: true }
				})
			: null;
		if (!original || original.status !== 'POSTED') {
			throw sourceChanged('ບັນທຶກການຈ່າຍເດີມບໍ່ໄດ້ຢູ່ໃນສະຖານະ POSTED');
		}
		if (original.currencyCode !== j.currencyCode) {
			throw Errors.conflict('ACCOUNTING_CURRENCY_MISMATCH', 'ສະກຸນເງິນບໍ່ກົງກັບບັນທຶກເດີມ');
		}
	}
	// mappings represented: each line's source still has an ACTIVE mapping to the SAME account
	if (j.journalType !== 'PAYMENT_REVERSAL' && j.ruleSetId) {
		const mappings = await tx.payrollAccountingMapping.findMany({
			where: { ruleSetId: j.ruleSetId, eventType: j.journalType, status: 'ACTIVE' }
		});
		const ruleSet = await tx.payrollAccountingRuleSet.findUnique({
			where: { id: j.ruleSetId },
			select: { status: true }
		});
		const byType = new Map(mappings.map((m) => [m.sourceType, m]));
		const missing = [...new Set(j.lines.map((l) => l.sourceType))].filter((s) => !byType.has(s));
		if (missing.length > 0) {
			throw missingMappingError(
				missing.map((s) => ({
					eventType: j.journalType,
					sourceType: s,
					dimension: null,
					affectedCount: j.lines.filter((l) => l.sourceType === s).length
				}))
			);
		}
		const changed = j.lines.some((l) => {
			const m = byType.get(l.sourceType)!;
			return l.accountId !== m.debitAccountId && l.accountId !== m.creditAccountId;
		});
		if (changed || ruleSet?.status !== 'ACTIVE') {
			throw Errors.conflict(
				'ACCOUNTING_MAPPING_CHANGED',
				'ການຕັ້ງຄ່າບັນຊີປ່ຽນແປງຫຼັງຈາກສ້າງບັນທຶກນີ້ — ຍົກເລີກບັນທຶກນີ້ ແລະ ສ້າງໃໝ່'
			);
		}
	}
}

export async function validateJournal(id: number, actorUserId: number) {
	await prisma.$transaction(async (tx) => {
		const j = await lockJournal(tx, id);
		if (j.status === 'POSTED') throw postedImmutable();
		if (j.status !== 'DRAFT') {
			throw Errors.conflict(
				'ACCOUNTING_JOURNAL_INVALID_STATUS',
				j.status === 'VALIDATED' ? 'ບັນທຶກນີ້ກວດສອບແລ້ວ' : 'ບັນທຶກນີ້ຖືກຍົກເລີກແລ້ວ'
			);
		}
		await checkJournal(tx, j);
		const moved = await tx.payrollJournal.updateMany({
			where: { id, status: 'DRAFT' },
			data: { status: 'VALIDATED', validatedAt: serverNow(), validatedByUserId: actorUserId }
		});
		if (moved.count === 1) {
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_ACCOUNTING_JOURNAL_VALIDATED,
				entityType: AuditEntity.PAYROLL_JOURNAL,
				entityId: id,
				companyId: j.companyId,
				actorUserId,
				metadata: {
					journalId: id,
					journalNumber: j.journalNumber,
					journalType: j.journalType,
					lineCount: j.lineCount,
					status: 'VALIDATED'
				}
			});
		}
	}, TX_OPTIONS);
	return getJournal(id);
}

/**
 * VALIDATED → POSTED (compare-and-set). A concurrent / repeated post of an already POSTED journal is
 * idempotent: it returns the posted journal with alreadyPosted = true and writes no second audit.
 */
export async function postJournal(id: number, actorUserId: number) {
	const alreadyPosted = await prisma.$transaction(async (tx) => {
		const j = await lockJournal(tx, id);
		if (j.status === 'POSTED') return true;
		if (j.status !== 'VALIDATED') {
			throw Errors.conflict(
				'ACCOUNTING_JOURNAL_NOT_VALIDATED',
				j.status === 'CANCELLED'
					? 'ບັນທຶກນີ້ຖືກຍົກເລີກແລ້ວ'
					: 'ກະລຸນາກວດສອບ (Validate) ບັນທຶກກ່ອນ Post'
			);
		}
		await checkJournal(tx, j);
		const moved = await tx.payrollJournal.updateMany({
			where: { id, status: 'VALIDATED' },
			data: { status: 'POSTED', postedAt: serverNow(), postedByUserId: actorUserId }
		});
		if (moved.count === 0) return true;
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_ACCOUNTING_JOURNAL_POSTED,
			entityType: AuditEntity.PAYROLL_JOURNAL,
			entityId: id,
			companyId: j.companyId,
			actorUserId,
			metadata: {
				journalId: id,
				journalNumber: j.journalNumber,
				journalType: j.journalType,
				lineCount: j.lineCount,
				status: 'POSTED'
			}
		});
		return false;
	}, TX_OPTIONS);
	return { alreadyPosted, journal: await getJournal(id) };
}

/** DRAFT / VALIDATED → CANCELLED (kept for history); releases its sources for a new journal. */
export async function cancelJournal(id: number, actorUserId: number) {
	await prisma.$transaction(async (tx) => {
		const j = await lockJournal(tx, id);
		if (j.status === 'POSTED') throw postedImmutable();
		if (j.status === 'CANCELLED') {
			throw Errors.conflict('ACCOUNTING_JOURNAL_INVALID_STATUS', 'ບັນທຶກນີ້ຖືກຍົກເລີກແລ້ວ');
		}
		await tx.payrollJournal.update({
			where: { id },
			data: { status: 'CANCELLED', cancelledAt: serverNow(), cancelledByUserId: actorUserId }
		});
		await tx.payrollJournalSource.updateMany({
			where: { journalId: id },
			data: { activeKey: null }
		});
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_ACCOUNTING_JOURNAL_CANCELLED,
			entityType: AuditEntity.PAYROLL_JOURNAL,
			entityId: id,
			companyId: j.companyId,
			actorUserId,
			metadata: {
				journalId: id,
				journalNumber: j.journalNumber,
				journalType: j.journalType,
				previousStatus: j.status,
				sourceCount: j.sources.length,
				status: 'CANCELLED'
			}
		});
	}, TX_OPTIONS);
	return getJournal(id);
}

// ============================================================================================
// read models
// ============================================================================================

function presentJournalSummary(j: PayrollJournal) {
	return {
		id: j.id,
		companyId: j.companyId,
		journalNumber: j.journalNumber,
		journalType: j.journalType,
		sourceType: j.sourceType,
		sourceId: j.sourceId,
		accountingDate: isoDate(j.accountingDate),
		currencyCode: j.currencyCode,
		status: j.status,
		ruleSetId: j.ruleSetId,
		ruleSetVersion: j.ruleSetVersion,
		totalDebit: moneyString(j.totalDebit),
		totalCredit: moneyString(j.totalCredit),
		lineCount: j.lineCount,
		description: j.description,
		reversedJournalId: j.reversedJournalId,
		createdAt: j.createdAt,
		validatedAt: j.validatedAt,
		postedAt: j.postedAt,
		cancelledAt: j.cancelledAt
	};
}

function presentLine(l: PayrollJournalLine) {
	return {
		id: l.id,
		lineNo: l.lineNo,
		accountId: l.accountId,
		accountCode: l.accountCodeSnapshot,
		accountName: l.accountNameSnapshot,
		debit: moneyString(l.debit),
		credit: moneyString(l.credit),
		description: l.description,
		employeeCode: l.employeeCodeSnapshot,
		branchCode: l.branchCodeSnapshot,
		departmentCode: l.departmentCodeSnapshot,
		hasEmployee: !!l.employeeId,
		hasBranch: !!l.branchId,
		hasDepartment: !!l.departmentId,
		sourceType: l.sourceType,
		sourceLabel: SOURCE_LABEL[l.sourceType]?.lo ?? l.sourceType,
		sourceEntity: l.sourceEntity,
		sourceId: l.sourceId,
		sourceReference: l.sourceReferenceSnapshot
	};
}

async function userNames(ids: (number | null)[]) {
	const list = [...new Set(ids.filter((x): x is number => x !== null))];
	if (list.length === 0) return new Map<number, string>();
	const users = await prisma.user.findMany({
		where: { id: { in: list } },
		select: { id: true, displayName: true }
	});
	return new Map(users.map((u) => [u.id, u.displayName]));
}

async function sourceTrace(j: PayrollJournal) {
	if (j.sourceType === 'PAYROLL_RUN') {
		const run = await prisma.payrollRun.findUnique({
			where: { id: j.sourceId },
			select: { id: true, status: true, period: { select: { code: true, name: true } } }
		});
		return run
			? {
					kind: 'PAYROLL_RUN' as const,
					runId: run.id,
					runStatus: run.status,
					periodCode: run.period.code,
					periodName: run.period.name
				}
			: null;
	}
	if (j.sourceType === 'PAYMENT_BATCH') {
		const b = await prisma.payrollPaymentBatch.findUnique({
			where: { id: j.sourceId },
			select: {
				id: true,
				batchNumber: true,
				payrollRunId: true,
				run: { select: { period: { select: { code: true, name: true } } } }
			}
		});
		return b
			? {
					kind: 'PAYMENT_BATCH' as const,
					batchId: b.id,
					batchNumber: b.batchNumber,
					runId: b.payrollRunId,
					periodCode: b.run.period.code,
					periodName: b.run.period.name
				}
			: null;
	}
	const r = await prisma.payrollPaymentReversal.findUnique({
		where: { id: j.sourceId },
		select: {
			id: true,
			effectiveDate: true,
			paymentItemId: true,
			batch: { select: { id: true, batchNumber: true, payrollRunId: true } },
			item: { select: { employeeCodeSnapshot: true } }
		}
	});
	return r
		? {
				kind: 'PAYMENT_REVERSAL' as const,
				reversalId: r.id,
				paymentItemId: r.paymentItemId,
				effectiveDate: isoDate(r.effectiveDate),
				employeeCode: r.item.employeeCodeSnapshot,
				batchId: r.batch.id,
				batchNumber: r.batch.batchNumber,
				runId: r.batch.payrollRunId
			}
		: null;
}

export async function getJournal(id: number) {
	const j = await prisma.payrollJournal.findUnique({
		where: { id },
		include: {
			lines: { orderBy: { lineNo: 'asc' } },
			ruleSet: { select: { id: true, name: true, version: true } },
			reversedJournal: { select: { id: true, journalNumber: true, status: true } },
			reversalJournals: {
				select: { id: true, journalNumber: true, status: true },
				orderBy: { createdAt: 'asc' }
			},
			exports: { orderBy: { createdAt: 'asc' } },
			_count: { select: { sources: true } }
		}
	});
	if (!j) throw Errors.notFound('ບໍ່ພົບບັນທຶກບັນຊີ');
	const names = await userNames([
		j.createdByUserId,
		j.validatedByUserId,
		j.postedByUserId,
		j.cancelledByUserId
	]);
	const nameOf = (u: number | null) => (u !== null ? (names.get(u) ?? null) : null);
	return {
		...presentJournalSummary(j),
		ruleSet: j.ruleSet,
		createdByName: nameOf(j.createdByUserId),
		validatedByName: nameOf(j.validatedByUserId),
		postedByName: nameOf(j.postedByUserId),
		cancelledByName: nameOf(j.cancelledByUserId),
		sourceCount: j._count.sources,
		source: await sourceTrace(j),
		reversedJournal: j.reversedJournal,
		reversalJournals: j.reversalJournals,
		lines: j.lines.map(presentLine),
		exports: j.exports.map((e) => ({
			id: e.id,
			exportNumber: e.exportNumber,
			exportProfileId: e.exportProfileId,
			format: e.format,
			fileName: e.fileName,
			fileHash: e.fileHash,
			rowCount: e.rowCount,
			createdAt: e.createdAt
		})),
		immutable: j.status === 'POSTED' || j.status === 'CANCELLED',
		postingNote:
			'Posting locks this journal in LaoHR. It does not send data to an external accounting system.'
	};
}

export async function listJournals(q: JournalListQuery) {
	let sourceFilter: Prisma.PayrollJournalWhereInput | undefined;
	if (q.periodId) {
		const run = await prisma.payrollRun.findUnique({
			where: { periodId: q.periodId },
			select: {
				id: true,
				paymentBatches: { select: { id: true, reversals: { select: { id: true } } } }
			}
		});
		const batchIds = run?.paymentBatches.map((b) => b.id) ?? [];
		const reversalIds = run?.paymentBatches.flatMap((b) => b.reversals.map((r) => r.id)) ?? [];
		sourceFilter = {
			OR: [
				...(run ? [{ sourceType: 'PAYROLL_RUN', sourceId: run.id }] : []),
				{ sourceType: 'PAYMENT_BATCH', sourceId: { in: batchIds } },
				{ sourceType: 'PAYMENT_REVERSAL', sourceId: { in: reversalIds } }
			]
		};
	}
	const where: Prisma.PayrollJournalWhereInput = {
		...(q.companyId ? { companyId: q.companyId } : {}),
		...(q.journalType ? { journalType: q.journalType } : {}),
		...(q.status ? { status: q.status } : {}),
		...(q.dateFrom || q.dateTo
			? {
					accountingDate: {
						...(q.dateFrom ? { gte: new Date(`${q.dateFrom}T00:00:00Z`) } : {}),
						...(q.dateTo ? { lte: new Date(`${q.dateTo}T00:00:00Z`) } : {})
					}
				}
			: {}),
		...(q.search
			? { OR: [{ journalNumber: { contains: q.search } }, { description: { contains: q.search } }] }
			: {}),
		...(sourceFilter ? { AND: [sourceFilter] } : {})
	};
	const [total, rows] = await Promise.all([
		prisma.payrollJournal.count({ where }),
		prisma.payrollJournal.findMany({
			where,
			orderBy: [{ accountingDate: 'desc' }, { createdAt: 'desc' }],
			skip: (q.page - 1) * q.pageSize,
			take: q.pageSize
		})
	]);
	return { items: rows.map(presentJournalSummary), total, page: q.page, pageSize: q.pageSize };
}

/** GET /payroll/runs/:id/accounting-journal — the run's accrual journals + what can be done next. */
export async function runAccounting(runId: number) {
	const run = await prisma.payrollRun.findUnique({
		where: { id: runId },
		select: {
			id: true,
			companyId: true,
			status: true,
			period: { select: { code: true, endDate: true } }
		}
	});
	if (!run) throw Errors.notFound('ບໍ່ພົບການຄິດໄລ່ເງິນເດືອນ');
	const journals = await prisma.payrollJournal.findMany({
		where: { sourceType: 'PAYROLL_RUN', sourceId: runId },
		orderBy: { createdAt: 'desc' }
	});
	const active = journals.find((j) => j.status !== 'CANCELLED') ?? null;
	const ruleSet = await applicableRuleSet(prisma, run.companyId, run.period.endDate);
	return {
		runId,
		runStatus: run.status,
		accountingDate: isoDate(run.period.endDate),
		activeJournal: active ? presentJournalSummary(active) : null,
		journals: journals.map(presentJournalSummary),
		ruleSet: ruleSet ? { id: ruleSet.id, name: ruleSet.name, version: ruleSet.version } : null,
		canCreate: run.status === 'FINALIZED' && !active
	};
}

/**
 * The accounting state of one payment reversal, from the LIVE settlement journal of its item and its own
 * live reversal journal: a reversal journal is only needed (PENDING) once the settlement is POSTED.
 */
export function reversalAccountingState(
	settlement: { status: string } | null,
	reversalJournal: unknown
): 'ACCOUNTED' | 'PENDING' | 'SETTLEMENT_NOT_POSTED' | 'NOT_REQUIRED' {
	if (reversalJournal) return 'ACCOUNTED';
	if (settlement?.status === 'POSTED') return 'PENDING';
	return settlement ? 'SETTLEMENT_NOT_POSTED' : 'NOT_REQUIRED';
}

/** GET /payroll/payment-batches/:id/accounting-status */
export async function batchAccountingStatus(batchId: number) {
	const batch = await prisma.payrollPaymentBatch.findUnique({
		where: { id: batchId },
		select: {
			id: true,
			items: { select: { id: true, status: true } },
			reversals: {
				select: {
					id: true,
					paymentItemId: true,
					effectiveDate: true,
					item: { select: { employeeCodeSnapshot: true } }
				},
				orderBy: { createdAt: 'asc' }
			}
		}
	});
	if (!batch) throw Errors.notFound('ບໍ່ພົບຊຸດການຈ່າຍ');
	const itemIds = batch.items.map((i) => i.id);
	const reversalIds = batch.reversals.map((r) => r.id);
	const liveSources = await prisma.payrollJournalSource.findMany({
		where: {
			activeKey: {
				in: [...itemIds.map(sourceKey.settlement), ...reversalIds.map(sourceKey.reversal)]
			}
		},
		include: { journal: { select: { id: true, journalNumber: true, status: true } } }
	});
	const byKey = new Map(liveSources.map((s) => [s.activeKey!, s.journal]));
	const paid = batch.items.filter((i) => i.status === 'PAID');
	const accountedItems = batch.items.filter((i) => byKey.has(sourceKey.settlement(i.id)));
	const unaccountedPaid = paid.filter((i) => !byKey.has(sourceKey.settlement(i.id)));
	const reversals = batch.reversals.map((r) => {
		const settlement = byKey.get(sourceKey.settlement(r.paymentItemId)) ?? null;
		const reversalJournal = byKey.get(sourceKey.reversal(r.id)) ?? null;
		const state = reversalAccountingState(settlement, reversalJournal);
		return {
			reversalId: r.id,
			paymentItemId: r.paymentItemId,
			employeeCode: r.item.employeeCodeSnapshot,
			effectiveDate: isoDate(r.effectiveDate),
			settlementJournal: settlement,
			reversalJournal,
			state
		};
	});
	const journals = await prisma.payrollJournal.findMany({
		where: {
			OR: [
				{ sourceType: 'PAYMENT_BATCH', sourceId: batchId },
				{ sourceType: 'PAYMENT_REVERSAL', sourceId: { in: reversalIds } }
			]
		},
		orderBy: { createdAt: 'asc' }
	});
	return {
		batchId,
		paidCount: paid.length,
		accountedCount: accountedItems.length,
		unaccountedPaidCount: unaccountedPaid.length,
		reversalAccountingPendingCount: reversals.filter((r) => r.state === 'PENDING').length,
		reversals,
		journals: journals.map(presentJournalSummary),
		canCreateSettlement: unaccountedPaid.length > 0
	};
}

// ============================================================================================
// export
// ============================================================================================

function formatDate(d: Date, fmt: string) {
	const [y, m, day] = d.toISOString().slice(0, 10).split('-') as [string, string, string];
	switch (fmt) {
		case 'DD/MM/YYYY':
			return `${day}/${m}/${y}`;
		case 'DD-MM-YYYY':
			return `${day}-${m}-${y}`;
		case 'MM/DD/YYYY':
			return `${m}/${day}/${y}`;
		case 'YYYYMMDD':
			return `${y}${m}${day}`;
		default:
			return `${y}-${m}-${day}`;
	}
}

/** GL-{journalNumber}-{YYYYMMDD}.{csv|xlsx}, e.g. GL-PAYGL-2026-07-20260731.csv */
export function journalExportFileName(
	journalNumber: string,
	accountingDate: Date,
	format: 'CSV' | 'XLSX'
) {
	const safe = journalNumber.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'JOURNAL';
	return `GL-${safe}-${formatDate(accountingDate, 'YYYYMMDD')}.${format === 'CSV' ? 'csv' : 'xlsx'}`;
}

function cellOf(
	field: AccountingExportField,
	j: PayrollJournal,
	l: PayrollJournalLine,
	cfg: AccountingProfileConfig
): Cell {
	const text = (value: string | null | undefined): Cell => ({
		kind: ACCOUNTING_TEXT_CODE_FIELDS.includes(field) ? 'account' : 'text',
		value: value ?? ''
	});
	switch (field) {
		case 'JOURNAL_NUMBER':
			return text(j.journalNumber);
		case 'ACCOUNTING_DATE':
			return text(formatDate(j.accountingDate, cfg.dateFormat));
		case 'JOURNAL_TYPE':
			return text(j.journalType);
		case 'LINE_NUMBER':
			return text(String(l.lineNo));
		case 'ACCOUNT_CODE':
			return text(l.accountCodeSnapshot);
		case 'ACCOUNT_NAME':
			return text(l.accountNameSnapshot);
		case 'DESCRIPTION':
			return text(l.description);
		case 'EMPLOYEE_CODE':
			return text(l.employeeCodeSnapshot);
		case 'BRANCH_CODE':
			return text(l.branchCodeSnapshot);
		case 'DEPARTMENT_CODE':
			return text(l.departmentCodeSnapshot);
		case 'DEBIT':
			return { kind: 'amount', value: moneyString(l.debit) };
		case 'CREDIT':
			return { kind: 'amount', value: moneyString(l.credit) };
		case 'CURRENCY':
			return text(j.currencyCode);
		case 'SOURCE_REFERENCE':
			return text(l.sourceReferenceSnapshot);
	}
}

export function generateJournalFile(
	j: PayrollJournal,
	lines: PayrollJournalLine[],
	cfg: AccountingProfileConfig
) {
	const ordered = [...lines].sort((a, b) => a.lineNo - b.lineNo);
	const headers = cfg.columns.map((c) => c.header);
	const cells = ordered.map((l) => cfg.columns.map((c) => cellOf(c.field, j, l, cfg)));
	const bytes =
		cfg.format === 'CSV'
			? buildCsv(headers, cells, {
					delimiter: cfg.delimiter === 'TAB' ? '\t' : (cfg.delimiter ?? ','),
					includeHeader: cfg.includeHeader,
					bom: cfg.encoding === 'UTF-8-BOM'
				})
			: buildXlsx(headers, cells, { includeHeader: cfg.includeHeader, sheetName: 'Journal' });
	return {
		bytes,
		hash: createHash('sha256').update(bytes).digest('hex'),
		fileName: journalExportFileName(j.journalNumber, j.accountingDate, cfg.format),
		contentType:
			cfg.format === 'CSV'
				? 'text/csv; charset=utf-8'
				: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		rowCount: ordered.length
	};
}

/**
 * POST /payroll/accounting/journals/:id/export — POSTED journals only. The same profile again returns
 * the SAME bytes (regenerated from the frozen profile + immutable lines; hash-checked); no content is
 * stored. Audit: ids / counts / hash only.
 */
export async function exportJournal(id: number, profileId: number, actorUserId: number) {
	const run = () =>
		prisma.$transaction(async (tx) => {
			const j = await lockJournal(tx, id);
			if (j.status !== 'POSTED') {
				throw Errors.conflict(
					'ACCOUNTING_JOURNAL_NOT_POSTED',
					'ສົ່ງອອກໄຟລ໌ໄດ້ສະເພາະບັນທຶກບັນຊີທີ່ Post ແລ້ວ'
				);
			}
			const profile = await tx.accountingExportProfile.findUnique({ where: { id: profileId } });
			if (!profile || profile.companyId !== j.companyId)
				throw Errors.notFound('ບໍ່ພົບຮູບແບບໄຟລ໌ບັນຊີ');
			const existing = await tx.payrollJournalExport.findUnique({
				where: { journalId_exportProfileId: { journalId: id, exportProfileId: profileId } }
			});
			if (existing) {
				const cfg = existing.profileSnapshotJson as unknown as AccountingProfileConfig;
				const file = generateJournalFile(j, j.lines, cfg);
				if (file.hash !== existing.fileHash) {
					throw Errors.conflict(
						'EXPORT_INTEGRITY_MISMATCH',
						'ໄຟລ໌ທີ່ສ້າງໃໝ່ບໍ່ກົງກັບໄຟລ໌ທີ່ສົ່ງອອກຄັ້ງທຳອິດ — ກະລຸນາຕິດຕໍ່ຜູ້ດູແລລະບົບ'
					);
				}
				await writeAuditEvent(tx, {
					action: AuditAction.PAYROLL_ACCOUNTING_EXPORT_DOWNLOADED,
					entityType: AuditEntity.PAYROLL_JOURNAL,
					entityId: id,
					companyId: j.companyId,
					actorUserId,
					metadata: {
						journalId: id,
						exportId: existing.id,
						exportProfileId: profileId,
						rowCount: existing.rowCount,
						fileHash: existing.fileHash
					}
				});
				return { ...file, exportId: existing.id, firstExport: false };
			}
			if (profile.status !== 'ACTIVE') {
				throw Errors.conflict('EXPORT_PROFILE_INACTIVE', 'ຮູບແບບໄຟລ໌ນີ້ຖືກປິດການໃຊ້ງານແລ້ວ');
			}
			const cfg = profileConfigOf(profile);
			const file = generateJournalFile(j, j.lines, cfg);
			const count = await tx.payrollJournalExport.count({ where: { journalId: id } });
			const record = await tx.payrollJournalExport.create({
				data: {
					journalId: id,
					exportProfileId: profileId,
					exportNumber: `${j.journalNumber}-E${count + 1}`,
					format: cfg.format,
					fileName: file.fileName,
					fileHash: file.hash,
					rowCount: file.rowCount,
					profileSnapshotJson: cfg as unknown as Prisma.InputJsonObject,
					createdByUserId: actorUserId
				}
			});
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_ACCOUNTING_JOURNAL_EXPORTED,
				entityType: AuditEntity.PAYROLL_JOURNAL,
				entityId: id,
				companyId: j.companyId,
				actorUserId,
				metadata: {
					journalId: id,
					journalNumber: j.journalNumber,
					exportId: record.id,
					exportProfileId: profileId,
					format: cfg.format,
					rowCount: file.rowCount,
					fileHash: file.hash
				}
			});
			return { ...file, exportId: record.id, firstExport: true };
		}, TX_OPTIONS);
	try {
		return await run();
	} catch (err) {
		// a concurrent request created this (journal, profile) export first → serve it as a re-export
		if (isUniqueViolation(err)) return run();
		throw err;
	}
}
