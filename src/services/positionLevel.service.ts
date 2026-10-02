import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertParentActive } from '../lib/orgValidation.js';
import { assertCompanyExists } from './company.service.js';
import type {
	PositionLevelCreateInput,
	PositionLevelListQuery,
	PositionLevelUpdateInput
} from '../validation/position.schema.js';
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
	rank: true,
	status: true
} satisfies Prisma.PositionLevelSelect;

const WITH_COMPANY = {
	include: { company: { select: { id: true, code: true, nameLao: true } } }
} satisfies Prisma.PositionLevelDefaultArgs;

export async function listPositionLevels(query: PositionLevelListQuery) {
	const where: Prisma.PositionLevelWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.search
			? { OR: [{ code: { contains: query.search } }, { nameLao: { contains: query.search } }] }
			: {})
	};

	const [items, total] = await Promise.all([
		prisma.positionLevel.findMany({
			where,
			...WITH_COMPANY,
			orderBy: { rank: 'asc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.positionLevel.count({ where })
	]);

	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getPositionLevelById(id: number) {
	const level = await prisma.positionLevel.findUnique({ where: { id }, ...WITH_COMPANY });
	if (!level) throw Errors.notFound('ບໍ່ພົບລະດັບຕຳແໜ່ງ');
	return level;
}

export async function assertPositionLevelExists(id: number) {
	const level = await prisma.positionLevel.findUnique({ where: { id } });
	if (!level) throw Errors.badRequest('INVALID_POSITION_LEVEL', 'ບໍ່ພົບລະດັບຕຳແໜ່ງ');
	return level;
}

export async function createPositionLevel(input: PositionLevelCreateInput) {
	const company = await assertCompanyExists(input.companyId);

	const [codeTaken, rankTaken] = await Promise.all([
		prisma.positionLevel.findUnique({
			where: { companyId_code: { companyId: input.companyId, code: input.code } }
		}),
		prisma.positionLevel.findUnique({
			where: { companyId_rank: { companyId: input.companyId, rank: input.rank } }
		})
	]);
	if (codeTaken)
		throw Errors.conflict('POSITION_LEVEL_CODE_TAKEN', 'ລະຫັດລະດັບຕຳແໜ່ງນີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');
	if (rankTaken)
		throw Errors.conflict('POSITION_LEVEL_RANK_TAKEN', 'ລຳດັບ (rank) ນີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');

	if (input.status === 'ACTIVE') assertParentActive(company.status, 'ບໍລິສັດ');

	return prisma.$transaction(async (tx) => {
		const row = await tx.positionLevel.create({ data: input, ...WITH_COMPANY });
		await writeAuditEvent(tx, {
			action: AuditAction.POSITION_CREATED,
			entityType: AuditEntity.POSITION,
			entityId: row.id,
			companyId: input.companyId,
			metadata: { kind: 'POSITION_LEVEL', ...safeLabel(row) }
		});
		return row;
	});
}

export async function updatePositionLevel(id: number, input: PositionLevelUpdateInput) {
	const existing = await prisma.positionLevel.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບລະດັບຕຳແໜ່ງ');

	if (input.rank !== undefined && input.rank !== existing.rank) {
		const rankTaken = await prisma.positionLevel.findUnique({
			where: { companyId_rank: { companyId: existing.companyId, rank: input.rank } }
		});
		if (rankTaken)
			throw Errors.conflict('POSITION_LEVEL_RANK_TAKEN', 'ລຳດັບ (rank) ນີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');
	}

	if (input.status === 'ACTIVE') {
		const company = await assertCompanyExists(existing.companyId);
		assertParentActive(company.status, 'ບໍລິສັດ');
	}

	return prisma.$transaction(async (tx) => {
		const row = await tx.positionLevel.update({ where: { id }, data: input, ...WITH_COMPANY });
		await auditUpdated(tx, {
			action: AuditAction.POSITION_UPDATED,
			entityType: AuditEntity.POSITION,
			entityId: id,
			companyId: existing.companyId,
			before: existing,
			after: row,
			fields: Object.keys(input),
			metadata: { kind: 'POSITION_LEVEL', ...safeLabel(existing) }
		});
		return row;
	});
}

export function listPositionLevelLookup(companyId: number, status?: 'ACTIVE' | 'INACTIVE') {
	return prisma.positionLevel.findMany({
		where: { companyId, ...(status ? { status } : { status: 'ACTIVE' }) },
		select: LOOKUP_SELECT,
		orderBy: { rank: 'asc' }
	});
}
