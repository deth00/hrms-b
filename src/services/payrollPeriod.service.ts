import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { idCol } from '../lib/sqlIds.js';
import { Errors } from '../utils/AppError.js';
import { formatDateOnly } from '../lib/dates.js';
import { assertCompanyExists } from './company.service.js';
import { AuditAction, AuditEntity, auditUpdated, writeAuditEvent } from './audit.service.js';
import { assertApprovalAllowsChange } from './payrollApprovalState.js';
import type {
	PeriodCreateInput,
	PeriodListQuery,
	PeriodUpdateInput
} from '../validation/payroll.schema.js';

/**
 * Payroll periods: a company's periods may NOT overlap at all (open or closed) — one calendar day
 * belongs to exactly one period. A CLOSED period (its run was finalized) is immutable, and while a
 * run exists the period's date range cannot change (it would invalidate the run's snapshot basis).
 */
const RUN_BRIEF = { select: { id: true, status: true, approvalState: true } } as const;
const INCLUDE = {
	company: { select: { id: true, code: true, nameLao: true } },
	schedule: { select: { id: true, code: true, nameLao: true, paymentsPerMonth: true } },
	run: RUN_BRIEF
} satisfies Prisma.PayrollPeriodInclude;

export async function lockCompany(tx: Prisma.TransactionClient, companyId: number) {
	await tx.$queryRaw`SELECT ${idCol()} AS id FROM companies WHERE ${idCol()} = ${companyId} FOR UPDATE`;
}

export async function assertNoOverlap(
	tx: Prisma.TransactionClient,
	companyId: number,
	startDate: Date,
	endDate: Date,
	exceptId?: number
) {
	const clash = await tx.payrollPeriod.findFirst({
		where: {
			companyId,
			startDate: { lte: endDate },
			endDate: { gte: startDate },
			...(exceptId ? { id: { not: exceptId } } : {})
		},
		select: { code: true, startDate: true, endDate: true }
	});
	if (clash) {
		throw Errors.conflict(
			'PAYROLL_PERIOD_OVERLAP',
			`ຊ່ວງວັນທີ່ຊ້ອນກັບງວດ ${clash.code} (${formatDateOnly(clash.startDate)} – ${formatDateOnly(clash.endDate)})`
		);
	}
}

export async function listPeriods(query: PeriodListQuery) {
	const where: Prisma.PayrollPeriodWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.scheduleId ? { payrollScheduleId: query.scheduleId } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.year
			? {
					startDate: {
						gte: new Date(Date.UTC(query.year, 0, 1)),
						lt: new Date(Date.UTC(query.year + 1, 0, 1))
					}
				}
			: {})
	};
	const [items, total] = await Promise.all([
		prisma.payrollPeriod.findMany({
			where,
			include: INCLUDE,
			orderBy: { startDate: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.payrollPeriod.count({ where })
	]);
	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getPeriod(id: number) {
	const row = await prisma.payrollPeriod.findUnique({ where: { id }, include: INCLUDE });
	if (!row) throw Errors.notFound('ບໍ່ພົບງວດເງິນເດືອນ');
	return row;
}

/**
 * Phase 12A.1 - a manual period's payroll-month identity is derived ONLY when unambiguous: it exactly
 * covers one whole calendar month (day 1 -> the month's last day). Anything else (a custom range, a
 * partial month, a range spanning a month boundary) stays NULL / ineligible - never guessed (§7, §20).
 */
function derivePayrollMonth(
	startDate: Date,
	endDate: Date
): { payrollMonth: string | null; eligible: boolean } {
	const y = startDate.getUTCFullYear();
	const m = startDate.getUTCMonth(); // 0-based
	const lastDay = new Date(Date.UTC(y, m + 1, 0));
	const isFullMonth =
		startDate.getUTCDate() === 1 &&
		endDate.getTime() === lastDay.getTime() &&
		endDate.getUTCFullYear() === y &&
		endDate.getUTCMonth() === m;
	if (!isFullMonth) return { payrollMonth: null, eligible: false };
	return { payrollMonth: `${y}-${String(m + 1).padStart(2, '0')}`, eligible: true };
}

export async function createPeriod(input: PeriodCreateInput, actorUserId: number) {
	await assertCompanyExists(input.companyId);
	try {
		return await prisma.$transaction(async (tx) => {
			await lockCompany(tx, input.companyId);
			const taken = await tx.payrollPeriod.findUnique({
				where: { companyId_code: { companyId: input.companyId, code: input.code } }
			});
			if (taken) throw Errors.conflict('PAYROLL_PERIOD_CODE_TAKEN', 'ລະຫັດງວດນີ້ຖືກໃຊ້ແລ້ວ');
			await assertNoOverlap(tx, input.companyId, input.startDate, input.endDate);
			const { payrollMonth, eligible } = derivePayrollMonth(input.startDate, input.endDate);
			const row = await tx.payrollPeriod.create({
				data: {
					...input,
					payrollMonth,
					statutoryMonthEligible: eligible,
					createdByUserId: actorUserId
				},
				include: INCLUDE
			});
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_PERIOD_CREATED,
				entityType: AuditEntity.PAYROLL_PERIOD,
				entityId: row.id,
				companyId: row.companyId,
				actorUserId,
				metadata: {
					code: row.code,
					startDate: formatDateOnly(row.startDate),
					endDate: formatDateOnly(row.endDate)
				}
			});
			return row;
		});
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict('PAYROLL_PERIOD_CODE_TAKEN', 'ລະຫັດງວດນີ້ຖືກໃຊ້ແລ້ວ');
		}
		throw err;
	}
}

