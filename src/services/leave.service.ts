import { Prisma } from '@prisma/client';
import type { LeaveRequestStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError, Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { addDays, formatDateOnly, todayInLaos } from '../lib/dates.js';
import { isInScope, scopeToWhere, type EmployeeScope } from '../lib/employeeScope.js';
import { resolveScheduleContext } from './schedule.service.js';
import { findActiveOvertimeDates } from './overtimeLookup.service.js';
import {
	approvalSummaries,
	cancelApprovalInstance,
	createApprovalInstance,
	isCurrentCandidate,
	withApproval
} from './approvalInstance.service.js';
import {
	computeBalance,
	computeBalances,
	balanceKey,
	lockEmployee,
	presentBalance,
	type BalanceCalc
} from './leaveBalance.service.js';
import type {
	LeaveCreateInput,
	LeaveListQuery,
	LeavePreviewInput,
	SelfLeaveListQuery
} from '../validation/leave.schema.js';

/**
 * LEAVE REQUESTS (Phase 7) — FULL-DAY ONLY, one review step (PENDING -> APPROVED | REJECTED,
 * PENDING -> CANCELLED by the requester). No generic multi-step approval workflow yet.
 *
 * Charged days are computed from the employee's SCHEDULE (Phase 4 resolver) for every calendar
 * date in the range — off-days and company holidays are excluded, never `end - start + 1`. The
 * charged dates are persisted as LeaveRequestDay rows (with the schedule snapshot), which is what
 * attendance and balances read; the original range is never re-interpreted later.
 *
 * Concurrency: creation and approval for one employee run inside a transaction that first takes a
 * row lock on the employee (SELECT ... FOR UPDATE), so overlap and balance checks cannot race.
 * A unique `activeKey` on LeaveRequestDay is a second, database-level guard against overlap.
 */

const ELIGIBLE_STATUSES = ['ACTIVE', 'PROBATION'];
const MAX_RANGE_DAYS = 366;
const ACTIVE_STATUSES: LeaveRequestStatus[] = ['PENDING', 'APPROVED'];
const D = Prisma.Decimal;

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
type LeaveEmployee = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_SELECT }>;

async function loadSelf(userId: number): Promise<LeaveEmployee> {
	const employee = await prisma.employee.findUnique({ where: { userId }, select: EMPLOYEE_SELECT });
	if (!employee) {
		throw Errors.forbiddenWith('NO_LINKED_EMPLOYEE', 'ບັນຊີນີ້ຍັງບໍ່ໄດ້ເຊື່ອມກັບພະນັກງານ');
	}
	return employee;
}

// ============================================================================================
// planning: which dates are charged?
// ============================================================================================

interface PlannedDay {
	date: Date;
	scheduleAssignmentId: number | null;
	shiftId: number | null;
	startTime: string;
	endTime: string;
	breakMinutes: number;
	crossesMidnight: boolean;
}
interface ExcludedDay {
	date: Date;
	reason: 'OFF_DAY' | 'HOLIDAY';
	holidayName: string | null;
}
interface Plan {
	employee: LeaveEmployee;
	leaveType: Prisma.LeaveTypeGetPayload<object>;
	startDate: Date;
	endDate: Date;
	days: PlannedDay[];
	excluded: ExcludedDay[];
	totalDays: Prisma.Decimal;
	/** charged days per calendar year (cross-year requests are validated per year) */
	byYear: Map<number, Prisma.Decimal>;
}

