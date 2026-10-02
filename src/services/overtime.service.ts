import { Prisma } from '@prisma/client';
import type { OvertimeType } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError, Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { formatDateOnly, todayInLaos } from '../lib/dates.js';
import { laosInstant, scheduledEndInstant } from '../lib/attendanceTime.js';
import { isInScope, scopeToWhere, type EmployeeScope } from '../lib/employeeScope.js';
import {
	calculateOvertime,
	deriveOvertimeType,
	intervalsOverlap,
	minutesBetween,
	MAX_REQUEST_MS,
	type Interval
} from '../lib/overtime.js';
import { resolveScheduleContext } from './schedule.service.js';
import { lockEmployee } from './leaveBalance.service.js';
import {
	approvalSummaries,
	cancelApprovalInstance,
	createApprovalInstance,
	isCurrentCandidate,
	withApproval
} from './approvalInstance.service.js';
import { getOvertimePolicy, type OvertimePolicyValues } from './overtimePolicy.service.js';
import {
	presentOvertimeFigures,
	recalculateOvertimeForEmployeeDate
} from './overtimeCalculation.service.js';
import type {
	OvertimeCreateInput,
	OvertimeListQuery,
	OvertimePreviewInput,
	SelfOvertimeListQuery
} from '../validation/overtime.schema.js';

/**
 * OVERTIME REQUESTS (Phase 8): request → one review step → approved window.
 * PENDING → APPROVED | REJECTED, and the requester may cancel while PENDING. No multi-step
 * workflow, no approved-OT cancellation, and NO money: this only decides whether OT was approved and
 * (via overtimeCalculation.service) how many approved minutes were actually worked.
 *
 * The OT TYPE, planned minutes and the schedule snapshot are derived here from the schedule
 * resolver + the requested instants — the client only supplies the work date, the window and a reason.
 *
 * Concurrency: creation and approval for one employee run after `SELECT … FOR UPDATE` on the
 * employee row (shared with Leave), so overlap / leave-conflict checks cannot race; the unique
 * `activeKey` (employee:date:type) is a second, database-level guard.
 */

const ELIGIBLE_STATUSES = ['ACTIVE', 'PROBATION'];
const ACTIVE = ['PENDING', 'APPROVED'] as const;

const EMPLOYEE_SELECT = {
	id: true,
	employeeCode: true,
	firstNameLao: true,
	lastNameLao: true,
	companyId: true,
	employmentStatus: true,
	startDate: true,
	endDate: true,
	userId: true
} satisfies Prisma.EmployeeSelect;
type OtEmployee = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_SELECT }>;
type Db = Prisma.TransactionClient | typeof prisma;

async function loadSelf(userId: number): Promise<OtEmployee> {
	const employee = await prisma.employee.findUnique({ where: { userId }, select: EMPLOYEE_SELECT });
	if (!employee) {
		throw Errors.forbiddenWith('NO_LINKED_EMPLOYEE', 'ບັນຊີນີ້ຍັງບໍ່ໄດ້ເຊື່ອມກັບພະນັກງານ');
	}
	return employee;
}

const activeKeyOf = (employeeId: number, workDate: Date, type: OvertimeType) =>
	`${employeeId}:${formatDateOnly(workDate)}:${type}`;

// ============================================================================================
// schedule context + evaluation (shared by preview / create / approve)
// ============================================================================================

async function resolveContext(employeeId: number, workDate: Date) {
	const ctx = await resolveScheduleContext(employeeId, workDate);
	const usable = ctx.hasSchedule && !!ctx.shift && !ctx.companyMismatch;
	const regular: Interval | null =
		usable && ctx.isWorkingDay && !ctx.isHoliday && ctx.expected
			? {
					start: laosInstant(workDate, ctx.expected.startTime),
					end: scheduledEndInstant(workDate, ctx.expected.endTime, ctx.expected.crossesMidnight)
				}
			: null;
	return { ctx, usable, regular };
}

async function leaveConflictOn(employeeId: number, workDate: Date, db: Db) {
	const day = await db.leaveRequestDay.findFirst({
		where: { employeeId, leaveDate: workDate, leaveRequest: { status: { in: [...ACTIVE] } } },
		select: { leaveRequest: { select: { status: true } } }
	});
	return (day?.leaveRequest.status as 'PENDING' | 'APPROVED' | undefined) ?? null;
}

