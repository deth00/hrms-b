import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { addDays, dayOfWeekOf, formatDateOnly, todayInLaos } from '../lib/dates.js';
import { isInScope, scopeToWhere, type EmployeeScope } from '../lib/employeeScope.js';
import type {
	ScheduleAssignInput,
	ScheduleListQuery,
	ScheduleUpdateInput
} from '../validation/schedule.schema.js';
import { AuditAction, AuditEntity, auditUpdated, writeAuditEvent } from './audit.service.js';

/**
 * Employee work-schedule assignments (Phase 4).
 *
 * Periods are CLOSED date ranges [effectiveFrom, effectiveTo] (effectiveTo null = open-ended), so
 * "2026-01-01 -> 2026-06-30" followed by "2026-07-01 -> open" is valid and any shared day is an
 * overlap. The assignment table is the single source of truth — nothing is denormalized onto
 * Employee. Nothing here touches attendance (there is none yet); a future Attendance phase will
 * resolve the schedule effective on each date via `resolveSchedule`.
 */

const SCHEDULABLE_STATUSES = ['ACTIVE', 'PROBATION'];

const WORKDAY_SELECT = {
	dayOfWeek: true,
	isWorkingDay: true,
	startTimeOverride: true,
	endTimeOverride: true,
	breakMinutesOverride: true
} as const;

const SHIFT_SUMMARY = {
	select: {
		id: true,
		companyId: true,
		code: true,
		nameLao: true,
		nameEnglish: true,
		shiftType: true,
		startTime: true,
		endTime: true,
		crossesMidnight: true,
		breakMinutes: true,
		lateGraceMinutes: true,
		earlyCheckInMinutes: true,
		earlyLeaveGraceMinutes: true,
		status: true,
		workDays: { select: WORKDAY_SELECT }
	}
} as const;

const PERSON_SELECT = {
	id: true,
	employeeCode: true,
	firstNameLao: true,
	lastNameLao: true,
	firstNameEnglish: true,
	lastNameEnglish: true
} as const;

export type ScheduleState = 'CURRENT' | 'FUTURE' | 'ENDED';

function stateOf(a: { effectiveFrom: Date; effectiveTo: Date | null }, today: Date): ScheduleState {
	if (a.effectiveFrom > today) return 'FUTURE';
	if (a.effectiveTo && a.effectiveTo < today) return 'ENDED';
	return 'CURRENT';
}

/** The shift summary without its weekly pattern (the resolved day is returned separately). */
function withoutWorkDays<T extends { workDays: unknown }>(shift: T): Omit<T, 'workDays'> {
	return Object.fromEntries(Object.entries(shift).filter(([key]) => key !== 'workDays')) as Omit<
		T,
		'workDays'
	>;
}

function overlaps(aFrom: Date, aTo: Date | null, bFrom: Date, bTo: Date | null): boolean {
	return (aTo === null || aTo >= bFrom) && (bTo === null || bTo >= aFrom);
}

function assertInScope(scope: EmployeeScope, employeeId: number): void {
	if (!isInScope(scope, employeeId)) throw Errors.forbidden();
}

async function loadEmployee(employeeId: number) {
	const employee = await prisma.employee.findUnique({
		where: { id: employeeId },
		select: { ...PERSON_SELECT, companyId: true, employmentStatus: true }
	});
	if (!employee) throw Errors.notFound('ບໍ່ພົບພະນັກງານ');
	return employee;
}

// ---------- list (Employees tab) ----------

