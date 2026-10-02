import { Prisma } from '@prisma/client';
import type { PunchSource } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { Errors, type AppError } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { addDays, laosDateOf, workDateForInstant, formatDateOnly } from '../lib/dates.js';
import {
	laosClockString,
	scheduledEndInstant,
	scheduledStartInstant
} from '../lib/attendanceTime.js';
import { distanceMeters } from '../lib/geo.js';
import { isInScope, scopeToWhere, type EmployeeScope } from '../lib/employeeScope.js';
import { resolveScheduleContext } from './schedule.service.js';
import { findApprovedLeaveDay } from './leaveDay.service.js';
import {
	findApprovedOvertimeByEmployees,
	findApprovedOvertimeForDate,
	findCheckInOvertime,
	listActiveOvertimeForDates
} from './overtimeLookup.service.js';
import { resolveApplicableLocation } from './workLocation.service.js';
import { recalculateAttendanceRecord } from './attendanceCalculation.service.js';
import { calculateAttendance } from '../lib/attendanceCalculation.js';
import { defaultGraceMs, getPolicy, loadGraceMap } from './attendancePolicy.service.js';
import { getOvertimePolicy } from './overtimePolicy.service.js';
import { snapshotOf } from './attendanceCalculation.service.js';
import type {
	AttendanceListQuery,
	HistoryQuery,
	PunchBody
} from '../validation/attendance.schema.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';

/**
 * Attendance punch core (Phase 5).
 *
 *  - The punch instant is ALWAYS `serverNow()` (UTC); the client never supplies a time.
 *  - The WORK DATE is resolved with the Phase 4 schedule resolver + `workDateForInstant`, so the
 *    after-midnight tail of an overnight shift belongs to the day it started.
 *  - An AttendanceRecord snapshots the schedule it was created under; AttendancePunch rows are
 *    immutable events carrying their own GPS/location snapshot.
 *  - Stored status is only IN_PROGRESS | COMPLETED. MISSING_CHECK_OUT is DERIVED on read (no cron):
 *    an IN_PROGRESS record whose scheduled end + grace has passed.
 *  - Off-days and holidays are not "normal attendance": self check-in is refused (NO_SCHEDULED_WORK)
 *    UNLESS an APPROVED OT request (OFF_DAY / HOLIDAY) covers this instant (Phase 8) — then the
 *    check-in is allowed, the record is created WITHOUT a regular schedule snapshot (so no fake
 *    late / early-leave), and OT minutes are derived from its effective times. An approved
 *    BEFORE_SHIFT OT extends the check-in window earlier. AFTER_SHIFT OT does not re-open the window:
 *    the employee must still be checked in (one continuous interval per work date — split / re-entry
 *    attendance needs a future multi-session phase).
 *  - Late / early-leave / absent / worked-hours / OT are NOT computed here.
 */

const ELIGIBLE_STATUSES = ['ACTIVE', 'PROBATION'];
const MS_PER_MINUTE = 60_000;

export interface RequestMeta {
	ipAddress: string | null;
	userAgent: string | null;
}

interface SelfEmployee {
	id: number;
	employeeCode: string;
	firstNameLao: string;
	lastNameLao: string;
	companyId: number;
	branchId: number | null;
	employmentStatus: string;
}

const PUNCH_SELECT = {
	id: true,
	type: true,
	punchedAt: true,
	source: true,
	latitude: true,
	longitude: true,
	accuracyMeters: true,
	distanceMeters: true,
	locationRadiusMeters: true,
	ipAddress: true,
	userAgent: true,
	workLocation: { select: { id: true, code: true, nameLao: true } }
} satisfies Prisma.AttendancePunchSelect;

export const RECORD_INCLUDE = {
	shift: { select: { id: true, code: true, nameLao: true } },
	employee: { select: { companyId: true } }
} satisfies Prisma.AttendanceRecordInclude;

export type RecordRow = Prisma.AttendanceRecordGetPayload<{ include: typeof RECORD_INCLUDE }>;
export type GraceMap = Map<number, number>;

// ---------- derived state ----------

export function isMissingCheckOut(
	record: {
		status: string;
		workDate: Date;
		scheduledEndTime: string | null;
		scheduledCrossesMidnight: boolean;
	},
	now: Date,
	graceMs: number
): boolean {
	if (record.status !== 'IN_PROGRESS' || !record.scheduledEndTime) return false;
	const end = scheduledEndInstant(
		record.workDate,
		record.scheduledEndTime,
		record.scheduledCrossesMidnight
	);
	return now.getTime() > end.getTime() + graceMs;
}