async function buildPlan(
	employee: LeaveEmployee,
	input: { leaveTypeId: number; startDate: Date; endDate: Date },
	now: Date
): Promise<Plan> {
	if (!ELIGIBLE_STATUSES.includes(employee.employmentStatus)) {
		throw Errors.forbiddenWith('EMPLOYEE_NOT_ACTIVE', 'ສະຖານະການຈ້າງງານປັດຈຸບັນບໍ່ອະນຸຍາດໃຫ້ຂໍລາ');
	}

	const leaveType = await prisma.leaveType.findUnique({ where: { id: input.leaveTypeId } });
	if (!leaveType) throw Errors.badRequest('INVALID_LEAVE_TYPE', 'ບໍ່ພົບປະເພດການລາ');
	if (leaveType.companyId !== employee.companyId) {
		throw Errors.badRequest(
			'LEAVE_TYPE_COMPANY_MISMATCH',
			'ປະເພດການລານີ້ບໍ່ໄດ້ຢູ່ພາຍໃຕ້ບໍລິສັດຂອງພະນັກງານ'
		);
	}
	if (leaveType.status !== 'ACTIVE') {
		throw Errors.badRequest('LEAVE_TYPE_INACTIVE', 'ປະເພດການລານີ້ປິດການນຳໃຊ້ແລ້ວ');
	}

	const { startDate, endDate } = input;
	if (endDate.getTime() < startDate.getTime()) {
		throw Errors.badRequest('INVALID_DATE_RANGE', 'ວັນທີ່ສິ້ນສຸດຕ້ອງບໍ່ກ່ອນວັນທີ່ເລີ່ມ');
	}
	const spanDays = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
	if (spanDays > MAX_RANGE_DAYS) {
		throw Errors.badRequest('LEAVE_RANGE_TOO_LONG', 'ໄລຍະເວລາຂໍລາຍາວເກີນໄປ');
	}

	// Laos calendar "today" from the server clock — never the browser's date.
	const today = todayInLaos(now);
	if (startDate.getTime() < today.getTime()) {
		throw Errors.badRequest('LEAVE_DATE_IN_PAST', 'ບໍ່ສາມາດຂໍລາຍ້ອນຫຼັງໄດ້');
	}
	const earliest = addDays(today, leaveType.minNoticeDays);
	if (startDate.getTime() < earliest.getTime()) {
		throw Errors.badRequest(
			'LEAVE_NOTICE_TOO_SHORT',
			`ຕ້ອງຂໍລາລ່ວງໜ້າຢ່າງໜ້ອຍ ${leaveType.minNoticeDays} ມື້`,
			{ minNoticeDays: leaveType.minNoticeDays, earliestStartDate: formatDateOnly(earliest) }
		);
	}

	if (
		startDate.getTime() < employee.startDate.getTime() ||
		(employee.endDate && endDate.getTime() > employee.endDate.getTime())
	) {
		throw Errors.badRequest('OUTSIDE_EMPLOYMENT', 'ວັນທີ່ເລືອກຢູ່ນອກໄລຍະເວລາການຈ້າງງານຂອງພະນັກງານ');
	}

	const dates: Date[] = [];
	for (let i = 0; i < spanDays; i++) dates.push(addDays(startDate, i));

	const days: PlannedDay[] = [];
	const excluded: ExcludedDay[] = [];
	const CHUNK = 10;
	for (let i = 0; i < dates.length; i += CHUNK) {
		const contexts = await Promise.all(
			dates.slice(i, i + CHUNK).map((d) => resolveScheduleContext(employee.id, d))
		);
		contexts.forEach((ctx, idx) => {
			const date = dates[i + idx] as Date;
			if (!ctx.hasSchedule || !ctx.shift || ctx.companyMismatch) {
				throw Errors.badRequest(
					'NO_ACTIVE_SCHEDULE',
					`ວັນທີ ${formatDateOnly(date)} ຍັງບໍ່ໄດ້ຮັບການກຳນົດກະເຮັດວຽກ`,
					{ date: formatDateOnly(date) }
				);
			}
			if (!ctx.isWorkingDay || !ctx.expected) {
				excluded.push({ date, reason: 'OFF_DAY', holidayName: null });
			} else if (ctx.isHoliday) {
				excluded.push({ date, reason: 'HOLIDAY', holidayName: ctx.holiday?.nameLao ?? null });
			} else {
				days.push({
					date,
					scheduleAssignmentId: ctx.assignment?.id ?? null,
					shiftId: ctx.shift.id,
					startTime: ctx.expected.startTime,
					endTime: ctx.expected.endTime,
					breakMinutes: ctx.expected.breakMinutes,
					crossesMidnight: ctx.expected.crossesMidnight
				});
			}
		});
	}

	if (days.length === 0) {
		throw Errors.badRequest('NO_LEAVE_WORK_DAYS', 'ບໍ່ມີມື້ເຮັດວຽກໃນຊ່ວງວັນທີ່ເລືອກ');
	}
	if (leaveType.maxConsecutiveDays !== null && days.length > leaveType.maxConsecutiveDays) {
		throw Errors.badRequest(
			'LEAVE_MAX_CONSECUTIVE_EXCEEDED',
			`ຂໍລາປະເພດນີ້ໄດ້ສູງສຸດ ${leaveType.maxConsecutiveDays} ມື້ຕໍ່ເນື່ອງ`,
			{ maxConsecutiveDays: leaveType.maxConsecutiveDays, requestedDays: days.length }
		);
	}

	const byYear = new Map<number, Prisma.Decimal>();
	for (const d of days) {
		const y = d.date.getUTCFullYear();
		byYear.set(y, (byYear.get(y) ?? new D(0)).plus(1));
	}
	return {
		employee,
		leaveType,
		startDate,
		endDate,
		days,
		excluded,
		totalDays: new D(days.length),
		byYear
	};
}

