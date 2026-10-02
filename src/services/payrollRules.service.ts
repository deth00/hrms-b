import { Prisma } from '@prisma/client';
import type { OvertimeCompensationRule, PayrollRuleSet } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { addDays, formatDateOnly } from '../lib/dates.js';
import { assertCompanyExists } from './company.service.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { lockCompany } from './payrollPeriod.service.js';
import type { RuleCreateInput, RuleListQuery } from '../validation/payrollRules.schema.js';

/**
 * PAYROLL RULE SETS (Phase 12A) — company-configured, effective-dated, IMMUTABLE versions.
 *
 *  - Every value here is company payroll policy. NOTHING is a statutory Lao rate: proration method,
 *    deduction switches, minute basis and OT multipliers / divisors are all entered by an admin.
 *  - There is no update and no delete. A change is a NEW version whose effectiveFrom is later than the
 *    latest version's; only the previous version's open `effectiveTo` is closed (the same "close and
 *    insert" rule salaries use), so a version that finalized payroll relied on never changes meaning.
 *  - Periods of one company's ACTIVE versions never overlap (checked under the company row lock).
 *  - A run resolves the version effective on the PERIOD END DATE (the Phase 11 snapshot date) and
 *    stores a full snapshot (`snapshotOf`) so a finalized run explains itself without the live rows.
 */
type Db = Prisma.TransactionClient | typeof prisma;
type RuleRow = PayrollRuleSet & { overtimeRules: OvertimeCompensationRule[] };

const INCLUDE = {
	company: { select: { id: true, code: true, nameLao: true } },
	overtimeRules: { orderBy: { overtimeType: 'asc' } },
	createdBy: { select: { id: true, displayName: true } }
} satisfies Prisma.PayrollRuleSetInclude;
type FullRow = Prisma.PayrollRuleSetGetPayload<{ include: typeof INCLUDE }>;

const presentOtRule = (r: OvertimeCompensationRule) => ({
	id: r.id,
	overtimeType: r.overtimeType,
	multiplier: r.multiplier.toFixed(4),
	rateBasis: r.rateBasis,
	monthlyDivisorDays: r.monthlyDivisorDays,
	standardDailyMinutes: r.standardDailyMinutes
});

function present(r: FullRow) {
	return {
		id: r.id,
		companyId: r.companyId,
		company: r.company,
		version: r.version,
		nameLao: r.nameLao,
		nameEnglish: r.nameEnglish,
		effectiveFrom: r.effectiveFrom,
		effectiveTo: r.effectiveTo,
		prorationMethod: r.prorationMethod,
		absenceDeductionEnabled: r.absenceDeductionEnabled,
		unpaidLeaveDeductionEnabled: r.unpaidLeaveDeductionEnabled,
		lateDeductionEnabled: r.lateDeductionEnabled,
		earlyLeaveDeductionEnabled: r.earlyLeaveDeductionEnabled,
		minuteDeductionBasis: r.minuteDeductionBasis,
		standardMonthlyDays: r.standardMonthlyDays,
		standardDailyMinutes: r.standardDailyMinutes,
		status: r.status,
		overtimeRules: r.overtimeRules.map(presentOtRule),
		createdBy: r.createdBy,
		createdAt: r.createdAt
	};
}

/** The immutable copy stored on a run: everything needed to explain a result without the live rows. */
export function snapshotOf(r: RuleRow) {
	return {
		ruleSetId: r.id,
		version: r.version,
		nameLao: r.nameLao,
		effectiveFrom: formatDateOnly(r.effectiveFrom),
		effectiveTo: r.effectiveTo ? formatDateOnly(r.effectiveTo) : null,
		prorationMethod: r.prorationMethod,
		absenceDeductionEnabled: r.absenceDeductionEnabled,
		unpaidLeaveDeductionEnabled: r.unpaidLeaveDeductionEnabled,
		lateDeductionEnabled: r.lateDeductionEnabled,
		earlyLeaveDeductionEnabled: r.earlyLeaveDeductionEnabled,
		minuteDeductionBasis: r.minuteDeductionBasis,
		standardMonthlyDays: r.standardMonthlyDays,
		standardDailyMinutes: r.standardDailyMinutes,
		overtimeRules: [...r.overtimeRules]
			.sort((a, b) => a.overtimeType.localeCompare(b.overtimeType))
			.map(presentOtRule)
	};
}
export type RuleSnapshot = ReturnType<typeof snapshotOf>;