/** Company-aware missing-check-out grace (policy, else the env/default fallback). */
export function graceFor(record: RecordRow, graces: GraceMap): number {
	return graces.get(record.employee.companyId) ?? defaultGraceMs();
}

export type DisplayResult =
	'IN_PROGRESS' | 'INCOMPLETE' | 'PRESENT' | 'LATE' | 'EARLY_LEAVE' | 'LATE_AND_EARLY';

/**
 * The public shape of a record. Schedule fields come from the SNAPSHOT (not the live Shift); RAW
 * facts (firstCheckInAt / lastCheckOutAt) are returned separately from the EFFECTIVE values and the
 * cached calculation, and `result` is the display verdict (an unfinished day is IN_PROGRESS, or
 * INCOMPLETE once the missing-check-out grace has passed).
 */
export function presentRecord(record: RecordRow, now: Date, graces: GraceMap) {
	const missing = isMissingCheckOut(record, now, graceFor(record, graces));
	const effIn = record.effectiveCheckInAt ?? record.firstCheckInAt;
	const effOut = record.effectiveCheckOutAt ?? record.lastCheckOutAt;

	// Legacy rows (never calculated) fall back to the pure formulas with default policy.
	const legacy =
		record.calculationVersion === 0
			? calculateAttendance(
					snapshotOf(record),
					{ checkInAt: effIn, checkOutAt: effOut },
					{ deductScheduledBreak: true }
				)
			: null;
	const calc = {
		scheduledWorkMinutes: legacy?.scheduledWorkMinutes ?? record.scheduledWorkMinutes,
		workedMinutes: legacy?.workedMinutes ?? record.workedMinutes,
		arrivalDelayMinutes: legacy?.arrivalDelayMinutes ?? record.arrivalDelayMinutes,
		lateMinutes: legacy?.lateMinutes ?? record.lateMinutes,
		earlyLeaveMinutes: legacy?.earlyLeaveMinutes ?? record.earlyLeaveMinutes,
		calculationStatus: legacy?.calculationStatus ?? record.calculationStatus,
		calculationVersion: record.calculationVersion,
		calculatedAt: record.calculatedAt
	};
	const result: DisplayResult =
		effIn && effOut
			? (calc.calculationStatus ?? 'PRESENT')
			: missing
				? 'INCOMPLETE'
				: 'IN_PROGRESS';

	return {
		id: record.id,
		employeeId: record.employeeId,
		workDate: record.workDate,
		status: missing ? 'MISSING_CHECK_OUT' : record.status,
		storedStatus: record.status,
		// RAW facts (immutable punch-derived)
		firstCheckInAt: record.firstCheckInAt,
		lastCheckOutAt: record.lastCheckOutAt,
		// EFFECTIVE (raw, or overlaid by an approved correction)
		effectiveCheckInAt: effIn,
		effectiveCheckOutAt: effOut,
		isCorrected: record.isCorrected,
		calculation: calc,
		result,
		isWorkingDay: record.isWorkingDay,
		isHoliday: record.isHoliday,
		holidayId: record.holidayId,
		scheduled: {
			startTime: record.scheduledStartTime,
			endTime: record.scheduledEndTime,
			breakMinutes: record.scheduledBreakMinutes,
			crossesMidnight: record.scheduledCrossesMidnight,
			lateGraceMinutes: record.scheduledLateGraceMinutes,
			earlyLeaveGraceMinutes: record.scheduledEarlyLeaveGraceMinutes,
			shift: record.shift
		}
	};
}

export async function presentMany(records: RecordRow[], now: Date) {
	const graces = await loadGraceMap(records.map((r) => r.employee.companyId));
	return records.map((r) => presentRecord(r, now, graces));
}

async function presentOne(record: RecordRow, now: Date) {
	return (await presentMany([record], now))[0]!;
}

// ---------- who is punching ----------

async function loadSelfEmployee(userId: number): Promise<SelfEmployee> {
	const employee = await prisma.employee.findUnique({
		where: { userId },
		select: {
			id: true,
			employeeCode: true,
			firstNameLao: true,
			lastNameLao: true,
			companyId: true,
			branchId: true,
			employmentStatus: true
		}
	});
	if (!employee) {
		throw Errors.forbiddenWith('NO_LINKED_EMPLOYEE', 'ບັນຊີນີ້ຍັງບໍ່ໄດ້ເຊື່ອມກັບພະນັກງານ');
	}
	return employee;
}

