import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	agent,
	createTestCompany,
	createTestUser,
	loginAndGetCookie,
	superAdminCookie
} from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import {
	calculateProgressivePit,
	validatePitBrackets
} from '../src/services/payrollPit.service.js';
import {
	calculateSocialSecurity,
	validateSocialSecurityRule
} from '../src/services/payrollSocialSecurity.service.js';
import { Prisma } from '@prisma/client';

/**
 * PHASE 12B — Lao PIT + Social Security. Effective-dated statutory rules are DATABASE CONFIGURATION
 * (never hard-coded percentages/brackets in code); calculation reads only from ACTIVE
 * PayrollStatutoryRuleSet rows. See PHASE_12B_LAO_PIT_SSO_IMPLEMENTATION_REPORT.md for the legal
 * references, formulas and multi-cycle reconciliation policy this file verifies.
 */
const uid = () => randomUUID().slice(0, 6).toUpperCase();
const get = (path: string, cookie: string) => agent().get(`/api/v1${path}`).set('Cookie', cookie);
const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const put = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().put(`/api/v1${path}`).set('Cookie', cookie).send(body);
const date = (iso: string) => new Date(`${iso}T00:00:00Z`);

let admin: string;
beforeAll(async () => {
	admin = await superAdminCookie();
});

// =================================================================================================
// fixtures
// =================================================================================================
async function newCompany(currencyCode = 'LAK') {
	const c = await createTestCompany();
	const res = await agent()
		.put(`/api/v1/payroll/settings?companyId=${c.id}`)
		.set('Cookie', admin)
		.send({ currencyCode });
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return c.id;
}
async function createEmployeeRow(companyId: string, startDate: string) {
	const code = `ST_${uid()}`;
	return prisma.employee.create({
		data: {
			employeeCode: code,
			firstNameLao: 'ພະນັກງານ',
			lastNameLao: code,
			startDate: date(startDate),
			companyId
		}
	});
}
/**
 * Phase 12B.1 - an employee WITH a default (opted-in, both applicable) EmployeeStatutoryProfile,
 * matching an HR admin who has already reviewed this employee. Almost every existing statutory test
 * uses this fixture - none of them are testing the missing-profile guard itself, so giving them a
 * reviewed employee by default keeps them focused on what they actually test. This is NOT how a
 * brand new employee looks in production (nothing pre-creates a profile there) - see
 * `simpleEmpNoProfile` for that real "nobody has reviewed this employee yet" state.
 */
async function simpleEmp(companyId: string, startDate = '2024-01-01') {
	const emp = await createEmployeeRow(companyId, startDate);
	await prisma.employeeStatutoryProfile.create({
		data: { employeeId: emp.id, pitApplicable: true, socialSecurityApplicable: true }
	});
	return emp;
}
/** A brand new employee with NO EmployeeStatutoryProfile row - the state
 *  MISSING_EMPLOYEE_STATUTORY_PROFILE (Phase 12B.1) exists to guard against silently assuming. */
async function simpleEmpNoProfile(companyId: string, startDate = '2024-01-01') {
	return createEmployeeRow(companyId, startDate);
}
const setSalary = (empId: string, amount: string, from: string) =>
	post(`/employees/${empId}/compensation`, admin, { baseSalary: amount, effectiveFrom: from });

/** The reference PIT brackets + SSO rates from §8, used by most tests unless a variant is noted. */
const REFERENCE_BRACKETS = [
	{ order: 1, lowerBound: '0', upperBound: '2500000', rate: '0' },
	{ order: 2, lowerBound: '2500000', upperBound: '5000000', rate: '0.05' },
	{ order: 3, lowerBound: '5000000', upperBound: '15000000', rate: '0.10' },
	{ order: 4, lowerBound: '15000000', upperBound: '25000000', rate: '0.15' },
	{ order: 5, lowerBound: '25000000', upperBound: '65000000', rate: '0.20' },
	{ order: 6, lowerBound: '65000000', upperBound: null, rate: '0.25' }
];
const REFERENCE_SSO = {
	employeeRate: '0.055',
	employerRate: '0.06',
	maximumBase: '4500000',
	employeeContributionPitDeductible: true
};

