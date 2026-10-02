import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertParentActive } from '../lib/orgValidation.js';
import { assertCompanyExists } from './company.service.js';
import { assertPositionLevelExists } from './positionLevel.service.js';
import type {
	PositionCreateInput,
	PositionListQuery,
	PositionUpdateInput
} from '../validation/position.schema.js';
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
		positionLevel: { select: { id: true, code: true, nameLao: true, rank: true } }
	}
} satisfies Prisma.PositionDefaultArgs;

async function assertPositionLevelBelongsToCompany(positionLevelId: number, companyId: number) {
	const level = await assertPositionLevelExists(positionLevelId);
	if (level.companyId !== companyId) {
		throw Errors.badRequest(
			'POSITION_LEVEL_COMPANY_MISMATCH',
			'ລະດັບຕຳແໜ່ງທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ບໍລິສັດດຽວກັນ'
		);
	}
	return level;
}

export async function listPositions(query: PositionListQuery) {
	const where: Prisma.PositionWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.positionLevelId ? { positionLevelId: query.positionLevelId } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.search
			? { OR: [{ code: { contains: query.search } }, { nameLao: { contains: query.search } }] }
			: {})
	};

	const [items, total] = await Promise.all([
		prisma.position.findMany({
			where,
			...WITH_CONTEXT,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.position.count({ where })
	]);

	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getPositionById(id: number) {
	const position = await prisma.position.findUnique({ where: { id }, ...WITH_CONTEXT });
	if (!position) throw Errors.notFound('ບໍ່ພົບຕຳແໜ່ງ');
	return position;
}

export async function createPosition(input: PositionCreateInput) {
	const company = await assertCompanyExists(input.companyId);
	const positionLevel = input.positionLevelId
		? await assertPositionLevelBelongsToCompany(input.positionLevelId, input.companyId)
		: null;

	const codeTaken = await prisma.position.findUnique({
		where: { companyId_code: { companyId: input.companyId, code: input.code } }
	});
	if (codeTaken)
		throw Errors.conflict('POSITION_CODE_TAKEN', 'ລະຫັດຕຳແໜ່ງນີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');

	if (input.status === 'ACTIVE') {
		assertParentActive(company.status, 'ບໍລິສັດ');
		if (positionLevel) assertParentActive(positionLevel.status, 'ລະດັບຕຳແໜ່ງ');
	}

	return prisma.$transaction(async (tx) => {
		const row = await tx.position.create({ data: input, ...WITH_CONTEXT });
		await writeAuditEvent(tx, {
			action: AuditAction.POSITION_CREATED,
			entityType: AuditEntity.POSITION,
			entityId: row.id,
			companyId: input.companyId,
			metadata: { kind: 'POSITION', ...safeLabel(row) }
		});
		return row;
	});
}

export async function updatePosition(id: number, input: PositionUpdateInput) {
	const existing = await prisma.position.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບຕຳແໜ່ງ');

	let positionLevel = null;
	if (input.positionLevelId !== undefined && input.positionLevelId !== null) {
		positionLevel = await assertPositionLevelBelongsToCompany(
			input.positionLevelId,
			existing.companyId
		);
	}

	if (input.status === 'ACTIVE') {
		const company = await assertCompanyExists(existing.companyId);
		assertParentActive(company.status, 'ບໍລິສັດ');

		const effectiveLevelId =
			input.positionLevelId !== undefined ? input.positionLevelId : existing.positionLevelId;
		if (effectiveLevelId) {
			const effectiveLevel = positionLevel ?? (await assertPositionLevelExists(effectiveLevelId));
			assertParentActive(effectiveLevel.status, 'ລະດັບຕຳແໜ່ງ');
		}
	}

	return prisma.$transaction(async (tx) => {
		const row = await tx.position.update({ where: { id }, data: input, ...WITH_CONTEXT });
		await auditUpdated(tx, {
			action: AuditAction.POSITION_UPDATED,
			entityType: AuditEntity.POSITION,
			entityId: id,
			companyId: existing.companyId,
			before: existing,
			after: row,
			fields: Object.keys(input),
			metadata: { kind: 'POSITION', ...safeLabel(existing) }
		});
		return row;
	});
}