function assertEligible(employee: SelfEmployee): void {
	if (!ELIGIBLE_STATUSES.includes(employee.employmentStatus)) {
		throw Errors.forbiddenWith(
			'EMPLOYEE_NOT_ACTIVE',
			'ສະຖານະການຈ້າງງານປັດຈຸບັນບໍ່ອະນຸຍາດໃຫ້ເຂົ້າ-ອອກວຽກ'
		);
	}
}

// ---------- work date + open record ----------

/**
 * Which scheduled work date does this instant belong to? Normally today's Laos date; but in the
 * hours after midnight up to the end of an OVERNIGHT shift that started yesterday it is
 * yesterday — decided by the same `workDateForInstant` helper Phase 4 introduced.
 */
async function resolveWorkDate(employeeId: number, now: Date) {
	const today = laosDateOf(now);
	const yesterday = addDays(today, -1);
	const yesterdayCtx = await resolveScheduleContext(employeeId, yesterday);

	if (
		yesterdayCtx.shift &&
		yesterdayCtx.isWorkingDay &&
		!yesterdayCtx.isHoliday &&
		yesterdayCtx.expected
	) {
		const claimed = workDateForInstant(now, {
			startTime: yesterdayCtx.expected.startTime,
			endTime: yesterdayCtx.expected.endTime
		});
		if (claimed.getTime() === yesterday.getTime())
			return { workDate: yesterday, ctx: yesterdayCtx };
	}
	return { workDate: today, ctx: await resolveScheduleContext(employeeId, today) };
}

/** The employee's checked-in-but-not-out record that can still be checked out (not "missing"). */
async function findOpenRecord(employeeId: number, now: Date, companyId: number) {
	const graceMs = (await loadGraceMap([companyId])).get(companyId) ?? defaultGraceMs();
	const today = laosDateOf(now);
	const candidates = await prisma.attendanceRecord.findMany({
		where: { employeeId, status: 'IN_PROGRESS', workDate: { gte: addDays(today, -1), lte: today } },
		include: RECORD_INCLUDE,
		orderBy: { workDate: 'desc' }
	});
	return candidates.find((r) => !isMissingCheckOut(r, now, graceMs)) ?? null;
}

// ---------- GPS ----------

interface LocationSnapshot {
	latitude: number | null;
	longitude: number | null;
	accuracyMeters: number | null;
	workLocationId: number | null;
	distanceMeters: number | null;
	locationRadiusMeters: number | null;
}

type Location = Awaited<ReturnType<typeof resolveApplicableLocation>>;

/**
 * Server-side geofence. Distance is ALWAYS computed here from the coordinates; nothing the client
 * claims about being "inside" is read. GPS is enforced only when the applicable location has
 * `requireGps`; otherwise coordinates are stored if volunteered and distance is informational.
 */
function evaluateLocation(location: Location, body: PunchBody): LocationSnapshot {
	const supplied = body.latitude !== undefined && body.longitude !== undefined;
	const snapshot: LocationSnapshot = {
		latitude: supplied ? (body.latitude ?? null) : null,
		longitude: supplied ? (body.longitude ?? null) : null,
		accuracyMeters: body.accuracyMeters ?? null,
		workLocationId: location?.id ?? null,
		distanceMeters: null,
		locationRadiusMeters: location?.radiusMeters ?? null
	};

	if (supplied && location) {
		snapshot.distanceMeters = distanceMeters(
			{ latitude: body.latitude as number, longitude: body.longitude as number },
			{ latitude: location.latitude, longitude: location.longitude }
		);
	}

	if (!location?.requireGps) return snapshot;

	if (!supplied || body.accuracyMeters === undefined) {
		throw Errors.badRequest(
			'GPS_REQUIRED',
			'ບໍ່ສາມາດເຂົ້າ-ອອກວຽກໄດ້ ເນື່ອງຈາກບໍ່ສາມາດກວດສອບຕຳແໜ່ງໄດ້'
		);
	}
	if (body.accuracyMeters > env.attendance.maxGpsAccuracyMeters) {
		throw Errors.badRequest(
			'GPS_ACCURACY_POOR',
			'ສັນຍານ GPS ບໍ່ແມ່ນຍຳພໍ ກະລຸນາລອງໃໝ່ໃນບ່ອນທີ່ໂລ່ງກວ່າ',
			{
				accuracyMeters: Math.round(body.accuracyMeters),
				maxAccuracyMeters: env.attendance.maxGpsAccuracyMeters
			}
		);
	}
	const distance = snapshot.distanceMeters as number;
	if (distance > location.radiusMeters) {
		throw Errors.badRequest('OUTSIDE_WORK_LOCATION', 'ທ່ານຢູ່ນອກພື້ນທີ່ Check-in', {
			distanceMeters: Math.round(distance),
			radiusMeters: location.radiusMeters
		});
	}
	return snapshot;
}