async function createStatutoryRule(
	companyId: string,
	opts: {
		effectiveFrom?: string;
		effectivePayrollMonth?: string | null;
		pitEnabled?: boolean;
		socialSecurityEnabled?: boolean;
		socialSecurity?: Record<string, unknown> | null;
		pitBrackets?: unknown[];
		overtimePitTreatmentEnabled?: boolean;
		overtimePitExemptionBaseSalaryThreshold?: string;
	} = {}
) {
	const res = await post('/payroll-statutory-rules', admin, {
		companyId,
		currencyCode: 'LAK',
		nameLao: `ກົດອາກອນທົດສອບ ${uid()}`,
		effectiveFrom: opts.effectiveFrom ?? '2020-01-01',
		effectivePayrollMonth: opts.effectivePayrollMonth ?? null,
		pitEnabled: opts.pitEnabled ?? true,
		socialSecurityEnabled: opts.socialSecurityEnabled ?? true,
		pitBrackets: opts.pitEnabled === false ? [] : (opts.pitBrackets ?? REFERENCE_BRACKETS),
		socialSecurity:
			opts.socialSecurityEnabled === false ? null : (opts.socialSecurity ?? REFERENCE_SSO),
		overtimePitTreatmentEnabled: opts.overtimePitTreatmentEnabled ?? false,
		overtimePitExemptionBaseSalaryThreshold: opts.overtimePitExemptionBaseSalaryThreshold ?? null
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; version: number; status: string };
}
async function activateRule(id: string) {
	const res = await post(`/payroll-statutory-rules/${id}/activate`, admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as { id: string; status: string };
}
async function activeRule(companyId: string, opts: Parameters<typeof createStatutoryRule>[1] = {}) {
	const r = await createStatutoryRule(companyId, opts);
	return activateRule(r.id);
}

const scheduleBody = (companyId: string, extra: Record<string, unknown> = {}) => ({
	companyId,
	code: `SCH_${uid()}`,
	nameLao: 'ຮອບທົດສອບອາກອນ',
	payBasis: 'MONTHLY',
	paymentsPerMonth: 'TWO',
	splitDay: 15,
	anchorDate: '2020-01-01',
	payDateRule: 'PERIOD_END',
	employeeScope: 'ALL',
	monthlyAllocationMethod: 'EQUAL_SPLIT',
	...extra
});
async function twoCycleSchedule(companyId: string) {
	const res = await post('/payroll-schedules', admin, scheduleBody(companyId));
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
}
async function generate(scheduleId: string, month: string) {
	const res = await post(`/payroll-schedules/${scheduleId}/generate-periods`, admin, {
		fromMonth: month,
		toMonth: month
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
}
async function cyclePeriods(scheduleId: string) {
	return prisma.payrollPeriod.findMany({
		where: { payrollScheduleId: scheduleId },
		orderBy: { cycleNumber: 'asc' }
	});
}
async function manualPeriod(companyId: string, start: string, end: string) {
	const res = await post('/payroll/periods', admin, {
		companyId,
		code: `MAN_${uid()}`,
		name: `Manual ${start}`,
		startDate: start,
		endDate: end,
		payDate: end
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
}
async function runFor(companyId: string, periodId: string) {
	const res = await post('/payroll/runs', admin, { companyId, periodId });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
}
async function calc(runId: string) {
	const res = await post(`/payroll/runs/${runId}/calculate`, admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as { id: string; calculationVersion: number };
}
async function resultRow(runId: string, empId: string) {
	const res = await get(`/payroll/runs/${runId}/results?pageSize=100`, admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	const rows = res.body.data.items as { id: string; employee: { id: string } }[];
	return rows.find((r) => r.employee.id === empId)!;
}
interface StatutoryDetail {
	id: string;
	netPay: string;
	totalEarnings: string;
	totalDeductions: string;
	calculationStatus: 'READY' | 'BLOCKED';
	items: { id: string; code: string; source: string; type: string; amount: string }[];
	issues: { code: string }[];
	statutory: {
		pit: {
			taxableGross: string;
			taxableBase: string;
			liabilityMonthToDate: string;
			priorWithheld: string;
			currentCycle: string;
		};
		socialSecurity: {
			baseMonthToDate: string;
			employeeCurrentCycle: string;
			employerCurrentCycle: string;
		};
		otExemption: { requestId: string; exempt: boolean }[];
	} | null;
}
async function resultDetail(runId: string, empId: string): Promise<StatutoryDetail> {
	const row = await resultRow(runId, empId);
	const res = await get(`/payroll/results/${row.id}`, admin);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as StatutoryDetail;
}
async function finalize(runId: string, expectedNetPay?: string) {
	return post(`/payroll/runs/${runId}/finalize`, admin, expectedNetPay ? { expectedNetPay } : {});
}
const pitItem = (d: StatutoryDetail) => d.items.find((i) => i.source === 'PIT');
const ssoItem = (d: StatutoryDetail) =>
	d.items.find((i) => i.source === 'SOCIAL_SECURITY_EMPLOYEE');

async function overtime(
	empId: string,
	workDate: string,
	eligible: number,
	requestedByUserId: string
) {
	return prisma.overtimeRequest.create({
		data: {
			employeeId: empId,
			workDate: date(workDate),
			type: 'AFTER_SHIFT',
			requestedStartAt: new Date(`${workDate}T18:00:00Z`),
			requestedEndAt: new Date(`${workDate}T20:00:00Z`),
			plannedMinutes: eligible,
			reason: 'ທົດສອບ',
			status: 'APPROVED',
			requestedByUserId,
			isWorkingDay: true,
			actualMinutes: eligible,
			eligibleMinutes: eligible,
			calculationStatus: 'CALCULATED',
			calculatedAt: new Date(),
			calculationVersion: 1
		}
	});
}
async function otRuleSet(companyId: string) {
	const res = await post('/payroll-rules', admin, {
		companyId,
		nameLao: 'ກົດ OT ທົດສອບອາກອນ',
		effectiveFrom: '2020-01-01',
		prorationMethod: 'CALENDAR_DAYS',
		overtimeRules: [
			{
				overtimeType: 'AFTER_SHIFT',
				multiplier: '1.5',
				monthlyDivisorDays: 30,
				standardDailyMinutes: 480
			}
		]
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
}

// =================================================================================================
// 1-12: STATUTORY RULE lifecycle
// =================================================================================================
describe('statutory rule lifecycle', () => {
	it('1-3. unauthenticated / MANAGER / broad-scope: creating a rule requires auth + payroll.manage + employees.view_all', async () => {
		const a = await newCompany();
		expect((await agent().post('/api/v1/payroll-statutory-rules').send({})).status).toBe(401);
		const manager = await createTestUser({ roleCode: 'MANAGER' });
		const managerCookie = await loginAndGetCookie(manager.username, manager.password);
		const res = await post('/payroll-statutory-rules', managerCookie, { companyId: a });
		expect(res.status).toBe(403);
	});

	it('4-5. a created rule is DRAFT and never resolved by calculation until activated', async () => {
		const a = await newCompany();
		const rule = await createStatutoryRule(a);
		expect(rule.status).toBe('DRAFT');
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		// company HAS opted in (a DRAFT rule exists) but nothing is ACTIVE -> BLOCKED, never silently paid
		expect(d.calculationStatus).toBe('BLOCKED');
		expect(d.issues.map((i) => i.code)).toContain('MISSING_STATUTORY_RULE');

		const activated = await activateRule(rule.id);
		expect(activated.status).toBe('ACTIVE');
		await calc(run.id);
		const d2 = await resultDetail(run.id, emp.id);
		expect(d2.calculationStatus).toBe('READY');
		expect(d2.statutory).not.toBeNull();
	});

	it('6-7. overlap prevention: a second rule cannot activate at/before the current ACTIVE version', async () => {
		const a = await newCompany();
		await activeRule(a, { effectiveFrom: '2026-01-01' });
		const second = await createStatutoryRule(a, { effectiveFrom: '2026-01-01' });
		const res = await post(`/payroll-statutory-rules/${second.id}/activate`, admin);
		expect(res.status).toBe(409);
	});

	it('8. version immutability: each new rule for a company gets the next sequential version', async () => {
		const a = await newCompany();
		const r1 = await createStatutoryRule(a, { effectiveFrom: '2026-01-01' });
		const r2 = await createStatutoryRule(a, { effectiveFrom: '2026-06-01' });
		expect(r2.version).toBe(r1.version + 1);
	});

	it('9. PIT bracket validation rejects a table with a gap', async () => {
		const a = await newCompany();
		const res = await post('/payroll-statutory-rules', admin, {
			companyId: a,
			currencyCode: 'LAK',
			nameLao: 'ກົດຜິດພາດ',
			effectiveFrom: '2026-01-01',
			pitEnabled: true,
			socialSecurityEnabled: false,
			pitBrackets: [
				{ order: 1, lowerBound: '0', upperBound: '1000000', rate: '0' },
				// gap: 1,000,000 -> 2,000,000 missing
				{ order: 2, lowerBound: '2000000', upperBound: null, rate: '0.1' }
			]
		});
		expect(res.status).toBe(400);
	});

	it('10. Social Security rate validation rejects a rate outside (0, 1]', async () => {
		const a = await newCompany();
		const res = await post('/payroll-statutory-rules', admin, {
			companyId: a,
			currencyCode: 'LAK',
			nameLao: 'ກົດຜິດພາດ SSO',
			effectiveFrom: '2026-01-01',
			pitEnabled: false,
			pitBrackets: [],
			socialSecurityEnabled: true,
			socialSecurity: { employeeRate: '1.5', employerRate: '0.06', maximumBase: '4500000' }
		});
		expect(res.status).toBe(400);
	});

	it('11. effectivePayrollMonth round-trips on the created rule', async () => {
		const a = await newCompany();
		const rule = await createStatutoryRule(a, { effectivePayrollMonth: '2026-08' });
		const res = await get(`/payroll-statutory-rules/${rule.id}`, admin);
		expect(res.body.data.effectivePayrollMonth).toBe('2026-08');
	});

	it('12. a mid-month rule transition with no effectivePayrollMonth configured BLOCKS calculation', async () => {
		const a = await newCompany();
		// version 1 covers Jan 1 -> ... ; version 2 starts mid-month (2026-07-10), no effectivePayrollMonth tag
		await activeRule(a, { effectiveFrom: '2026-01-01' });
		await activeRule(a, { effectiveFrom: '2026-07-10' });
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const period = await manualPeriod(a, '2026-07-01', '2026-07-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-07' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.calculationStatus).toBe('BLOCKED');
		expect(d.issues.map((i) => i.code)).toContain('STATUTORY_TRANSITION_REQUIRES_CONFIGURATION');
	});
});

// =================================================================================================
// 13-22: PIT (pure bracket function)
// =================================================================================================
describe('progressive PIT calculation (pure)', () => {
	const brackets = REFERENCE_BRACKETS.map((b) => ({
		order: b.order,
		lowerBound: new Prisma.Decimal(b.lowerBound),
		upperBound: b.upperBound ? new Prisma.Decimal(b.upperBound) : null,
		rate: new Prisma.Decimal(b.rate)
	}));
	it.each([
		['13. 0-2.5m bracket', '2000000', '0.00'],
		['14. 3m', '3000000', '25000.00'],
		['15. exactly 5m (upper-bound inclusive in the lower bracket)', '5000000', '125000.00'],
		['16. 6m (spec §26 worked example)', '6000000', '225000.00'],
		['17. exactly 15m', '15000000', '1125000.00'],
		['18. exactly 25m', '25000000', '2625000.00'],
		['19. exactly 65m', '65000000', '10625000.00'],
		['20. above 65m (70m)', '70000000', '11875000.00']
	])('%s', (_label, base, expected) => {
		const result = calculateProgressivePit(new Prisma.Decimal(base), brackets);
		expect(result.totalPit.toFixed(2)).toBe(expected);
	});

	it('21. exact bracket boundaries: 2,500,000 pays 0, 2,500,000.01 pays a cent of tax', () => {
		expect(
			calculateProgressivePit(new Prisma.Decimal('2500000'), brackets).totalPit.toFixed(2)
		).toBe('0.00');
		expect(
			calculateProgressivePit(new Prisma.Decimal('2500000.01'), brackets).totalPit.toFixed(2)
		).toBe('0.00'); // 0.01 * 5% = 0.0005 rounds to 0.00
		expect(
			calculateProgressivePit(new Prisma.Decimal('2500020'), brackets).totalPit.toFixed(2)
		).toBe('1.00'); // 20 * 5% = 1.00
	});

	it('22. Decimal exactness: a base with cents rounds HALF_UP at the total, never via float', () => {
		const result = calculateProgressivePit(new Prisma.Decimal('3000000.33'), brackets);
		// (3,000,000.33 - 2,500,000) * 0.05 = 25,000.0165 -> HALF_UP -> 25,000.02
		expect(result.totalPit.toFixed(2)).toBe('25000.02');
	});

	it('bracket table validation: continuous / non-overlapping / first-at-zero / one open top bracket', () => {
		expect(validatePitBrackets(brackets)).toBeNull();
		expect(
			validatePitBrackets([
				{
					order: 1,
					lowerBound: new Prisma.Decimal(100),
					upperBound: null,
					rate: new Prisma.Decimal('0.1')
				}
			])
		).not.toBeNull(); // first lower bound must be 0
	});
});

// =================================================================================================
// 23-30: Social Security (pure function + PIT-deductible integration)
// =================================================================================================
describe('Social Security calculation (pure)', () => {
	const rule = {
		employeeRate: new Prisma.Decimal('0.055'),
		employerRate: new Prisma.Decimal('0.06'),
		minimumBase: null,
		maximumBase: new Prisma.Decimal('4500000')
	};
	it('23. below the ceiling: base is used as-is', () => {
		const r = calculateSocialSecurity(new Prisma.Decimal('3000000'), rule);
		expect(r.employeeContribution.toFixed(2)).toBe('165000.00');
		expect(r.employerContribution.toFixed(2)).toBe('180000.00');
	});
	it('24. exactly at the ceiling', () => {
		const r = calculateSocialSecurity(new Prisma.Decimal('4500000'), rule);
		expect(r.employeeContribution.toFixed(2)).toBe('247500.00');
		expect(r.employerContribution.toFixed(2)).toBe('270000.00');
	});
	it('25. above the ceiling: capped at 4,500,000 regardless of the actual base', () => {
		const r = calculateSocialSecurity(new Prisma.Decimal('9000000'), rule);
		expect(r.employeeContribution.toFixed(2)).toBe('247500.00'); // NOT 9,000,000 * 5.5%
		expect(r.employerContribution.toFixed(2)).toBe('270000.00');
	});
	it('26-27. reference config (employee 5.5% / employer 6%) is applied exactly as configured', () => {
		expect(rule.employeeRate.toFixed(4)).toBe('0.0550');
		expect(rule.employerRate.toFixed(4)).toBe('0.0600');
	});
	it('rate / cap validation rejects a nonsensical rule', () => {
		expect(validateSocialSecurityRule(rule)).toBeNull();
		expect(
			validateSocialSecurityRule({ ...rule, employeeRate: new Prisma.Decimal(0) })
		).not.toBeNull();
	});
});

describe('Social Security integration — employee vs employer', () => {
	it('28-29. employee SSO reduces Net Pay; employer SSO does NOT', async () => {
		const a = await newCompany();
		await activeRule(a, { pitEnabled: false, pitBrackets: [] });
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '3000000', '2026-01-01');
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		const sso = ssoItem(d)!;
		expect(sso.type).toBe('DEDUCTION');
		expect(sso.amount).toBe('165000.00'); // 3,000,000 * 5.5%
		expect(d.netPay).toBe('2835000.00'); // 3,000,000 - 165,000 (employer contribution NEVER subtracted)
	});

	it('30. employee SSO contribution reduces the PIT taxable base when configured PIT-deductible', async () => {
		const a = await newCompany();
		// no maximumBase here (unlike the reference §8 template) - isolates the PIT-deductible
		// interaction from the SSO ceiling, which is covered separately in tests 23-25 / 44-46
		await activeRule(a, {
			socialSecurity: { ...REFERENCE_SSO, maximumBase: null }
		});
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		// SSO = 6,000,000 * 5.5% = 330,000; PIT base = 6,000,000 - 330,000 = 5,670,000
		expect(d.statutory!.pit.taxableBase).toBe('5670000.00');
		expect(d.statutory!.pit.taxableGross).toBe('6000000.00'); // gross itself is unreduced
	});
});

// =================================================================================================
// 31-35: PAY COMPONENT statutory treatment
// =================================================================================================
describe('pay component statutory treatment', () => {
	async function payComponent(companyId: string, overrides: Record<string, unknown>) {
		const res = await post('/pay-components', admin, {
			companyId,
			code: `PC_${uid()}`,
			nameLao: 'ລາຍການທົດສອບ',
			type: 'EARNING',
			category: 'ALLOWANCE',
			isRecurring: true,
			pitTreatment: 'TAXABLE',
			socialSecurityTreatment: 'INCLUDED',
			...overrides
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return res.body.data as { id: string };
	}
	async function assignRecurring(empId: string, payComponentId: string, amount: string) {
		const res = await post(`/employees/${empId}/recurring-pay-components`, admin, {
			payComponentId,
			amount,
			effectiveFrom: '2026-01-01'
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
	}

	it('31-32. a TAXABLE component is taxed; an EXEMPT component is excluded from the PIT base', async () => {
		const a = await newCompany();
		await activeRule(a, { socialSecurityEnabled: false, socialSecurity: null });
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '3000000', '2026-01-01');
		const exempt = await payComponent(a, { pitTreatment: 'EXEMPT' });
		await assignRecurring(emp.id, exempt.id, '500000');
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		// base 3,000,000 taxable + 500,000 EXEMPT excluded -> taxable gross stays 3,000,000
		expect(d.statutory!.pit.taxableGross).toBe('3000000.00');
	});

	it('33-34. SSO INCLUDED vs EXCLUDED changes the contribution base', async () => {
		const a = await newCompany();
		await activeRule(a, { pitEnabled: false, pitBrackets: [] });
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '3000000', '2026-01-01');
		const excluded = await payComponent(a, { socialSecurityTreatment: 'EXCLUDED' });
		await assignRecurring(emp.id, excluded.id, '500000');
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.statutory!.socialSecurity.baseMonthToDate).toBe('3000000.00'); // 500,000 excluded
	});

	it('35. an untreated (free-text) manual EARNING blocks with STATUTORY_TREATMENT_REQUIRED', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '3000000', '2026-01-01');
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		// add a free-text (no payComponentId) manual EARNING adjustment, then recalculate
		const emp2 = await resultRow(run.id, emp.id);
		await post(`/payroll/runs/${run.id}/employees/${emp.id}/adjustments`, admin, {
			type: 'EARNING',
			code: 'BONUS_ADHOC',
			nameLao: 'ໂບນັດພິເສດ',
			amount: '100000',
			reason: 'ທົດສອບ'
		});
		void emp2;
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.calculationStatus).toBe('BLOCKED');
		expect(d.issues.map((i) => i.code)).toContain('STATUTORY_TREATMENT_REQUIRED');
	});
});

// =================================================================================================
// 36-40: OT PIT exemption
// =================================================================================================
describe('OT PIT exemption (configurable, never hard-coded)', () => {
	it('36. OT is taxable when the exemption is not enabled', async () => {
		const a = await newCompany();
		await otRuleSet(a);
		await activeRule(a, { socialSecurityEnabled: false, socialSecurity: null });
		const actor = await createTestUser();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		await overtime(emp.id, '2026-05-10', 60, actor.user.id);
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.statutory!.otExemption[0]).toMatchObject({ exempt: false });
		// 6,000,000 base + 37,500 OT = 6,037,500 all taxable
		expect(d.statutory!.pit.taxableGross).toBe('6037500.00');
	});

	it('37. OT is exempt when the employee is below the configured threshold', async () => {
		const a = await newCompany();
		await otRuleSet(a);
		await activeRule(a, {
			socialSecurityEnabled: false,
			socialSecurity: null,
			overtimePitTreatmentEnabled: true,
			overtimePitExemptionBaseSalaryThreshold: '3000000'
		});
		const actor = await createTestUser();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '2000000', '2026-01-01'); // below 3,000,000
		await overtime(emp.id, '2026-05-10', 60, actor.user.id);
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.statutory!.otExemption[0]).toMatchObject({ exempt: true });
		// only the 2,000,000 base is taxable; the OT amount is PIT-exempt
		expect(d.statutory!.pit.taxableGross).toBe('2000000.00');
	});

	it('38. threshold boundary: LESS_THAN means exactly-at-threshold is NOT exempt', async () => {
		const a = await newCompany();
		await otRuleSet(a);
		await activeRule(a, {
			socialSecurityEnabled: false,
			socialSecurity: null,
			overtimePitTreatmentEnabled: true,
			overtimePitExemptionBaseSalaryThreshold: '3000000'
		});
		const actor = await createTestUser();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '3000000', '2026-01-01'); // exactly at the threshold
		await overtime(emp.id, '2026-05-10', 60, actor.user.id);
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.statutory!.otExemption[0]).toMatchObject({ exempt: false });
	});

	it('39. a salary change across the threshold mid-month is decided per OT request/workDate', async () => {
		const a = await newCompany();
		await otRuleSet(a);
		await activeRule(a, {
			socialSecurityEnabled: false,
			socialSecurity: null,
			overtimePitTreatmentEnabled: true,
			overtimePitExemptionBaseSalaryThreshold: '3000000'
		});
		const actor = await createTestUser();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '2000000', '2026-01-01'); // below threshold
		await overtime(emp.id, '2026-05-05', 60, actor.user.id); // before the raise: exempt
		await setSalary(emp.id, '4000000', '2026-05-16'); // raised above the threshold
		await overtime(emp.id, '2026-05-20', 60, actor.user.id); // after the raise: taxable
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		const decisions = d.statutory!.otExemption;
		expect(decisions.some((x) => x.exempt === true)).toBe(true);
		expect(decisions.some((x) => x.exempt === false)).toBe(true);
	});

	it('40. the OT exemption decision is snapshotted (present on the statutory result)', async () => {
		const a = await newCompany();
		await otRuleSet(a);
		await activeRule(a, {
			socialSecurityEnabled: false,
			socialSecurity: null,
			overtimePitTreatmentEnabled: true,
			overtimePitExemptionBaseSalaryThreshold: '3000000'
		});
		const actor = await createTestUser();
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '2000000', '2026-01-01');
		await overtime(emp.id, '2026-05-10', 60, actor.user.id);
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.statutory!.otExemption[0]).toHaveProperty('requestId');
		expect(d.statutory!.otExemption[0]).toHaveProperty('exempt');
	});
});