function policyAllows(policy: OvertimePolicyValues, type: OvertimeType): boolean {
	switch (type) {
		case 'BEFORE_SHIFT':
			return policy.allowBeforeShift;
		case 'AFTER_SHIFT':
			return policy.allowAfterShift;
		case 'OFF_DAY':
			return policy.allowOffDay;
		case 'HOLIDAY':
			return policy.allowHoliday;
	}
}

const leaveBlocker = (kind: 'APPROVED' | 'PENDING') =>
	kind === 'APPROVED'
		? Errors.badRequest(
				'APPROVED_LEAVE_DAY',
				'ວັນທີ່ເລືອກເປັນມື້ລາທີ່ອະນຸມັດແລ້ວ ບໍ່ສາມາດຂໍ OT ໄດ້'
			)
		: Errors.conflict('PENDING_LEAVE_CONFLICT', 'ມີຄຳຂໍລາທີ່ຍັງລໍຖ້າພິຈາລະນາໃນວັນທີ່ເລືອກ');

interface Evaluation {
	workDate: Date;
	window: Interval;
	plannedMinutes: number | null;
	policy: OvertimePolicyValues | null;
	ctx: Awaited<ReturnType<typeof resolveContext>>['ctx'] | null;
	regular: Interval | null;
	type: OvertimeType | null;
	leaveConflict: 'APPROVED' | 'PENDING' | null;
	overtimeConflicts: {
		id: number;
		type: OvertimeType;
		requestedStartAt: Date;
		requestedEndAt: Date;
		status: string;
	}[];
	blockers: AppError[];
}