function inferSource(body: PunchBody, meta: RequestMeta): PunchSource {
	if (body.source) return body.source;
	return meta.userAgent && /Mobi|Android|iPhone|iPad/i.test(meta.userAgent) ? 'MOBILE_WEB' : 'WEB';
}

// ---------- check-in planning (validation without side effects) ----------

async function planCheckIn(employee: SelfEmployee, now: Date) {
	assertEligible(employee);

	const open = await findOpenRecord(employee.id, now, employee.companyId);
	if (open) {
		throw Errors.conflict('ALREADY_CHECKED_IN', 'ທ່ານເຂົ້າວຽກແລ້ວ', {
			attendance: await presentOne(open, now)
		});
	}

	// approved OT that makes this instant a legitimate check-in moment (off-day / holiday work)
	const { policy: otPolicy, windows: otWindows } = await findCheckInOvertime(employee, now);
	const candidate = otWindows.find((o) => o.type === 'OFF_DAY' || o.type === 'HOLIDAY') ?? null;
	let special: (typeof otWindows)[number] | null = null;
	let resolved = await resolveWorkDate(employee.id, now);
	if (candidate) {
		const otCtx = await resolveScheduleContext(employee.id, candidate.workDate);
		if (!otCtx.isWorkingDay || otCtx.isHoliday) {
			special = candidate;
			resolved = { workDate: candidate.workDate, ctx: otCtx };
		}
	}
	const { workDate, ctx } = resolved;

	const existing = await prisma.attendanceRecord.findUnique({
		where: { employeeId_workDate: { employeeId: employee.id, workDate } },
		include: RECORD_INCLUDE
	});
	if (existing) {
		if (existing.status === 'COMPLETED') {
			throw Errors.conflict('ALREADY_COMPLETED', 'ການເຂົ້າ-ອອກວຽກຂອງມື້ນີ້ສຳເລັດແລ້ວ', {
				attendance: await presentOne(existing, now)
			});
		}
		throw Errors.conflict(
			'MISSING_CHECK_OUT',
			'ມີການເຂົ້າວຽກທີ່ຍັງບໍ່ໄດ້ອອກວຽກ ກະລຸນາຕິດຕໍ່ HR ເພື່ອແກ້ໄຂ',
			{ attendance: await presentOne(existing, now) }
		);
	}

	// approved full-day leave: no normal check-in (raw punches that already exist are untouched)
	const leave = await findApprovedLeaveDay(employee.id, workDate);
	if (leave) {
		throw Errors.badRequest('APPROVED_LEAVE_DAY', 'ມື້ນີ້ທ່ານລາ ບໍ່ຕ້ອງເຂົ້າວຽກ', { leave });
	}

	if (!ctx.hasSchedule || !ctx.shift || ctx.companyMismatch) {
		throw Errors.badRequest('NO_ACTIVE_SCHEDULE', 'ທ່ານຍັງບໍ່ໄດ້ຮັບການກຳນົດກະເຮັດວຽກ');
	}
	if (special) {
		// approved off-day / holiday OT: check-in allowed, no regular schedule to measure against
		return { workDate, ctx, shift: ctx.shift, expected: null, special };
	}
	if (!ctx.isWorkingDay || ctx.isHoliday || !ctx.expected) {
		throw Errors.badRequest(
			'NO_SCHEDULED_WORK',
			ctx.isHoliday ? 'ມື້ນີ້ເປັນວັນພັກ ບໍ່ມີການເຂົ້າວຽກຕາມກະ' : 'ມື້ນີ້ບໍ່ແມ່ນມື້ເຮັດວຽກຂອງທ່ານ'
		);
	}

	// Window: from (start - early) until the scheduled end. Late is allowed (Phase 6 measures it),
	// but not after the shift is over, and not hours ahead where the punch could attach wrongly.
	const early = ctx.shift.earlyCheckInMinutes ?? env.attendance.defaultEarlyCheckInMinutes;
	const start = scheduledStartInstant(workDate, ctx.expected.startTime);
	let earliest = new Date(start.getTime() - early * MS_PER_MINUTE);
	// an approved BEFORE_SHIFT OT extends the window to (OT start - the OT policy's early minutes)
	for (const o of await findApprovedOvertimeForDate(employee.id, workDate)) {
		if (o.type !== 'BEFORE_SHIFT') continue;
		const otEarliest = new Date(
			o.requestedStartAt.getTime() - otPolicy.checkInEarlyMinutes * MS_PER_MINUTE
		);
		if (otEarliest < earliest) earliest = otEarliest;
	}
	if (now < earliest) {
		throw Errors.badRequest(
			'TOO_EARLY_CHECK_IN',
			`ຍັງບໍ່ເຖິງເວລາເຂົ້າວຽກ (ເຂົ້າໄດ້ຕັ້ງແຕ່ ${laosClockString(earliest).slice(0, 5)})`,
			{ earliestCheckInTime: laosClockString(earliest).slice(0, 5) }
		);
	}
	const end = scheduledEndInstant(workDate, ctx.expected.endTime, ctx.expected.crossesMidnight);
	if (now > end) {
		throw Errors.badRequest('CHECK_IN_WINDOW_CLOSED', 'ກະເຮັດວຽກຂອງມື້ນີ້ສິ້ນສຸດແລ້ວ');
	}

	return { workDate, ctx, shift: ctx.shift, expected: ctx.expected, special: null };
}

