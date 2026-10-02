import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { idRef } from '../lib/idFormat.js';
import { idCol } from '../lib/sqlIds.js';
import { Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { moneyOrNull, moneyString } from '../lib/money.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { createNotifications, NotificationType } from './notification.service.js';

/**
 * PAYSLIPS (Phase 13 §30-47).
 *
 *  - A payslip is an IMMUTABLE snapshot of ONE finalized PayrollEmployeeResult. It is built ONLY from
 *    the finalized payroll rows (result + items + segments + statutory result + the run/period/company
 *    as they were at issue time) and is never rebuilt from live employee / compensation / pay component
 *    / statutory data afterwards. It never calls the payroll calculation engine.
 *  - One payslip per result (`payroll_employee_result_id` UNIQUE) → creation is idempotent: only the
 *    missing ones are created, under the run row lock.
 *  - Contains NO TIN / social security number / GPS / punches / approval notes / manual-adjustment
 *    reasons / audit data. Money is fixed-2-decimal strings (never JS floats).
 *  - Rendering (HTML page and PDF) reads `snapshotJson` only.
 */
export const PAYSLIP_TEMPLATE_VERSION = 1;

type Db = Prisma.TransactionClient | typeof prisma;

const RESULT_FOR_PAYSLIP = {
	items: true,
	segments: { orderBy: { segmentStart: 'asc' as const } },
	statutoryResult: true,
	employee: { select: { userId: true } }
} satisfies Prisma.PayrollEmployeeResultInclude;
type ResultForPayslip = Prisma.PayrollEmployeeResultGetPayload<{
	include: typeof RESULT_FOR_PAYSLIP;
}>;

const RUN_FOR_PAYSLIP = {
	company: {
		select: {
			id: true,
			code: true,
			nameLao: true,
			nameEnglish: true,
			registrationNumber: true,
			phone: true,
			email: true,
			address: true,
			village: true,
			district: true,
			province: true
		}
	},
	period: true
} satisfies Prisma.PayrollRunInclude;
type RunForPayslip = Prisma.PayrollRunGetPayload<{ include: typeof RUN_FOR_PAYSLIP }>;

/** "PS-{periodCode}-{employeeCode}" upper-cased, anything outside A-Z / 0-9 collapsed to "-". */
export function payslipNumberOf(periodCode: string, employeeCode: string) {
	const norm = (s: string) =>
		s
			.normalize('NFKD')
			.toUpperCase()
			.replace(/[^A-Z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
	return `PS-${norm(periodCode) || 'PERIOD'}-${norm(employeeCode) || 'EMP'}`;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const STATUTORY_SOURCES = new Set(['PIT', 'SOCIAL_SECURITY_EMPLOYEE']);

/** The payslip snapshot contract (templateVersion 1). Every amount is a fixed-2 string. */
export function buildPayslipSnapshot(
	run: RunForPayslip,
	r: ResultForPayslip,
	payslipNumber: string,
	issuedAt: Date
) {
	const line = (i: ResultForPayslip['items'][number]) => ({
		code: i.code,
		nameLao: i.nameLao,
		nameEnglish: i.nameEnglish,
		amount: moneyString(i.amount)
	});
	const regular = r.items.filter((i) => !STATUTORY_SOURCES.has(i.source));
	const statutoryItems = r.items.filter((i) => STATUTORY_SOURCES.has(i.source));
	// a statutory line is a DEDUCTION normally; a negative current-cycle figure is stored as an EARNING
	// (a credit, Phase 12B §28) and is shown as an ADDITION — never as a negative deduction
	const statutoryLine = (source: string) => {
		const item = statutoryItems.find((i) => i.source === source);
		return item
			? {
					code: item.code,
					nameLao: item.nameLao,
					nameEnglish: item.nameEnglish,
					amount: moneyString(item.amount),
					direction: item.type === 'EARNING' ? ('CREDIT' as const) : ('DEDUCTION' as const)
				}
			: null;
	};
	const companyNameAtPeriod = r.segments.at(-1)?.companyNameSnapshot ?? run.company.nameLao;
	const multiCycle = run.paymentsPerMonth === 'TWO' && run.cycleNumber !== null;
	const address = [
		run.company.address,
		run.company.village,
		run.company.district,
		run.company.province
	]
		.filter((x): x is string => !!x && x.trim().length > 0)
		.join(', ');

	return {
		templateVersion: PAYSLIP_TEMPLATE_VERSION,
		payslipNumber,
		issuedAt: issuedAt.toISOString(),
		company: {
			code: run.company.code,
			nameLao: companyNameAtPeriod,
			nameEnglish: run.company.nameEnglish,
			registrationNumber: run.company.registrationNumber,
			address: address || null,
			phone: run.company.phone,
			email: run.company.email
		},
		employee: {
			employeeCode: r.employeeCodeSnapshot,
			name: r.employeeNameSnapshot,
			department: r.departmentNameSnapshot,
			position: r.positionNameSnapshot,
			branch: r.branchNameSnapshot
		},
		payroll: {
			periodCode: run.period.code,
			periodName: run.period.name,
			periodStart: day(run.period.startDate),
			periodEnd: day(run.period.endDate),
			payDate: day(run.period.payDate),
			payrollMonth: run.payrollMonth ?? run.period.payrollMonth ?? null,
			cycleNumber: multiCycle ? run.cycleNumber : null,
			cyclesPerMonth: multiCycle ? 2 : null,
			currencyCode: r.currencyCode,
			calculationVersion: r.calculationVersion
		},
		// monthly / cycle context — present only when the (v3+) result recorded it
		compensation:
			r.monthlyBaseSalarySnapshot || r.baseSalarySnapshot
				? {
						monthlyBaseSalary: moneyOrNull(r.monthlyBaseSalarySnapshot),
						cycleAllocationFactor: r.cycleAllocationFactorSnapshot
							? r.cycleAllocationFactorSnapshot.toFixed(10)
							: null,
						cycleBaseSalary: multiCycle ? moneyOrNull(r.baseSalarySnapshot) : null,
						baseSalary: moneyOrNull(r.baseSalarySnapshot)
					}
				: null,
		earnings: regular.filter((i) => i.type === 'EARNING').map(line),
		deductions: regular.filter((i) => i.type === 'DEDUCTION').map(line),
		// v5 only; older results simply have no statutory section
		statutory:
			r.statutoryResult || statutoryItems.length > 0
				? {
						ruleVersion: r.statutoryResult?.ruleVersion ?? null,
						pit: statutoryLine('PIT'),
						employeeSocialSecurity: statutoryLine('SOCIAL_SECURITY_EMPLOYEE'),
						// employer cost: INFORMATIONAL only — never part of the employee's net pay
						employerSocialSecurity: r.statutoryResult
							? moneyString(r.statutoryResult.employerSsoCurrentCycle)
							: null
					}
				: null,
		totals: {
			totalEarnings: moneyString(r.totalEarnings),
			totalDeductions: moneyString(r.totalDeductions),
			netPay: moneyString(r.netPay),
			employerContributionTotal: moneyOrNull(r.employerContributionTotal)
		}
	};
}
export type PayslipSnapshot = ReturnType<typeof buildPayslipSnapshot>;

async function lockRun(tx: Prisma.TransactionClient, id: number) {
	await tx.$queryRaw`SELECT ${idCol()} AS id FROM payroll_runs WHERE ${idCol()} = ${id} FOR UPDATE`;
}

/**
 * Creates the MISSING payslips of a FINALIZED run inside the caller's transaction (finalization, or the
 * historical backfill). Idempotent: results that already have a payslip are skipped, so a retry creates
 * nothing and notifies nobody twice. The caller must hold the run lock (finalize does) — the backfill
 * entry point below takes it itself.
 */
export async function createMissingPayslips(
	tx: Prisma.TransactionClient,
	runId: number,
	actorUserId: number | null,
	source: 'FINALIZE' | 'BACKFILL'
) {
	const run = await tx.payrollRun.findUniqueOrThrow({
		where: { id: runId },
		include: RUN_FOR_PAYSLIP
	});
	if (run.status !== 'FINALIZED') {
		throw Errors.conflict(
			'PAYROLL_RUN_NOT_FINALIZED',
			'ອອກໃບແຈ້ງເງິນເດືອນໄດ້ສະເພາະຮອບເງິນເດືອນທີ່ຢືນຢັນແລ້ວ'
		);
	}
	const results = await tx.payrollEmployeeResult.findMany({
		where: { payrollRunId: runId, payslip: null },
		include: RESULT_FOR_PAYSLIP,
		orderBy: { employeeCodeSnapshot: 'asc' }
	});
	const issuedAt = serverNow();
	const created: { id: number; employeeId: number; userId: number | null }[] = [];
	for (const r of results) {
		let payslipNumber = payslipNumberOf(run.period.code, r.employeeCodeSnapshot);
		// two codes that normalize to the same text ("A_1" / "A-1"): stay deterministic, never fail finalization
		const taken = await tx.payslip.findUnique({
			where: { companyId_payslipNumber: { companyId: run.companyId, payslipNumber } },
			select: { id: true }
		});
		if (taken) payslipNumber = `${payslipNumber}-${idRef(r.id)}`;
		const snapshot = buildPayslipSnapshot(run, r, payslipNumber, issuedAt);
		const row = await tx.payslip.create({
			data: {
				companyId: run.companyId,
				payrollRunId: run.id,
				payrollEmployeeResultId: r.id,
				employeeId: r.employeeId,
				payslipNumber,
				templateVersion: PAYSLIP_TEMPLATE_VERSION,
				payrollMonth: snapshot.payroll.payrollMonth,
				periodCode: run.period.code,
				periodName: run.period.name,
				periodStart: run.period.startDate,
				periodEnd: run.period.endDate,
				payDate: run.period.payDate,
				cycleNumber: snapshot.payroll.cycleNumber,
				currencyCode: r.currencyCode,
				issuedAt,
				issuedByUserId: actorUserId,
				snapshotJson: snapshot as unknown as Prisma.InputJsonObject
			}
		});
		created.push({ id: row.id, employeeId: r.employeeId, userId: r.employee.userId });
		await writeAuditEvent(tx, {
			action: AuditAction.PAYSLIP_CREATED,
			entityType: AuditEntity.PAYSLIP,
			entityId: row.id,
			companyId: run.companyId,
			employeeId: r.employeeId,
			actorUserId: actorUserId ?? undefined,
			// identifiers only — never salary / net / PIT / SSO
			metadata: { payslipId: row.id, runId: run.id, employeeId: r.employeeId, source }
		});
	}
	if (created.length > 0) {
		await writeAuditEvent(tx, {
			action: AuditAction.PAYSLIP_BATCH_CREATED,
			entityType: AuditEntity.PAYROLL_RUN,
			entityId: run.id,
			companyId: run.companyId,
			actorUserId: actorUserId ?? undefined,
			metadata: { runId: run.id, periodId: run.periodId, count: created.length, source }
		});
		// first issue only (this batch): the linked user is told — period only, never an amount
		await createNotifications(
			tx,
			created
				.filter((c): c is typeof c & { userId: number } => !!c.userId)
				.map((c) => ({
					userId: c.userId,
					type: NotificationType.PAYSLIP_ISSUED,
					titleLao: `ໃບແຈ້ງເງິນເດືອນ ງວດ ${run.period.name} ພ້ອມແລ້ວ`,
					bodyLao: null,
					link: `/app/my-payslips/${c.id}`,
					metadata: { payslipId: c.id, runId: run.id },
					dedupeKey: `payslip:${c.id}:issued`
				}))
		);
	}
	return created.length;
}

/** POST /payroll/runs/:id/generate-payslips — historical finalized runs (v1-v5). Never recalculates. */
export async function generatePayslipsForRun(runId: number, actorUserId: number) {
	const exists = await prisma.payrollRun.findUnique({
		where: { id: runId },
		select: { id: true, status: true }
	});
	if (!exists) throw Errors.notFound('ບໍ່ພົບຮອບເງິນເດືອນ');
	const created = await prisma.$transaction(
		async (tx) => {
			await lockRun(tx, runId);
			return createMissingPayslips(tx, runId, actorUserId, 'BACKFILL');
		},
		{ timeout: 60_000, maxWait: 10_000 }
	);
	const total = await prisma.payslip.count({ where: { payrollRunId: runId } });
	return { created, total };
}

// ============================================================================================
// reading (admin + self)
// ============================================================================================

const brief = (p: {
	id: number;
	payslipNumber: string;
	payrollRunId: number;
	employeeId: number;
	payrollMonth: string | null;
	periodCode: string;
	periodName: string;
	periodStart: Date;
	periodEnd: Date;
	payDate: Date;
	cycleNumber: number | null;
	currencyCode: string;
	issuedAt: Date;
	snapshotJson: Prisma.JsonValue;
}) => {
	const snap = p.snapshotJson as unknown as PayslipSnapshot;
	return {
		id: p.id,
		payslipNumber: p.payslipNumber,
		payrollRunId: p.payrollRunId,
		employeeId: p.employeeId,
		employee: { employeeCode: snap.employee.employeeCode, name: snap.employee.name },
		payrollMonth: p.payrollMonth,
		periodCode: p.periodCode,
		periodName: p.periodName,
		periodStart: day(p.periodStart),
		periodEnd: day(p.periodEnd),
		payDate: day(p.payDate),
		cycleNumber: p.cycleNumber,
		currencyCode: p.currencyCode,
		netPay: snap.totals.netPay,
		issuedAt: p.issuedAt,
		// a payslip only ever exists for a FINALIZED run
		status: 'ISSUED' as const
	};
};

const full = (p: Parameters<typeof brief>[0] & { templateVersion: number }) => ({
	...brief(p),
	templateVersion: p.templateVersion,
	snapshot: p.snapshotJson as unknown as PayslipSnapshot
});

/** Admin: every payslip of a run (payroll.view + employees.view_all). */
export async function listRunPayslips(runId: number) {
	const run = await prisma.payrollRun.findUnique({ where: { id: runId }, select: { id: true } });
	if (!run) throw Errors.notFound('ບໍ່ພົບຮອບເງິນເດືອນ');
	const rows = await prisma.payslip.findMany({
		where: { payrollRunId: runId },
		orderBy: { payslipNumber: 'asc' }
	});
	const results = await prisma.payrollEmployeeResult.count({ where: { payrollRunId: runId } });
	return { items: rows.map(brief), total: rows.length, results };
}

export async function getPayslip(id: number) {
	const row = await prisma.payslip.findUnique({ where: { id } });
	if (!row) throw Errors.notFound('ບໍ່ພົບໃບແຈ້ງເງິນເດືອນ');
	return full(row);
}

/** The employee linked to this user, or null (a user without an employee record has no payslips). */
async function linkedEmployeeId(db: Db, userId: number) {
	const e = await db.employee.findUnique({ where: { userId }, select: { id: true } });
	return e?.id ?? null;
}

/** Self: own payslips only — the employee is DERIVED from the session, never taken from the client. */
export async function listMyPayslips(userId: number) {
	const employeeId = await linkedEmployeeId(prisma, userId);
	if (!employeeId) return { linkedEmployee: false, items: [] };
	const rows = await prisma.payslip.findMany({
		where: { employeeId },
		orderBy: [{ periodEnd: 'desc' }, { payslipNumber: 'asc' }]
	});
	return { linkedEmployee: true, items: rows.map(brief) };
}

/** Self detail: someone else's payslip id answers exactly like a missing one (404, no data). */
export async function getMyPayslip(userId: number, id: number) {
	const employeeId = await linkedEmployeeId(prisma, userId);
	const row = employeeId ? await prisma.payslip.findFirst({ where: { id, employeeId } }) : null;
	if (!row) throw Errors.notFound('ບໍ່ພົບໃບແຈ້ງເງິນເດືອນ');
	return full(row);
}

/** Safe download name: the payslip number is already [A-Z0-9-] only. */
export const payslipFileName = (payslipNumber: string) =>
	`${payslipNumber.replace(/[^A-Za-z0-9-]/g, '-')}.pdf`;