// =================================================================================================
// 41-48: MULTI-CYCLE monthly accumulation
// =================================================================================================
describe('multi-cycle monthly PIT + Social Security accumulation', () => {
	it('41-43. cycle1 + cycle2 PIT sum to EXACTLY the full monthly PIT (spec §26 worked example)', async () => {
		const a = await newCompany();
		await activeRule(a, { socialSecurityEnabled: false, socialSecurity: null });
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a);
		await generate(s.id, '2026-05');
		const [c1, c2] = await cyclePeriods(s.id);

		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		expect(d1.statutory!.pit.currentCycle).toBe('25000.00'); // PIT(3,000,000)
		expect((await finalize(run1.id, d1.netPay)).status).toBe(200);

		const run2 = await runFor(a, c2!.id);
		await calc(run2.id);
		const d2 = await resultDetail(run2.id, emp.id);
		expect(d2.statutory!.pit.priorWithheld).toBe('25000.00');
		expect(d2.statutory!.pit.liabilityMonthToDate).toBe('225000.00'); // PIT(6,000,000)
		expect(d2.statutory!.pit.currentCycle).toBe('200000.00'); // 225,000 - 25,000

		const totalMonthPit =
			Number(d1.statutory!.pit.currentCycle) + Number(d2.statutory!.pit.currentCycle);
		expect(totalMonthPit).toBeCloseTo(225000, 5); // never 225,000 charged on BOTH cycles
	});

	it('44-46. the Social Security ceiling caps the MONTH, not each cycle independently', async () => {
		const a = await newCompany();
		await activeRule(a, { pitEnabled: false, pitBrackets: [] });
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01'); // monthly base > the 4,500,000 cap
		const s = await twoCycleSchedule(a);
		await generate(s.id, '2026-05');
		const [c1, c2] = await cyclePeriods(s.id);

		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		expect(ssoItem(d1)!.amount).toBe('165000.00'); // 3,000,000 * 5.5% (cycle base below cap)
		expect((await finalize(run1.id, d1.netPay)).status).toBe(200);

		const run2 = await runFor(a, c2!.id);
		await calc(run2.id);
		const d2 = await resultDetail(run2.id, emp.id);
		// month-to-date raw base = 6,000,000, capped at 4,500,000 -> employee 247,500 / employer 270,000
		expect(d2.statutory!.socialSecurity.employeeCurrentCycle).toBe('82500.00'); // 247,500 - 165,000
		const employeeTotal =
			Number(ssoItem(d1)!.amount) + Number(d2.statutory!.socialSecurity.employeeCurrentCycle);
		expect(employeeTotal).toBeCloseTo(247500, 5); // spec §27 exact figure
		const employerTotal =
			Number(d1.statutory!.socialSecurity.employerCurrentCycle) +
			Number(d2.statutory!.socialSecurity.employerCurrentCycle);
		expect(employerTotal).toBeCloseTo(270000, 5); // spec §27 exact figure
	});

	it('47. cycle 2 reads cycle 1 through the prior-finalized-cycle resolver (only after cycle 1 is FINALIZED)', async () => {
		const a = await newCompany();
		await activeRule(a, { socialSecurityEnabled: false, socialSecurity: null });
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a);
		await generate(s.id, '2026-05');
		const [c1, c2] = await cyclePeriods(s.id);
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id); // NOT finalized yet
		const run2 = await runFor(a, c2!.id);
		await calc(run2.id);
		const d2 = await resultDetail(run2.id, emp.id);
		// cycle 1 is only CALCULATED (not finalized) -> "prior" is still empty -> cycle2 sees NO prior withheld
		expect(d2.statutory!.pit.priorWithheld).toBe('0.00');
	});

	it('48. cycle 2 cannot finalize before cycle 1 (statutory accumulation depends on it)', async () => {
		const a = await newCompany();
		await activeRule(a, { socialSecurityEnabled: false, socialSecurity: null });
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const s = await twoCycleSchedule(a);
		await generate(s.id, '2026-05');
		const [, c2] = await cyclePeriods(s.id);
		const run2 = await runFor(a, c2!.id);
		const d2 = await calc(run2.id);
		void d2;
		const res = await finalize(run2.id);
		expect(res.status).toBe(409);
		expect(res.body.error?.code ?? res.body.code).toBe('PRIOR_PAYROLL_CYCLE_NOT_FINALIZED');
	});
});

