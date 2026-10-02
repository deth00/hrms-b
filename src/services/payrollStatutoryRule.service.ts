import { Prisma } from '@prisma/client';
import type {
	PayrollPitBracket,
	PayrollSocialSecurityRule,
	PayrollStatutoryRuleSet
} from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { addDays, formatDateOnly } from '../lib/dates.js';
import { assertCompanyExists } from './company.service.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { validatePitBrackets, type PitBracketInput } from './payrollPit.service.js';
import { validateSocialSecurityRule } from './payrollSocialSecurity.service.js';
import { lockCompany } from './payrollPeriod.service.js';
import type {
	StatutoryRuleCreateInput,
	StatutoryRuleListQuery
} from '../validation/payrollStatutoryRule.schema.js';

/**
 * PHASE 12B — STATUTORY RULE SETS (Lao PIT + Social Security). §1-8, §34.
 *
 *  - A company's OWN effective-dated configuration of the current legal PIT brackets / Social Security
 *    rates. NOTHING here is a hard-coded Lao constant — every number is a database row an admin entered
 *    (optionally pre-filled from the "current reference" template, §8, which the admin must still
 *    explicitly activate).
 *  - Created as DRAFT. A DRAFT is NEVER resolved by calculation (§34). `activateRule` is the one
 *    explicit step that makes a version resolvable, and closes the previous ACTIVE version's
 *    `effectiveTo` the same way PayrollRuleSet (Phase 12A) does — the only mutation a rule row ever
 *    receives. There is no update/delete: a correction is a NEW version.
 *  - `resolveStatutoryRuleForMonth` is the ONE place calculation resolves "which rule applies to this
 *    payroll month", including the §3 transition-safety block.
 */
type Db = Prisma.TransactionClient | typeof prisma;
type RuleRow = PayrollStatutoryRuleSet & {
	pitBrackets: PayrollPitBracket[];
	socialSecurityRule: PayrollSocialSecurityRule | null;
};

const INCLUDE = {
	company: { select: { id: true, code: true, nameLao: true } },
	pitBrackets: { orderBy: { order: 'asc' } },
	socialSecurityRule: true,
	createdBy: { select: { id: true, displayName: true } }
} satisfies Prisma.PayrollStatutoryRuleSetInclude;
type FullRow = Prisma.PayrollStatutoryRuleSetGetPayload<{ include: typeof INCLUDE }>;

const presentBracket = (b: PayrollPitBracket) => ({
	id: b.id,
	order: b.order,
	lowerBound: b.lowerBound.toFixed(2),
	upperBound: b.upperBound ? b.upperBound.toFixed(2) : null,
	rate: b.rate.toFixed(4)
});

const presentSso = (s: PayrollSocialSecurityRule | null) =>
	s && {
		employeeRate: s.employeeRate.toFixed(4),
		employerRate: s.employerRate.toFixed(4),
		minimumBase: s.minimumBase ? s.minimumBase.toFixed(2) : null,
		maximumBase: s.maximumBase ? s.maximumBase.toFixed(2) : null,
		employeeContributionPitDeductible: s.employeeContributionPitDeductible
	};

function present(r: FullRow) {
	return {
		id: r.id,
		companyId: r.companyId,
		company: r.company,
		jurisdictionCode: r.jurisdictionCode,
		currencyCode: r.currencyCode,
		version: r.version,
		nameLao: r.nameLao,
		nameEnglish: r.nameEnglish,
		effectiveFrom: r.effectiveFrom,
		effectiveTo: r.effectiveTo,
		effectivePayrollMonth: r.effectivePayrollMonth,
		legalReference: r.legalReference,
		sourceDescription: r.sourceDescription,
		verifiedAt: r.verifiedAt,
		notes: r.notes,
		pitEnabled: r.pitEnabled,
		socialSecurityEnabled: r.socialSecurityEnabled,
		overtimePitTreatmentEnabled: r.overtimePitTreatmentEnabled,
		overtimePitExemptionBaseSalaryThreshold: r.overtimePitExemptionBaseSalaryThreshold
			? r.overtimePitExemptionBaseSalaryThreshold.toFixed(2)
			: null,
		overtimePitThresholdComparison: r.overtimePitThresholdComparison,
		status: r.status,
		pitBrackets: r.pitBrackets.map(presentBracket),
		socialSecurity: presentSso(r.socialSecurityRule),
		createdBy: r.createdBy,
		createdAt: r.createdAt
	};
}
export type StatutoryRulePresented = ReturnType<typeof present>;

