import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertCompanyExists } from './company.service.js';
import {
	AuditAction,
	AuditEntity,
	auditUpdated,
	safeLabel,
	writeAuditEvent
} from './audit.service.js';
import type {
	PayComponentCreateInput,
	PayComponentListQuery,
	PayComponentUpdateInput
} from '../validation/payroll.schema.js';

/**
 * Codes that name system lines in a payroll result. Users cannot create components (or manual
 * adjustments) with them, so a result line called BASE_SALARY is always the real base salary, and no
 * TAX / SOCIAL_SECURITY / OVERTIME line can be faked before those phases exist.
 */
export const RESERVED_PAY_CODES = ['BASE_SALARY', 'TAX', 'SOCIAL_SECURITY', 'OVERTIME', 'PIT'];

export const assertCodeNotReserved = (code: string) => {
	if (RESERVED_PAY_CODES.includes(code.toUpperCase())) {
		throw Errors.badRequest('PAY_CODE_RESERVED', `ລະຫັດ ${code} ຖືກສະຫງວນໄວ້ໂດຍລະບົບ`);
	}
};

const WITH_COMPANY = { company: { select: { id: true, code: true, nameLao: true } } } as const;

const EARNING_CATEGORIES = ['ALLOWANCE', 'BONUS', 'OTHER_EARNING'];
const DEDUCTION_CATEGORIES = ['DEDUCTION', 'OTHER_DEDUCTION'];
const categoryFits = (type: string, category: string) =>
	(type === 'EARNING' ? EARNING_CATEGORIES : DEDUCTION_CATEGORIES).includes(category);

export async function listPayComponents(query: PayComponentListQuery) {
	const where: Prisma.PayComponentWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.type ? { type: query.type } : {}),
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
		prisma.payComponent.findMany({
			where,
			include: WITH_COMPANY,
			orderBy: [{ type: 'asc' }, { code: 'asc' }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.payComponent.count({ where })
	]);
	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getPayComponent(id: number) {
	const row = await prisma.payComponent.findUnique({ where: { id }, include: WITH_COMPANY });
	if (!row) throw Errors.notFound('ບໍ່ພົບລາຍການລາຍຮັບ/ລາຍຈ່າຍ');
	return row;
}

export async function createPayComponent(input: PayComponentCreateInput) {
	await assertCompanyExists(input.companyId);
	assertCodeNotReserved(input.code);
	const taken = await prisma.payComponent.findUnique({
		where: { companyId_code: { companyId: input.companyId, code: input.code } }
	});
	if (taken) {
		throw Errors.conflict('PAY_COMPONENT_CODE_TAKEN', 'ລະຫັດນີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');
	}
	try {
		return await prisma.$transaction(async (tx) => {
			const row = await tx.payComponent.create({ data: input, include: WITH_COMPANY });
			await writeAuditEvent(tx, {
				action: AuditAction.PAY_COMPONENT_CREATED,
				entityType: AuditEntity.PAY_COMPONENT,
				entityId: row.id,
				companyId: row.companyId,
				metadata: { ...safeLabel(row), type: row.type, category: row.category }
			});
			return row;
		});
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict('PAY_COMPONENT_CODE_TAKEN', 'ລະຫັດນີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');
		}
		throw err;
	}
}

/**
 * Updates the descriptive fields / status. `type` and `companyId` are fixed for life; disabling a
 * component blocks NEW assignments only — existing recurring rows and historical results are untouched.
 */
export async function updatePayComponent(id: number, input: PayComponentUpdateInput) {
	const existing = await prisma.payComponent.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບລາຍການລາຍຮັບ/ລາຍຈ່າຍ');
	if (input.category && !categoryFits(existing.type, input.category)) {
		throw Errors.badRequest('INVALID_CATEGORY', 'ໝວດໝູ່ບໍ່ສອດຄ່ອງກັບປະເພດລາຍຮັບ/ລາຍຈ່າຍ');
	}
	return prisma.$transaction(async (tx) => {
		const row = await tx.payComponent.update({ where: { id }, data: input, include: WITH_COMPANY });
		const treatmentChanged =
			('pitTreatment' in input && input.pitTreatment !== existing.pitTreatment) ||
			('socialSecurityTreatment' in input &&
				input.socialSecurityTreatment !== existing.socialSecurityTreatment);
		await auditUpdated(tx, {
			action: treatmentChanged
				? AuditAction.PAY_COMPONENT_STATUTORY_TREATMENT_UPDATED
				: AuditAction.PAY_COMPONENT_UPDATED,
			entityType: AuditEntity.PAY_COMPONENT,
			entityId: id,
			companyId: existing.companyId,
			before: existing,
			after: row,
			fields: Object.keys(input),
			metadata: { ...safeLabel(existing), type: existing.type }
		});
		return row;
	});
}
