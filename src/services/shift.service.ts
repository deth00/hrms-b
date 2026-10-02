import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { assertParentActive } from '../lib/orgValidation.js';
import { shiftCrossesMidnight } from '../lib/dates.js';
import { assertCompanyExists } from './company.service.js';
import {
	DAYS,
	shiftTimeIssues,
	type ShiftCreateInput,
	type ShiftListQuery,
	type ShiftUpdateInput,
	type WorkDayInput
} from '../validation/schedule.schema.js';
import {
	AuditAction,
	AuditEntity,
	auditUpdated,
	safeLabel,
	writeAuditEvent
} from './audit.service.js';

const DEFAULT_WORKING = new Set(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']);

const WITH_CONTEXT = {
	include: {
		company: { select: { id: true, code: true, nameLao: true } },
		workDays: true
	}
} satisfies Prisma.ShiftDefaultArgs;

type ShiftRow = Prisma.ShiftGetPayload<typeof WITH_CONTEXT>;

/** Always present the weekly pattern Monday -> Sunday. */
function present(shift: ShiftRow) {
	const order = new Map(DAYS.map((d, i) => [d, i]));
	return {
		...shift,
		workDays: [...shift.workDays].sort(
			(a, b) => (order.get(a.dayOfWeek) ?? 0) - (order.get(b.dayOfWeek) ?? 0)
		)
	};
}

/**
 * Always persist all 7 days. Omitted -> the typical Mon-Fri working / Sat-Sun off; a partial list
 * leaves the missing days OFF. Per-day overrides are validated against the shift's effective times.
 */
function normalizeWorkDays(
	input: WorkDayInput[] | undefined,
	shift: { startTime: string; endTime: string; breakMinutes: number }
) {
	const given = new Map((input ?? []).map((d) => [d.dayOfWeek, d]));
	return DAYS.map((day) => {
		const d = given.get(day);
		const isWorkingDay = d ? d.isWorkingDay : !input && DEFAULT_WORKING.has(day);
		const startTimeOverride = isWorkingDay ? (d?.startTimeOverride ?? null) : null;
		const endTimeOverride = isWorkingDay ? (d?.endTimeOverride ?? null) : null;
		const breakMinutesOverride = isWorkingDay ? (d?.breakMinutesOverride ?? null) : null;

		if (startTimeOverride || endTimeOverride || breakMinutesOverride != null) {
			const start = startTimeOverride ?? shift.startTime;
			const end = endTimeOverride ?? shift.endTime;
			const issues = shiftTimeIssues({
				startTime: start,
				endTime: end,
				breakMinutes: breakMinutesOverride ?? shift.breakMinutes
			});
			if (issues.length > 0) {
				throw Errors.badRequest('INVALID_WORKDAY_OVERRIDE', `${day}: ${issues[0]!.message}`);
			}
		}
		return {
			dayOfWeek: day,
			isWorkingDay,
			startTimeOverride,
			endTimeOverride,
			breakMinutesOverride
		};
	});
}

export async function listShifts(query: ShiftListQuery) {
	const where: Prisma.ShiftWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.type ? { shiftType: query.type } : {}),
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
		prisma.shift.findMany({
			where,
			...WITH_CONTEXT,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.shift.count({ where })
	]);
	return {
		items: items.map(present),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getShiftById(id: number) {
	const shift = await prisma.shift.findUnique({ where: { id }, ...WITH_CONTEXT });
	if (!shift) throw Errors.notFound('ບໍ່ພົບກະເຮັດວຽກ');
	return present(shift);
}

export async function createShift(input: ShiftCreateInput) {
	const company = await assertCompanyExists(input.companyId);
	const taken = await prisma.shift.findUnique({
		where: { companyId_code: { companyId: input.companyId, code: input.code } }
	});
	if (taken) throw Errors.conflict('SHIFT_CODE_TAKEN', 'ລະຫັດກະນີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');
	if (input.status === 'ACTIVE') assertParentActive(company.status, 'ບໍລິສັດ');

	const { workDays, ...data } = input;
	const days = normalizeWorkDays(workDays, input);

	const created = await prisma.$transaction(async (tx) => {
		const shift = await tx.shift.create({
			// crossesMidnight is DERIVED from the times — never trusted from the client.
			data: { ...data, crossesMidnight: shiftCrossesMidnight(input.startTime, input.endTime) }
		});
		await tx.shiftWorkDay.createMany({ data: days.map((d) => ({ ...d, shiftId: shift.id })) });
		await writeAuditEvent(tx, {
			action: AuditAction.SHIFT_CREATED,
			entityType: AuditEntity.SHIFT,
			entityId: shift.id,
			companyId: shift.companyId,
			metadata: safeLabel(shift)
		});
		return tx.shift.findUniqueOrThrow({ where: { id: shift.id }, ...WITH_CONTEXT });
	});
	return present(created);
}

export async function updateShift(id: number, input: ShiftUpdateInput) {
	const existing = await prisma.shift.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບກະເຮັດວຽກ');

	const { workDays, ...fields } = input;
	const merged = {
		startTime: fields.startTime ?? existing.startTime,
		endTime: fields.endTime ?? existing.endTime,
		breakMinutes: fields.breakMinutes ?? existing.breakMinutes,
		minimumWorkMinutes:
			fields.minimumWorkMinutes !== undefined
				? fields.minimumWorkMinutes
				: existing.minimumWorkMinutes
	};
	const issues = shiftTimeIssues(merged);
	if (issues.length > 0) throw Errors.badRequest('INVALID_SHIFT_TIME', issues[0]!.message);

	if (input.status === 'ACTIVE') {
		const company = await assertCompanyExists(existing.companyId);
		assertParentActive(company.status, 'ບໍລິສັດ');
	}
	const days = workDays ? normalizeWorkDays(workDays, merged) : null;

	const updated = await prisma.$transaction(async (tx) => {
		const after = await tx.shift.update({
			where: { id },
			data: { ...fields, crossesMidnight: shiftCrossesMidnight(merged.startTime, merged.endTime) }
		});
		if (days) {
			await tx.shiftWorkDay.deleteMany({ where: { shiftId: id } });
			await tx.shiftWorkDay.createMany({ data: days.map((d) => ({ ...d, shiftId: id })) });
		}
		const disabled = existing.status === 'ACTIVE' && after.status === 'INACTIVE';
		const changed = await auditUpdated(tx, {
			action: disabled ? AuditAction.SHIFT_DISABLED : AuditAction.SHIFT_UPDATED,
			entityType: AuditEntity.SHIFT,
			entityId: id,
			companyId: existing.companyId,
			before: existing,
			after,
			fields: Object.keys(fields),
			metadata: safeLabel(existing)
		});
		if (days && !changed) {
			// only the weekly work-day pattern changed
			await writeAuditEvent(tx, {
				action: AuditAction.SHIFT_UPDATED,
				entityType: AuditEntity.SHIFT,
				entityId: id,
				companyId: existing.companyId,
				changes: { workDays: { changed: true } },
				metadata: safeLabel(existing)
			});
		}
		return tx.shift.findUniqueOrThrow({ where: { id }, ...WITH_CONTEXT });
	});
	return present(updated);
}

export function listShiftLookup(companyId: number, status?: 'ACTIVE' | 'INACTIVE') {
	return prisma.shift.findMany({
		where: { companyId, ...(status ? { status } : { status: 'ACTIVE' }) },
		select: {
			id: true,
			code: true,
			nameLao: true,
			nameEnglish: true,
			shiftType: true,
			startTime: true,
			endTime: true,
			crossesMidnight: true,
			status: true
		},
		orderBy: { nameLao: 'asc' }
	});
}