/** Employees (within the caller's data scope) with the schedule in force on `date` and the next one. */
export async function listSchedules(query: ScheduleListQuery, scope: EmployeeScope) {
	const date = query.date ?? todayInLaos();
	const covering = {
		effectiveFrom: { lte: date },
		OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }]
	} satisfies Prisma.EmployeeScheduleAssignmentWhereInput;

	const search = query.search;
	const where: Prisma.EmployeeWhereInput = {
		AND: [
			scopeToWhere(scope),
			query.includeEnded === 'true'
				? {}
				: { employmentStatus: { notIn: ['RESIGNED', 'TERMINATED'] } },
			query.employeeId ? { id: query.employeeId } : {},
			query.companyId ? { companyId: query.companyId } : {},
			query.departmentId ? { departmentId: query.departmentId } : {},
			query.shiftId
				? { scheduleAssignments: { some: { shiftId: query.shiftId, ...covering } } }
				: {},
			search
				? {
						OR: [
							{ employeeCode: { contains: search } },
							{ firstNameLao: { contains: search } },
							{ lastNameLao: { contains: search } },
							{ firstNameEnglish: { contains: search } },
							{ lastNameEnglish: { contains: search } }
						]
					}
				: {}
		]
	};

	const [rows, total] = await Promise.all([
		prisma.employee.findMany({
			where,
			select: {
				...PERSON_SELECT,
				companyId: true,
				employmentStatus: true,
				department: { select: { id: true, code: true, nameLao: true } },
				position: { select: { id: true, code: true, nameLao: true } },
				// only the periods still relevant on/after `date`: the current one and later ones
				scheduleAssignments: {
					where: { OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }] },
					orderBy: { effectiveFrom: 'asc' },
					take: 3,
					include: { shift: SHIFT_SUMMARY }
				}
			},
			orderBy: { employeeCode: 'asc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.employee.count({ where })
	]);

	const items = rows.map(({ scheduleAssignments, ...employee }) => {
		const current = scheduleAssignments.find((a) => a.effectiveFrom <= date) ?? null;
		const upcoming = scheduleAssignments.find((a) => a.effectiveFrom > date) ?? null;
		return {
			employee,
			date,
			current,
			upcoming,
			currentCompanyMismatch: current ? current.shift.companyId !== employee.companyId : false
		};
	});

	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

// ---------- history ----------

export async function listEmployeeSchedules(
	employeeId: number,
	page: number,
	pageSize: number,
	scope: EmployeeScope
) {
	assertInScope(scope, employeeId);
	const employee = await loadEmployee(employeeId);
	const today = todayInLaos();

	const where = { employeeId };
	const [rows, total] = await Promise.all([
		prisma.employeeScheduleAssignment.findMany({
			where,
			include: { shift: SHIFT_SUMMARY, createdBy: { select: { id: true, displayName: true } } },
			orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
			skip: (page - 1) * pageSize,
			take: pageSize
		}),
		prisma.employeeScheduleAssignment.count({ where })
	]);

	return {
		items: rows.map((a) => ({
			...a,
			state: stateOf(a, today),
			companyMismatch: a.shift.companyId !== employee.companyId
		})),
		page,
		pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / pageSize))
	};
}

// ---------- assign ----------

