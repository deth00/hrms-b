import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertParentActive } from '../lib/orgValidation.js';
import { assertDepartmentExists } from './department.service.js';
import type {
	DivisionCreateInput,
	DivisionListQuery,
	DivisionUpdateInput
} from '../validation/organization.schema.js';
import {
	AuditAction,
	AuditEntity,
	auditUpdated,
	safeLabel,
	writeAuditEvent
} from './audit.service.js';

const LOOKUP_SELECT = {
	id: true,
	code: true,
	nameLao: true,
	nameEnglish: true,
	status: true
} satisfies Prisma.DivisionSelect;

const WITH_CONTEXT = {
	include: {
		department: {
			select: {
				id: true,
				code: true,
				nameLao: true,
				company: { select: { id: true, code: true, nameLao: true } },
				branch: { select: { id: true, code: true, nameLao: true } }
			}
		}
	}
} satisfies Prisma.DivisionDefaultArgs;

export async function listDivisions(query: DivisionListQuery) {
	const where: Prisma.DivisionWhereInput = {
		...(query.departmentId ? { departmentId: query.departmentId } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.search
			? { OR: [{ code: { contains: query.search } }, { nameLao: { contains: query.search } }] }
			: {})
	};

	const [items, total] = await Promise.all([
		prisma.division.findMany({
			where,
			...WITH_CONTEXT,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.division.count({ where })
	]);

	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getDivisionById(id: number) {
	const division = await prisma.division.findUnique({ where: { id }, ...WITH_CONTEXT });
	if (!division) throw Errors.notFound('ບໍ່ພົບຝ່າຍ');
	return division;
}

export async function assertDivisionExists(id: number) {
	const division = await prisma.division.findUnique({ where: { id } });
	if (!division) throw Errors.badRequest('INVALID_DIVISION', 'ບໍ່ພົບຝ່າຍ');
	return division;
}

export async function createDivision(input: DivisionCreateInput) {
	const department = await assertDepartmentExists(input.departmentId);

	const codeTaken = await prisma.division.findUnique({
		where: { departmentId_code: { departmentId: input.departmentId, code: input.code } }
	});
	if (codeTaken) throw Errors.conflict('DIVISION_CODE_TAKEN', 'ລະຫັດຝ່າຍນີ້ຖືກໃຊ້ແລ້ວໃນພະແນກນີ້');

	if (input.status === 'ACTIVE') assertParentActive(department.status, 'ພະແນກ');

	return prisma.$transaction(async (tx) => {
		const row = await tx.division.create({ data: input, ...WITH_CONTEXT });
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
			metadata: { kind: 'DIVISION', ...safeLabel(row) }
		});
		return row;
	});
}

export async function updateDivision(id: number, input: DivisionUpdateInput) {
	const existing = await prisma.division.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບຝ່າຍ');

	if (input.status === 'ACTIVE') {
		const department = await assertDepartmentExists(existing.departmentId);
		assertParentActive(department.status, 'ພະແນກ');
	}

	return prisma.$transaction(async (tx) => {
		const row = await tx.division.update({ where: { id }, data: input, ...WITH_CONTEXT });
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
			metadata: { kind: 'DIVISION', ...safeLabel(existing) }
		});
		return row;
	});
}

export function listDivisionLookup(departmentId: number, status?: 'ACTIVE' | 'INACTIVE') {
	return prisma.division.findMany({
		where: { departmentId, ...(status ? { status } : { status: 'ACTIVE' }) },
		select: LOOKUP_SELECT,
		orderBy: { nameLao: 'asc' }
	});
}
