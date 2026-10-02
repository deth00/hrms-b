import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
	agent,
	createTestCompany,
	createTestUser,
	loginAndGetCookie,
	userWithPermissions
} from './helpers.js';
import { prisma } from '../src/config/prisma.js';

/**
 * Shared fixtures for the Phase 13 suites (payroll approval + payslips). Periods are in the past
 * (Sep 2025) so attendance-based deductions see real ABSENT days.
 */
export const uid = () => randomUUID().slice(0, 6).toUpperCase();
export const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
export const get = (path: string, cookie: string) =>
	agent().get(`/api/v1${path}`).set('Cookie', cookie);
export const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);
export const put = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().put(`/api/v1${path}`).set('Cookie', cookie).send(body);

export const START = '2025-09-01';
export const END = '2025-09-30';

export const ctx = {} as {
	admin: string;
	adminUserId: string;
	/** HR_ADMIN — payroll.manage + calculate + finalize + approve (the usual submitter) */
	submitter: { cookie: string; userId: string };
	/** payroll.approve + payroll.view + employees.view_all only */
	approver: { cookie: string; userId: string };
	approver2: { cookie: string; userId: string };
};

async function hrAdmin() {
	const { user, username, password } = await createTestUser({ roleCode: 'HR_ADMIN' });
	return { cookie: await loginAndGetCookie(username, password), userId: user.id };
}
export async function approverUser() {
	const u = await userWithPermissions(['payroll.approve', 'payroll.view', 'employees.view_all']);
	return { cookie: u.cookie, userId: u.user.id };
}

export async function setupPhase13() {
	const { user, username, password } = await createTestUser({ roleCode: 'SUPER_ADMIN' });
	ctx.admin = await loginAndGetCookie(username, password);
	ctx.adminUserId = user.id;
	ctx.submitter = await hrAdmin();
	ctx.approver = await approverUser();
	ctx.approver2 = await approverUser();
}