type Db = Prisma.TransactionClient | typeof prisma;

/** Checks that depend on other rows (overlap, balance) — run again inside the locked transaction. */
async function checkSoftRules(plan: Plan, db: Db): Promise<AppError[]> {
	const problems: AppError[] = [];
	const clash = await db.leaveRequestDay.findMany({
		where: {
			employeeId: plan.employee.id,
			leaveDate: { in: plan.days.map((d) => d.date) },
			leaveRequest: { status: { in: ACTIVE_STATUSES } }
		},
		select: { leaveDate: true },
		orderBy: { leaveDate: 'asc' }
	});
	if (clash.length > 0) {
		problems.push(
			Errors.conflict('LEAVE_DATE_OVERLAP', 'ມີການຂໍລາ ຫຼື ລາທີ່ອະນຸມັດແລ້ວໃນວັນທີ່ເລືອກ', {
				dates: clash.map((c) => formatDateOnly(c.leaveDate))
			})
		);
	}
	if (plan.leaveType.requiresBalance) {
		for (const [year, requested] of plan.byYear) {
			const calc = await computeBalance(plan.employee.id, plan.leaveType.id, year, db);
			if (calc.requestableAvailable.lessThan(requested)) {
				problems.push(
					Errors.badRequest('INSUFFICIENT_LEAVE_BALANCE', 'ສິດການລາຄົງເຫຼືອບໍ່ພໍ', {
						year,
						requestedDays: requested.toNumber(),
						availableDays: calc.requestableAvailable.toNumber()
					})
				);
				break;
			}
		}
	}
	return problems;
}

async function attendanceConflictDates(employeeId: number, dates: Date[]): Promise<string[]> {
	const records = await prisma.attendanceRecord.findMany({
		where: { employeeId, workDate: { in: dates } },
		select: { workDate: true },
		orderBy: { workDate: 'asc' }
	});
	return records.map((r) => formatDateOnly(r.workDate));
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
	leaveType: {
		select: {
			id: true,
			code: true,
			nameLao: true,
			nameEnglish: true,
			isPaid: true,
			requiresBalance: true,
			status: true
		}
	},
	requestedBy: { select: { id: true, displayName: true } },
	reviewedBy: { select: { id: true, displayName: true } },
	days: { orderBy: { leaveDate: 'asc' as const } }
} satisfies Prisma.LeaveRequestInclude;
type RequestRow = Prisma.LeaveRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

function presentRequest(r: RequestRow) {
	const { userId: _userId, ...employee } = r.employee;
	void _userId;
	return {
		id: r.id,
		employee,
		leaveType: r.leaveType,
		startDate: r.startDate,
		endDate: r.endDate,
		totalDays: r.totalDays.toNumber(),
		reason: r.reason,
		status: r.status,
		requestedBy: r.requestedBy,
		reviewedBy: r.reviewedBy,
		reviewedAt: r.reviewedAt,
		reviewNote: r.reviewNote,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
		days: r.days.map((d) => ({
			leaveDate: d.leaveDate,
			dayValue: d.dayValue.toNumber(),
			shiftId: d.shiftId,
			scheduledStartTime: d.scheduledStartTime,
			scheduledEndTime: d.scheduledEndTime
		}))
	};
}

