import type { Prisma } from '@prisma/client';
import { formatDateOnly } from '../lib/dates.js';
import { calc, moneyString, roundMoney, type CalcValue } from '../lib/money.js';
import type { OvertimeSummary } from './overtimeLookup.service.js';
import type { RuleSnapshot } from './payrollRules.service.js';
import { resolveOvertimeRateBasis } from './payrollOvertimeRate.service.js';

/**
 * PAYROLL OT COMPENSATION (Phase 12A / corrected in 12A.2). Pays ONLY Phase 8's
 * `OvertimeRequest.eligibleMinutes` of APPROVED requests — never plannedMinutes, actualMinutes or raw
 * attendance. The Phase 8 cap / approved-window logic is not re-applied here; when an Attendance
 * Correction changes the eligible minutes, the next (non-finalized) calculation simply reads the new
 * figure.
 *
 *   minute rate = the MONTHLY base salary effective on the OT work date ÷ monthlyDivisorDays
 *                 ÷ standardDailyMinutes                                    (payrollOvertimeRate.service.ts)
 *   OT amount   = eligibleMinutes × minute rate × multiplier                (per request, exact)
 *
 * Phase 12A.2: the numerator is the employee's MONTHLY compensation, resolved on the OT's own work
 * date — NEVER the cycle-allocated or segment-prorated amount Phase 12A.1 / 12A compute for normal
 * salary. Payroll payment frequency (once vs. twice a month) must not change the OT rate; a salary
 * change lands its OWN request on whichever side of the effective date the work date falls, independent
 * of which payroll cycle or segment that date happens to fall in for NORMAL salary purposes.
 *
 * Multiplier, divisor and daily minutes come from the company's OvertimeCompensationRule for that OT
 * type — they are company policy, never hard-coded and never presented as statutory, and always MONTHLY
 * (never divided for a twice-monthly schedule). A type that has eligible minutes but no complete rule,
 * or no monthly compensation resolvable for that work date, makes the employee BLOCKED
 * (OT_COMPENSATION_RULE_INCOMPLETE) — nothing is guessed. Requests are calculated independently,
 * aggregated per OT type into one line (rounded HALF_UP once) and stay traceable through
 * `details.requests` (each carrying its OWN monthly-salary / rate snapshot, since two requests of the
 * same type can legitimately use different monthly salaries if one landed before and one after a raise).
 */
export interface OvertimeInput {
	summary: OvertimeSummary;
	/** Phase 12A.2 - the MONTHLY compensation effective on summary.workDate (never cycle/segment-scaled) */
	monthlyBaseSalary: Prisma.Decimal | null;
}

export interface OvertimeLine {
	type: OvertimeSummary['type'];
	code: string;
	nameLao: string;
	nameEnglish: string;
	amount: Prisma.Decimal;
	details: Record<string, unknown>;
}

export interface OvertimeSummaryOut {
	requests: {
		requestId: number;
		type: string;
		workDate: string;
		eligibleMinutes: number;
		calculationStatus: string | null;
	}[];
	byType: { type: string; eligibleMinutes: number }[];
	totalEligibleMinutes: number;
	/** approved requests whose eligible minutes are not final yet (attendance pending / incomplete) */
	notCalculatedRequests: number;
}

const NAMES: Record<OvertimeSummary['type'], [string, string]> = {
	BEFORE_SHIFT: ['ຄ່າລ່ວງເວລາ (ກ່ອນເຂົ້າວຽກ)', 'OT Before Shift'],
	AFTER_SHIFT: ['ຄ່າລ່ວງເວລາ (ຫຼັງເລີກວຽກ)', 'OT After Shift'],
	OFF_DAY: ['ຄ່າລ່ວງເວລາ (ວັນພັກປະຈຳອາທິດ)', 'OT Off Day'],
	HOLIDAY: ['ຄ່າລ່ວງເວລາ (ວັນພັກລັດຖະການ)', 'OT Holiday']
};