async function evaluate(
	employee: OtEmployee,
	input: { workDate: Date; requestedStartAt: Date; requestedEndAt: Date },
	now: Date,
	db: Db,
	options: { excludeRequestId?: number } = {}
): Promise<Evaluation> {
	const window: Interval = { start: input.requestedStartAt, end: input.requestedEndAt };
	const ev: Evaluation = {
		workDate: input.workDate,
		window,
		plannedMinutes: null,
		policy: null,
		ctx: null,
		regular: null,
		type: null,
		leaveConflict: null,
		overtimeConflicts: [],
		blockers: []
	};
	const block = (e: AppError) => void ev.blockers.push(e);

	if (!ELIGIBLE_STATUSES.includes(employee.employmentStatus)) {
		block(
			Errors.forbiddenWith('EMPLOYEE_NOT_ACTIVE', 'ສະຖານະການຈ້າງງານປັດຈຸບັນບໍ່ອະນຸຍາດໃຫ້ຂໍ OT')
		);
		return ev;
	}
	const spanMs = window.end.getTime() - window.start.getTime();
	if (spanMs <= 0) {
		block(Errors.badRequest('INVALID_TIME_RANGE', 'ເວລາສິ້ນສຸດຕ້ອງຫຼັງເວລາເລີ່ມ'));
		return ev;
	}
	if (spanMs > MAX_REQUEST_MS) {
		block(Errors.badRequest('OT_TOO_LONG', 'ຂໍ OT ໄດ້ບໍ່ເກີນ 24 ຊົ່ວໂມງ'));
		return ev;
	}
	ev.plannedMinutes = minutesBetween(window.start, window.end);

	// Laos calendar "today" from the server clock — never the browser's date.
	if (
		input.workDate.getTime() < todayInLaos(now).getTime() ||
		window.end.getTime() <= now.getTime()
	) {
		block(Errors.badRequest('OT_DATE_IN_PAST', 'ບໍ່ສາມາດຂໍ OT ຍ້ອນຫຼັງໄດ້'));
	}
	if (
		input.workDate.getTime() < employee.startDate.getTime() ||
		(employee.endDate && input.workDate.getTime() > employee.endDate.getTime())
	) {
		block(
			Errors.badRequest('OUTSIDE_EMPLOYMENT', 'ວັນທີ່ເລືອກຢູ່ນອກໄລຍະເວລາການຈ້າງງານຂອງພະນັກງານ')
		);
		return ev;
	}

	const { ctx, usable, regular } = await resolveContext(employee.id, input.workDate);
	ev.ctx = ctx;
	ev.regular = regular;
	if (!usable) {
		block(Errors.badRequest('NO_ACTIVE_SCHEDULE', 'ວັນທີ່ເລືອກຍັງບໍ່ໄດ້ຮັບການກຳນົດກະເຮັດວຽກ'));
		return ev;
	}

	ev.leaveConflict = await leaveConflictOn(employee.id, input.workDate, db);
	if (ev.leaveConflict) block(leaveBlocker(ev.leaveConflict));

	const derived = deriveOvertimeType({
		workDate: input.workDate,
		isWorkingDay: ctx.isWorkingDay,
		isHoliday: ctx.isHoliday,
		regular,
		window
	});
	if (!derived.ok) {
		block(Errors.badRequest(derived.code, derived.message));
		return ev;
	}
	ev.type = derived.type;

	const policy = await getOvertimePolicy(employee.companyId, db);
	ev.policy = policy;
	if (!policyAllows(policy, derived.type)) {
		block(
			Errors.badRequest('OT_TYPE_NOT_ALLOWED', 'ບໍລິສັດບໍ່ອະນຸຍາດ OT ປະເພດນີ້', {
				type: derived.type
			})
		);
	}
	if (ev.plannedMinutes < policy.minimumRequestMinutes) {
		block(
			Errors.badRequest('OT_TOO_SHORT', `ຂໍ OT ຢ່າງໜ້ອຍ ${policy.minimumRequestMinutes} ນາທີ`, {
				minimumRequestMinutes: policy.minimumRequestMinutes,
				plannedMinutes: ev.plannedMinutes
			})
		);
	}
	if (ev.plannedMinutes > policy.maximumRequestMinutesPerDay) {
		block(
			Errors.badRequest(
				'OT_TOO_LONG',
				`ຂໍ OT ໄດ້ສູງສຸດ ${policy.maximumRequestMinutesPerDay} ນາທີຕໍ່ຄັ້ງ`,
				{
					maximumRequestMinutesPerDay: policy.maximumRequestMinutesPerDay,
					plannedMinutes: ev.plannedMinutes
				}
			)
		);
	}

	// overlap with the employee's other ACTIVE OT (any window that touches this one, or the same
	// type on the same work date)
	const others = await db.overtimeRequest.findMany({
		where: {
			employeeId: employee.id,
			status: { in: [...ACTIVE] },
			...(options.excludeRequestId ? { id: { not: options.excludeRequestId } } : {}),
			OR: [
				{ requestedStartAt: { lt: window.end }, requestedEndAt: { gt: window.start } },
				{ workDate: input.workDate, type: derived.type }
			]
		},
		select: { id: true, type: true, status: true, requestedStartAt: true, requestedEndAt: true },
		orderBy: { requestedStartAt: 'asc' }
	});
	ev.overtimeConflicts = others.filter(
		(o) =>
			intervalsOverlap(window, { start: o.requestedStartAt, end: o.requestedEndAt }) ||
			o.type === derived.type
	);
	if (ev.overtimeConflicts.length > 0) {
		block(
			Errors.conflict('OVERTIME_OVERLAP', 'ມີຄຳຂໍ OT ທີ່ທັບຊ້ອນກັບເວລາທີ່ເລືອກ', {
				conflicts: ev.overtimeConflicts.map((c) => ({
					id: c.id,
					type: c.type,
					requestedStartAt: c.requestedStartAt,
					requestedEndAt: c.requestedEndAt
				}))
			})
		);
	}
	return ev;
}

async function existingAttendance(employeeId: number, workDate: Date) {
	const record = await prisma.attendanceRecord.findUnique({
		where: { employeeId_workDate: { employeeId, workDate } },
		select: {
			id: true,
			firstCheckInAt: true,
			lastCheckOutAt: true,
			effectiveCheckInAt: true,
			effectiveCheckOutAt: true,
			isCorrected: true
		}
	});
	return record
		? {
				id: record.id,
				checkInAt: record.effectiveCheckInAt ?? record.firstCheckInAt,
				checkOutAt: record.effectiveCheckOutAt ?? record.lastCheckOutAt,
				rawCheckInAt: record.firstCheckInAt,
				rawCheckOutAt: record.lastCheckOutAt,
				isCorrected: record.isCorrected
			}
		: null;
}

// ============================================================================================
// presentation
// ============================================================================================

const REQUEST_INCLUDE = {
	employee: {
		select: {
			id: true,
			employeeCode: true,
			firstNameLao: true,
			lastNameLao: true,
			firstNameEnglish: true,
			lastNameEnglish: true,
			companyId: true,
			userId: true,
			department: { select: { id: true, code: true, nameLao: true } },
			position: { select: { id: true, code: true, nameLao: true } }
		}
	},
	requestedBy: { select: { id: true, displayName: true } },
	reviewedBy: { select: { id: true, displayName: true } }
} satisfies Prisma.OvertimeRequestInclude;
type RequestRow = Prisma.OvertimeRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

