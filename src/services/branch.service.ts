import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertParentActive } from '../lib/orgValidation.js';
import { assertCompanyExists } from './company.service.js';
import type {
	BranchCreateInput,
	BranchListQuery,
	BranchUpdateInput
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
} satisfies Prisma.BranchSelect;

const WITH_COMPANY = {
	include: { company: { select: { id: true, code: true, nameLao: true } } }
} satisfies Prisma.BranchDefaultArgs;

export async function listBranches(query: BranchListQuery) {
	const where: Prisma.BranchWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.search
			? { OR: [{ code: { contains: query.search } }, { nameLao: { contains: query.search } }] }
			: {})
	};

	const [items, total] = await Promise.all([
		prisma.branch.findMany({
			where,
			...WITH_COMPANY,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.branch.count({ where })
	]);

	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getBranchById(id: number) {
	const branch = await prisma.branch.findUnique({ where: { id }, ...WITH_COMPANY });
	if (!branch) throw Errors.notFound('ບໍ່ພົບສາຂາ');
	return branch;
}

export async function assertBranchExists(id: number) {
	const branch = await prisma.branch.findUnique({ where: { id } });
	if (!branch) throw Errors.badRequest('INVALID_BRANCH', 'ບໍ່ພົບສາຂາ');
	return branch;
}

export async function createBranch(input: BranchCreateInput) {
	const company = await assertCompanyExists(input.companyId);

	const codeTaken = await prisma.branch.findUnique({
		where: { companyId_code: { companyId: input.companyId, code: input.code } }
	});
	if (codeTaken) throw Errors.conflict('BRANCH_CODE_TAKEN', 'ລະຫັດສາຂານີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');

	if (input.status === 'ACTIVE') assertParentActive(company.status, 'ບໍລິສັດ');

	return prisma.$transaction(async (tx) => {
		const row = await tx.branch.create({ data: input, ...WITH_COMPANY });
		await writeAuditEvent(tx, {
			action: AuditAction.ORG_CREATED,
			entityType: AuditEntity.ORGANIZATION,
			entityId: row.id,
			companyId: input.companyId,
			metadata: { kind: 'BRANCH', ...safeLabel(row) }
		});
		return row;
	});
}

export async function updateBranch(id: number, input: BranchUpdateInput) {
	const existing = await prisma.branch.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບສາຂາ');

	if (input.status === 'ACTIVE') {
		const company = await assertCompanyExists(existing.companyId);
		assertParentActive(company.status, 'ບໍລິສັດ');
	}

	return prisma.$transaction(async (tx) => {
		const row = await tx.branch.update({ where: { id }, data: input, ...WITH_COMPANY });
		await auditUpdated(tx, {
			action: AuditAction.ORG_UPDATED,
			entityType: AuditEntity.ORGANIZATION,
			entityId: id,
			companyId: existing.companyId,
			before: existing,
			after: row,
			fields: Object.keys(input),
			metadata: { kind: 'BRANCH', ...safeLabel(existing) }
		});
		return row;
	});
}

export function listBranchLookup(companyId: number, status?: 'ACTIVE' | 'INACTIVE') {
	return prisma.branch.findMany({
		where: { companyId, ...(status ? { status } : { status: 'ACTIVE' }) },
		select: LOOKUP_SELECT,
		orderBy: { nameLao: 'asc' }
	});
}