export async function assignSchedule(
	employeeId: number,
	input: ScheduleAssignInput,
	actor: { userId: number },
	scope: EmployeeScope
) {
	assertInScope(scope, employeeId);
	const employee = await loadEmployee(employeeId);

	if (!SCHEDULABLE_STATUSES.includes(employee.employmentStatus)) {
		throw Errors.badRequest(
			'EMPLOYEE_NOT_SCHEDULABLE',
			'ກຳນົດກະໃຫ້ໄດ້ສະເພາະພະນັກງານທີ່ມີສະຖານະເຮັດວຽກ ຫຼື ທົດລອງງານ'
		);
	}

	const shift = await prisma.shift.findUnique({ where: { id: input.shiftId } });
	if (!shift) throw Errors.badRequest('INVALID_SHIFT', 'ບໍ່ພົບກະເຮັດວຽກ');
	if (shift.companyId !== employee.companyId) {
		throw Errors.badRequest(
			'SHIFT_COMPANY_MISMATCH',
			'ກະທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ບໍລິສັດຂອງພະນັກງານ'
		);
	}
	if (shift.status !== 'ACTIVE') {
		throw Errors.badRequest('INACTIVE_SHIFT', 'ບໍ່ສາມາດກຳນົດກະທີ່ປິດການນຳໃຊ້ໄດ້');
	}

	const from = input.effectiveFrom;
	const to = input.effectiveTo ?? null;

	const created = await prisma.$transaction(async (tx) => {
		const all = await tx.employeeScheduleAssignment.findMany({
			where: { employeeId },
			orderBy: { effectiveFrom: 'asc' }
		});

		// Replacing the open-ended schedule: close it the day before the new one starts, so
		// "OFFICE now, FLEX from next month" needs no manual clean-up. Only done for an
		// open-ended NEW period that starts after the open one began; anything else that
		// collides is an overlap the caller must resolve explicitly.
		const open = all.find((a) => a.effectiveTo === null);
		const closing = to === null && open && open.effectiveFrom < from ? open : null;
		const closeAt = closing ? addDays(from, -1) : null;

		for (const a of all) {
			const aTo = closing && a.id === closing.id ? closeAt : a.effectiveTo;
			if (overlaps(from, to, a.effectiveFrom, aTo)) {
				throw Errors.badRequest(
					'SCHEDULE_OVERLAP',
					`ຊ່ວງເວລານີ້ຊ້ອນກັບການກຳນົດກະເດີມ (${formatDateOnly(a.effectiveFrom)} → ${
						aTo ? formatDateOnly(aTo) : 'ບໍ່ກຳນົດ'
					})`
				);
			}
		}

		if (closing) {
			await tx.employeeScheduleAssignment.update({
				where: { id: closing.id },
				data: { effectiveTo: closeAt }
			});
		}
		const row = await tx.employeeScheduleAssignment.create({
			data: {
				employeeId,
				shiftId: shift.id,
				effectiveFrom: from,
				effectiveTo: to,
				reason: input.reason ?? null,
				createdByUserId: actor.userId
			},
			include: { shift: SHIFT_SUMMARY }
		});
		await writeAuditEvent(tx, {
			action: AuditAction.SCHEDULE_ASSIGNED,
			entityType: AuditEntity.SCHEDULE_ASSIGNMENT,
			entityId: row.id,
			companyId: employee.companyId,
			employeeId,
			actorUserId: actor.userId,
			metadata: {
				shiftId: shift.id,
				shiftCode: shift.code,
				effectiveFrom: formatDateOnly(from),
				effectiveTo: to ? formatDateOnly(to) : null,
				closedPreviousAssignmentId: closing?.id ?? null
			}
		});
		return row;
	});

	return { ...created, state: stateOf(created, todayInLaos()) };
}

/** Safe correction: change the end of a period and/or the reason — re-validating overlap. */
export async function updateAssignment(
	assignmentId: number,
	input: ScheduleUpdateInput,
	scope: EmployeeScope
) {
	const existing = await prisma.employeeScheduleAssignment.findUnique({
		where: { id: assignmentId }
	});
	if (!existing) throw Errors.notFound('ບໍ່ພົບການກຳນົດກະ');
	assertInScope(scope, existing.employeeId);

	const to = input.effectiveTo !== undefined ? input.effectiveTo : existing.effectiveTo;
	if (to && to < existing.effectiveFrom) {
		throw Errors.badRequest('INVALID_EFFECTIVE_TO', 'ວັນສິ້ນສຸດຕ້ອງບໍ່ກ່ອນວັນເລີ່ມ');
	}

	const others = await prisma.employeeScheduleAssignment.findMany({
		where: { employeeId: existing.employeeId, id: { not: assignmentId } }
	});
	const clash = others.find((o) =>
		overlaps(existing.effectiveFrom, to, o.effectiveFrom, o.effectiveTo)
	);
	if (clash) {
		throw Errors.badRequest('SCHEDULE_OVERLAP', 'ຊ່ວງເວລານີ້ຈະຊ້ອນກັບການກຳນົດກະອື່ນ');
	}

	const updated = await prisma.$transaction(async (tx) => {
		const row = await tx.employeeScheduleAssignment.update({
			where: { id: assignmentId },
			data: {
				...(input.effectiveTo !== undefined ? { effectiveTo: input.effectiveTo } : {}),
				...(input.reason !== undefined ? { reason: input.reason } : {})
			},
			include: { shift: SHIFT_SUMMARY }
		});
		const emp = await tx.employee.findUnique({
			where: { id: existing.employeeId },
			select: { companyId: true }
		});
		await auditUpdated(tx, {
			action: AuditAction.SCHEDULE_UPDATED,
			entityType: AuditEntity.SCHEDULE_ASSIGNMENT,
			entityId: assignmentId,
			companyId: emp?.companyId,
			employeeId: existing.employeeId,
			before: existing,
			after: row,
			fields: Object.keys(input).filter((k) => k === 'effectiveTo' || k === 'reason'),
			metadata: { shiftId: existing.shiftId }
		});
		return row;
	});
	return { ...updated, state: stateOf(updated, todayInLaos()) };
}