function presentRequest(r: RequestRow, now: Date) {
	const { userId: _userId, ...employee } = r.employee;
	void _userId;
	const figures = presentOvertimeFigures(r, now);
	return {
		id: r.id,
		employee,
		workDate: r.workDate,
		type: r.type,
		requestedStartAt: r.requestedStartAt,
		requestedEndAt: r.requestedEndAt,
		plannedMinutes: r.plannedMinutes,
		reason: r.reason,
		status: r.status,
		requestedBy: r.requestedBy,
		reviewedBy: r.reviewedBy,
		reviewedAt: r.reviewedAt,
		reviewNote: r.reviewNote,
		schedule: {
			shiftId: r.shiftId,
			regularStartAt: r.regularScheduledStartAt,
			regularEndAt: r.regularScheduledEndAt,
			isWorkingDay: r.isWorkingDay,
			isHoliday: r.isHoliday,
			holidayId: r.holidayId
		},
		actualMinutes: figures.actualMinutes,
		eligibleMinutes: figures.eligibleMinutes,
		calculationStatus: figures.calculationStatus,
		calculatedAt: r.calculatedAt,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt
	};
}

// ============================================================================================
// self service
// ============================================================================================

export async function previewMyOvertime(userId: number, input: OvertimePreviewInput) {
	const employee = await loadSelf(userId);
	const now = serverNow();
	const ev = await evaluate(employee, input, now, prisma);
	const attendance = await existingAttendance(employee.id, input.workDate);
	const ctx = ev.ctx;
	return {
		workDate: input.workDate,
		requestedStartAt: input.requestedStartAt,
		requestedEndAt: input.requestedEndAt,
		schedule: ctx
			? {
					hasSchedule: ctx.hasSchedule,
					dayOfWeek: ctx.dayOfWeek,
					isWorkingDay: ctx.isWorkingDay,
					isHoliday: ctx.isHoliday,
					holiday: ctx.holiday,
					shift: ctx.shift
						? { id: ctx.shift.id, code: ctx.shift.code, nameLao: ctx.shift.nameLao }
						: null,
					regularStartAt: ev.regular?.start ?? null,
					regularEndAt: ev.regular?.end ?? null
				}
			: null,
		derivedType: ev.type,
		plannedMinutes: ev.plannedMinutes,
		policy: ev.policy,
		existingAttendance: attendance,
		existingLeaveConflict: ev.leaveConflict,
		existingOvertimeConflicts: ev.overtimeConflicts,
		canSubmit: ev.blockers.length === 0,
		blockers: ev.blockers.map((b) => ({
			code: b.code,
			message: b.message,
			details: b.details ?? null
		}))
	};
}

export async function createMyOvertime(userId: number, input: OvertimeCreateInput) {
	const employee = await loadSelf(userId);
	const now = serverNow();

	// cheap rejection first (no lock), then the authoritative re-check under the employee lock
	const first = await evaluate(employee, input, now, prisma);
	if (first.blockers[0]) throw first.blockers[0];

	try {
		const id = await prisma.$transaction(async (tx) => {
			await lockEmployee(tx, employee.id);
			const ev = await evaluate(employee, input, now, tx);
			if (ev.blockers[0]) throw ev.blockers[0];
			const ctx = ev.ctx!;
			const created = await tx.overtimeRequest.create({
				data: {
					employeeId: employee.id,
					workDate: input.workDate,
					type: ev.type!,
					requestedStartAt: input.requestedStartAt,
					requestedEndAt: input.requestedEndAt,
					plannedMinutes: ev.plannedMinutes!,
					reason: input.reason,
					status: 'PENDING',
					requestedByUserId: userId,
					scheduleAssignmentId: ctx.assignment?.id ?? null,
					shiftId: ctx.shift?.id ?? null,
					regularScheduledStartAt: ev.regular?.start ?? null,
					regularScheduledEndAt: ev.regular?.end ?? null,
					isWorkingDay: ctx.isWorkingDay,
					isHoliday: ctx.isHoliday,
					holidayId: ctx.holiday?.id ?? null,
					activeKey: activeKeyOf(employee.id, input.workDate, ev.type!)
				}
			});
			await createApprovalInstance(tx, {
				targetType: 'OVERTIME',
				targetId: created.id,
				companyId: employee.companyId,
				employeeId: employee.id,
				requesterUserId: userId
			});
			return created.id;
		});
		return await getMyOvertime(userId, id);
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict('OVERTIME_OVERLAP', 'ມີຄຳຂໍ OT ທີ່ທັບຊ້ອນກັບເວລາທີ່ເລືອກ');
		}
		throw err;
	}
}

