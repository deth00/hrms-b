import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertParentActive } from '../lib/orgValidation.js';
import { assertCompanyExists } from './company.service.js';
import type {
	WorkLocationCreateInput,
	WorkLocationListQuery,
	WorkLocationUpdateInput
} from '../validation/attendance.schema.js';
import {
	AuditAction,
	AuditEntity,
	auditUpdated,
	safeLabel,
	writeAuditEvent
} from './audit.service.js';

const WITH_CONTEXT = {
	include: {
		company: { select: { id: true, code: true, nameLao: true } },
		branch: { select: { id: true, code: true, nameLao: true } }
	}
} satisfies Prisma.WorkLocationDefaultArgs;

export async function listWorkLocations(query: WorkLocationListQuery) {
	const where: Prisma.WorkLocationWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.branchId ? { branchId: query.branchId } : {}),
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
		prisma.workLocation.findMany({
			where,
			...WITH_CONTEXT,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.workLocation.count({ where })
	]);
	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getWorkLocationById(id: number) {
	const location = await prisma.workLocation.findUnique({ where: { id }, ...WITH_CONTEXT });
	if (!location) throw Errors.notFound('ບໍ່ພົບສະຖານທີ່ Check-in');
	return location;
}

/** A branch must exist and belong to the same company as the location. */
async function loadBranchOf(companyId: number, branchId: number) {
	const branch = await prisma.branch.findUnique({ where: { id: branchId } });
	if (!branch) throw Errors.badRequest('INVALID_BRANCH', 'ບໍ່ພົບສາຂາ');
	if (branch.companyId !== companyId) {
		throw Errors.badRequest('BRANCH_COMPANY_MISMATCH', 'ສາຂາທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ບໍລິສັດດຽວກັນ');
	}
	return branch;
}

export async function createWorkLocation(input: WorkLocationCreateInput) {
	const company = await assertCompanyExists(input.companyId);
	const branch = input.branchId ? await loadBranchOf(input.companyId, input.branchId) : null;

	const taken = await prisma.workLocation.findUnique({
		where: { companyId_code: { companyId: input.companyId, code: input.code } }
	});
	if (taken) {
		throw Errors.conflict('WORK_LOCATION_CODE_TAKEN', 'ລະຫັດສະຖານທີ່ນີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');
	}

	if (input.status === 'ACTIVE') {
		assertParentActive(company.status, 'ບໍລິສັດ');
		if (branch) assertParentActive(branch.status, 'ສາຂາ');
	}
	return prisma.$transaction(async (tx) => {
		const row = await tx.workLocation.create({ data: input, ...WITH_CONTEXT });
		await writeAuditEvent(tx, {
			action: AuditAction.WORK_LOCATION_CREATED,
			entityType: AuditEntity.WORK_LOCATION,
			entityId: row.id,
			companyId: input.companyId,
			metadata: { kind: 'WORK_LOCATION', ...safeLabel(row) }
		});
		return row;
	});
}

export async function updateWorkLocation(id: number, input: WorkLocationUpdateInput) {
	const existing = await prisma.workLocation.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບສະຖານທີ່ Check-in');

	const branchId = input.branchId !== undefined ? input.branchId : existing.branchId;
	const branch = branchId ? await loadBranchOf(existing.companyId, branchId) : null;

	const resultingStatus = input.status ?? existing.status;
	if (resultingStatus === 'ACTIVE' && (input.status === 'ACTIVE' || input.branchId)) {
		const company = await assertCompanyExists(existing.companyId);
		assertParentActive(company.status, 'ບໍລິສັດ');
		if (branch) assertParentActive(branch.status, 'ສາຂາ');
	}
	return prisma.$transaction(async (tx) => {
		const row = await tx.workLocation.update({ where: { id }, data: input, ...WITH_CONTEXT });
		await auditUpdated(tx, {
			action: AuditAction.WORK_LOCATION_UPDATED,
			entityType: AuditEntity.WORK_LOCATION,
			entityId: id,
			companyId: existing.companyId,
			before: existing,
			after: row,
			fields: Object.keys(input),
			metadata: { kind: 'WORK_LOCATION', ...safeLabel(existing) }
		});
		return row;
	});
}

/**
 * Which location governs an employee's punches (documented rule):
 *  1. an ACTIVE location of the employee's own branch (same company);
 *  2. otherwise an ACTIVE company-level location (no branch);
 *  3. otherwise none -> no geofence applies and GPS is not required.
 * If several match at one level, the lowest code wins (deterministic).
 */
export async function resolveApplicableLocation(employee: {
	companyId: number;
	branchId: number | null;
}) {
	if (employee.branchId) {
		const branchLocation = await prisma.workLocation.findFirst({
			where: { companyId: employee.companyId, branchId: employee.branchId, status: 'ACTIVE' },
			orderBy: { code: 'asc' }
		});
		if (branchLocation) return branchLocation;
	}
	return prisma.workLocation.findFirst({
		where: { companyId: employee.companyId, branchId: null, status: 'ACTIVE' },
		orderBy: { code: 'asc' }
	});
}