export function computeOvertimeCompensation(input: {
	requests: readonly OvertimeInput[];
	rule: RuleSnapshot;
}): { lines: OvertimeLine[]; summary: OvertimeSummaryOut; incomplete: boolean } {
	const summary: OvertimeSummaryOut = {
		requests: [],
		byType: [],
		totalEligibleMinutes: 0,
		notCalculatedRequests: 0
	};
	let incomplete = false;
	const byType = new Map<
		OvertimeSummary['type'],
		{ amount: CalcValue; minutes: number; requests: Record<string, unknown>[]; rule: unknown }
	>();

	for (const { summary: ot, monthlyBaseSalary } of input.requests) {
		if (ot.eligibleMinutes === null) summary.notCalculatedRequests += 1;
		const minutes = ot.eligibleMinutes ?? 0;
		if (minutes <= 0) continue;
		summary.requests.push({
			requestId: ot.requestId,
			type: ot.type,
			workDate: formatDateOnly(ot.workDate),
			eligibleMinutes: minutes,
			calculationStatus: ot.calculationStatus
		});
		summary.totalEligibleMinutes += minutes;

		const rule = input.rule.overtimeRules.find((r) => r.overtimeType === ot.type);
		// Phase 12A.2 - the numerator is the MONTHLY salary effective on THIS request's work date,
		// resolved by the caller (never the cycle-allocated / segment-prorated amount)
		const basis = rule ? resolveOvertimeRateBasis(monthlyBaseSalary, rule) : null;
		if (!basis) {
			incomplete = true;
			continue;
		}
		const amount = basis.minuteRate.times(minutes).times(calc(basis.multiplier));
		const acc = byType.get(ot.type) ?? { amount: calc(0), minutes: 0, requests: [], rule };
		acc.amount = acc.amount.plus(amount);
		acc.minutes += minutes;
		acc.requests.push({
			requestId: ot.requestId,
			workDate: formatDateOnly(ot.workDate),
			eligibleMinutes: minutes,
			// Phase 12A.2 - full per-request rate snapshot (§13): two requests of the same OT type can
			// legitimately use different monthly salaries (a raise landing between them)
			monthlyBaseSalary: moneyString(basis.monthlyBaseSalary),
			monthlyDivisorDays: basis.monthlyDivisorDays,
			standardDailyMinutes: basis.standardDailyMinutes,
			minuteRate: basis.minuteRate.toDecimalPlaces(8).toFixed(8),
			multiplier: basis.multiplier.toFixed(4),
			// Phase 12B - this request's OWN (unrounded-line) amount, so a statutory step can split
			// taxable / PIT-exempt OT (§17-18) without re-deriving the formula. Rounded to money
			// precision independently of the aggregated line's single rounding — see §17 in the
			// Phase 12B report for why a 1-cent domain separation here is accepted.
			amount: roundMoney(amount).toFixed(2)
		});
		byType.set(ot.type, acc);
	}

	const minutesByType = new Map<string, number>();
	for (const r of summary.requests) {
		minutesByType.set(r.type, (minutesByType.get(r.type) ?? 0) + r.eligibleMinutes);
	}
	summary.byType = [...minutesByType].map(([type, eligibleMinutes]) => ({ type, eligibleMinutes }));

	const lines: OvertimeLine[] = [];
	for (const [type, acc] of byType) {
		const amount = roundMoney(acc.amount);
		if (!amount.greaterThan(0)) continue;
		const rule = input.rule.overtimeRules.find((r) => r.overtimeType === type)!;
		lines.push({
			type,
			code: `OT_${type}`,
			nameLao: NAMES[type][0],
			nameEnglish: NAMES[type][1],
			amount,
			details: {
				minutes: acc.minutes,
				multiplier: rule.multiplier,
				rateBasis: rule.rateBasis,
				monthlyDivisorDays: rule.monthlyDivisorDays,
				standardDailyMinutes: rule.standardDailyMinutes,
				requests: acc.requests
			}
		});
	}
	return { lines, summary, incomplete };
}