// ---------- self: today ----------

export async function getMyToday(userId: number) {
	const employee = await loadSelfEmployee(userId);
	const now = serverNow();
	const eligible = ELIGIBLE_STATUSES.includes(employee.employmentStatus);

	const open = await findOpenRecord(employee.id, now, employee.companyId);
	const { workDate, ctx } = await resolveWorkDate(employee.id, now);
	const location = await resolveApplicableLocation(employee);

	const record =
		open ??
		(await prisma.attendanceRecord.findUnique({
			where: { employeeId_workDate: { employeeId: employee.id, workDate } },
			include: RECORD_INCLUDE
		}));

	const leave = await findApprovedLeaveDay(employee.id, workDate);
	let checkInBlocked: { code: string; message: string } | null = null;
	if (!eligible) {
		checkInBlocked = {
			code: 'EMPLOYEE_NOT_ACTIVE',
			message: 'ສະຖານະການຈ້າງງານບໍ່ອະນຸຍາດໃຫ້ເຂົ້າ-ອອກວຽກ'
		};
	} else {
		try {
			await planCheckIn(employee, now);
		} catch (err) {
			const e = err as AppError;
			if (e && typeof e.code === 'string') checkInBlocked = { code: e.code, message: e.message };
			else throw err;
		}
	}

	return {
		employee: {
			id: employee.id,
			employeeCode: employee.employeeCode,
			firstNameLao: employee.firstNameLao,
			lastNameLao: employee.lastNameLao
		},
		now,
		laosDate: laosDateOf(now),
		laosTime: laosClockString(now),
		workDate,
		schedule: {
			hasSchedule: ctx.hasSchedule,
			dayOfWeek: ctx.dayOfWeek,
			isWorkingDay: ctx.isWorkingDay,
			isHoliday: ctx.isHoliday,
			holiday: ctx.holiday,
			shift: ctx.shift
				? {
						id: ctx.shift.id,
						code: ctx.shift.code,
						nameLao: ctx.shift.nameLao,
						shiftType: ctx.shift.shiftType
					}
				: null,
			expected: ctx.expected
		},
		// coordinates of the location are deliberately NOT exposed to the client
		workLocation: location
			? {
					id: location.id,
					code: location.code,
					nameLao: location.nameLao,
					radiusMeters: location.radiusMeters,
					requireGps: location.requireGps
				}
			: null,
		gpsRequired: location?.requireGps ?? false,
		maxGpsAccuracyMeters: env.attendance.maxGpsAccuracyMeters,
		attendance: record ? await presentOne(record, now) : null,
		allowedActions: {
			checkIn: eligible && checkInBlocked === null,
			checkOut: eligible && open !== null
		},
		checkInBlocked,
		leave,
		// own PENDING / APPROVED OT for today and the work date (dashboard + attendance card)
		overtime: {
			items: await listActiveOvertimeForDates(
				employee.id,
				[...new Set([laosDateOf(now).getTime(), workDate.getTime()])].map((t) => new Date(t)),
				now
			),
			checkInEarlyMinutes: (await getOvertimePolicy(employee.companyId)).checkInEarlyMinutes
		}
	};
}

// ---------- self: check in ----------