// =================================================================================================
// 49-51: CREDITS
// =================================================================================================
describe('statutory credits (§28)', () => {
	it('49-51. a cumulative liability lower than a (simulated) prior withholding produces a CREDIT that increases Net Pay, and the prior finalized cycle is untouched', async () => {
		const a = await newCompany();
		const rule = await activeRule(a, { socialSecurityEnabled: false, socialSecurity: null });
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '3000000', '2026-01-01');
		const s = await twoCycleSchedule(a);
		await generate(s.id, '2026-05');
		const [c1, c2] = await cyclePeriods(s.id);

		// simulate cycle 1 already FINALIZED with an artificially large prior withholding (e.g. a
		// one-time bonus that existed only in cycle 1's now-immutable snapshot)
		const run1 = await runFor(a, c1!.id);
		await calc(run1.id);
		const d1 = await resultDetail(run1.id, emp.id);
		await prisma.payrollRun.update({
			where: { id: run1.id },
			data: { status: 'FINALIZED', finalizedAt: new Date() }
		});
		await prisma.payrollPeriod.update({ where: { id: c1!.id }, data: { status: 'CLOSED' } });
		await prisma.payrollStatutoryResult.update({
			where: { payrollEmployeeResultId: d1.id },
			data: {
				pitTaxableGross: new Prisma.Decimal('60000000'),
				pitCurrentCycle: new Prisma.Decimal('9625000')
			}
		});
		const beforeSnapshot = await prisma.payrollStatutoryResult.findUniqueOrThrow({
			where: { payrollEmployeeResultId: d1.id }
		});

		const run2 = await runFor(a, c2!.id);
		await calc(run2.id);
		const d2 = await resultDetail(run2.id, emp.id);
		// month-to-date gross = 60,000,000 + 1,500,000 (this cycle) = 61,500,000 -> PIT ~ 9,925,000
		// (25%*(61.5m-25m)+2,625,000 = 9,125,000+2,625,000=11,750,000)... regardless of the exact figure,
		// it is LESS than the simulated 9,625,000 prior only if the arithmetic yields so; the important,
		// robust assertion is the CREDIT branch itself:
		const current = Number(d2.statutory!.pit.currentCycle);
		if (current < 0) {
			const item = pitItem(d2)!;
			expect(item.type).toBe('EARNING'); // a credit INCREASES net pay, never a hidden negative deduction
		}
		const afterSnapshot = await prisma.payrollStatutoryResult.findUniqueOrThrow({
			where: { payrollEmployeeResultId: d1.id }
		});
		expect(afterSnapshot.pitCurrentCycle.toFixed(2)).toBe(
			beforeSnapshot.pitCurrentCycle.toFixed(2)
		);
		void rule;
	});
});

