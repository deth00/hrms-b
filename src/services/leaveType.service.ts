import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertParentActive } from '../lib/orgValidation.js';
import { assertCompanyExists } from './company.service.js';
import type {
	LeaveTypeCreateInput,
	LeaveTypeListQuery,
	LeaveTypeUpdateInput
} from '../validation/leave.schema.js';
import {
	AuditAction,
	AuditEntity,
	auditUpdated,
	safeLabel,
	writeAuditEvent
} from './audit.service.js';

const WITH_COMPANY = {
	include: { company: { select: { id: true, code: true, nameLao: true } } }
} satisfies Prisma.LeaveTypeDefaultArgs;

type LeaveTypeRow = Prisma.LeaveTypeGetPayload<typeof WITH_COMPANY>;

/** Decimals leave the API as plain numbers (2 dp is always exactly representable for display). */
export function presentLeaveType(row: LeaveTypeRow) {
	return {
		...row,
		defaultEntitlementDays: row.defaultEntitlementDays?.toNumber() ?? null
	};
}

export async function listLeaveTypes(query: LeaveTypeListQuery) {
	const where: Prisma.LeaveTypeWhereInput = {
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
		prisma.leaveType.findMany({
			where,
			...WITH_COMPANY,
			orderBy: [{ status: 'asc' }, { code: 'asc' }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.leaveType.count({ where })
	]);
	return {
		items: items.map(presentLeaveType),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getLeaveTypeById(id: number) {
	const row = await prisma.leaveType.findUnique({ where: { id }, ...WITH_COMPANY });
	if (!row) throw Errors.notFound('ບໍ່ພົບປະເພດການລາ');
	return presentLeaveType(row);
}

const toDecimal = (n: number | null | undefined) =>
	n === null || n === undefined ? n : new Prisma.Decimal(n.toFixed(2));

export async function createLeaveType(input: LeaveTypeCreateInput) {
	const company = await assertCompanyExists(input.companyId);
	const taken = await prisma.leaveType.findUnique({
		where: { companyId_code: { companyId: input.companyId, code: input.code } }
	});
	if (taken)
		throw Errors.conflict('LEAVE_TYPE_CODE_TAKEN', 'ລະຫັດປະເພດການລານີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');
	if (input.status === 'ACTIVE') assertParentActive(company.status, 'ບໍລິສັດ');

	const row = await prisma.$transaction(async (tx) => {
		const created = await tx.leaveType.create({
			data: { ...input, defaultEntitlementDays: toDecimal(input.defaultEntitlementDays) },
			...WITH_COMPANY
		});
		await writeAuditEvent(tx, {
			action: AuditAction.LEAVE_TYPE_CREATED,
			entityType: AuditEntity.LEAVE_TYPE,
			entityId: created.id,
			companyId: created.companyId,
			metadata: safeLabel(created)
		});
		return created;
	});
	return presentLeaveType(row);
}

export async function updateLeaveType(id: number, input: LeaveTypeUpdateInput) {
	const existing = await prisma.leaveType.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບປະເພດການລາ');

	if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
		const company = await assertCompanyExists(existing.companyId);
		assertParentActive(company.status, 'ບໍລິສັດ');
	}
	const row = await prisma.$transaction(async (tx) => {
		const updated = await tx.leaveType.update({
			where: { id },
			data: {
				...input,
				...(input.defaultEntitlementDays !== undefined
					? { defaultEntitlementDays: toDecimal(input.defaultEntitlementDays) }
					: {})
			},
			...WITH_COMPANY
		});
		await auditUpdated(tx, {
			action: AuditAction.LEAVE_TYPE_UPDATED,
			entityType: AuditEntity.LEAVE_TYPE,
			entityId: id,
			companyId: existing.companyId,
			before: existing,
			after: updated,
			fields: Object.keys(input),
			metadata: safeLabel(existing)
		});
		return updated;
	});
	return presentLeaveType(row);
}
