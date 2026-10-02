import { Prisma } from '@prisma/client';
import type { CorrectionStatus, CorrectionType } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors, type AppError } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { addDays, formatDateOnly, parseDateOnly, todayInLaos } from '../lib/dates.js';
import { scheduledEndInstant, scheduledStartInstant } from '../lib/attendanceTime.js';
import { isInScope, scopeToWhere, type EmployeeScope } from '../lib/employeeScope.js';
import type { ScheduleSnapshot } from '../lib/attendanceCalculation.js';
import { resolveScheduleContext } from './schedule.service.js';
import { findApprovedLeaveDay } from './leaveDay.service.js';
import {
	approvalSummaries,
	cancelApprovalInstance,
	createApprovalInstance,
	isCurrentCandidate,
	withApproval
} from './approvalInstance.service.js';
import { getPolicy } from './attendancePolicy.service.js';
import {
	previewCalculation,
	recalculateAttendanceRecord,
	snapshotOf
} from './attendanceCalculation.service.js';
import type {
	CorrectionCreateInput,
	CorrectionListQuery
} from '../validation/attendanceRules.schema.js';

/**
 * Attendance corrections (Phase 6).
 *
 * Immutable-punch guarantee: nothing here updates, deletes or inserts an AttendancePunch. An
 * APPROVED request produces an AttendanceCorrectionApplication (the effective-value overlay); the
 * record's cached effective/calculated fields are then recalculated from raw + latest overlay.
 * A correction for a day with no AttendanceRecord creates the record from the historical schedule
 * snapshot with raw check-in/out left NULL (no fake punch), marked isCorrected.
 */

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

const EMPLOYEE_SELECT = {
	id: true,
	employeeCode: true,
	firstNameLao: true,
	lastNameLao: true,
	firstNameEnglish: true,
	lastNameEnglish: true,
	employmentStatus: true,
	companyId: true,
	startDate: true,
	endDate: true,
	department: { select: { id: true, code: true, nameLao: true } },
	position: { select: { id: true, code: true, nameLao: true } }
} satisfies Prisma.EmployeeSelect;

type CorrEmployee = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_SELECT }>;

const REQUEST_INCLUDE = {
	employee: { select: EMPLOYEE_SELECT },
	record: {
		select: {
			id: true,
			firstCheckInAt: true,
			lastCheckOutAt: true,
			effectiveCheckInAt: true,
			effectiveCheckOutAt: true,
			scheduledStartTime: true,
			scheduledEndTime: true,
			scheduledCrossesMidnight: true
		}
	},
	requestedBy: { select: { id: true, displayName: true } },
	reviewedBy: { select: { id: true, displayName: true } }
} satisfies Prisma.AttendanceCorrectionRequestInclude;

type RequestRow = Prisma.AttendanceCorrectionRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

// ---------- context: what does this employee's work day look like? ----------

interface DayContext {
	record: Prisma.AttendanceRecordGetPayload<{
		include: { shift: { select: { id: true; code: true; nameLao: true } } };
	}> | null;
	snapshot: ScheduleSnapshot;
	shift: { id: number | null; code: string | null; nameLao: string | null };
	assignmentId: number | null;
	current: { checkInAt: Date | null; checkOutAt: Date | null };
}

/**
 * The schedule this correction is judged against: the record's own SNAPSHOT when it exists,
 * otherwise the schedule the Phase 4 resolver reports for that historical date. A day that is not a
 * scheduled working day (off-day / holiday) or has no schedule cannot be corrected.
 */
