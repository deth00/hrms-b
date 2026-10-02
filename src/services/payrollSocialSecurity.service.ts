import { Prisma } from '@prisma/client';
import { calc, roundMoney, type CalcValue } from '../lib/money.js';

/**
 * SOCIAL SECURITY (Phase 12B §19-21). Pure function — the rates and the ceiling are DATABASE
 * CONFIGURATION (PayrollSocialSecurityRule), never hard-coded.
 *
 *   cappedBase          = min(monthlyContributionBase, maximumBase)     (the cap applies to the WHOLE
 *                                                                        MONTH, never independently
 *                                                                        per cycle - §20, §27)
 *   employeeContribution = cappedBase × employeeRate
 *   employerContribution = cappedBase × employerRate
 */
export interface SocialSecurityRuleInput {
	employeeRate: Prisma.Decimal;
	employerRate: Prisma.Decimal;
	minimumBase: Prisma.Decimal | null;
	maximumBase: Prisma.Decimal | null;
}

export interface SocialSecurityResult {
	base: Prisma.Decimal;
	cappedBase: Prisma.Decimal;
	employeeContribution: Prisma.Decimal;
	employerContribution: Prisma.Decimal;
}

export function calculateSocialSecurity(
	monthlyContributionBase: Prisma.Decimal | CalcValue,
	rule: SocialSecurityRuleInput
): SocialSecurityResult {
	const base = calc(monthlyContributionBase).isNegative() ? calc(0) : calc(monthlyContributionBase);
	let cappedBase = base;
	if (rule.maximumBase !== null) cappedBase = CalcMin(cappedBase, calc(rule.maximumBase));
	if (rule.minimumBase !== null) cappedBase = CalcMax(cappedBase, calc(rule.minimumBase));
	const employeeContribution = roundMoney(cappedBase.times(calc(rule.employeeRate)));
	const employerContribution = roundMoney(cappedBase.times(calc(rule.employerRate)));
	return {
		base: new Prisma.Decimal(base.toFixed(2)),
		cappedBase: new Prisma.Decimal(cappedBase.toFixed(2)),
		employeeContribution,
		employerContribution
	};
}

function CalcMin(a: CalcValue, b: CalcValue): CalcValue {
	return a.lessThan(b) ? a : b;
}
function CalcMax(a: CalcValue, b: CalcValue): CalcValue {
	return a.greaterThan(b) ? a : b;
}

/** Structural validation (§6, §20): rates must be sane fractions and the ceiling (when set) positive. */
export function validateSocialSecurityRule(input: SocialSecurityRuleInput): string | null {
	if (input.employeeRate.lessThanOrEqualTo(0) || input.employeeRate.greaterThan(1)) {
		return 'ອັດຕາປະກັນສັງຄົມຝ່າຍພະນັກງານຕ້ອງຢູ່ລະຫວ່າງ 0 ແລະ 100%';
	}
	if (input.employerRate.lessThanOrEqualTo(0) || input.employerRate.greaterThan(1)) {
		return 'ອັດຕາປະກັນສັງຄົມຝ່າຍນາຍຈ້າງຕ້ອງຢູ່ລະຫວ່າງ 0 ແລະ 100%';
	}
	if (input.maximumBase !== null && input.maximumBase.lessThanOrEqualTo(0)) {
		return 'ເພດານຖານເງິນເດືອນຕ້ອງຫຼາຍກວ່າ 0';
	}
	if (
		input.minimumBase !== null &&
		input.maximumBase !== null &&
		input.minimumBase.greaterThan(input.maximumBase)
	) {
		return 'ຖານຕໍ່າສຸດຕ້ອງບໍ່ຫຼາຍກວ່າຖານສູງສຸດ';
	}
	return null;
}