/** The immutable copy stored on a statutory result (§32, §47) — explains a historical result alone. */
export function snapshotOf(r: RuleRow) {
	return {
		ruleSetId: r.id,
		version: r.version,
		nameLao: r.nameLao,
		legalReference: r.legalReference,
		sourceDescription: r.sourceDescription,
		verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
		effectiveFrom: formatDateOnly(r.effectiveFrom),
		effectiveTo: r.effectiveTo ? formatDateOnly(r.effectiveTo) : null,
		pitEnabled: r.pitEnabled,
		socialSecurityEnabled: r.socialSecurityEnabled,
		overtimePitTreatmentEnabled: r.overtimePitTreatmentEnabled,
		overtimePitExemptionBaseSalaryThreshold:
			r.overtimePitExemptionBaseSalaryThreshold?.toFixed(2) ?? null,
		overtimePitThresholdComparison: r.overtimePitThresholdComparison,
		pitBrackets: [...r.pitBrackets]
			.sort((a, b) => a.order - b.order)
			.map((b) => ({
				order: b.order,
				lowerBound: b.lowerBound.toFixed(2),
				upperBound: b.upperBound ? b.upperBound.toFixed(2) : null,
				rate: b.rate.toFixed(4)
			})),
		socialSecurity: r.socialSecurityRule
			? {
					employeeRate: r.socialSecurityRule.employeeRate.toFixed(4),
					employerRate: r.socialSecurityRule.employerRate.toFixed(4),
					minimumBase: r.socialSecurityRule.minimumBase?.toFixed(2) ?? null,
					maximumBase: r.socialSecurityRule.maximumBase?.toFixed(2) ?? null,
					employeeContributionPitDeductible: r.socialSecurityRule.employeeContributionPitDeductible
				}
			: null
	};
}
export type StatutoryRuleSnapshot = ReturnType<typeof snapshotOf>;

/**
 * §8 — an OPTIONAL, read-only reference template (Lao Income Tax Law (Amended) No. 88/NA, plus the
 * standard private-sector Social Security reference — see the Phase 12B implementation report for the
 * exact source and the date these values were checked). NEVER writes anything, NEVER activates
 * anything — it only pre-fills the create form so an admin can review, adjust and explicitly create +
 * activate a real rule version. These are values a real deployment MUST re-verify against current
 * official guidance before using in production payroll.
 */
export function currentLaoReferenceTemplate() {
	return {
		nameLao: 'ອ້າງອີງປັດຈຸບັນ (ພາສີເງິນໄດ້ + ປະກັນສັງຄົມລາວ)',
		nameEnglish: 'Current Lao Reference (PIT + Social Security)',
		jurisdictionCode: 'LA',
		legalReference:
			'ກົດໝາຍພາສີເງິນໄດ້ (ສະບັບປັບປຸງ) ເລກທີ 88/ສພຊ (Income Tax Law (Amended) No. 88/NA)',
		sourceDescription:
			'ອັດຕາພາສີເງິນໄດ້ແບບຄືບໜ້າ ແລະ ອັດຕາປະກັນສັງຄົມມາດຕະຖານພາກເອກະຊົນ — ຄ່າອ້າງອີງນີ້ຕ້ອງໄດ້ຮັບການກວດສອບກັບແຫຼ່ງທາງການ/ກົດໝາຍປັດຈຸບັນກ່ອນນຳໃຊ້ຈິງ (This reference must be verified against current official/legal guidance before production use).',
		pitEnabled: true,
		socialSecurityEnabled: true,
		pitBrackets: [
			{ order: 1, lowerBound: '0', upperBound: '2500000', rate: '0' },
			{ order: 2, lowerBound: '2500000', upperBound: '5000000', rate: '0.05' },
			{ order: 3, lowerBound: '5000000', upperBound: '15000000', rate: '0.10' },
			{ order: 4, lowerBound: '15000000', upperBound: '25000000', rate: '0.15' },
			{ order: 5, lowerBound: '25000000', upperBound: '65000000', rate: '0.20' },
			{ order: 6, lowerBound: '65000000', upperBound: null, rate: '0.25' }
		],
		socialSecurity: {
			employeeRate: '0.055',
			employerRate: '0.06',
			minimumBase: null,
			maximumBase: '4500000',
			employeeContributionPitDeductible: true
		},
		overtimePitTreatmentEnabled: true,
		overtimePitExemptionBaseSalaryThreshold: '3000000',
		overtimePitThresholdComparison: 'LESS_THAN' as const
	};
}