async function loadDayContext(employee: { id: number }, workDate: Date): Promise<DayContext> {
	// An approved full-day leave date is not a day to correct (existing correction history stays).
	const leave = await findApprovedLeaveDay(employee.id, workDate);
	if (leave) {
		throw Errors.badRequest(
			'APPROVED_LEAVE_DAY',
			'ວັນທີ່ເລືອກເປັນມື້ລາທີ່ອະນຸມັດແລ້ວ ບໍ່ສາມາດຂໍແກ້ໄຂໄດ້',
			{
				leave
			}
		);
	}
	const record = await prisma.attendanceRecord.findUnique({
		where: { employeeId_workDate: { employeeId: employee.id, workDate } },
		include: { shift: { select: { id: true, code: true, nameLao: true } } }
	});

	if (record) {
		return {
			record,
			snapshot: snapshotOf(record),
			shift: {
				id: record.shift?.id ?? null,
				code: record.shift?.code ?? null,
				nameLao: record.shift?.nameLao ?? null
			},
			assignmentId: record.scheduleAssignmentId,
			current: {
				checkInAt: record.effectiveCheckInAt ?? record.firstCheckInAt,
				checkOutAt: record.effectiveCheckOutAt ?? record.lastCheckOutAt
			}
		};
	}

	const ctx = await resolveScheduleContext(employee.id, workDate);
	if (!ctx.hasSchedule || !ctx.shift || ctx.companyMismatch) {
		throw Errors.badRequest('NO_ACTIVE_SCHEDULE', 'ວັນທີ່ເລືອກບໍ່ມີການກຳນົດກະເຮັດວຽກ');
	}
	if (!ctx.isWorkingDay || ctx.isHoliday || !ctx.expected) {
		throw Errors.badRequest(
			'NO_SCHEDULED_WORK',
			ctx.isHoliday
				? 'ວັນທີ່ເລືອກເປັນວັນພັກ ບໍ່ສາມາດຂໍແກ້ໄຂໄດ້'
				: 'ວັນທີ່ເລືອກບໍ່ແມ່ນມື້ເຮັດວຽກ ບໍ່ສາມາດຂໍແກ້ໄຂໄດ້'
		);
	}
	return {
		record: null,
		snapshot: {
			workDate,
			startTime: ctx.expected.startTime,
			endTime: ctx.expected.endTime,
			breakMinutes: ctx.expected.breakMinutes,
			crossesMidnight: ctx.expected.crossesMidnight,
			lateGraceMinutes: ctx.shift.lateGraceMinutes,
			earlyLeaveGraceMinutes: ctx.shift.earlyLeaveGraceMinutes
		},
		shift: { id: ctx.shift.id, code: ctx.shift.code, nameLao: ctx.shift.nameLao },
		assignmentId: ctx.assignment?.id ?? null,
		current: { checkInAt: null, checkOutAt: null }
	};
}

/**
 * Validates requested instants against the day: required fields per type, type/current-state
 * agreement, ordering, not in the future, and within ±12h of the snapshotted shift window (which
 * makes an overnight check-out on the next calendar day valid).
 */