export async function checkIn(userId: number, body: PunchBody, meta: RequestMeta) {
	const employee = await loadSelfEmployee(userId);
	const now = serverNow();
	const plan = await planCheckIn(employee, now);

	const location = await resolveApplicableLocation(employee);
	const snapshot = evaluateLocation(location, body);
	const { ctx, expected, workDate, shift, special } = plan;

	try {
		const created = await prisma.$transaction(async (tx) => {
			// The (employeeId, workDate) unique key makes a concurrent double check-in fail here.
			const record = await tx.attendanceRecord.create({
				data: {
					employeeId: employee.id,
					workDate,
					scheduleAssignmentId: ctx.assignment?.id ?? null,
					shiftId: shift.id,
					// an approved off-day / holiday OT record has NO regular schedule snapshot: the
					// attendance calculation then never invents late / early-leave for it
					scheduledStartTime: expected?.startTime ?? null,
					scheduledEndTime: expected?.endTime ?? null,
					scheduledBreakMinutes: expected?.breakMinutes ?? null,
					scheduledCrossesMidnight: expected?.crossesMidnight ?? false,
					scheduledLateGraceMinutes: expected ? shift.lateGraceMinutes : null,
					scheduledEarlyLeaveGraceMinutes: expected ? shift.earlyLeaveGraceMinutes : null,
					firstCheckInAt: now,
					status: 'IN_PROGRESS',
					isWorkingDay: special ? ctx.isWorkingDay : true,
					isHoliday: special ? ctx.isHoliday : false,
					holidayId: special ? (ctx.holiday?.id ?? null) : null
				}
			});
			const punch = await tx.attendancePunch.create({
				data: {
					attendanceRecordId: record.id,
					employeeId: employee.id,
					type: 'CHECK_IN',
					punchedAt: now,
					source: inferSource(body, meta),
					...snapshot,
					ipAddress: meta.ipAddress,
					userAgent: meta.userAgent?.slice(0, 255) ?? null,
					createdByUserId: userId
				}
			});
			await recalculateAttendanceRecord(record.id, tx);
			// raw GPS (latitude / longitude / accuracy) is deliberately NOT audited — only ids
			await writeAuditEvent(tx, {
				action: AuditAction.ATTENDANCE_CHECK_IN,
				entityType: AuditEntity.ATTENDANCE,
				entityId: record.id,
				companyId: employee.companyId,
				employeeId: employee.id,
				actorUserId: userId,
				metadata: {
					punchId: punch.id,
					workDate: formatDateOnly(workDate),
					source: punch.source,
					workLocationId: snapshot.workLocationId
				}
			});
			return { record, punch };
		});
		const record = await prisma.attendanceRecord.findUniqueOrThrow({
			where: { id: created.record.id },
			include: RECORD_INCLUDE
		});
		return {
			attendance: await presentOne(record, now),
			punchedAt: created.punch.punchedAt,
			type: 'CHECK_IN' as const
		};
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			const existing = await prisma.attendanceRecord.findUnique({
				where: { employeeId_workDate: { employeeId: employee.id, workDate } },
				include: RECORD_INCLUDE
			});
			throw Errors.conflict('ALREADY_CHECKED_IN', 'ທ່ານເຂົ້າວຽກແລ້ວ', {
				attendance: existing ? await presentOne(existing, now) : null
			});
		}
		throw err;
	}
}

// ---------- self: check out ----------

