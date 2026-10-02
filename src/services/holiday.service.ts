import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertParentActive } from '../lib/orgValidation.js';
import { assertCompanyExists } from './company.service.js';
import type {
	HolidayCreateInput,
	HolidayListQuery,
	HolidayUpdateInput
} from '../validation/schedule.schema.js';
import {
	AuditAction,
	AuditEntity,
	auditUpdated,
	safeLabel,
	writeAuditEvent
} from './audit.service.js';

const WITH_COMPANY = {
	include: { company: { select: { id: true, code: true, nameLao: true } } }
} satisfies Prisma.HolidayDefaultArgs;

const DUPLICATE_MESSAGE = 'ມີວັນພັກຊື່ນີ້ໃນວັນທີ່ດຽວກັນແລ້ວ';

export async function listHolidays(query: HolidayListQuery) {
	let dateRange: Prisma.HolidayWhereInput = {};
	if (query.year !== undefined) {
		const from = new Date(Date.UTC(query.year, (query.month ?? 1) - 1, 1));
		const to =
			query.month !== undefined
				? new Date(Date.UTC(query.year, query.month, 1))
				: new Date(Date.UTC(query.year + 1, 0, 1));
		dateRange = { holidayDate: { gte: from, lt: to } };
	}

	const where: Prisma.HolidayWhereInput = {
		...dateRange,
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.type ? { type: query.type } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.search
			? {
					OR: [{ nameLao: { contains: query.search } }, { nameEnglish: { contains: query.search } }]
				}
			: {})
	};

	const [items, total] = await Promise.all([
		prisma.holiday.findMany({
			where,
			...WITH_COMPANY,
			orderBy: [{ holidayDate: 'asc' }, { nameLao: 'asc' }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.holiday.count({ where })
	]);
	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getHolidayById(id: number) {
	const holiday = await prisma.holiday.findUnique({ where: { id }, ...WITH_COMPANY });
	if (!holiday) throw Errors.notFound('ບໍ່ພົບວັນພັກ');
	return holiday;
}

function isDuplicate(err: unknown): boolean {
	return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function createHoliday(input: HolidayCreateInput) {
	const company = await assertCompanyExists(input.companyId);
	if (input.status === 'ACTIVE') assertParentActive(company.status, 'ບໍລິສັດ');

	try {
		return await prisma.$transaction(async (tx) => {
			const row = await tx.holiday.create({ data: input, ...WITH_COMPANY });
			await writeAuditEvent(tx, {
				action: AuditAction.HOLIDAY_CREATED,
				entityType: AuditEntity.HOLIDAY,
				entityId: row.id,
				companyId: input.companyId,
				metadata: { kind: 'HOLIDAY', ...safeLabel(row) }
			});
			return row;
		});
	} catch (err) {
		if (isDuplicate(err)) throw Errors.conflict('HOLIDAY_DUPLICATE', DUPLICATE_MESSAGE);
		throw err;
	}
}

export async function updateHoliday(id: number, input: HolidayUpdateInput) {
	const existing = await prisma.holiday.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບວັນພັກ');

	if (input.status === 'ACTIVE') {
		const company = await assertCompanyExists(existing.companyId);
		assertParentActive(company.status, 'ບໍລິສັດ');
	}

	try {
		return await prisma.$transaction(async (tx) => {
			const row = await tx.holiday.update({ where: { id }, data: input, ...WITH_COMPANY });
			await auditUpdated(tx, {
				action: AuditAction.HOLIDAY_UPDATED,
				entityType: AuditEntity.HOLIDAY,
				entityId: id,
				companyId: existing.companyId,
				before: existing,
				after: row,
				fields: Object.keys(input),
				metadata: { kind: 'HOLIDAY', ...safeLabel(existing) }
			});
			return row;
		});
	} catch (err) {
		if (isDuplicate(err)) throw Errors.conflict('HOLIDAY_DUPLICATE', DUPLICATE_MESSAGE);
		throw err;
	}
}