export async function listStatutoryRules(query: StatutoryRuleListQuery) {
	const where: Prisma.PayrollStatutoryRuleSetWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.status ? { status: query.status } : {})
	};
	const [rows, total] = await Promise.all([
		prisma.payrollStatutoryRuleSet.findMany({
			where,
			include: INCLUDE,
			orderBy: [{ companyId: 'asc' }, { effectiveFrom: 'desc' }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.payrollStatutoryRuleSet.count({ where })
	]);
	return {
		items: rows.map(present),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getStatutoryRule(id: number) {
	const row = await prisma.payrollStatutoryRuleSet.findUnique({ where: { id }, include: INCLUDE });
	if (!row) throw Errors.notFound('ບໍ່ພົບກົດອາກອນ ແລະ ປະກັນສັງຄົມ');
	return present(row);
}

function assertValid(brackets: PitBracketInput[], sso: StatutoryRuleCreateInput['socialSecurity']) {
	const bracketError = validatePitBrackets(brackets);
	if (bracketError) throw Errors.badRequest('INVALID_PIT_BRACKETS', bracketError);
	if (sso) {
		const ssoError = validateSocialSecurityRule({
			employeeRate: new Prisma.Decimal(sso.employeeRate),
			employerRate: new Prisma.Decimal(sso.employerRate),
			minimumBase: sso.minimumBase ? new Prisma.Decimal(sso.minimumBase) : null,
			maximumBase: sso.maximumBase ? new Prisma.Decimal(sso.maximumBase) : null
		});
		if (ssoError) throw Errors.badRequest('INVALID_SOCIAL_SECURITY_RULE', ssoError);
	}
}

/** Always created DRAFT (§34) — never immediately usable by calculation. */
export async function createStatutoryRule(input: StatutoryRuleCreateInput, actorUserId: number) {
	await assertCompanyExists(input.companyId);
	const brackets: PitBracketInput[] = input.pitBrackets.map((b) => ({
		order: b.order,
		lowerBound: new Prisma.Decimal(b.lowerBound),
		upperBound: b.upperBound ? new Prisma.Decimal(b.upperBound) : null,
		rate: new Prisma.Decimal(b.rate)
	}));
	if (input.pitEnabled)
		assertValid(brackets, input.socialSecurityEnabled ? input.socialSecurity : null);
	if (input.socialSecurityEnabled && !input.socialSecurity) {
		throw Errors.badRequest(
			'SOCIAL_SECURITY_RULE_REQUIRED',
			'ກະລຸນາຕັ້ງຄ່າອັດຕາປະກັນສັງຄົມ ເມື່ອເປີດໃຊ້ປະກັນສັງຄົມ'
		);
	}
	const id = await prisma.$transaction(async (tx) => {
		const maxVersion = await tx.payrollStatutoryRuleSet.aggregate({
			where: { companyId: input.companyId },
			_max: { version: true }
		});
		const row = await tx.payrollStatutoryRuleSet.create({
			data: {
				companyId: input.companyId,
				jurisdictionCode: input.jurisdictionCode ?? 'LA',
				currencyCode: input.currencyCode,
				version: (maxVersion._max.version ?? 0) + 1,
				nameLao: input.nameLao,
				nameEnglish: input.nameEnglish ?? null,
				effectiveFrom: input.effectiveFrom,
				effectivePayrollMonth: input.effectivePayrollMonth ?? null,
				legalReference: input.legalReference ?? null,
				sourceDescription: input.sourceDescription ?? null,
				verifiedAt: input.verifiedAt ?? null,
				notes: input.notes ?? null,
				pitEnabled: input.pitEnabled,
				socialSecurityEnabled: input.socialSecurityEnabled,
				overtimePitTreatmentEnabled: input.overtimePitTreatmentEnabled,
				overtimePitExemptionBaseSalaryThreshold:
					input.overtimePitExemptionBaseSalaryThreshold ?? null,
				overtimePitThresholdComparison: input.overtimePitTreatmentEnabled ? 'LESS_THAN' : null,
				status: 'DRAFT',
				createdByUserId: actorUserId,
				pitBrackets: input.pitEnabled
					? {
							create: brackets.map((b) => ({
								order: b.order,
								lowerBound: b.lowerBound,
								upperBound: b.upperBound,
								rate: b.rate
							}))
						}
					: undefined,
				socialSecurityRule:
					input.socialSecurityEnabled && input.socialSecurity
						? {
								create: {
									employeeRate: new Prisma.Decimal(input.socialSecurity.employeeRate),
									employerRate: new Prisma.Decimal(input.socialSecurity.employerRate),
									minimumBase: input.socialSecurity.minimumBase
										? new Prisma.Decimal(input.socialSecurity.minimumBase)
										: null,
									maximumBase: input.socialSecurity.maximumBase
										? new Prisma.Decimal(input.socialSecurity.maximumBase)
										: null,
									employeeContributionPitDeductible:
										input.socialSecurity.employeeContributionPitDeductible
								}
							}
						: undefined
			}
		});
		await writeAuditEvent(tx, {
			action: AuditAction.STATUTORY_RULE_CREATED,
			entityType: AuditEntity.STATUTORY_RULE,
			entityId: row.id,
			companyId: row.companyId,
			actorUserId,
			// configuration only - never an employee salary/amount
			metadata: {
				version: row.version,
				effectiveFrom: formatDateOnly(row.effectiveFrom),
				pitEnabled: row.pitEnabled,
				socialSecurityEnabled: row.socialSecurityEnabled,
				legalReference: row.legalReference
			}
		});
		return row.id;
	});
	return getStatutoryRule(id);
}

/** DRAFT -> ACTIVE. Closes the previous ACTIVE version's effectiveTo (§34, §4 — never an in-place edit). */
export async function activateStatutoryRule(id: number, actorUserId: number) {
	await prisma.$transaction(async (tx) => {
		const row = await tx.payrollStatutoryRuleSet.findUnique({
			where: { id },
			include: { pitBrackets: true, socialSecurityRule: true }
		});
		if (!row) throw Errors.notFound('ບໍ່ພົບກົດອາກອນ ແລະ ປະກັນສັງຄົມ');
		if (row.status !== 'DRAFT') {
			throw Errors.conflict('STATUTORY_RULE_NOT_DRAFT', 'ກົດນີ້ບໍ່ແມ່ນສະຖານະຮ່າງ (Draft) ອີກຕໍ່ໄປ');
		}
		if (row.pitEnabled) {
			assertValid(
				row.pitBrackets.map((b) => ({
					order: b.order,
					lowerBound: b.lowerBound,
					upperBound: b.upperBound,
					rate: b.rate
				})),
				null
			);
		}
		if (row.socialSecurityEnabled && row.socialSecurityRule) {
			const err = validateSocialSecurityRule(row.socialSecurityRule);
			if (err) throw Errors.badRequest('INVALID_SOCIAL_SECURITY_RULE', err);
		} else if (row.socialSecurityEnabled) {
			throw Errors.badRequest('SOCIAL_SECURITY_RULE_REQUIRED', 'ຍັງບໍ່ໄດ້ຕັ້ງຄ່າອັດຕາປະກັນສັງຄົມ');
		}
		await lockCompany(tx, row.companyId);
		const latestActive = await tx.payrollStatutoryRuleSet.findFirst({
			where: { companyId: row.companyId, status: 'ACTIVE' },
			orderBy: { effectiveFrom: 'desc' }
		});
		if (latestActive && row.effectiveFrom.getTime() <= latestActive.effectiveFrom.getTime()) {
			throw Errors.conflict(
				'STATUTORY_RULE_PERIOD_OVERLAP',
				'ວັນທີມີຜົນຕ້ອງຫຼັງຈາກວັນທີມີຜົນຂອງກົດເວີຊັນລ່າສຸດທີ່ໃຊ້ງານຢູ່',
				{
					latestEffectiveFrom: formatDateOnly(latestActive.effectiveFrom),
					latestVersion: latestActive.version
				}
			);
		}
		if (
			latestActive &&
			(latestActive.effectiveTo === null ||
				latestActive.effectiveTo.getTime() >= row.effectiveFrom.getTime())
		) {
			await tx.payrollStatutoryRuleSet.update({
				where: { id: latestActive.id },
				data: { effectiveTo: addDays(row.effectiveFrom, -1) }
			});
		}
		await tx.payrollStatutoryRuleSet.update({ where: { id }, data: { status: 'ACTIVE' } });
		await writeAuditEvent(tx, {
			action: AuditAction.STATUTORY_RULE_ACTIVATED,
			entityType: AuditEntity.STATUTORY_RULE,
			entityId: id,
			companyId: row.companyId,
			actorUserId,
			metadata: { version: row.version, effectiveFrom: formatDateOnly(row.effectiveFrom) }
		});
	});
	return getStatutoryRule(id);
}

// ============================================================================================
// resolution (used by the calculation engine)
// ============================================================================================

/** Has this company opted into statutory payroll at all (any rule ever created, any status)? */
export const companyHasStatutoryRules = async (db: Db, companyId: number) =>
	(await db.payrollStatutoryRuleSet.count({ where: { companyId } })) > 0;

export type StatutoryResolution =
	| { outcome: 'RESOLVED'; rule: RuleRow }
	| { outcome: 'MISSING' }
	| { outcome: 'TRANSITION_AMBIGUOUS' };

/**
 * Resolves the ACTIVE rule for a whole PAYROLL MONTH (§3, §34) — never for a single cycle, since PIT /
 * SSO are monthly obligations. `monthStart` / `monthEnd` are the FULL calendar month's bounds
 * (day 1 .. last day), regardless of which cycle is being calculated.
 *
 *   - a rule explicitly tagged `effectivePayrollMonth` for this exact month always wins (the admin's
 *     explicit transition decision, §3);
 *   - otherwise, exactly one ACTIVE rule that already covered the WHOLE month (started on/before its
 *     first day) resolves unambiguously;
 *   - anything else (no rule at all; a rule starting mid-month with no explicit tag; two rules
 *     overlapping the month) is a transition this system refuses to guess.
 */
export async function resolveStatutoryRuleForMonth(
	db: Db,
	companyId: number,
	payrollMonth: string,
	monthStart: Date,
	monthEnd: Date
): Promise<StatutoryResolution> {
	const candidates = await db.payrollStatutoryRuleSet.findMany({
		where: {
			companyId,
			status: 'ACTIVE',
			effectiveFrom: { lte: monthEnd },
			OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }]
		},
		include: { pitBrackets: true, socialSecurityRule: true },
		orderBy: { effectiveFrom: 'desc' }
	});
	if (candidates.length === 0) return { outcome: 'MISSING' };
	const explicit = candidates.find((r) => r.effectivePayrollMonth === payrollMonth);
	if (explicit) return { outcome: 'RESOLVED', rule: explicit };
	const unambiguous = candidates.filter((r) => r.effectiveFrom.getTime() <= monthStart.getTime());
	if (candidates.length === 1 && unambiguous.length === 1) {
		return { outcome: 'RESOLVED', rule: unambiguous[0]! };
	}
	return { outcome: 'TRANSITION_AMBIGUOUS' };
}