function validateRequestedTimes(
	input: {
		type: CorrectionType;
		requestedCheckInAt?: Date | null;
		requestedCheckOutAt?: Date | null;
	},
	day: DayContext,
	now: Date
): { effectiveIn: Date | null; effectiveOut: Date | null } {
	const reqIn = input.requestedCheckInAt ?? null;
	const reqOut = input.requestedCheckOutAt ?? null;
	const bad = (code: string, message: string) => Errors.badRequest(code, message);

	switch (input.type) {
		case 'MISSING_CHECK_IN':
			if (!reqIn || reqOut)
				throw bad('INVALID_CORRECTION_FIELDS', 'ກະລຸນາລະບຸສະເພາະເວລາເຂົ້າວຽກທີ່ຕ້ອງການແກ້ໄຂ');
			if (day.current.checkInAt)
				throw bad('CORRECTION_TYPE_MISMATCH', 'ມີເວລາເຂົ້າວຽກແລ້ວ — ໃຫ້ເລືອກ "ແກ້ໄຂເວລາ"');
			break;
		case 'MISSING_CHECK_OUT':
			if (!reqOut || reqIn)
				throw bad('INVALID_CORRECTION_FIELDS', 'ກະລຸນາລະບຸສະເພາະເວລາອອກວຽກທີ່ຕ້ອງການແກ້ໄຂ');
			if (day.current.checkOutAt)
				throw bad('CORRECTION_TYPE_MISMATCH', 'ມີເວລາອອກວຽກແລ້ວ — ໃຫ້ເລືອກ "ແກ້ໄຂເວລາ"');
			break;
		case 'MISSING_BOTH':
			if (!reqIn || !reqOut)
				throw bad('INVALID_CORRECTION_FIELDS', 'ກະລຸນາລະບຸທັງເວລາເຂົ້າ ແລະ ເວລາອອກວຽກ');
			if (day.current.checkInAt || day.current.checkOutAt)
				throw bad('CORRECTION_TYPE_MISMATCH', 'ມີເວລາບັນທຶກແລ້ວ — ໃຫ້ເລືອກ "ແກ້ໄຂເວລາ"');
			break;
		case 'TIME_ADJUSTMENT':
			if (!reqIn && !reqOut) throw bad('INVALID_CORRECTION_FIELDS', 'ກະລຸນາລະບຸເວລາຢ່າງໜ້ອຍ 1 ຄ່າ');
			break;
	}

	const effectiveIn = reqIn ?? day.current.checkInAt;
	const effectiveOut = reqOut ?? day.current.checkOutAt;
	if (effectiveIn && effectiveOut && effectiveOut.getTime() <= effectiveIn.getTime()) {
		throw bad('INVALID_CORRECTION_TIMES', 'ເວລາອອກວຽກຕ້ອງຫຼັງເວລາເຂົ້າວຽກ');
	}

	const { workDate, startTime, endTime, crossesMidnight } = day.snapshot;
	if (startTime && endTime) {
		const lower = scheduledStartInstant(workDate, startTime).getTime() - TWELVE_HOURS;
		const upper = scheduledEndInstant(workDate, endTime, crossesMidnight).getTime() + TWELVE_HOURS;
		for (const t of [reqIn, reqOut]) {
			if (t && (t.getTime() < lower || t.getTime() > upper)) {
				throw bad('CORRECTION_TIME_OUT_OF_RANGE', 'ເວລາທີ່ຂໍແກ້ໄຂຢູ່ນອກຊ່ວງເວລາຂອງກະໃນວັນທີ່ເລືອກ');
			}
		}
	}
	for (const t of [reqIn, reqOut]) {
		if (t && t.getTime() > now.getTime())
			throw bad('CORRECTION_FUTURE_TIME', 'ບໍ່ສາມາດຂໍແກ້ໄຂເປັນເວລາໃນອະນາຄົດ');
	}
	return { effectiveIn, effectiveOut };
}

function assertEmploymentCovers(
	employee: { startDate: Date; endDate: Date | null },
	workDate: Date
): void {
	if (workDate < employee.startDate || (employee.endDate && workDate > employee.endDate)) {
		throw Errors.badRequest('OUTSIDE_EMPLOYMENT', 'ວັນທີ່ເລືອກຢູ່ນອກໄລຍະເວລາການຈ້າງງານຂອງພະນັກງານ');
	}
}

const pendingKeyOf = (employeeId: number, workDate: Date) =>
	`${employeeId}:${formatDateOnly(workDate)}`;

function parseWorkDate(value: string): Date {
	const date = parseDateOnly(value);
	if (!date) throw Errors.badRequest('INVALID_WORK_DATE', 'ວັນທີ່ບໍ່ຖືກຕ້ອງ');
	return date;
}

// ---------- self ----------

async function loadSelf(userId: number): Promise<CorrEmployee> {
	const employee = await prisma.employee.findUnique({ where: { userId }, select: EMPLOYEE_SELECT });
	if (!employee)
		throw Errors.forbiddenWith('NO_LINKED_EMPLOYEE', 'ບັນຊີນີ້ຍັງບໍ່ໄດ້ເຊື່ອມກັບພະນັກງານ');
	return employee;
}

function assertWindow(
	policy: Awaited<ReturnType<typeof getPolicy>>,
	workDate: Date,
	today: Date
): void {
	if (!policy.allowEmployeeCorrection) {
		throw Errors.forbiddenWith(
			'CORRECTION_NOT_ALLOWED',
			'ບໍລິສັດບໍ່ອະນຸຍາດໃຫ້ພະນັກງານຂໍແກ້ໄຂເວລາເອງ'
		);
	}
	if (workDate.getTime() > today.getTime()) {
		throw Errors.badRequest('CORRECTION_FUTURE_DATE', 'ບໍ່ສາມາດຂໍແກ້ໄຂວັນທີ່ໃນອະນາຄົດ');
	}
	if (workDate.getTime() < addDays(today, -policy.correctionRequestWindowDays).getTime()) {
		throw Errors.badRequest(
			'CORRECTION_WINDOW_EXPIRED',
			`ຂໍແກ້ໄຂໄດ້ຍ້ອນຫຼັງສູງສຸດ ${policy.correctionRequestWindowDays} ມື້`
		);
	}
}