export async function newCompany(approvalMode: 'DIRECT' | 'WORKFLOW' = 'DIRECT') {
	const c = await createTestCompany();
	const res = await put(`/payroll/settings?companyId=${c.id}`, ctx.admin, {
		currencyCode: 'LAK',
		...(approvalMode === 'WORKFLOW' ? { approvalMode } : {})
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return c.id;
}

export const permStep = (nameLao = 'ອະນຸມັດເງິນເດືອນ') => ({
	nameLao,
	approverType: 'PERMISSION',
	permissionCode: 'payroll.approve'
});
export const userStep = (userId: string, nameLao = 'ຜູ້ອະນຸມັດສະເພາະ') => ({
	nameLao,
	approverType: 'USER',
	userId
});
export async function payrollWorkflow(
	companyId: string,
	steps: Record<string, unknown>[] = [permStep()]
) {
	const res = await post('/approval-workflows', ctx.admin, {
		companyId,
		targetType: 'PAYROLL_RUN',
		code: `PAYROLL_${uid()}`,
		nameLao: 'ຂັ້ນຕອນອະນຸມັດຮອບເງິນເດືອນ',
		steps
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string };
}

export async function employee(
	companyId: string,
	o: {
		salary?: string | null;
		start?: string;
		code?: string;
		userId?: string | null;
		managerEmployeeId?: string;
	} = {}
) {
	const code = o.code ?? `P13_${uid()}`;
	const emp = await prisma.employee.create({
		data: {
			employeeCode: code,
			firstNameLao: 'ພະນັກງານ',
			lastNameLao: code,
			startDate: D(o.start ?? '2024-01-01'),
			companyId,
			userId: o.userId ?? null,
			managerEmployeeId: o.managerEmployeeId ?? null
		}
	});
	if (o.salary !== null) {
		const r = await post(`/employees/${emp.id}/compensation`, ctx.admin, {
			baseSalary: o.salary ?? '5000000',
			effectiveFrom: '2025-01-01'
		});
		expect(r.status, JSON.stringify(r.body)).toBe(201);
	}
	return emp;
}

export async function manualPeriod(companyId: string, start = START, end = END) {
	const res = await post('/payroll/periods', ctx.admin, {
		companyId,
		code: `MAN_${uid()}`,
		name: `ງວດທົດສອບ ${uid()}`,
		startDate: start,
		endDate: end,
		payDate: end
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as { id: string; code: string; name: string };
}

export interface RunView {
	id: string;
	status: string;
	calculationVersion: number;
	summary: { employees: number; ready: number; blocked: number; netPay: string };
	approval: {
		mode: 'DIRECT' | 'WORKFLOW';
		state: string;
		attemptNo: number | null;
		approvalInstanceId: string | null;
		submittedBy: { id: string } | null;
		approvedBy: { id: string } | null;
		approvedAt: string | null;
	};
	payslipCount: number;
}
export async function newRun(companyId: string, periodId: string, cookie = ctx.admin) {
	const res = await post('/payroll/runs', cookie, { companyId, periodId });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as RunView;
}
export async function calc(runId: string, cookie = ctx.admin) {
	const res = await post(`/payroll/runs/${runId}/calculate`, cookie);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as RunView;
}
export const submit = (runId: string, cookie = ctx.submitter.cookie) =>
	post(`/payroll/runs/${runId}/submit-approval`, cookie);
export const cancelSub = (runId: string, cookie = ctx.submitter.cookie) =>
	post(`/payroll/runs/${runId}/cancel-approval`, cookie);
export const reopen = (runId: string, cookie = ctx.submitter.cookie) =>
	post(`/payroll/runs/${runId}/reopen`, cookie);
export const finalize = (runId: string, cookie = ctx.admin) =>
	post(`/payroll/runs/${runId}/finalize`, cookie);
export const approveI = (instanceId: string, cookie = ctx.approver.cookie) =>
	post(`/approvals/${instanceId}/approve`, cookie);
export const rejectI = (instanceId: string, cookie = ctx.approver.cookie, note = 'ຕົວເລກບໍ່ຖືກ') =>
	post(`/approvals/${instanceId}/reject`, cookie, { note });
export async function runOf(runId: string, cookie = ctx.admin) {
	const res = await get(`/payroll/runs/${runId}`, cookie);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as RunView;
}
export async function submitOk(runId: string, cookie = ctx.submitter.cookie) {
	const res = await submit(runId, cookie);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as RunView;
}
export async function approveOk(runId: string, cookie = ctx.approver.cookie) {
	const run = await runOf(runId);
	const res = await approveI(run.approval.approvalInstanceId!, cookie);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return runOf(runId);
}

/** WORKFLOW company + one-step payroll.approve workflow + 1 employee + a CALCULATED manual run. */
export async function workflowWorld(
	o: { employees?: number; salary?: string; workflow?: boolean } = {}
) {
	const companyId = await newCompany('WORKFLOW');
	if (o.workflow !== false) await payrollWorkflow(companyId);
	const emps = [];
	for (let i = 0; i < (o.employees ?? 1); i++)
		emps.push(await employee(companyId, { salary: o.salary }));
	const period = await manualPeriod(companyId);
	const run = await newRun(companyId, period.id);
	await calc(run.id);
	return { companyId, emps, period, run };
}

/** WORKFLOW world already APPROVED (submitter submitted, approver approved). */
export async function approvedWorld(o: Parameters<typeof workflowWorld>[0] = {}) {
	const w = await workflowWorld(o);
	await submitOk(w.run.id);
	const run = await approveOk(w.run.id);
	expect(run.approval.state).toBe('APPROVED');
	return w;
}

// ---------- rule-based (v2) world: shift, schedule, attendance, rule ----------
export const OT_AFTER = {
	overtimeType: 'AFTER_SHIFT',
	multiplier: '1.5',
	monthlyDivisorDays: 30,
	standardDailyMinutes: 480
};
function days(from: string, to: string) {
	const out: string[] = [];
	for (let d = D(from); d.getTime() <= D(to).getTime(); d = new Date(d.getTime() + 86_400_000)) {
		out.push(d.toISOString().slice(0, 10));
	}
	return out;
}
export const weekdays = (from = START, to = END) =>
	days(from, to).filter((iso) => ![0, 6].includes(D(iso).getUTCDay()));

export async function shiftFor(companyId: string) {
	const days7 = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
	return prisma.shift.create({
		data: {
			companyId,
			code: `SH_${uid()}`,
			nameLao: 'ກະທົດສອບ',
			startTime: '08:00',
			endTime: '17:00',
			breakMinutes: 60,
			workDays: {
				create: days7.map((dayOfWeek, i) => ({
					dayOfWeek: dayOfWeek as never,
					isWorkingDay: i < 5
				}))
			}
		}
	});
}
export const presentRow = (employeeId: string, shiftId: string, iso: string) => ({
	employeeId,
	workDate: D(iso),
	shiftId,
	scheduledStartTime: '08:00',
	scheduledEndTime: '17:00',
	scheduledBreakMinutes: 60,
	scheduledLateGraceMinutes: 0,
	scheduledEarlyLeaveGraceMinutes: 0,
	firstCheckInAt: new Date(`${iso}T01:00:00Z`),
	lastCheckOutAt: new Date(`${iso}T10:00:00Z`),
	effectiveCheckInAt: new Date(`${iso}T01:00:00Z`),
	effectiveCheckOutAt: new Date(`${iso}T10:00:00Z`),
	scheduledWorkMinutes: 480,
	workedMinutes: 480,
	arrivalDelayMinutes: 0,
	lateMinutes: 0,
	earlyLeaveMinutes: 0,
	calculationStatus: 'PRESENT' as never,
	calculatedAt: new Date(),
	calculationVersion: 1,
	status: 'COMPLETED' as const,
	isWorkingDay: true
});

/**
 * WORKFLOW + a payroll RULE (absence + unpaid leave deductions, AFTER_SHIFT OT), one employee with a
 * Mon–Fri schedule and PRESENT on every working day except `absent`.
 */
export async function ruleWorkflowWorld(absent: string[] = []) {
	const companyId = await newCompany('WORKFLOW');
	await payrollWorkflow(companyId);
	const rule = await post('/payroll-rules', ctx.admin, {
		companyId,
		nameLao: 'ກົດທົດສອບ P13',
		effectiveFrom: '2025-01-01',
		prorationMethod: 'CALENDAR_DAYS',
		absenceDeductionEnabled: true,
		unpaidLeaveDeductionEnabled: true,
		overtimeRules: [OT_AFTER]
	});
	expect(rule.status, JSON.stringify(rule.body)).toBe(201);
	const emp = await employee(companyId, { salary: '3000000' });
	const shift = await shiftFor(companyId);
	await prisma.employeeScheduleAssignment.create({
		data: { employeeId: emp.id, shiftId: shift.id, effectiveFrom: D('2024-01-01') }
	});
	await prisma.attendanceRecord.createMany({
		data: weekdays()
			.filter((d) => !absent.includes(d))
			.map((d) => presentRow(emp.id, shift.id, d))
	});
	const period = await manualPeriod(companyId);
	const run = await newRun(companyId, period.id);
	await calc(run.id);
	return { companyId, emp, shiftId: shift.id, period, run };
}

// ---------- statutory (v5) ----------
export const REFERENCE_BRACKETS = [
	{ order: 1, lowerBound: '0', upperBound: '2500000', rate: '0' },
	{ order: 2, lowerBound: '2500000', upperBound: '5000000', rate: '0.05' },
	{ order: 3, lowerBound: '5000000', upperBound: '15000000', rate: '0.10' },
	{ order: 4, lowerBound: '15000000', upperBound: '25000000', rate: '0.15' },
	{ order: 5, lowerBound: '25000000', upperBound: '65000000', rate: '0.20' },
	{ order: 6, lowerBound: '65000000', upperBound: null, rate: '0.25' }
];
export async function statutoryRule(
	companyId: string,
	o: { effectiveFrom?: string; sso?: boolean; brackets?: unknown[] } = {}
) {
	const res = await post('/payroll-statutory-rules', ctx.admin, {
		companyId,
		currencyCode: 'LAK',
		nameLao: `ກົດອາກອນ ${uid()}`,
		effectiveFrom: o.effectiveFrom ?? '2020-01-01',
		effectivePayrollMonth: null,
		pitEnabled: true,
		socialSecurityEnabled: o.sso !== false,
		pitBrackets: o.brackets ?? REFERENCE_BRACKETS,
		socialSecurity:
			o.sso === false
				? null
				: {
						employeeRate: '0.055',
						employerRate: '0.06',
						maximumBase: '4500000',
						employeeContributionPitDeductible: true
					},
		overtimePitTreatmentEnabled: false,
		overtimePitExemptionBaseSalaryThreshold: null
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	const act = await post(`/payroll-statutory-rules/${res.body.data.id}/activate`, ctx.admin);
	expect(act.status, JSON.stringify(act.body)).toBe(200);
	return res.body.data as { id: string; version: number };
}
export async function profile(employeeId: string, body: Record<string, unknown> = {}) {
	const res = await put(`/employees/${employeeId}/statutory-profile`, ctx.admin, {
		pitApplicable: true,
		socialSecurityApplicable: true,
		...body
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
}

// ---------- TWO/month schedule ----------
export async function twoCycleSchedule(companyId: string) {
	const res = await post('/payroll-schedules', ctx.admin, {
		companyId,
		code: `SCH_${uid()}`,
		nameLao: 'ຮອບທົດສອບ P13',
		payBasis: 'MONTHLY',
		paymentsPerMonth: 'TWO',
		splitDay: 15,
		anchorDate: '2020-01-01',
		payDateRule: 'PERIOD_END',
		employeeScope: 'ALL',
		monthlyAllocationMethod: 'EQUAL_SPLIT'
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	const gen = await post(`/payroll-schedules/${res.body.data.id}/generate-periods`, ctx.admin, {
		fromMonth: '2025-09',
		toMonth: '2025-09'
	});
	expect(gen.status, JSON.stringify(gen.body)).toBe(200);
	return prisma.payrollPeriod.findMany({
		where: { payrollScheduleId: res.body.data.id },
		orderBy: { cycleNumber: 'asc' }
	});
}

/** A user linked to an employee (for self-service), logged in. */
export async function linkedUser(roleCode: 'EMPLOYEE' | 'MANAGER') {
	const { user, username, password } = await createTestUser({ roleCode });
	return { userId: user.id, cookie: await loginAndGetCookie(username, password) };
}

/** every digit-group representation of an amount we must never find in audit / notifications */
export const moneyNeedles = (amount: string) => {
	const [int] = amount.split('.');
	const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return [amount, int!, grouped];
};