export async function checkOut(userId: number, body: PunchBody, meta: RequestMeta) {
	const employee = await loadSelfEmployee(userId);
	assertEligible(employee);
	const now = serverNow();

	const open = await findOpenRecord(employee.id, now, employee.companyId);
	if (!open) {
		const { workDate } = await resolveWorkDate(employee.id, now);
		const same = await prisma.attendanceRecord.findUnique({
			where: { employeeId_workDate: { employeeId: employee.id, workDate } },
			include: RECORD_INCLUDE
		});
		if (same?.status === 'COMPLETED') {
			throw Errors.conflict('ALREADY_CHECKED_OUT', 'ທ່ານອອກວຽກແລ້ວ', {
				attendance: await presentOne(same, now)
			});
		}
		const stale = await prisma.attendanceRecord.findFirst({
			where: { employeeId: employee.id, status: 'IN_PROGRESS' },
			orderBy: { workDate: 'desc' },
			include: RECORD_INCLUDE
		});
		if (
			stale &&
			isMissingCheckOut(
				stale,
				now,
				(await loadGraceMap([employee.companyId])).get(employee.companyId) ?? defaultGraceMs()
			)
		) {
			throw Errors.conflict(
				'MISSING_CHECK_OUT',
				'ມີການເຂົ້າວຽກທີ່ເກີນເວລາອອກວຽກແລ້ວ ກະລຸນາຕິດຕໍ່ HR ເພື່ອແກ້ໄຂ',
				{ attendance: await presentOne(stale, now) }
			);
		}
		throw Errors.badRequest('NOT_CHECKED_IN', 'ທ່ານຍັງບໍ່ໄດ້ເຂົ້າວຽກ');
	}

	const location = await resolveApplicableLocation(employee);
	const snapshot = evaluateLocation(location, body);

	try {
		const punch = await prisma.$transaction(async (tx) => {
			// Compare-and-set: only one of two concurrent check-outs can flip IN_PROGRESS -> COMPLETED.
			const flipped = await tx.attendanceRecord.updateMany({
				where: { id: open.id, status: 'IN_PROGRESS' },
				data: { status: 'COMPLETED', lastCheckOutAt: now }
			});
			if (flipped.count === 0) throw Errors.conflict('ALREADY_CHECKED_OUT', 'ທ່ານອອກວຽກແລ້ວ');
			const created = await tx.attendancePunch.create({
				data: {
					attendanceRecordId: open.id,
					employeeId: employee.id,
					type: 'CHECK_OUT',
					punchedAt: now,
					source: inferSource(body, meta),
					...snapshot,
					ipAddress: meta.ipAddress,
					userAgent: meta.userAgent?.slice(0, 255) ?? null,
					createdByUserId: userId
				}
			});
			await recalculateAttendanceRecord(open.id, tx);
			await writeAuditEvent(tx, {
				action: AuditAction.ATTENDANCE_CHECK_OUT,
				entityType: AuditEntity.ATTENDANCE,
				entityId: open.id,
				companyId: employee.companyId,
				employeeId: employee.id,
				actorUserId: userId,
				metadata: {
					punchId: created.id,
					workDate: formatDateOnly(open.workDate),
					source: created.source,
					workLocationId: snapshot.workLocationId
				}
			});
			return created;
		});
		const record = await prisma.attendanceRecord.findUniqueOrThrow({
			where: { id: open.id },
			include: RECORD_INCLUDE
		});
		return {
			attendance: await presentOne(record, now),
			punchedAt: punch.punchedAt,
			type: 'CHECK_OUT' as const
		};
	} catch (err) {
		if ((err as AppError)?.code === 'ALREADY_CHECKED_OUT') {
			const record = await prisma.attendanceRecord.findUnique({
				where: { id: open.id },
				include: RECORD_INCLUDE
			});
			throw Errors.conflict('ALREADY_CHECKED_OUT', 'ທ່ານອອກວຽກແລ້ວ', {
				attendance: record ? await presentOne(record, now) : null
			});
		}
		throw err;
	}
}

// ---------- self: history ----------