async function balancesFor(r: RequestRow, db: Db = prisma) {
	const years = [...new Set(r.days.map((d) => d.leaveDate.getUTCFullYear()))].sort();
	const calcs = await computeBalances(
		years.map((year) => ({ employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, year }))
	);
	void db;
	return years.map((year) => {
		const calc = calcs.get(balanceKey(r.employeeId, r.leaveTypeId, year)) as BalanceCalc;
		const requested = r.days
			.filter((d) => d.leaveDate.getUTCFullYear() === year)
			.reduce((sum, d) => sum.plus(d.dayValue), new D(0));
		return { ...presentBalance(calc), requestedDays: requested.toNumber() };
	});
}

// ============================================================================================
// self service
// ============================================================================================

function presentPlan(plan: Plan) {
	return {
		leaveType: {
			id: plan.leaveType.id,
			code: plan.leaveType.code,
			nameLao: plan.leaveType.nameLao,
			isPaid: plan.leaveType.isPaid,
			requiresBalance: plan.leaveType.requiresBalance
		},
		startDate: plan.startDate,
		endDate: plan.endDate,
		days: plan.days.map((d) => ({ leaveDate: d.date, dayValue: 1 })),
		excludedDays: plan.excluded.map((e) => ({
			date: e.date,
			reason: e.reason,
			holidayName: e.holidayName
		})),
		totalDays: plan.totalDays.toNumber()
	};
}

export async function previewMyLeave(userId: number, input: LeavePreviewInput) {
	const employee = await loadSelf(userId);
	const now = serverNow();
	const plan = await buildPlan(employee, input, now);
	const problems = await checkSoftRules(plan, prisma);

	let balance: {
		year: number;
		before: number;
		after: number;
		available: number;
		requestedDays: number;
	}[] = [];
	if (plan.leaveType.requiresBalance) {
		balance = [];
		for (const [year, requested] of plan.byYear) {
			const calc = await computeBalance(employee.id, plan.leaveType.id, year);
			balance.push({
				year,
				available: calc.available.toNumber(),
				before: calc.requestableAvailable.toNumber(),
				after: calc.requestableAvailable.minus(requested).toNumber(),
				requestedDays: requested.toNumber()
			});
		}
	}
	return {
		...presentPlan(plan),
		balance,
		attendanceConflictDates: await attendanceConflictDates(
			employee.id,
			plan.days.map((d) => d.date)
		),
		// an active (PENDING / APPROVED) OT request on a charged date will BLOCK approval of this leave
		overtimeConflictDates: (
			await findActiveOvertimeDates(
				employee.id,
				plan.days.map((d) => d.date)
			)
		).map(formatDateOnly),
		canSubmit: problems.length === 0,
		blockers: problems.map((p) => ({
			code: p.code,
			message: p.message,
			details: p.details ?? null
		}))
	};
}