// ---------- resolution ----------

/**
 * Expected schedule CONTEXT for one employee on one calendar date. It never decides attendance
 * status: `isWorkingDay` is the weekly pattern only, and `isHoliday` is reported separately so the
 * (future) attendance logic can apply its own policy.
 */
export async function resolveSchedule(
	employeeId: number,
	date: Date | undefined,
	scope: EmployeeScope
) {
	assertInScope(scope, employeeId);
	return resolveScheduleContext(employeeId, date);
}

/**
 * The resolver itself, with NO data-scope check — callers (the scoped endpoint above and the
 * attendance service, which has already established who the caller is) own authorization.
 */
export async function resolveScheduleContext(employeeId: number, date: Date | undefined) {
	const employee = await loadEmployee(employeeId);
	const day = date ?? todayInLaos();
	const dayOfWeek = dayOfWeekOf(day);

	const assignment = await prisma.employeeScheduleAssignment.findFirst({
		where: {
			employeeId,
			effectiveFrom: { lte: day },
			OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }]
		},
		include: { shift: SHIFT_SUMMARY }
	});

	const holidayCompanyId = assignment?.shift.companyId ?? employee.companyId;
	const holiday = await prisma.holiday.findFirst({
		where: { companyId: holidayCompanyId, holidayDate: day, status: 'ACTIVE' },
		select: { id: true, nameLao: true, nameEnglish: true, type: true, isPaid: true }
	});

	const shift = assignment?.shift ?? null;
	const workDay = shift?.workDays.find((w) => w.dayOfWeek === dayOfWeek) ?? null;
	const isWorkingDay = workDay?.isWorkingDay ?? false;

	const expected =
		shift && workDay?.isWorkingDay
			? {
					startTime: workDay.startTimeOverride ?? shift.startTime,
					endTime: workDay.endTimeOverride ?? shift.endTime,
					breakMinutes: workDay.breakMinutesOverride ?? shift.breakMinutes,
					crossesMidnight: shift.crossesMidnight,
					/** the calendar date the working period ends on (next day for overnight shifts) */
					endsOnDate: shift.crossesMidnight ? addDays(day, 1) : day
				}
			: null;

	const shiftSummary = shift ? withoutWorkDays(shift) : null;

	return {
		employee: {
			id: employee.id,
			employeeCode: employee.employeeCode,
			firstNameLao: employee.firstNameLao,
			lastNameLao: employee.lastNameLao
		},
		date: day,
		dayOfWeek,
		hasSchedule: assignment !== null,
		companyMismatch: shift ? shift.companyId !== employee.companyId : false,
		assignment: assignment
			? {
					id: assignment.id,
					effectiveFrom: assignment.effectiveFrom,
					effectiveTo: assignment.effectiveTo,
					reason: assignment.reason
				}
			: null,
		shift: shiftSummary,
		workDay,
		isWorkingDay,
		isHoliday: holiday !== null,
		holiday,
		expected
	};
}
