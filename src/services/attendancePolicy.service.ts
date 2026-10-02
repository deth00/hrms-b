import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { Errors } from '../utils/AppError.js';
import { assertCompanyExists } from './company.service.js';
import type { AttendancePolicyUpdateInput } from '../validation/attendanceRules.schema.js';
import { AuditAction, AuditEntity, auditUpdated } from './audit.service.js';

export type Db = typeof prisma | Prisma.TransactionClient;

export interface PolicyValues {
	deductScheduledBreak: boolean;
	missingCheckOutGraceMinutes: number;
	allowEmployeeCorrection: boolean;
	correctionRequestWindowDays: number;
}

/**
 * Used when a company has no AttendancePolicy row (nothing is persisted for it): the documented
 * defaults, with the missing-check-out grace falling back to the Phase 5 environment value.
 */
export function defaultPolicy(): PolicyValues {
	return {
		deductScheduledBreak: true,
		missingCheckOutGraceMinutes: env.attendance.checkOutGraceHours * 60,
		allowEmployeeCorrection: true,
		correctionRequestWindowDays: 30
	};
}

export async function getPolicy(companyId: number, db: Db = prisma): Promise<PolicyValues> {
	const row = await db.attendancePolicy.findUnique({ where: { companyId } });
	if (!row || row.status !== 'ACTIVE') return defaultPolicy();
	return {
		deductScheduledBreak: row.deductScheduledBreak,
		missingCheckOutGraceMinutes: row.missingCheckOutGraceMinutes,
		allowEmployeeCorrection: row.allowEmployeeCorrection,
		correctionRequestWindowDays: row.correctionRequestWindowDays
	};
}

/** Missing-check-out grace (ms) for several companies at once. */
export async function loadGraceMap(companyIds: number[]): Promise<Map<number, number>> {
	const unique = [...new Set(companyIds)];
	const rows = unique.length
		? await prisma.attendancePolicy.findMany({
				where: { companyId: { in: unique }, status: 'ACTIVE' }
			})
		: [];
	const map = new Map<number, number>();
	for (const row of rows) map.set(row.companyId, row.missingCheckOutGraceMinutes * 60_000);
	return map;
}
export const defaultGraceMs = () => defaultPolicy().missingCheckOutGraceMinutes * 60_000;

// ---------- API ----------

export async function getPolicyForCompany(companyId: number) {
	await assertCompanyExists(companyId);
	const row = await prisma.attendancePolicy.findUnique({ where: { companyId } });
	return {
		companyId,
		isDefault: !row,
		...(row
			? {
					deductScheduledBreak: row.deductScheduledBreak,
					missingCheckOutGraceMinutes: row.missingCheckOutGraceMinutes,
					allowEmployeeCorrection: row.allowEmployeeCorrection,
					correctionRequestWindowDays: row.correctionRequestWindowDays,
					updatedAt: row.updatedAt
				}
			: { ...defaultPolicy(), updatedAt: null })
	};
}

/**
 * One policy per company (upsert). Changing a policy affects FUTURE calculations only — cached
 * results on existing records are not silently rewritten and raw punches are never touched.
 */
export async function updatePolicy(companyId: number, input: AttendancePolicyUpdateInput) {
	await assertCompanyExists(companyId);
	if (Object.keys(input).length === 0)
		throw Errors.badRequest('NO_CHANGES', 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ');
	const base = defaultPolicy();
	await prisma.$transaction(async (tx) => {
		const existing = await tx.attendancePolicy.findUnique({ where: { companyId } });
		const before = existing ?? base;
		await tx.attendancePolicy.upsert({
			where: { companyId },
			update: input,
			create: { companyId, ...base, ...input }
		});
		await auditUpdated(tx, {
			action: AuditAction.POLICY_UPDATED,
			entityType: AuditEntity.POLICY,
			entityId: companyId,
			companyId,
			before,
			after: { ...before, ...input },
			fields: Object.keys(input),
			metadata: { policy: 'ATTENDANCE' }
		});
	});
	return getPolicyForCompany(companyId);
}