export async function updatePeriod(id: number, input: PeriodUpdateInput) {
	const found = await prisma.payrollPeriod.findUnique({
		where: { id },
		select: { companyId: true }
	});
	if (!found) throw Errors.notFound('ບໍ່ພົບງວດເງິນເດືອນ');
	return prisma.$transaction(async (tx) => {
		await lockCompany(tx, found.companyId);
		const existing = await tx.payrollPeriod.findUniqueOrThrow({
			where: { id },
			include: { run: RUN_BRIEF }
		});
		if (existing.status === 'CLOSED' || existing.run?.status === 'FINALIZED') {
			throw Errors.conflict('PAYROLL_PERIOD_CLOSED', 'ງວດນີ້ຖືກປິດແລ້ວ ແລະ ແກ້ໄຂບໍ່ໄດ້');
		}
		// Phase 13 — the period of a run under approval (or approved) is frozen with it
		if (existing.run) assertApprovalAllowsChange(existing.run);
		const startDate = input.startDate ?? existing.startDate;
		const endDate = input.endDate ?? existing.endDate;
		const payDate = input.payDate ?? existing.payDate;
		if (endDate < startDate) {
			throw Errors.badRequest('INVALID_DATE_RANGE', 'ວັນສິ້ນສຸດຕ້ອງບໍ່ກ່ອນວັນເລີ່ມ');
		}
		if (payDate < endDate) {
			throw Errors.badRequest('INVALID_PAY_DATE', 'ວັນຈ່າຍຕ້ອງບໍ່ກ່ອນວັນສິ້ນສຸດງວດ');
		}
		const rangeChanged =
			startDate.getTime() !== existing.startDate.getTime() ||
			endDate.getTime() !== existing.endDate.getTime();
		if (rangeChanged) {
			if (existing.run) {
				throw Errors.conflict(
					'PAYROLL_PERIOD_HAS_RUN',
					'ງວດນີ້ມີຮອບເງິນເດືອນແລ້ວ — ບໍ່ສາມາດປ່ຽນຊ່ວງວັນທີ່ໄດ້'
				);
			}
			await assertNoOverlap(tx, existing.companyId, startDate, endDate, id);
		}
		// re-derive the manual period's payroll-month identity when its range actually moved
		// (a schedule-generated period's payrollMonth is schedule-owned and never re-derived here)
		const derived =
			rangeChanged && !existing.generatedBySchedule ? derivePayrollMonth(startDate, endDate) : null;
		const row = await tx.payrollPeriod.update({
			where: { id },
			data: {
				name: input.name,
				startDate,
				endDate,
				payDate,
				...(derived
					? { payrollMonth: derived.payrollMonth, statutoryMonthEligible: derived.eligible }
					: {})
			},
			include: INCLUDE
		});
		await auditUpdated(tx, {
			action: AuditAction.PAYROLL_PERIOD_UPDATED,
			entityType: AuditEntity.PAYROLL_PERIOD,
			entityId: id,
			companyId: existing.companyId,
			before: existing,
			after: row,
			fields: ['name', 'startDate', 'endDate', 'payDate'],
			metadata: { code: existing.code }
		});
		return row;
	});
}