export async function listRules(query: RuleListQuery) {
	const where: Prisma.PayrollRuleSetWhereInput = query.companyId
		? { companyId: query.companyId }
		: {};
	const [rows, total] = await Promise.all([
		prisma.payrollRuleSet.findMany({
			where,
			include: INCLUDE,
			orderBy: [{ companyId: 'asc' }, { effectiveFrom: 'desc' }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.payrollRuleSet.count({ where })
	]);
	return {
		items: rows.map(present),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getRule(id: number) {
	const row = await prisma.payrollRuleSet.findUnique({ where: { id }, include: INCLUDE });
	if (!row) throw Errors.notFound('ບໍ່ພົບກົດການຄຳນວນເງິນເດືອນ');
	return present(row);
}

export async function createRule(input: RuleCreateInput, actorUserId: number) {
	await assertCompanyExists(input.companyId);
	const id = await prisma.$transaction(async (tx) => {
		await lockCompany(tx, input.companyId);
		const existing = await tx.payrollRuleSet.findMany({
			where: { companyId: input.companyId, status: 'ACTIVE' },
			orderBy: { effectiveFrom: 'desc' }
		});
		const latest = existing[0];
		if (latest && input.effectiveFrom.getTime() <= latest.effectiveFrom.getTime()) {
			throw Errors.conflict(
				'PAYROLL_RULE_PERIOD_OVERLAP',
				'ວັນທີມີຜົນຕ້ອງຫຼັງຈາກວັນທີມີຜົນຂອງກົດເວີຊັນລ່າສຸດ',
				{ latestEffectiveFrom: formatDateOnly(latest.effectiveFrom), latestVersion: latest.version }
			);
		}
		// close the previous open version the day before (the only mutation a rule row ever receives)
		if (
			latest &&
			(latest.effectiveTo === null || latest.effectiveTo.getTime() >= input.effectiveFrom.getTime())
		) {
			await tx.payrollRuleSet.update({
				where: { id: latest.id },
				data: { effectiveTo: addDays(input.effectiveFrom, -1) }
			});
		}
		const maxVersion = await tx.payrollRuleSet.aggregate({
			where: { companyId: input.companyId },
			_max: { version: true }
		});
		const { overtimeRules, ...data } = input;
		const row = await tx.payrollRuleSet.create({
			data: {
				...data,
				nameEnglish: data.nameEnglish ?? null,
				standardMonthlyDays: data.standardMonthlyDays ?? null,
				standardDailyMinutes: data.standardDailyMinutes ?? null,
				version: (maxVersion._max.version ?? 0) + 1,
				effectiveTo: null,
				status: 'ACTIVE',
				createdByUserId: actorUserId,
				overtimeRules: {
					create: overtimeRules.map((r) => ({
						overtimeType: r.overtimeType,
						multiplier: new Prisma.Decimal(r.multiplier),
						rateBasis: r.rateBasis,
						monthlyDivisorDays: r.monthlyDivisorDays ?? null,
						standardDailyMinutes: r.standardDailyMinutes ?? null
					}))
				}
			}
		});
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_RULE_CREATED,
			entityType: AuditEntity.PAYROLL_RULE,
			entityId: row.id,
			companyId: row.companyId,
			actorUserId,
			// configuration only (a rule set holds no employee amounts)
			metadata: {
				version: row.version,
				effectiveFrom: formatDateOnly(row.effectiveFrom),
				prorationMethod: row.prorationMethod,
				absenceDeductionEnabled: row.absenceDeductionEnabled,
				unpaidLeaveDeductionEnabled: row.unpaidLeaveDeductionEnabled,
				lateDeductionEnabled: row.lateDeductionEnabled,
				earlyLeaveDeductionEnabled: row.earlyLeaveDeductionEnabled,
				minuteDeductionBasis: row.minuteDeductionBasis,
				overtimeTypes: overtimeRules.map((r) => r.overtimeType)
			}
		});
		return row.id;
	});
	return getRule(id);
}

// ============================================================================================
// resolution (used by the calculation engine)
// ============================================================================================

export const companyHasRules = async (db: Db, companyId: number) =>
	(await db.payrollRuleSet.count({ where: { companyId } })) > 0;

/** The ACTIVE version effective on `date` (the period end date), or null. */
export async function resolveRuleAt(
	db: Db,
	companyId: number,
	date: Date
): Promise<RuleRow | null> {
	return db.payrollRuleSet.findFirst({
		where: {
			companyId,
			status: 'ACTIVE',
			effectiveFrom: { lte: date },
			OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }]
		},
		include: { overtimeRules: true },
		orderBy: { effectiveFrom: 'desc' }
	});
}

/** A stored rule must be internally consistent before a run may use it. */
export function ruleConfigurationProblem(r: RuleSnapshot): string | null {
	if (r.minuteDeductionBasis === 'STANDARD_DAILY_MINUTES' && !r.standardDailyMinutes) {
		return 'STANDARD_DAILY_MINUTES requires standardDailyMinutes';
	}
	if (r.prorationMethod !== 'CALENDAR_DAYS' && r.prorationMethod !== 'WORKING_DAYS') {
		return 'unknown proration method';
	}
	return null;
}