function pageOf(total: number, page: number, pageSize: number) {
	return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
const yearRange = (year: number) => ({
	gte: new Date(Date.UTC(year, 0, 1)),
	lte: new Date(Date.UTC(year, 11, 31))
});

export async function listMyOvertime(userId: number, query: SelfOvertimeListQuery) {
	const employee = await loadSelf(userId);
	const now = serverNow();
	const where: Prisma.OvertimeRequestWhereInput = {
		employeeId: employee.id,
		...(query.status ? { status: query.status } : {}),
		...(query.year ? { workDate: yearRange(query.year) } : {})
	};
	const [rows, total] = await Promise.all([
		prisma.overtimeRequest.findMany({
			where,
			include: REQUEST_INCLUDE,
			orderBy: [{ workDate: 'desc' }, { requestedStartAt: 'desc' }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.overtimeRequest.count({ where })
	]);
	return {
		items: await withApproval(
			'OVERTIME',
			rows.map((r) => presentRequest(r, now))
		),
		...pageOf(total, query.page, query.pageSize)
	};
}

export async function getMyOvertime(userId: number, id: number) {
	const employee = await loadSelf(userId);
	const row = await prisma.overtimeRequest.findFirst({
		where: { id, employeeId: employee.id },
		include: REQUEST_INCLUDE
	});
	if (!row) throw Errors.notFound('ບໍ່ພົບຄຳຂໍ OT');
	return {
		...presentRequest(row, serverNow()),
		approval: (await approvalSummaries('OVERTIME', [row.id])).get(row.id) ?? null
	};
}

export async function cancelMyOvertime(userId: number, id: number) {
	const employee = await loadSelf(userId);
	const row = await prisma.overtimeRequest.findFirst({ where: { id, employeeId: employee.id } });
	if (!row) throw Errors.notFound('ບໍ່ພົບຄຳຂໍ OT');
	if (row.status !== 'PENDING') {
		throw Errors.conflict(
			'OVERTIME_NOT_CANCELLABLE',
			row.status === 'APPROVED'
				? 'OT ທີ່ອະນຸມັດແລ້ວບໍ່ສາມາດຍົກເລີກໄດ້ (ຍັງບໍ່ຮອງຮັບ)'
				: 'ຄຳຂໍນີ້ບໍ່ສາມາດຍົກເລີກໄດ້'
		);
	}
	await prisma.$transaction(async (tx) => {
		const flipped = await tx.overtimeRequest.updateMany({
			where: { id, status: 'PENDING' },
			data: { status: 'CANCELLED', activeKey: null }
		});
		if (flipped.count === 0) {
			throw Errors.conflict('OVERTIME_NOT_CANCELLABLE', 'ຄຳຂໍນີ້ຖືກພິຈາລະນາແລ້ວ');
		}
		await cancelApprovalInstance(tx, 'OVERTIME', id);
	});
	return getMyOvertime(userId, id);
}

// ============================================================================================
// review
// ============================================================================================

export async function listOvertimeRequests(query: OvertimeListQuery, scope: EmployeeScope) {
	const now = serverNow();
	const employeeWhere: Prisma.EmployeeWhereInput = {
		AND: [
			scopeToWhere(scope),
			query.companyId ? { companyId: query.companyId } : {},
			query.departmentId ? { departmentId: query.departmentId } : {},
			query.search
				? {
						OR: [
							{ employeeCode: { contains: query.search } },
							{ firstNameLao: { contains: query.search } },
							{ lastNameLao: { contains: query.search } },
							{ firstNameEnglish: { contains: query.search } },
							{ lastNameEnglish: { contains: query.search } }
						]
					}
				: {}
		]
	};
	const dateRange: Prisma.DateTimeFilter = {
		...(query.year ? yearRange(query.year) : {}),
		...(query.from ? { gte: query.from } : {}),
		...(query.to ? { lte: query.to } : {})
	};
	const where: Prisma.OvertimeRequestWhereInput = {
		employee: employeeWhere,
		...(query.status ? { status: query.status } : {}),
		...(query.type ? { type: query.type } : {}),
		...(query.employeeId ? { employeeId: query.employeeId } : {}),
		...(Object.keys(dateRange).length ? { workDate: dateRange } : {})
	};
	const [rows, total] = await Promise.all([
		prisma.overtimeRequest.findMany({
			where,
			include: REQUEST_INCLUDE,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.overtimeRequest.count({ where })
	]);
	return {
		items: await withApproval(
			'OVERTIME',
			rows.map((r) => presentRequest(r, now))
		),
		...pageOf(total, query.page, query.pageSize)
	};
}

async function loadForReview(id: number, scope: EmployeeScope) {
	const row = await prisma.overtimeRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
	if (!row) throw Errors.notFound('ບໍ່ພົບຄຳຂໍ OT');
	if (!isInScope(scope, row.employeeId)) throw Errors.forbidden();
	return row;
}

function isOwn(row: RequestRow, viewerUserId: number) {
	return row.employee.userId === viewerUserId || row.requestedByUserId === viewerUserId;
}
function assertNotOwn(row: RequestRow, reviewerUserId: number): void {
	if (isOwn(row, reviewerUserId)) {
		throw Errors.forbiddenWith(
			'CANNOT_REVIEW_OWN_OVERTIME',
			'ທ່ານບໍ່ສາມາດພິຈາລະນາຄຳຂໍ OT ຂອງຕົນເອງໄດ້'
		);
	}
}

export async function getOvertimeRequest(id: number, scope: EmployeeScope, viewerUserId: number) {
	const row = await loadForReview(id, scope);
	const now = serverNow();
	const attendance = await existingAttendance(row.employeeId, row.workDate);
	const window = { start: row.requestedStartAt, end: row.requestedEndAt };

	const warnings = {
		leaveConflict: null as 'APPROVED' | 'PENDING' | null,
		typeNotAllowed: false,
		scheduleChanged: false,
		overlapsOther: false
	};
	if (row.status === 'PENDING') {
		warnings.leaveConflict = await leaveConflictOn(row.employeeId, row.workDate, prisma);
		const policy = await getOvertimePolicy(row.employee.companyId);
		warnings.typeNotAllowed = !policyAllows(policy, row.type);
		const { ctx, usable, regular } = await resolveContext(row.employeeId, row.workDate);
		const derived = usable
			? deriveOvertimeType({
					workDate: row.workDate,
					isWorkingDay: ctx.isWorkingDay,
					isHoliday: ctx.isHoliday,
					regular,
					window
				})
			: null;
		warnings.scheduleChanged = !derived || !derived.ok || derived.type !== row.type;
		const others = await prisma.overtimeRequest.count({
			where: {
				employeeId: row.employeeId,
				id: { not: row.id },
				status: { in: [...ACTIVE] },
				requestedStartAt: { lt: row.requestedEndAt },
				requestedEndAt: { gt: row.requestedStartAt }
			}
		});
		warnings.overlapsOther = others > 0;
	}

	// Potential actual OT from attendance that already exists — informational only; approval
	// still approves exactly the requested window.
	const potential = calculateOvertime({
		window,
		effective: attendance
			? { checkInAt: attendance.checkInAt, checkOutAt: attendance.checkOutAt }
			: null,
		now
	});
	const own = isOwn(row, viewerUserId);
	return {
		...presentRequest(row, now),
		existingAttendance: attendance,
		potential: row.status === 'PENDING' ? potential : null,
		warnings,
		isOwnRequest: own,
		// a reviewer can act only when they are a candidate of the CURRENT workflow step
		canReview:
			row.status === 'PENDING' &&
			!own &&
			(await isCurrentCandidate('OVERTIME', row.id, viewerUserId)),
		approval: (await approvalSummaries('OVERTIME', [row.id])).get(row.id) ?? null
	};
}

/**
 * Review pre-flight used by the controllers before they hand the action to the approval engine:
 * the request must be inside the reviewer's data scope and must not be the reviewer's own.
 */
export async function preflightOvertimeReview(
	id: number,
	scope: EmployeeScope,
	reviewerUserId: number
) {
	const row = await loadForReview(id, scope);
	assertNotOwn(row, reviewerUserId);
	return row;
}

/**
 * FINAL approval of an OT request — invoked by the approval engine inside its transaction when the
 * LAST workflow step is approved. Phase 8 validation stays here: schedule re-resolution, leave
 * conflict, policy, overlap, compare-and-set, then the OT recalculation. A throw rolls the whole
 * workflow action back.
 */
export async function finalizeOvertimeApproval(
	tx: Prisma.TransactionClient,
	id: number,
	reviewerUserId: number,
	reviewNote?: string
) {
	const now = serverNow();
	const pre = await tx.overtimeRequest.findUniqueOrThrow({
		where: { id },
		select: { employeeId: true, employee: { select: { companyId: true } } }
	});
	const employee = pre.employee;
	await lockEmployee(tx, pre.employeeId);
	const row = await tx.overtimeRequest.findUniqueOrThrow({ where: { id } });
	if (row.status !== 'PENDING') {
		throw Errors.conflict('OVERTIME_ALREADY_REVIEWED', 'ຄຳຂໍນີ້ຖືກພິຈາລະນາແລ້ວ');
	}
	const window = { start: row.requestedStartAt, end: row.requestedEndAt };

	// re-resolve the schedule: the day may have become a holiday / the shift may have changed
	const { ctx, usable, regular } = await resolveContext(row.employeeId, row.workDate);
	if (!usable) {
		throw Errors.badRequest('NO_ACTIVE_SCHEDULE', 'ວັນທີ່ເລືອກບໍ່ມີການກຳນົດກະເຮັດວຽກແລ້ວ');
	}
	const derived = deriveOvertimeType({
		workDate: row.workDate,
		isWorkingDay: ctx.isWorkingDay,
		isHoliday: ctx.isHoliday,
		regular,
		window
	});
	if (!derived.ok || derived.type !== row.type) {
		throw Errors.conflict(
			'OVERTIME_SCHEDULE_CHANGED',
			'ຕາຕະລາງເຮັດວຽກຂອງວັນນັ້ນປ່ຽນໄປແລ້ວ — ກະລຸນາໃຫ້ພະນັກງານຂໍໃໝ່',
			{
				requestedType: row.type,
				currentType: derived.ok ? derived.type : null
			}
		);
	}

	const leave = await leaveConflictOn(row.employeeId, row.workDate, tx);
	if (leave) throw leaveBlocker(leave);

	const policy = await getOvertimePolicy(employee.companyId, tx);
	if (!policyAllows(policy, row.type)) {
		throw Errors.badRequest('OT_TYPE_NOT_ALLOWED', 'ບໍລິສັດບໍ່ອະນຸຍາດ OT ປະເພດນີ້', {
			type: row.type
		});
	}

	const clash = await tx.overtimeRequest.count({
		where: {
			employeeId: row.employeeId,
			id: { not: id },
			status: { in: [...ACTIVE] },
			requestedStartAt: { lt: row.requestedEndAt },
			requestedEndAt: { gt: row.requestedStartAt }
		}
	});
	if (clash > 0) {
		throw Errors.conflict('OVERTIME_OVERLAP', 'ມີຄຳຂໍ OT ທີ່ທັບຊ້ອນກັບເວລານີ້');
	}

	const flipped = await tx.overtimeRequest.updateMany({
		where: { id, status: 'PENDING' },
		data: {
			status: 'APPROVED',
			reviewedByUserId: reviewerUserId,
			reviewedAt: now,
			reviewNote: reviewNote || null
		}
	});
	if (flipped.count === 0) {
		throw Errors.conflict('OVERTIME_ALREADY_REVIEWED', 'ຄຳຂໍນີ້ຖືກພິຈາລະນາແລ້ວ');
	}
	// attendance may already exist for that day — compute right away
	await recalculateOvertimeForEmployeeDate(row.employeeId, row.workDate, tx);
}

/** FINAL rejection of an OT request (any workflow step may reject) — frees its active key. */
export async function finalizeOvertimeRejection(
	tx: Prisma.TransactionClient,
	id: number,
	reviewerUserId: number,
	reviewNote: string
) {
	const flipped = await tx.overtimeRequest.updateMany({
		where: { id, status: 'PENDING' },
		data: {
			status: 'REJECTED',
			reviewedByUserId: reviewerUserId,
			reviewedAt: serverNow(),
			reviewNote,
			activeKey: null
		}
	});
	if (flipped.count === 0) {
		throw Errors.conflict('OVERTIME_ALREADY_REVIEWED', 'ຄຳຂໍນີ້ຖືກພິຈາລະນາແລ້ວ');
	}
}
