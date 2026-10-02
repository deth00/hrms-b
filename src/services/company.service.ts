import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { ensureDefaultWorkflows } from './approvalInstance.service.js';
import type {
	CompanyCreateInput,
	CompanyListQuery,
	CompanyUpdateInput
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
} satisfies Prisma.CompanySelect;

export async function listCompanies(query: CompanyListQuery) {
	const where: Prisma.CompanyWhereInput = {
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
		prisma.company.findMany({
			where,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.company.count({ where })
	]);

	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getCompanyById(id: number) {
	const company = await prisma.company.findUnique({ where: { id } });
	if (!company) throw Errors.notFound('ບໍ່ພົບບໍລິສັດ');
	return company;
}

export async function assertCompanyExists(id: number) {
	const company = await prisma.company.findUnique({ where: { id } });
	if (!company) throw Errors.badRequest('INVALID_COMPANY', 'ບໍ່ພົບບໍລິສັດ');
	return company;
}

export async function createCompany(input: CompanyCreateInput) {
	const codeTaken = await prisma.company.findUnique({ where: { code: input.code } });
	if (codeTaken) throw Errors.conflict('COMPANY_CODE_TAKEN', 'ລະຫັດບໍລິສັດນີ້ຖືກໃຊ້ແລ້ວ');

	const company = await prisma.$transaction(async (tx) => {
		const row = await tx.company.create({ data: input });
		await writeAuditEvent(tx, {
			action: AuditAction.ORG_CREATED,
			entityType: AuditEntity.ORGANIZATION,
			entityId: row.id,
			companyId: row.id,
			metadata: { kind: 'COMPANY', ...safeLabel(row) }
		});
		return row;
	});
	// every company must be usable immediately: default one-step Leave / OT / Correction workflows
	await ensureDefaultWorkflows(company.id);
	return company;
}

export async function updateCompany(id: number, input: CompanyUpdateInput) {
	const existing = await prisma.company.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບບໍລິສັດ');

	return prisma.$transaction(async (tx) => {
		const row = await tx.company.update({ where: { id }, data: input });
		await auditUpdated(tx, {
			action: AuditAction.ORG_UPDATED,
			entityType: AuditEntity.ORGANIZATION,
			entityId: id,
			companyId: existing.id,
			before: existing,
			after: row,
			fields: Object.keys(input),
			metadata: { kind: 'COMPANY', ...safeLabel(existing) }
		});
		return row;
	});
}

export function listCompanyLookup(status?: 'ACTIVE' | 'INACTIVE') {
	return prisma.company.findMany({
		where: status ? { status } : { status: 'ACTIVE' },
		select: LOOKUP_SELECT,
		orderBy: { nameLao: 'asc' }
	});
}