/** Everything the "request correction" dialog needs for a chosen day (never accepts an employee id). */
export async function getSelfCorrectionContext(userId: number, workDateText: string) {
	const employee = await loadSelf(userId);
	const workDate = parseWorkDate(workDateText);
	const policy = await getPolicy(employee.companyId);
	const today = todayInLaos(serverNow());

	const pending = await prisma.attendanceCorrectionRequest.findFirst({
		where: { employeeId: employee.id, workDate, status: 'PENDING' },
		select: { id: true }
	});

	let eligible = true;
	let blocked: { code: string; message: string } | null = null;
	let day: DayContext | null = null;
	try {
		assertWindow(policy, workDate, today);
		assertEmploymentCovers(employee, workDate);
		day = await loadDayContext(employee, workDate);
		if (pending)
			throw Errors.conflict('CORRECTION_ALREADY_PENDING', 'ມີຄຳຂໍແກ້ໄຂທີ່ລໍຖ້າການພິຈາລະນາແລ້ວ');
	} catch (err) {
		const e = err as AppError;
		if (!e || typeof e.code !== 'string') throw err;
		eligible = false;
		blocked = { code: e.code, message: e.message };
	}

	return {
		workDate,
		eligible,
		blocked,
		pendingRequestId: pending?.id ?? null,
		policy: {
			allowEmployeeCorrection: policy.allowEmployeeCorrection,
			correctionRequestWindowDays: policy.correctionRequestWindowDays
		},
		schedule: day
			? {
					shift: day.shift,
					startTime: day.snapshot.startTime,
					endTime: day.snapshot.endTime,
					breakMinutes: day.snapshot.breakMinutes,
					crossesMidnight: day.snapshot.crossesMidnight
				}
			: null,
		recorded: day
			? {
					hasRecord: day.record !== null,
					rawCheckInAt: day.record?.firstCheckInAt ?? null,
					rawCheckOutAt: day.record?.lastCheckOutAt ?? null,
					effectiveCheckInAt: day.current.checkInAt,
					effectiveCheckOutAt: day.current.checkOutAt
				}
			: null
	};
}

export async function createCorrection(userId: number, input: CorrectionCreateInput) {
	const employee = await loadSelf(userId);
	const workDate = parseWorkDate(input.workDate);
	const policy = await getPolicy(employee.companyId);
	const now = serverNow();

	assertWindow(policy, workDate, todayInLaos(now));
	assertEmploymentCovers(employee, workDate);
	const day = await loadDayContext(employee, workDate);
	validateRequestedTimes(input, day, now);

	const key = pendingKeyOf(employee.id, workDate);
	const alreadyPending = await prisma.attendanceCorrectionRequest.findUnique({
		where: { pendingKey: key }
	});
	if (alreadyPending) {
		throw Errors.conflict(
			'CORRECTION_ALREADY_PENDING',
			'ມີຄຳຂໍແກ້ໄຂຂອງວັນທີ່ນີ້ທີ່ລໍຖ້າການພິຈາລະນາແລ້ວ'
		);
	}

	try {
		// request + workflow instance (steps and candidate snapshots) are created atomically: if any
		// step has no approver (APPROVER_NOT_FOUND) nothing is left behind
		const created = await prisma.$transaction(async (tx) => {
			const row = await tx.attendanceCorrectionRequest.create({
				data: {
					employeeId: employee.id,
					attendanceRecordId: day.record?.id ?? null,
					workDate,
					type: input.type,
					requestedCheckInAt: input.requestedCheckInAt ?? null,
					requestedCheckOutAt: input.requestedCheckOutAt ?? null,
					reason: input.reason,
					status: 'PENDING',
					pendingKey: key,
					requestedByUserId: userId
				},
				include: REQUEST_INCLUDE
			});
			await createApprovalInstance(tx, {
				targetType: 'ATTENDANCE_CORRECTION',
				targetId: row.id,
				companyId: employee.companyId,
				employeeId: employee.id,
				requesterUserId: userId
			});
			return row;
		});
		return {
			...created,
			approval:
				(await approvalSummaries('ATTENDANCE_CORRECTION', [created.id])).get(created.id) ?? null
		};
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict(
				'CORRECTION_ALREADY_PENDING',
				'ມີຄຳຂໍແກ້ໄຂຂອງວັນທີ່ນີ້ທີ່ລໍຖ້າການພິຈາລະນາແລ້ວ'
			);
		}
		throw err;
	}
}