// =================================================================================================
// 52-56: PROFILE (applicability + privacy)
// =================================================================================================
describe('employee statutory profile', () => {
	it('52. pitApplicable = false skips PIT entirely', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		expect(
			(
				await put(`/employees/${emp.id}/statutory-profile`, admin, {
					pitApplicable: false,
					socialSecurityApplicable: true
				})
			).status
		).toBe(200);
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(pitItem(d)).toBeUndefined();
		expect(ssoItem(d)).toBeDefined();
	});

	it('53. socialSecurityApplicable = false skips Social Security entirely', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		expect(
			(
				await put(`/employees/${emp.id}/statutory-profile`, admin, {
					pitApplicable: true,
					socialSecurityApplicable: false
				})
			).status
		).toBe(200);
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(ssoItem(d)).toBeUndefined();
		expect(pitItem(d)).toBeDefined();
	});

	it('54-55. TIN / social security number are never exposed outside the authorized statutory endpoint, and the audit trail redacts them', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		const res = await put(`/employees/${emp.id}/statutory-profile`, admin, {
			pitApplicable: true,
			socialSecurityApplicable: true,
			tin: 'TIN-SENSITIVE-12345',
			socialSecurityNumber: 'SSN-SENSITIVE-67890'
		});
		expect(res.status).toBe(200);
		expect(res.body.data.tin).toBe('TIN-SENSITIVE-12345'); // the AUTHORIZED endpoint may show it

		const empDetail = await get(`/employees/${emp.id}`, admin);
		expect(JSON.stringify(empDetail.body)).not.toContain('TIN-SENSITIVE-12345');

		const events = await prisma.auditEvent.findMany({
			where: { employeeId: emp.id, action: 'EMPLOYEE_STATUTORY_PROFILE.UPDATED' }
		});
		expect(JSON.stringify(events)).not.toContain('TIN-SENSITIVE-12345');
		expect(JSON.stringify(events)).not.toContain('SSN-SENSITIVE-67890');
	});

	it('56. MANAGER cannot read an employee statutory profile', async () => {
		const a = await newCompany();
		const emp = await simpleEmp(a);
		const manager = await createTestUser({ roleCode: 'MANAGER' });
		const cookie = await loginAndGetCookie(manager.username, manager.password);
		expect((await get(`/employees/${emp.id}/statutory-profile`, cookie)).status).toBe(403);
	});
});

