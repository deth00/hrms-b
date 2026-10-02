import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertCompanyExists } from './company.service.js';
import type { OvertimePolicyUpdateInput } from '../validation/overtime.schema.js';
import { AuditAction, AuditEntity, auditUpdated } from './audit.service.js';

type Db = typeof prisma | Prisma.TransactionClient;

/**
 * Per-company overtime RULES: request limits, which kinds of OT are allowed, and how early an
 * employee may check in for an approved OT. Deliberately NO pay rates / multipliers / salary —
 * Phase 8 only decides whether OT was approved and how many approved minutes were worked.
 */
export interface OvertimePolicyValues {
	minimumRequestMinutes: number;
	maximumRequestMinutesPerDay: number;
	allowBeforeShift: boolean;
	allowAfterShift: boolean;
	allowOffDay: boolean;
	allowHoliday: boolean;
	checkInEarlyMinutes: number;
}

/** Used when a company has no OvertimePolicy row (nothing is persisted for it). */
export function defaultOvertimePolicy(): OvertimePolicyValues {
	return {
		minimumRequestMinutes: 30,
		maximumRequestMinutesPerDay: 480,
		allowBeforeShift: true,
		allowAfterShift: true,
		allowOffDay: true,
		allowHoliday: true,
		checkInEarlyMinutes: 60
	};
}

const valuesOf = (row: OvertimePolicyValues): OvertimePolicyValues => ({
	minimumRequestMinutes: row.minimumRequestMinutes,
	maximumRequestMinutesPerDay: row.maximumRequestMinutesPerDay,
	allowBeforeShift: row.allowBeforeShift,
	allowAfterShift: row.allowAfterShift,
	allowOffDay: row.allowOffDay,
	allowHoliday: row.allowHoliday,
	checkInEarlyMinutes: row.checkInEarlyMinutes
});

export async function getOvertimePolicy(
	companyId: number,
	db: Db = prisma
): Promise<OvertimePolicyValues> {
	const row = await db.overtimePolicy.findUnique({ where: { companyId } });
	if (!row || row.status !== 'ACTIVE') return defaultOvertimePolicy();
	return valuesOf(row);
}

export async function getOvertimePolicyForCompany(companyId: number) {
	await assertCompanyExists(companyId);
	const row = await prisma.overtimePolicy.findUnique({ where: { companyId } });
	return {
		companyId,
		isDefault: !row,
		...(row
			? { ...valuesOf(row), updatedAt: row.updatedAt }
			: { ...defaultOvertimePolicy(), updatedAt: null })
	};
}

/** One policy per company (upsert). Affects future requests / approvals; existing requests keep their snapshot. */
export async function updateOvertimePolicy(companyId: number, input: OvertimePolicyUpdateInput) {
	await assertCompanyExists(companyId);
	const existing = await prisma.overtimePolicy.findUnique({ where: { companyId } });
	const merged = { ...(existing ? valuesOf(existing) : defaultOvertimePolicy()), ...input };
	if (merged.maximumRequestMinutesPerDay < merged.minimumRequestMinutes) {
		throw Errors.badRequest('INVALID_OVERTIME_LIMITS', 'OT ສູງສຸດຕໍ່ມື້ຕ້ອງບໍ່ໜ້ອຍກວ່າ OT ຂັ້ນຕ່ຳ');
	}
	await prisma.$transaction(async (tx) => {
		await tx.overtimePolicy.upsert({
			where: { companyId },
			update: input,
			create: { companyId, ...merged }
		});
		await auditUpdated(tx, {
			action: AuditAction.POLICY_UPDATED,
			entityType: AuditEntity.POLICY,
			entityId: companyId,
			companyId,
			before: existing ? valuesOf(existing) : defaultOvertimePolicy(),
			after: merged,
			fields: Object.keys(input),
			metadata: { policy: 'OVERTIME' }
		});
	});
	return getOvertimePolicyForCompany(companyId);
}