export async function listMyCorrections(
	userId: number,
	page: number,
	pageSize: number,
	status?: CorrectionStatus
) {
	const employee = await loadSelf(userId);
	const where: Prisma.AttendanceCorrectionRequestWhereInput = {
		employeeId: employee.id,
		...(status ? { status } : {})
	};
	const [items, total] = await Promise.all([
		prisma.attendanceCorrectionRequest.findMany({
			where,
			include: REQUEST_INCLUDE,
			orderBy: { createdAt: 'desc' },
			skip: (page - 1) * pageSize,
			take: pageSize
		}),
		prisma.attendanceCorrectionRequest.count({ where })
	]);
	return {
		items: await withApproval('ATTENDANCE_CORRECTION', items),
		page,
		pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / pageSize))
	};
}

export async function getMyCorrection(userId: number, id: number) {
	const employee = await loadSelf(userId);
	const request = await prisma.attendanceCorrectionRequest.findFirst({
		where: { id, employeeId: employee.id },
		include: REQUEST_INCLUDE
	});
	if (!request) throw Errors.notFound('ບໍ່ພົບຄຳຂໍແກ້ໄຂ');
	return {
		...request,
		approval:
			(await approvalSummaries('ATTENDANCE_CORRECTION', [request.id])).get(request.id) ?? null
	};
}

export async function cancelMyCorrection(userId: number, id: number) {
	const employee = await loadSelf(userId);
	const request = await prisma.attendanceCorrectionRequest.findFirst({
		where: { id, employeeId: employee.id }
	});
	if (!request) throw Errors.notFound('ບໍ່ພົບຄຳຂໍແກ້ໄຂ');

	await prisma.$transaction(async (tx) => {
		const flipped = await tx.attendanceCorrectionRequest.updateMany({
			where: { id, status: 'PENDING' },
			data: { status: 'CANCELLED', pendingKey: null }
		});
		if (flipped.count === 0) {
			throw Errors.conflict('CORRECTION_NOT_PENDING', 'ຍົກເລີກໄດ້ສະເພາະຄຳຂໍທີ່ຍັງລໍຖ້າການພິຈາລະນາ');
		}
		await cancelApprovalInstance(tx, 'ATTENDANCE_CORRECTION', id);
	});
	return getMyCorrection(userId, id);
}

// ---------- review ----------

