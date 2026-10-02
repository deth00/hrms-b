import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertParentActive } from '../lib/orgValidation.js';
import { assertCompanyExists } from './company.service.js';
import { assertBranchExists } from './branch.service.js';
import type {
	DepartmentCreateInput,
	DepartmentListQuery,
	DepartmentUpdateInput
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
} satisfies Prisma.DepartmentSelect;

const WITH_CONTEXT = {
	include: {
		company: { select: { id: true, code: true, nameLao: true } },
		branch: { select: { id: true, code: true, nameLao: true } }
	}
} satisfies Prisma.DepartmentDefaultArgs;

/** branchId, when present, must belong to the same company as the department. */
async function assertBranchBelongsToCompany(branchId: number, companyId: number) {
	const branch = await assertBranchExists(branchId);
	if (branch.companyId !== companyId) {
		throw Errors.badRequest('BRANCH_COMPANY_MISMATCH', 'ສາຂາທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ບໍລິສັດດຽວກັນ');
	}
	return branch;
}

export async function listDepartments(query: DepartmentListQuery) {
	const where: Prisma.DepartmentWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.branchId ? { branchId: query.branchId } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.search
			? { OR: [{ code: { contains: query.search } }, { nameLao: { contains: query.search } }] }
			: {})
	};

	const [items, total] = await Promise.all([
		prisma.department.findMany({
			where,
			...WITH_CONTEXT,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.department.count({ where })
	]);

	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getDepartmentById(id: number) {
	const department = await prisma.department.findUnique({ where: { id }, ...WITH_CONTEXT });
	if (!department) throw Errors.notFound('ບໍ່ພົບພະແນກ');
	return department;
}

export async function assertDepartmentExists(id: number) {
	const department = await prisma.department.findUnique({ where: { id } });
	if (!department) throw Errors.badRequest('INVALID_DEPARTMENT', 'ບໍ່ພົບພະແນກ');
	return department;
}

export async function createDepartment(input: DepartmentCreateInput) {
	const company = await assertCompanyExists(input.companyId);
	const branch = input.branchId
		? await assertBranchBelongsToCompany(input.branchId, input.companyId)
		: null;

	const codeTaken = await prisma.department.findUnique({
		where: { companyId_code: { companyId: input.companyId, code: input.code } }
	});
	if (codeTaken)
		throw Errors.conflict('DEPARTMENT_CODE_TAKEN', 'ລະຫັດພະແນກນີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');

	if (input.status === 'ACTIVE') {
		assertParentActive(company.status, 'ບໍລິສັດ');
		if (branch) assertParentActive(branch.status, 'ສາຂາ');
	}

	return prisma.$transaction(async (tx) => {
		const row = await tx.department.create({ data: input, ...WITH_CONTEXT });
		await writeAuditEvent(tx, {
			action: AuditAction.ORG_CREATED,
			entityType: AuditEntity.ORGANIZATION,
			entityId: row.id,
			companyId: input.companyId,
			metadata: { kind: 'DEPARTMENT', ...safeLabel(row) }
		});
		return row;
	});
}

export async function updateDepartment(id: number, input: DepartmentUpdateInput) {
	const existing = await prisma.department.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບພະແນກ');

	// branchId may change (to another branch, or cleared to null) but companyId is fixed on update.
	let branch = null;
	if (input.branchId !== undefined && input.branchId !== null) {
		branch = await assertBranchBelongsToCompany(input.branchId, existing.companyId);
	}

	if (input.status === 'ACTIVE') {
		const company = await assertCompanyExists(existing.companyId);
		assertParentActive(company.status, 'ບໍລິສັດ');

		const effectiveBranchId = input.branchId !== undefined ? input.branchId : existing.branchId;
		if (effectiveBranchId) {
			const effectiveBranch = branch ?? (await assertBranchExists(effectiveBranchId));
			assertParentActive(effectiveBranch.status, 'ສາຂາ');
		}
	}

	return prisma.$transaction(async (tx) => {
		const row = await tx.department.update({ where: { id }, data: input, ...WITH_CONTEXT });
		await auditUpdated(tx, {
			action: AuditAction.ORG_UPDATED,
			entityType: AuditEntity.ORGANIZATION,
			entityId: id,
			companyId: existing.companyId,
			before: existing,
			after: row,
			fields: Object.keys(input),
			metadata: { kind: 'DEPARTMENT', ...safeLabel(existing) }
		});
		return row;
	});
}

export function listDepartmentLookup(
	companyId: number,
	branchId?: number,
	status?: 'ACTIVE' | 'INACTIVE'
) {
	return prisma.department.findMany({
		where: {
			companyId,
			...(branchId ? { branchId } : {}),
			...(status ? { status } : { status: 'ACTIVE' })
		},
		select: LOOKUP_SELECT,
		orderBy: { nameLao: 'asc' }
	});
}