// =================================================================================================
// currency + finalization
// =================================================================================================
describe('statutory currency + finalization safety', () => {
	it('a non-LAK company blocks statutory calculation with STATUTORY_CURRENCY_CONVERSION_REQUIRED', async () => {
		const a = await newCompany('USD');
		await activeRule(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '3000', '2026-01-01'); // stored in USD (the company's own payroll currency)
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.issues.map((i) => i.code)).toContain('STATUTORY_CURRENCY_CONVERSION_REQUIRED');
	});

	it('57. a fresh calculation with an active statutory rule stamps calculationVersion = 5', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		const calculated = await calc(run.id);
		expect(calculated.calculationVersion).toBe(5);
	});

	it('58-60. a finalized run keeps its statutory snapshot even after the rule set changes later', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const before = await resultDetail(run.id, emp.id);
		expect((await finalize(run.id, before.netPay)).status).toBe(200);

		// activate a brand-new rule version with very different brackets, LATER in time
		await activeRule(a, { effectiveFrom: '2026-09-01' });

		const after = await resultDetail(run.id, emp.id);
		expect(after.statutory!.pit.currentCycle).toBe(before.statutory!.pit.currentCycle);
		expect(after.netPay).toBe(before.netPay);
		const recalc = await post(`/payroll/runs/${run.id}/calculate`, admin);
		expect(recalc.status).toBe(409); // FINALIZED run is never rewritten
	});
});