export async function listCorrections(query: CorrectionListQuery, scope: EmployeeScope) {
	const search = query.search;
	const where: Prisma.AttendanceCorrectionRequestWhereInput = {
		employee: {
			AND: [
				scopeToWhere(scope),
				query.departmentId ? { departmentId: query.departmentId } : {},
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
		},
		...(query.employeeId ? { employeeId: query.employeeId } : {}),
		...(query.status ? { status: query.status } : {}),
		...(query.date
			? { workDate: query.date }
			: query.from || query.to
				? {
						workDate: {
							...(query.from ? { gte: query.from } : {}),
							...(query.to ? { lte: query.to } : {})
						}
					}
				: {})
	};
	const [items, total] = await Promise.all([
		prisma.attendanceCorrectionRequest.findMany({
			where,
			include: REQUEST_INCLUDE,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.attendanceCorrectionRequest.count({ where })
	]);
	return {
		items: await withApproval('ATTENDANCE_CORRECTION', items),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

async function loadForReview(id: number, scope: EmployeeScope): Promise<RequestRow> {
	const request = await prisma.attendanceCorrectionRequest.findUnique({
		where: { id },
		include: REQUEST_INCLUDE
	});
	if (!request) throw Errors.notFound('ບໍ່ພົບຄຳຂໍແກ້ໄຂ');
	if (!isInScope(scope, request.employeeId)) throw Errors.forbidden();
	return request;
}

/** Before/after numbers — computed by the SAME backend formulas that approval will persist. */
async function buildPreview(request: RequestRow) {
	const policy = await getPolicy(request.employee.companyId);
	let day: DayContext;
	try {
		day = await loadDayContext(request.employee, request.workDate);
	} catch (err) {
		const e = err as AppError;
		return { available: false as const, code: e.code, message: e.message };
	}
	const requested = {
		type: request.type,
		requestedCheckInAt: request.requestedCheckInAt,
		requestedCheckOutAt: request.requestedCheckOutAt
	};
	const after = {
		checkInAt: requested.requestedCheckInAt ?? day.current.checkInAt,
		checkOutAt: requested.requestedCheckOutAt ?? day.current.checkOutAt
	};
	return {
		available: true as const,
		scheduled: {
			shift: day.shift,
			startTime: day.snapshot.startTime,
			endTime: day.snapshot.endTime,
			breakMinutes: day.snapshot.breakMinutes,
			crossesMidnight: day.snapshot.crossesMidnight
		},
		raw: {
			checkInAt: day.record?.firstCheckInAt ?? null,
			checkOutAt: day.record?.lastCheckOutAt ?? null
		},
		before: previewCalculation(day.snapshot, day.current, policy),
		after: previewCalculation(day.snapshot, after, policy)
	};
}

export async function getCorrection(
	id: number,
	scope: EmployeeScope,
	reviewer: { userId: number }
) {
	const request = await loadForReview(id, scope);
	const reviewerEmployee = await prisma.employee.findUnique({
		where: { userId: reviewer.userId },
		select: { id: true }
	});
	const isOwn =
		reviewerEmployee?.id === request.employeeId || request.requestedByUserId === reviewer.userId;
	return {
		...request,
		preview: await buildPreview(request),
		// a reviewer can act only when they are a candidate of the CURRENT workflow step
		canReview:
			request.status === 'PENDING' &&
			!isOwn &&
			(await isCurrentCandidate('ATTENDANCE_CORRECTION', request.id, reviewer.userId)),
		approval:
			(await approvalSummaries('ATTENDANCE_CORRECTION', [request.id])).get(request.id) ?? null,
		isOwnRequest: isOwn
	};
}

async function assertReviewer(request: RequestRow, reviewer: { userId: number }) {
	const own = await prisma.employee.findUnique({
		where: { userId: reviewer.userId },
		select: { id: true }
	});
	if (own?.id === request.employeeId || request.requestedByUserId === reviewer.userId) {
		throw Errors.forbiddenWith(
			'CANNOT_REVIEW_OWN_REQUEST',
			'ບໍ່ສາມາດອະນຸມັດ ຫຼື ປະຕິເສດຄຳຂໍຂອງຕົນເອງ'
		);
	}
}

/**
 * Review pre-flight used by the controllers before they hand the action to the approval engine:
 * the request must be inside the reviewer's data scope and must not be the reviewer's own.
 */
export async function preflightCorrectionReview(
	id: number,
	scope: EmployeeScope,
	reviewer: { userId: number }
) {
	const request = await loadForReview(id, scope);
	await assertReviewer(request, reviewer);
	return request;
}

/**
 * FINAL approval of an attendance correction — invoked by the approval engine inside its
 * transaction when the LAST workflow step is approved. Phase 6 logic stays here: re-validate against
 * the current schedule/times, create the record from the snapshot if none exists, write the
 * immutable correction overlay, recalculate attendance (which also recalculates OT). Raw punches
 * are never touched. A throw rolls the whole workflow action back.
 */
export async function finalizeCorrectionApproval(
	tx: Prisma.TransactionClient,
	id: number,
	reviewerUserId: number,
	reviewNote?: string
) {
	const request = await tx.attendanceCorrectionRequest.findUniqueOrThrow({
		where: { id },
		include: REQUEST_INCLUDE
	});
	const reviewer = { userId: reviewerUserId };
	if (request.status !== 'PENDING') {
		throw Errors.conflict('CORRECTION_ALREADY_REVIEWED', 'ຄຳຂໍນີ້ຖືກພິຈາລະນາແລ້ວ');
	}

	// Re-validate against the CURRENT state (schedule, holiday, times) before writing anything.
	const now = serverNow();
	const day = await loadDayContext(request.employee, request.workDate);
	validateRequestedTimes(request, day, now);

	try {
		// Compare-and-set: only one reviewer can move PENDING -> APPROVED.
		const flipped = await tx.attendanceCorrectionRequest.updateMany({
			where: { id, status: 'PENDING' },
			data: {
				status: 'APPROVED',
				pendingKey: null,
				reviewedByUserId: reviewer.userId,
				reviewedAt: now,
				reviewNote: reviewNote ?? null
			}
		});
		if (flipped.count === 0)
			throw Errors.conflict('CORRECTION_ALREADY_REVIEWED', 'ຄຳຂໍນີ້ຖືກພິຈາລະນາແລ້ວ');

		let record = await tx.attendanceRecord.findUnique({
			where: {
				employeeId_workDate: { employeeId: request.employeeId, workDate: request.workDate }
			}
		});
		if (!record) {
			// No punches exist: build the record from the historical schedule snapshot, raw times NULL.
			record = await tx.attendanceRecord.create({
				data: {
					employeeId: request.employeeId,
					workDate: request.workDate,
					scheduleAssignmentId: day.assignmentId,
					shiftId: day.shift.id,
					scheduledStartTime: day.snapshot.startTime,
					scheduledEndTime: day.snapshot.endTime,
					scheduledBreakMinutes: day.snapshot.breakMinutes,
					scheduledCrossesMidnight: day.snapshot.crossesMidnight,
					scheduledLateGraceMinutes: day.snapshot.lateGraceMinutes,
					scheduledEarlyLeaveGraceMinutes: day.snapshot.earlyLeaveGraceMinutes,
					status: 'IN_PROGRESS',
					isWorkingDay: true,
					isHoliday: false
				}
			});
		}

		const current = {
			checkInAt: record.effectiveCheckInAt ?? record.firstCheckInAt,
			checkOutAt: record.effectiveCheckOutAt ?? record.lastCheckOutAt
		};
		const effectiveIn = request.requestedCheckInAt ?? current.checkInAt;
		const effectiveOut = request.requestedCheckOutAt ?? current.checkOutAt;

		await tx.attendanceCorrectionApplication.create({
			data: {
				correctionRequestId: request.id,
				attendanceRecordId: record.id,
				effectiveCheckInAt: effectiveIn,
				effectiveCheckOutAt: effectiveOut,
				appliedByUserId: reviewer.userId,
				appliedAt: now
			}
		});
		await tx.attendanceCorrectionRequest.update({
			where: { id },
			data: { attendanceRecordId: record.id }
		});
		// Operational status: a day with an effective check-out is complete (raw rows untouched).
		if (effectiveOut && record.status !== 'COMPLETED') {
			await tx.attendanceRecord.update({
				where: { id: record.id },
				data: { status: 'COMPLETED' }
			});
		}
		await recalculateAttendanceRecord(record.id, tx);
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict('CONFLICT_RETRY', 'ມີການປ່ຽນແປງຂໍ້ມູນພ້ອມກັນ ກະລຸນາລອງໃໝ່');
		}
		throw err;
	}
}

/** FINAL rejection of a correction (any workflow step may reject). */
export async function finalizeCorrectionRejection(
	tx: Prisma.TransactionClient,
	id: number,
	reviewerUserId: number,
	reviewNote: string
) {
	const flipped = await tx.attendanceCorrectionRequest.updateMany({
		where: { id, status: 'PENDING' },
		data: {
			status: 'REJECTED',
			pendingKey: null,
			reviewedByUserId: reviewerUserId,
			reviewedAt: serverNow(),
			reviewNote
		}
	});
	if (flipped.count === 0)
		throw Errors.conflict('CORRECTION_ALREADY_REVIEWED', 'ຄຳຂໍນີ້ຖືກພິຈາລະນາແລ້ວ');
}
