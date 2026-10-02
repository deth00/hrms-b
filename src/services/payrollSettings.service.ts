import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { buildChanges } from '../lib/auditRedaction.js';
import { assertCompanyExists } from './company.service.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import type { PayrollSettingsUpdateInput } from '../validation/payroll.schema.js';

/**
 * ONE payroll currency per company, MONTHLY frequency only. The currency is never converted and never
 * hard-coded in the calculation — it is read from here. Once compensation or a payroll run exists for
 * the company the currency is locked (changing it would silently re-denominate stored amounts).
 */
export async function getPayrollSettings(companyId: number) {
	await assertCompanyExists(companyId);
	const [row, workflow] = await Promise.all([
		prisma.payrollSettings.findUnique({ where: { companyId } }),
		// Phase 13 — status only: the workflow itself is designed in Settings → Approval Workflow
		prisma.approvalWorkflow.findFirst({
			where: { companyId, targetType: 'PAYROLL_RUN', status: 'ACTIVE' },
			select: { id: true, nameLao: true, version: true, _count: { select: { steps: true } } }
		})
	]);
	return {
		companyId,
		configured: !!row,
		currencyCode: row?.currencyCode ?? null,
		payFrequency: row?.payFrequency ?? 'MONTHLY',
		periodNamingPattern: row?.periodNamingPattern ?? null,
		approvalMode: row?.approvalMode ?? 'DIRECT',
		payrollWorkflow: workflow
			? {
					configured: true,
					id: workflow.id,
					nameLao: workflow.nameLao,
					version: workflow.version,
					steps: workflow._count.steps
				}
			: { configured: false, id: null, nameLao: null, version: null, steps: 0 },
		status: row?.status ?? 'ACTIVE',
		updatedAt: row?.updatedAt ?? null
	};
}

/** The company's settings or a clear 409 — used before any amount is stored. */
export async function requirePayrollSettings(companyId: number, db: typeof prisma = prisma) {
	const row = await db.payrollSettings.findUnique({ where: { companyId } });
	if (!row) {
		throw Errors.conflict(
			'PAYROLL_SETTINGS_REQUIRED',
			'ຍັງບໍ່ໄດ້ຕັ້ງຄ່າເງິນເດືອນຂອງບໍລິສັດນີ້ (ສະກຸນເງິນ) — ກະລຸນາຕັ້ງຄ່າກ່ອນ'
		);
	}
	return row;
}

export async function updatePayrollSettings(companyId: number, input: PayrollSettingsUpdateInput) {
	await assertCompanyExists(companyId);
	await prisma.$transaction(async (tx) => {
		const existing = await tx.payrollSettings.findUnique({ where: { companyId } });
		if (existing && existing.currencyCode !== input.currencyCode) {
			const [comps, runs] = await Promise.all([
				tx.employeeCompensation.count({ where: { companyId } }),
				tx.payrollRun.count({ where: { companyId } })
			]);
			if (comps > 0 || runs > 0) {
				throw Errors.conflict(
					'PAYROLL_CURRENCY_LOCKED',
					'ບໍ່ສາມາດປ່ຽນສະກຸນເງິນໄດ້ ເນື່ອງຈາກມີຂໍ້ມູນເງິນເດືອນ ຫຼື ຮອບເງິນເດືອນແລ້ວ'
				);
			}
		}
		const saved = await tx.payrollSettings.upsert({
			where: { companyId },
			update: {
				currencyCode: input.currencyCode,
				payFrequency: input.payFrequency,
				periodNamingPattern: input.periodNamingPattern ?? null,
				// only NEW runs snapshot it — existing runs keep their approvalModeSnapshot
				...(input.approvalMode ? { approvalMode: input.approvalMode } : {})
			},
			create: {
				companyId,
				currencyCode: input.currencyCode,
				payFrequency: input.payFrequency,
				periodNamingPattern: input.periodNamingPattern ?? null,
				approvalMode: input.approvalMode ?? 'DIRECT'
			}
		});
		const fields = ['currencyCode', 'payFrequency', 'periodNamingPattern', 'approvalMode'] as const;
		const changes = existing
			? buildChanges(existing, saved, fields)
			: buildChanges({}, saved, fields);
		if (changes || !existing) {
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_SETTINGS_UPDATED,
				entityType: AuditEntity.PAYROLL_SETTINGS,
				entityId: saved.id,
				companyId,
				changes,
				metadata: { operation: existing ? 'updated' : 'created' }
			});
		}
	});
	return getPayrollSettings(companyId);
}
