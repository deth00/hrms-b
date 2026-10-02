import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertParentActive } from '../lib/orgValidation.js';
import { assertDepartmentExists } from './department.service.js';
import { assertDivisionExists } from './division.service.js';
import type {
	UnitCreateInput,
	UnitListQuery,
	UnitUpdateInput
} from '../validation/organization.schema.js';
import {
	AuditAction,
	AuditEntity,
	auditUpdated,
	safeLabel,
	writeAuditEvent
} from './audit.service.js';

const WITH_CONTEXT = {
	include: {
		department: { select: { id: true, code: true, nameLao: true } },
		division: { select: { id: true, code: true, nameLao: true } }
	}
} satisfies Prisma.UnitDefaultArgs;

async function assertDivisionBelongsToDepartment(divisionId: number, departmentId: number) {
	const division = await assertDivisionExists(divisionId);
	if (division.departmentId !== departmentId) {
		throw Errors.badRequest(
			'DIVISION_DEPARTMENT_MISMATCH',
			'ຝ່າຍທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ພະແນກດຽວກັນ'
		);
	}
	return division;
}

export async function listUnits(query: UnitListQuery) {
	const where: Prisma.UnitWhereInput = {
		...(query.departmentId ? { departmentId: query.departmentId } : {}),
		...(query.divisionId ? { divisionId: query.divisionId } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.search
			? { OR: [{ code: { contains: query.search } }, { nameLao: { contains: query.search } }] }
			: {})
	};

	const [items, total] = await Promise.all([
		prisma.unit.findMany({
			where,
			...WITH_CONTEXT,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.unit.count({ where })
	]);

	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getUnitById(id: number) {
	const unit = await prisma.unit.findUnique({ where: { id }, ...WITH_CONTEXT });
	if (!unit) throw Errors.notFound('ບໍ່ພົບໜ່ວຍງານ');
	return unit;
}

export async function createUnit(input: UnitCreateInput) {
	const department = await assertDepartmentExists(input.departmentId);
	const division = input.divisionId
		? await assertDivisionBelongsToDepartment(input.divisionId, input.departmentId)
		: null;

	const codeTaken = await prisma.unit.findUnique({
		where: { departmentId_code: { departmentId: input.departmentId, code: input.code } }
	});
	if (codeTaken) throw Errors.conflict('UNIT_CODE_TAKEN', 'ລະຫັດໜ່ວຍງານນີ້ຖືກໃຊ້ແລ້ວໃນພະແນກນີ້');

	if (input.status === 'ACTIVE') {
		assertParentActive(department.status, 'ພະແນກ');
		if (division) assertParentActive(division.status, 'ຝ່າຍ');
	}

	return prisma.$transaction(async (tx) => {
		const row = await tx.unit.create({ data: input, ...WITH_CONTEXT });
		await writeAuditEvent(tx, {
			action: AuditAction.ORG_CREATED,
			entityType: AuditEntity.ORGANIZATION,
			entityId: row.id,
			companyId: (
				await tx.department.findUnique({
					where: { id: input.departmentId },
					select: { companyId: true }
				})
			)?.companyId,
			metadata: { kind: 'UNIT', ...safeLabel(row) }
		});
		return row;
	});
}

export async function updateUnit(id: number, input: UnitUpdateInput) {
	const existing = await prisma.unit.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບໜ່ວຍງານ');

	let division = null;
	if (input.divisionId !== undefined && input.divisionId !== null) {
		division = await assertDivisionBelongsToDepartment(input.divisionId, existing.departmentId);
	}

	if (input.status === 'ACTIVE') {
		const department = await assertDepartmentExists(existing.departmentId);
		assertParentActive(department.status, 'ພະແນກ');

		// If the division isn't changing in this request, re-check whichever one still applies.
		const effectiveDivisionId =
			input.divisionId !== undefined ? input.divisionId : existing.divisionId;
		if (effectiveDivisionId) {
			const effectiveDivision = division ?? (await assertDivisionExists(effectiveDivisionId));
			assertParentActive(effectiveDivision.status, 'ຝ່າຍ');
		}
	}

	return prisma.$transaction(async (tx) => {
		const row = await tx.unit.update({ where: { id }, data: input, ...WITH_CONTEXT });
		await auditUpdated(tx, {
			action: AuditAction.ORG_UPDATED,
			entityType: AuditEntity.ORGANIZATION,
			entityId: id,
			companyId: (
				await tx.department.findUnique({
					where: { id: existing.departmentId },
					select: { companyId: true }
				})
			)?.companyId,
			before: existing,
			after: row,
			fields: Object.keys(input),
			metadata: { kind: 'UNIT', ...safeLabel(existing) }
		});
		return row;
	});
}
