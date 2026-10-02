import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { AuditAction, AuditEntity, auditUpdated, writeAuditEvent } from './audit.service.js';
import { lockEmployee } from './leaveBalance.service.js';
import type { StatutoryProfileUpdateInput } from '../validation/employeeStatutoryProfile.schema.js';

/**
 * EMPLOYEE STATUTORY PROFILE (Phase 12B §10-11, hardened Phase 12B.1) — HR-managed applicability +
 * sensitive identifiers.
 *
 *  - `pitApplicable` / `socialSecurityApplicable` are NEVER inferred (not from nationality, role or
 *    position) — HR sets them explicitly; calculation trusts only this row.
 *  - Phase 12B.1: the ABSENCE of a row is no longer treated as "applicable = true" by the
 *    calculation engine (`payrollStatutoryBase.service.ts`) once a company has opted into statutory
 *    payroll — it BLOCKS with `MISSING_EMPLOYEE_STATUTORY_PROFILE` instead. This service's `present()`
 *    still returns `true`/`true` defaults for a missing row (so an unconfigured screen has *something*
 *    to show), but exposes `exists: false` so callers can tell "explicitly configured" apart from
 *    "nothing set yet" — never assume the defaults reflect a real HR decision.
 *  - `tin` / `socialSecurityNumber` are SENSITIVE: this service is the ONLY place they are read or
 *    written. They must never be selected into an Employee list / general detail / Notification
 *    payload. The audit trail records only `{ changed: true }` (via `auditRedaction`'s MASKED_FIELDS —
 *    never the raw before/after value.
 */
async function loadEmployee(employeeId: number) {
	const employee = await prisma.employee.findUnique({
		where: { id: employeeId },
		select: { id: true, companyId: true }
	});
	if (!employee) throw Errors.notFound('ບໍ່ພົບພະນັກງານ');
	return employee;
}

const present = (
	row: {
		employeeId: number;
		pitApplicable: boolean;
		socialSecurityApplicable: boolean;
		tin: string | null;
		socialSecurityNumber: string | null;
		socialSecurityEffectiveFrom: Date | null;
		socialSecurityEffectiveTo: Date | null;
		notes: string | null;
		updatedAt: Date;
	} | null,
	employeeId: number
) => ({
	employeeId,
	/** Phase 12B.1 - true only when a real EmployeeStatutoryProfile row exists (HR has explicitly
	 *  configured this employee). `false` means every other field below is a display default, not a
	 *  recorded decision — the frontend must show a "not configured yet" state, never the defaults as
	 *  if they were real. */
	exists: row !== null,
	pitApplicable: row?.pitApplicable ?? true,
	socialSecurityApplicable: row?.socialSecurityApplicable ?? true,
	tin: row?.tin ?? null,
	socialSecurityNumber: row?.socialSecurityNumber ?? null,
	socialSecurityEffectiveFrom: row?.socialSecurityEffectiveFrom ?? null,
	socialSecurityEffectiveTo: row?.socialSecurityEffectiveTo ?? null,
	notes: row?.notes ?? null,
	updatedAt: row?.updatedAt ?? null
});

/** Authorized statutory screens ONLY (payroll.view + employees.view_all) — never the general Employee views. */
export async function getStatutoryProfile(employeeId: number) {
	await loadEmployee(employeeId);
	const row = await prisma.employeeStatutoryProfile.findUnique({ where: { employeeId } });
	return present(row, employeeId);
}

export async function updateStatutoryProfile(
	employeeId: number,
	input: StatutoryProfileUpdateInput,
	actorUserId: number
) {
	const employee = await loadEmployee(employeeId);
	const updated = await prisma.$transaction(async (tx) => {
		await lockEmployee(tx, employeeId);
		const existing = await tx.employeeStatutoryProfile.findUnique({ where: { employeeId } });
		const data = {
			pitApplicable: input.pitApplicable,
			socialSecurityApplicable: input.socialSecurityApplicable,
			tin: input.tin ?? null,
			socialSecurityNumber: input.socialSecurityNumber ?? null,
			socialSecurityEffectiveFrom: input.socialSecurityEffectiveFrom ?? null,
			socialSecurityEffectiveTo: input.socialSecurityEffectiveTo ?? null,
			notes: input.notes ?? null
		};
		const row = existing
			? await tx.employeeStatutoryProfile.update({
					where: { employeeId },
					data: { ...data, updatedByUserId: actorUserId }
				})
			: await tx.employeeStatutoryProfile.create({
					data: { employeeId, ...data, createdByUserId: actorUserId }
				});
		if (existing) {
			await auditUpdated(tx, {
				action: AuditAction.EMPLOYEE_STATUTORY_PROFILE_UPDATED,
				entityType: AuditEntity.EMPLOYEE_STATUTORY_PROFILE,
				entityId: row.id,
				companyId: employee.companyId,
				employeeId,
				before: existing,
				after: row,
				fields: ['pitApplicable', 'socialSecurityApplicable', 'tin', 'socialSecurityNumber']
			});
		} else {
			await writeAuditEvent(tx, {
				action: AuditAction.EMPLOYEE_STATUTORY_PROFILE_UPDATED,
				entityType: AuditEntity.EMPLOYEE_STATUTORY_PROFILE,
				entityId: row.id,
				companyId: employee.companyId,
				employeeId,
				actorUserId,
				// never the identifier values themselves — only that they were set
				metadata: {
					pitApplicable: row.pitApplicable,
					socialSecurityApplicable: row.socialSecurityApplicable,
					tinSet: row.tin !== null,
					socialSecurityNumberSet: row.socialSecurityNumber !== null
				}
			});
		}
		return row;
	});
	return present(updated, employeeId);
}