export async function getMyHistory(userId: number, query: HistoryQuery) {
	const employee = await loadSelfEmployee(userId);
	const now = serverNow();
	const where: Prisma.AttendanceRecordWhereInput = {
		employeeId: employee.id,
		...(query.from || query.to
			? {
					workDate: {
						...(query.from ? { gte: query.from } : {}),
						...(query.to ? { lte: query.to } : {})
					}
				}
			: {})
	};
	const [rows, total] = await Promise.all([
		prisma.attendanceRecord.findMany({
			where,
			include: RECORD_INCLUDE,
			orderBy: { workDate: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.attendanceRecord.count({ where })
	]);
	return {
		items: await presentMany(rows, now),
		correctionPolicy: {
			allowEmployeeCorrection: (await getPolicy(employee.companyId)).allowEmployeeCorrection,
			correctionRequestWindowDays: (await getPolicy(employee.companyId))
				.correctionRequestWindowDays,
			today: laosDateOf(now)
		},
		pendingCorrectionDates: (
			await prisma.attendanceCorrectionRequest.findMany({
				where: { employeeId: employee.id, status: 'PENDING' },
				select: { workDate: true }
			})
		).map((c) => formatDateOnly(c.workDate)),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

// ---------- admin ----------

export const EMPLOYEE_SUMMARY = {
	select: {
		id: true,
		companyId: true,
		employeeCode: true,
		firstNameLao: true,
		lastNameLao: true,
		firstNameEnglish: true,
		lastNameEnglish: true,
		employmentStatus: true,
		department: { select: { id: true, code: true, nameLao: true } },
		position: { select: { id: true, code: true, nameLao: true } }
	}
} as const;

export async function listAttendance(query: AttendanceListQuery, scope: EmployeeScope) {
	const now = serverNow();
	const search = query.search;

	const employeeWhere: Prisma.EmployeeWhereInput = {
		AND: [
			scopeToWhere(scope),
			query.companyId ? { companyId: query.companyId } : {},
			query.branchId ? { branchId: query.branchId } : {},
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
	};

	const dateFilter: Prisma.AttendanceRecordWhereInput = query.date
		? { workDate: query.date }
		: query.from || query.to
			? {
					workDate: {
						...(query.from ? { gte: query.from } : {}),
						...(query.to ? { lte: query.to } : {})
					}
				}
			: {};

	const base: Prisma.AttendanceRecordWhereInput = {
		...dateFilter,
		...(query.employeeId ? { employeeId: query.employeeId } : {}),
		employee: employeeWhere
	};

	const include = {
		...RECORD_INCLUDE,
		employee: EMPLOYEE_SUMMARY
	} satisfies Prisma.AttendanceRecordInclude;
	const orderBy: Prisma.AttendanceRecordOrderByWithRelationInput[] = [
		{ workDate: 'desc' },
		{ employee: { employeeCode: 'asc' } }
	];

	// IN_PROGRESS vs MISSING_CHECK_OUT is derived (time-dependent), so those two filters are
	// applied after loading the (small) set of unfinished records.
	if (query.status === 'IN_PROGRESS' || query.status === 'MISSING_CHECK_OUT') {
		const open = await prisma.attendanceRecord.findMany({
			where: { ...base, status: 'IN_PROGRESS' },
			include,
			orderBy,
			take: 2000
		});
		const wantMissing = query.status === 'MISSING_CHECK_OUT';
		const graces = await loadGraceMap(open.map((r) => r.employee.companyId));
		const matching = open.filter(
			(r) => isMissingCheckOut(r, now, graceFor(r, graces)) === wantMissing
		);
		const start = (query.page - 1) * query.pageSize;
		return {
			items: matching
				.slice(start, start + query.pageSize)
				.map((r) => ({ ...presentRecord(r, now, graces), employee: r.employee })),
			page: query.page,
			pageSize: query.pageSize,
			total: matching.length,
			totalPages: Math.max(1, Math.ceil(matching.length / query.pageSize))
		};
	}

	const where: Prisma.AttendanceRecordWhereInput = {
		...base,
		...(query.status ? { status: query.status } : {})
	};
	const [rows, total] = await Promise.all([
		prisma.attendanceRecord.findMany({
			where,
			include,
			orderBy,
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.attendanceRecord.count({ where })
	]);
	return {
		items: (await presentMany(rows, now)).map((presented, i) => ({
			...presented,
			employee: rows[i]!.employee
		})),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getAttendanceById(id: number, scope: EmployeeScope) {
	const now = serverNow();
	const record = await prisma.attendanceRecord.findUnique({
		where: { id },
		include: {
			...RECORD_INCLUDE,
			employee: EMPLOYEE_SUMMARY,
			holiday: { select: { id: true, nameLao: true, nameEnglish: true, type: true, isPaid: true } },
			punches: { select: PUNCH_SELECT, orderBy: { punchedAt: 'asc' } }
		}
	});
	if (!record) throw Errors.notFound('ບໍ່ພົບຂໍ້ມູນການເຂົ້າ-ອອກວຽກ');
	if (!isInScope(scope, record.employeeId)) throw Errors.forbidden();

	const { punches, employee, holiday, ...rest } = record;
	return {
		...presentRecord(
			{ ...rest, employee: { companyId: employee.companyId } },
			now,
			await loadGraceMap([employee.companyId])
		),
		correctionRequests: await prisma.attendanceCorrectionRequest.findMany({
			where: {
				OR: [
					{ attendanceRecordId: id },
					{ employeeId: record.employeeId, workDate: record.workDate }
				]
			},
			select: {
				id: true,
				type: true,
				status: true,
				reason: true,
				reviewedAt: true,
				createdAt: true
			},
			orderBy: { createdAt: 'desc' }
		}),
		employee,
		holiday,
		workDateText: formatDateOnly(record.workDate),
		// approved leave on this date (raw punches stay visible; this only flags the conflict)
		leave: await findApprovedLeaveDay(record.employeeId, record.workDate),
		// approved OT for this work date (planned / actual / eligible minutes — never money)
		overtimeRequests:
			(await findApprovedOvertimeByEmployees([record.employeeId], record.workDate, now)).get(
				record.employeeId
			) ?? [],
		punches
	};
}
