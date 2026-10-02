import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertParentActive } from '../lib/orgValidation.js';
import { assertCompanyExists } from './company.service.js';
import type {
	EmploymentTypeCreateInput,
	EmploymentTypeListQuery,
	EmploymentTypeUpdateInput
} from '../validation/employee.schema.js';
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
} satisfies Prisma.EmploymentTypeSelect;

const WITH_COMPANY = {
	include: { company: { select: { id: true, code: true, nameLao: true } } }
} satisfies Prisma.EmploymentTypeDefaultArgs;

export async function listEmploymentTypes(query: EmploymentTypeListQuery) {
	const where: Prisma.EmploymentTypeWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.search
			? {
					OR: [
						{ code: { contains: query.search } },
						{ nameLao: { contains: query.search } },
						{ nameEnglish: { contains: query.search } }
					]
				}
			: {})
	};

	const [items, total] = await Promise.all([
		prisma.employmentType.findMany({
			where,
			...WITH_COMPANY,
			orderBy: [{ createdAt: 'desc' }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.employmentType.count({ where })
	]);

	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getEmploymentTypeById(id: number) {
	const type = await prisma.employmentType.findUnique({ where: { id }, ...WITH_COMPANY });
	if (!type) throw Errors.notFound('ບໍ່ພົບປະເພດການຈ້າງງານ');
	return type;
}

export async function createEmploymentType(input: EmploymentTypeCreateInput) {
	const company = await assertCompanyExists(input.companyId);

	const codeTaken = await prisma.employmentType.findUnique({
		where: { companyId_code: { companyId: input.companyId, code: input.code } }
	});
	if (codeTaken) {
		throw Errors.conflict(
			'EMPLOYMENT_TYPE_CODE_TAKEN',
			'ລະຫັດປະເພດການຈ້າງງານນີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້'
		);
	}

	if (input.status === 'ACTIVE') assertParentActive(company.status, 'ບໍລິສັດ');

	return prisma.$transaction(async (tx) => {
		const row = await tx.employmentType.create({ data: input, ...WITH_COMPANY });
		await writeAuditEvent(tx, {
			action: AuditAction.ORG_CREATED,
			entityType: AuditEntity.ORGANIZATION,
			entityId: row.id,
			companyId: input.companyId,
			metadata: { kind: 'EMPLOYMENT_TYPE', ...safeLabel(row) }
		});
		return row;
	});
}

export async function updateEmploymentType(id: number, input: EmploymentTypeUpdateInput) {
	const existing = await prisma.employmentType.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບປະເພດການຈ້າງງານ');

	if (input.status === 'ACTIVE') {
		const company = await assertCompanyExists(existing.companyId);
		assertParentActive(company.status, 'ບໍລິສັດ');
	}

	return prisma.$transaction(async (tx) => {
		const row = await tx.employmentType.update({ where: { id }, data: input, ...WITH_COMPANY });
		await auditUpdated(tx, {
			action: AuditAction.ORG_UPDATED,
			entityType: AuditEntity.ORGANIZATION,
			entityId: id,
			companyId: existing.companyId,
			before: existing,
			after: row,
			fields: Object.keys(input),
			metadata: { kind: 'EMPLOYMENT_TYPE', ...safeLabel(existing) }
		});
		return row;
	});
}

export function listEmploymentTypeLookup(companyId: number, status?: 'ACTIVE' | 'INACTIVE') {
	return prisma.employmentType.findMany({
		where: { companyId, ...(status ? { status } : { status: 'ACTIVE' }) },
		select: LOOKUP_SELECT,
		orderBy: { nameLao: 'asc' }
	});
}