export async function createMyLeave(userId: number, input: LeaveCreateInput) {
	const employee = await loadSelf(userId);
	const plan = await buildPlan(employee, input, serverNow());

	try {
		const id = await prisma.$transaction(async (tx) => {
			await lockEmployee(tx, employee.id);
			const problems = await checkSoftRules(plan, tx);
			if (problems[0]) throw problems[0];

			const created = await tx.leaveRequest.create({
				data: {
					employeeId: employee.id,
					leaveTypeId: plan.leaveType.id,
					startDate: plan.startDate,
					endDate: plan.endDate,
					totalDays: plan.totalDays,
					reason: input.reason,
					status: 'PENDING',
					requestedByUserId: userId
				}
			});
			await tx.leaveRequestDay.createMany({
				data: plan.days.map((d) => ({
					leaveRequestId: created.id,
					employeeId: employee.id,
					leaveDate: d.date,
					dayValue: new D(1),
					activeKey: `${employee.id}:${formatDateOnly(d.date)}`,
					scheduleAssignmentId: d.scheduleAssignmentId,
					shiftId: d.shiftId,
					scheduledStartTime: d.startTime,
					scheduledEndTime: d.endTime,
					scheduledBreakMinutes: d.breakMinutes,
					scheduledCrossesMidnight: d.crossesMidnight
				}))
			});
			// the approval workflow instance (steps + candidate snapshot) is created atomically with the
			// request: no approver for some step → APPROVER_NOT_FOUND and the whole submission rolls back
			await createApprovalInstance(tx, {
				targetType: 'LEAVE',
				targetId: created.id,
				companyId: employee.companyId,
				employeeId: employee.id,
				requesterUserId: userId
			});
			return created.id;
		});
		return await getMyLeave(userId, id);
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict('LEAVE_DATE_OVERLAP', 'ມີການຂໍລາ ຫຼື ລາທີ່ອະນຸມັດແລ້ວໃນວັນທີ່ເລືອກ');
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

export async function listMyLeave(userId: number, query: SelfLeaveListQuery) {
	const employee = await loadSelf(userId);
	const where: Prisma.LeaveRequestWhereInput = {
		employeeId: employee.id,
		...(query.status ? { status: query.status } : {}),
		...(query.year
			? {
					startDate: { lte: yearRange(query.year).lte },
					endDate: { gte: yearRange(query.year).gte }
				}
			: {})
	};
	const [rows, total] = await Promise.all([
		prisma.leaveRequest.findMany({
			where,
			include: REQUEST_INCLUDE,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.leaveRequest.count({ where })
	]);
	return {
		items: await withApproval('LEAVE', rows.map(presentRequest)),
		...pageOf(total, query.page, query.pageSize)
	};
}

export async function getMyLeave(userId: number, id: number) {
	const employee = await loadSelf(userId);
	const row = await prisma.leaveRequest.findFirst({
		where: { id, employeeId: employee.id },
		include: REQUEST_INCLUDE
	});
	if (!row) throw Errors.notFound('ບໍ່ພົບຄຳຂໍລາ');
	return {
		...presentRequest(row),
		balances: await balancesFor(row),
		approval: (await approvalSummaries('LEAVE', [row.id])).get(row.id) ?? null
	};
}

export async function cancelMyLeave(userId: number, id: number) {
	const employee = await loadSelf(userId);
	const row = await prisma.leaveRequest.findFirst({ where: { id, employeeId: employee.id } });
	if (!row) throw Errors.notFound('ບໍ່ພົບຄຳຂໍລາ');
	if (row.status !== 'PENDING') {
		throw Errors.conflict(
			'LEAVE_NOT_CANCELLABLE',
			row.status === 'APPROVED'
				? 'ການລາທີ່ອະນຸມັດແລ້ວບໍ່ສາມາດຍົກເລີກໄດ້ (ຍັງບໍ່ຮອງຮັບ)'
				: 'ຄຳຂໍນີ້ບໍ່ສາມາດຍົກເລີກໄດ້'
		);
	}
	await prisma.$transaction(async (tx) => {
		const flipped = await tx.leaveRequest.updateMany({
			where: { id, status: 'PENDING' },
			data: { status: 'CANCELLED' }
		});
		if (flipped.count === 0) {
			throw Errors.conflict('LEAVE_NOT_CANCELLABLE', 'ຄຳຂໍນີ້ຖືກພິຈາລະນາແລ້ວ');
		}
		await tx.leaveRequestDay.updateMany({
			where: { leaveRequestId: id },
			data: { activeKey: null }
		});
		await cancelApprovalInstance(tx, 'LEAVE', id);
	});
	return getMyLeave(userId, id);
}

// ============================================================================================
// review
// ============================================================================================

export async function listLeaveRequests(query: LeaveListQuery, scope: EmployeeScope) {
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
	const range: Prisma.LeaveRequestWhereInput[] = [];
	if (query.year) {
		range.push({
			startDate: { lte: yearRange(query.year).lte },
			endDate: { gte: yearRange(query.year).gte }
		});
	}
	if (query.from) range.push({ endDate: { gte: query.from } });
	if (query.to) range.push({ startDate: { lte: query.to } });

	const where: Prisma.LeaveRequestWhereInput = {
		employee: employeeWhere,
		...(query.status ? { status: query.status } : {}),
		...(query.employeeId ? { employeeId: query.employeeId } : {}),
		...(query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {}),
		...(range.length ? { AND: range } : {})
	};
	const [rows, total] = await Promise.all([
		prisma.leaveRequest.findMany({
			where,
			include: REQUEST_INCLUDE,
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.leaveRequest.count({ where })
	]);
	return {
		items: await withApproval('LEAVE', rows.map(presentRequest)),
		...pageOf(total, query.page, query.pageSize)
	};
}

async function loadForReview(id: number, scope: EmployeeScope) {
	const row = await prisma.leaveRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
	if (!row) throw Errors.notFound('ບໍ່ພົບຄຳຂໍລາ');
	if (!isInScope(scope, row.employeeId)) throw Errors.forbidden();
	return row;
}

export async function getLeaveRequest(id: number, scope: EmployeeScope, viewerUserId: number) {
	const row = await loadForReview(id, scope);
	const balances = await balancesFor(row);
	const dates = row.days.map((d) => d.leaveDate);

	const warnings = {
		balanceInsufficient: [] as { year: number; requestedDays: number; availableDays: number }[],
		leaveTypeInactive: row.leaveType.status !== 'ACTIVE',
		attendanceConflictDates: await attendanceConflictDates(row.employeeId, dates),
		overtimeConflictDates: (await findActiveOvertimeDates(row.employeeId, dates)).map(
			formatDateOnly
		),
		scheduleChangedDates: [] as string[]
	};
	if (row.status === 'PENDING') {
		if (row.leaveType.requiresBalance) {
			for (const b of balances) {
				// PENDING days of THIS request are part of `pending`; compare against available.
				if (b.available < b.requestedDays) {
					warnings.balanceInsufficient.push({
						year: b.year,
						requestedDays: b.requestedDays,
						availableDays: b.available
					});
				}
			}
		}
		const contexts = await Promise.all(
			row.days.map((d) => resolveScheduleContext(row.employeeId, d.leaveDate))
		);
		row.days.forEach((d, i) => {
			const ctx = contexts[i];
			if (!ctx || !ctx.isWorkingDay || ctx.isHoliday || ctx.shift?.id !== d.shiftId) {
				warnings.scheduleChangedDates.push(formatDateOnly(d.leaveDate));
			}
		});
	}
	const isOwn = row.employee.userId === viewerUserId || row.requestedByUserId === viewerUserId;
	return {
		...presentRequest(row),
		balances,
		warnings,
		isOwnRequest: isOwn,
		// a reviewer can act only when they are a candidate of the CURRENT workflow step
		canReview:
			row.status === 'PENDING' &&
			!isOwn &&
			(await isCurrentCandidate('LEAVE', row.id, viewerUserId)),
		approval: (await approvalSummaries('LEAVE', [row.id])).get(row.id) ?? null
	};
}

function assertNotOwn(row: RequestRow, reviewerUserId: number): void {
	if (row.employee.userId === reviewerUserId || row.requestedByUserId === reviewerUserId) {
		throw Errors.forbiddenWith('CANNOT_REVIEW_OWN_LEAVE', 'ທ່ານບໍ່ສາມາດພິຈາລະນາຄຳຂໍລາຂອງຕົນເອງໄດ້');
	}
}

/**
 * Review pre-flight used by the controllers before they hand the action to the approval engine:
 * the request must be inside the reviewer's data scope and must not be the reviewer's own.
 */
export async function preflightLeaveReview(
	id: number,
	scope: EmployeeScope,
	reviewerUserId: number
) {
	const row = await loadForReview(id, scope);
	assertNotOwn(row, reviewerUserId);
	return row;
}

/**
 * FINAL approval of a leave request — invoked by the approval engine (approvalTargetAdapter) inside
 * its transaction when the LAST workflow step is approved. All Phase 7 business validation stays
 * here: leave type active, overlap, active-OT conflict, per-year balance, compare-and-set.
 * Any throw rolls the whole workflow action back (the final step stays PENDING).
 */
export async function finalizeLeaveApproval(
	tx: Prisma.TransactionClient,
	id: number,
	reviewerUserId: number,
	reviewNote?: string
) {
	const pre = await tx.leaveRequest.findUniqueOrThrow({
		where: { id },
		select: { employeeId: true }
	});
	await lockEmployee(tx, pre.employeeId);
	const row = await tx.leaveRequest.findUniqueOrThrow({
		where: { id },
		include: { leaveType: true, days: true }
	});
	if (row.status !== 'PENDING') {
		throw Errors.conflict('LEAVE_ALREADY_REVIEWED', 'ຄຳຂໍນີ້ຖືກພິຈາລະນາແລ້ວ');
	}
	if (row.leaveType.status !== 'ACTIVE') {
		throw Errors.conflict('LEAVE_TYPE_INACTIVE', 'ປະເພດການລານີ້ປິດການນຳໃຊ້ແລ້ວ ບໍ່ສາມາດອະນຸມັດໄດ້');
	}
	// overlap re-check: no OTHER active request may hold one of these dates
	const clash = await tx.leaveRequestDay.count({
		where: {
			employeeId: row.employeeId,
			leaveDate: { in: row.days.map((d) => d.leaveDate) },
			leaveRequestId: { not: id },
			leaveRequest: { status: { in: ACTIVE_STATUSES } }
		}
	});
	if (clash > 0) {
		throw Errors.conflict('LEAVE_DATE_OVERLAP', 'ມີການລາທີ່ທັບຊ້ອນກັບວັນທີ່ເລືອກ');
	}
	// Approved leave and active OT must never coexist on a date: a human resolves the OT first
	// (neither request is cancelled or deleted here).
	const otDates = await findActiveOvertimeDates(
		row.employeeId,
		row.days.map((d) => d.leaveDate),
		tx
	);
	if (otDates.length > 0) {
		throw Errors.conflict(
			'OVERTIME_CONFLICT',
			'ມີຄຳຂໍ OT ທີ່ຍັງໃຊ້ງານໃນວັນທີ່ລາ — ກະລຸນາຈັດການ OT ກ່ອນອະນຸມັດການລາ',
			{ dates: otDates.map(formatDateOnly) }
		);
	}
	// balance re-check per calendar year (this request's own PENDING days are not double counted)
	if (row.leaveType.requiresBalance) {
		const byYear = new Map<number, Prisma.Decimal>();
		for (const d of row.days) {
			const y = d.leaveDate.getUTCFullYear();
			byYear.set(y, (byYear.get(y) ?? new D(0)).plus(d.dayValue));
		}
		for (const [year, requested] of byYear) {
			const calc = await computeBalance(row.employeeId, row.leaveTypeId, year, tx);
			if (calc.available.lessThan(requested)) {
				throw Errors.badRequest('INSUFFICIENT_LEAVE_BALANCE', 'ສິດການລາຄົງເຫຼືອບໍ່ພໍ', {
					year,
					requestedDays: requested.toNumber(),
					availableDays: calc.available.toNumber()
				});
			}
		}
	}
	const flipped = await tx.leaveRequest.updateMany({
		where: { id, status: 'PENDING' },
		data: {
			status: 'APPROVED',
			reviewedByUserId: reviewerUserId,
			reviewedAt: serverNow(),
			reviewNote: reviewNote || null
		}
	});
	if (flipped.count === 0) {
		throw Errors.conflict('LEAVE_ALREADY_REVIEWED', 'ຄຳຂໍນີ້ຖືກພິຈາລະນາແລ້ວ');
	}
}

/** FINAL rejection of a leave request (any workflow step may reject) — releases its dates and balance. */
export async function finalizeLeaveRejection(
	tx: Prisma.TransactionClient,
	id: number,
	reviewerUserId: number,
	reviewNote: string
) {
	const pre = await tx.leaveRequest.findUniqueOrThrow({
		where: { id },
		select: { employeeId: true }
	});
	await lockEmployee(tx, pre.employeeId);
	const flipped = await tx.leaveRequest.updateMany({
		where: { id, status: 'PENDING' },
		data: {
			status: 'REJECTED',
			reviewedByUserId: reviewerUserId,
			reviewedAt: serverNow(),
			reviewNote
		}
	});
	if (flipped.count === 0) {
		throw Errors.conflict('LEAVE_ALREADY_REVIEWED', 'ຄຳຂໍນີ້ຖືກພິຈາລະນາແລ້ວ');
	}
	// a rejected request no longer holds its dates or balance
	await tx.leaveRequestDay.updateMany({
		where: { leaveRequestId: id },
		data: { activeKey: null }
	});
}