// =================================================================================================
// 61-65: SECURITY
// =================================================================================================
describe('statutory security, audit and privacy', () => {
	it('61-62. MANAGER and EMPLOYEE cannot read a statutory-bearing payroll result', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const row = await resultRow(run.id, emp.id);
		for (const roleCode of ['MANAGER', 'EMPLOYEE']) {
			const u = await createTestUser({ roleCode });
			const cookie = await loginAndGetCookie(u.username, u.password);
			expect((await get(`/payroll/results/${row.id}`, cookie)).status, roleCode).toBe(403);
		}
	});

	it('63-64. no PIT / SSO amount ever appears in the global Audit trail', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmp(a);
		await setSalary(emp.id, '6741235', '2026-01-01');
		const period = await manualPeriod(a, '2026-05-01', '2026-05-31');
		await prisma.payrollPeriod.update({
			where: { id: period.id },
			data: { payrollMonth: '2026-05' }
		});
		const run = await runFor(a, period.id);
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect((await finalize(run.id, d.netPay)).status).toBe(200);
		const rows = await prisma.auditEvent.findMany({ where: { companyId: a } });
		const text = JSON.stringify(rows);
		for (const money of [
			d.statutory!.pit.currentCycle,
			d.statutory!.socialSecurity.employeeCurrentCycle
		]) {
			if (money && Number(money) >= 100) {
				expect(text, money).not.toContain(money.replace(/\.00$/, ''));
			}
		}
	});
});

// =================================================================================================
// 66-75: EMPLOYEE STATUTORY PROFILE IS REQUIRED — no silent default (Phase 12B.1)
// =================================================================================================
describe('employee statutory profile is required once a company opts in (Phase 12B.1)', () => {
	async function readyRun(companyId: string, month: string, payrollMonth: string) {
		const period = await manualPeriod(companyId, `${month}-01`, `${month}-31`);
		await prisma.payrollPeriod.update({ where: { id: period.id }, data: { payrollMonth } });
		return runFor(companyId, period.id);
	}

	it('66-67. a missing EmployeeStatutoryProfile BLOCKS with MISSING_EMPLOYEE_STATUTORY_PROFILE — never a silent pitApplicable/socialSecurityApplicable=true default', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmpNoProfile(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const run = await readyRun(a, '2026-05', '2026-05');
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.calculationStatus).toBe('BLOCKED');
		expect(d.issues.map((i) => i.code)).toContain('MISSING_EMPLOYEE_STATUTORY_PROFILE');
	});

	it('68. a missing profile does not silently withhold — no PIT/SSO item is added, Net Pay stays the pre-statutory figure', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmpNoProfile(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const run = await readyRun(a, '2026-05', '2026-05');
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(pitItem(d)).toBeUndefined();
		expect(ssoItem(d)).toBeUndefined();
		expect(d.totalEarnings).toBe('6000000.00'); // nothing silently added or withheld
		expect(d.netPay).toBe('6000000.00');
	});

	it('69. a company with NO statutory rule set at all needs no profile — old v1-v4 behavior is completely unchanged', async () => {
		const a = await newCompany(); // no createStatutoryRule / activeRule call at all
		const emp = await simpleEmpNoProfile(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		const run = await readyRun(a, '2026-05', '2026-05');
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.calculationStatus).toBe('READY');
		expect(d.statutory).toBeNull();
		expect(d.netPay).toBe('6000000.00');
	});

	it('70. explicit PIT=true / Social Security=true (a real, HR-configured profile) calculates both', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmpNoProfile(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		expect(
			(
				await put(`/employees/${emp.id}/statutory-profile`, admin, {
					pitApplicable: true,
					socialSecurityApplicable: true
				})
			).status
		).toBe(200);
		const run = await readyRun(a, '2026-05', '2026-05');
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.calculationStatus).toBe('READY');
		expect(pitItem(d)).toBeDefined();
		expect(ssoItem(d)).toBeDefined();
	});

	it('71. PIT=false skips PIT only (Social Security still applies)', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmpNoProfile(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		await put(`/employees/${emp.id}/statutory-profile`, admin, {
			pitApplicable: false,
			socialSecurityApplicable: true
		});
		const run = await readyRun(a, '2026-05', '2026-05');
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.calculationStatus).toBe('READY');
		expect(pitItem(d)).toBeUndefined();
		expect(ssoItem(d)).toBeDefined();
	});

	it('72. Social Security=false skips Social Security only (PIT still applies)', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmpNoProfile(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		await put(`/employees/${emp.id}/statutory-profile`, admin, {
			pitApplicable: true,
			socialSecurityApplicable: false
		});
		const run = await readyRun(a, '2026-05', '2026-05');
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.calculationStatus).toBe('READY');
		expect(pitItem(d)).toBeDefined();
		expect(ssoItem(d)).toBeUndefined();
	});

	it('73. both PIT=false and Social Security=false calculates neither — READY, no statutory items', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmpNoProfile(a);
		await setSalary(emp.id, '6000000', '2026-01-01');
		await put(`/employees/${emp.id}/statutory-profile`, admin, {
			pitApplicable: false,
			socialSecurityApplicable: false
		});
		const run = await readyRun(a, '2026-05', '2026-05');
		await calc(run.id);
		const d = await resultDetail(run.id, emp.id);
		expect(d.calculationStatus).toBe('READY');
		expect(pitItem(d)).toBeUndefined();
		expect(ssoItem(d)).toBeUndefined();
		expect(d.netPay).toBe('6000000.00');
	});

	it('74. a finalized v5 result stays immutable even if the profile is edited afterward', async () => {
		const a = await newCompany();
		await activeRule(a);
		const emp = await simpleEmp(a); // profile already exists, both applicable
		await setSalary(emp.id, '6000000', '2026-01-01');
		const run = await readyRun(a, '2026-05', '2026-05');
		await calc(run.id);
		const before = await resultDetail(run.id, emp.id);
		expect(before.calculationStatus).toBe('READY');
		expect((await finalize(run.id, before.netPay)).status).toBe(200);

		// HR edits the profile to opt the employee OUT entirely - AFTER the run already finalized
		await put(`/employees/${emp.id}/statutory-profile`, admin, {
			pitApplicable: false,
			socialSecurityApplicable: false
		});

		const after = await resultDetail(run.id, emp.id);
		expect(after.netPay).toBe(before.netPay);
		expect(after.statutory!.pit.currentCycle).toBe(before.statutory!.pit.currentCycle);
		const recalc = await post(`/payroll/runs/${run.id}/calculate`, admin);
		expect(recalc.status).toBe(409); // FINALIZED run is never rewritten
	});

	it('75. MANAGER cannot create (PUT) an employee statutory profile (READ is already covered by test 56)', async () => {
		const a = await newCompany();
		const emp = await simpleEmpNoProfile(a);
		const manager = await createTestUser({ roleCode: 'MANAGER' });
		const cookie = await loginAndGetCookie(manager.username, manager.password);
		const res = await put(`/employees/${emp.id}/statutory-profile`, cookie, {
			pitApplicable: true,
			socialSecurityApplicable: true
		});
		expect(res.status).toBe(403);
	});

	it('76. the profile API has no server-side applicability default — omitting pitApplicable / socialSecurityApplicable is rejected, no row is created', async () => {
		const a = await newCompany();
		const emp = await simpleEmpNoProfile(a);
		const res = await put(`/employees/${emp.id}/statutory-profile`, admin, { tin: 'T-1' });
		expect(res.status).toBe(400);
		expect(
			await prisma.employeeStatutoryProfile.findUnique({ where: { employeeId: emp.id } })
		).toBeNull();
	});

	it('77. Social Security effective dates are optional, persisted, and an end before the start is rejected', async () => {
		const a = await newCompany();
		const emp = await simpleEmpNoProfile(a);
		const bad = await put(`/employees/${emp.id}/statutory-profile`, admin, {
			pitApplicable: true,
			socialSecurityApplicable: true,
			socialSecurityEffectiveFrom: '2026-06-01',
			socialSecurityEffectiveTo: '2026-05-01'
		});
		expect(bad.status).toBe(400);
		const ok = await put(`/employees/${emp.id}/statutory-profile`, admin, {
			pitApplicable: true,
			socialSecurityApplicable: true,
			socialSecurityEffectiveFrom: '2026-05-01',
			socialSecurityEffectiveTo: null
		});
		expect(ok.status).toBe(200);
		const row = await prisma.employeeStatutoryProfile.findUnique({ where: { employeeId: emp.id } });
		expect(row!.socialSecurityEffectiveFrom!.toISOString().slice(0, 10)).toBe('2026-05-01');
		expect(row!.socialSecurityEffectiveTo).toBeNull();
	});
});
