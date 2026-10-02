import { Prisma } from '@prisma/client';
import type { PayrollSchedule } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { formatDateOnly } from '../lib/dates.js';
import { buildChanges } from '../lib/auditRedaction.js';
import { assertCompanyExists } from './company.service.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { assertNoOverlap, lockCompany } from './payrollPeriod.service.js';
import { formatPayrollMonth, monthCycleRanges } from '../lib/payrollCycles.js';
import {
	allocationMethodIssue,
	monthsBetween,
	splitDayIssue
} from '../validation/payrollSchedule.schema.js';
import type {
	GeneratePeriodsInput,
	ScheduleCreateInput,
	ScheduleListQuery,
	ScheduleUpdateInput
} from '../validation/payrollSchedule.schema.js';

/**
 * PAYROLL SCHEDULE = HOW payroll periods are created.
 *
 *   Schedule ──generate──▶ PayrollPeriod (concrete dates) ──▶ PayrollRun (calculation) ──▶ Employee results
 *
 * Period CODE CONVENTION (deterministic, never derived from a display name):
 *     ONE payment / month :  {scheduleCode}-{YYYY-MM}          e.g. MONTHLY-STAFF-2026-10
 *     TWO payments / month:  {scheduleCode}-{YYYY-MM}-{cycle}  e.g. MONTHLY-TWICE-2026-10-2
 * The schedule code prefix keeps two schedules of one company from colliding on a code. Identity /
 * idempotency, however, is the numeric \`sequenceNumber\` (unique per schedule), not the text.
 *
 * Only MONTHLY is supported: a DAILY schedule can be stored (schema is future-ready) but previewing,
 * generating or calculating it returns PAYROLL_BASIS_NOT_SUPPORTED — no fake daily payroll.
 * payDateRule PERIOD_END: payDate = the period's end date (no banking-day logic).
 */
const EMPLOYEE_BRIEF = {
	id: true,
	employeeCode: true,
	firstNameLao: true,
	lastNameLao: true
} satisfies Prisma.EmployeeSelect;

const INCLUDE = {
	company: { select: { id: true, code: true, nameLao: true } },
	_count: { select: { employees: true, periods: true } },
	// Phase 12A.1 - presence alone tells us the allocation method is locked (§6); no amounts read
	runs: { where: { status: 'FINALIZED' }, select: { id: true }, take: 1 }
} satisfies Prisma.PayrollScheduleInclude;
type Row = Prisma.PayrollScheduleGetPayload<{ include: typeof INCLUDE }>;

const present = (r: Row) => ({
	id: r.id,
	companyId: r.companyId,
	company: r.company,
	code: r.code,
	nameLao: r.nameLao,
	nameEnglish: r.nameEnglish,
	payBasis: r.payBasis,
	paymentsPerMonth: r.paymentsPerMonth,
	anchorDate: r.anchorDate,
	splitDay: r.splitDay,
	payDateRule: r.payDateRule,
	monthlyAllocationMethod: r.monthlyAllocationMethod,
	allocationMethodLocked: r.runs.length > 0,
	employeeScope: r.employeeScope,
	groupByBranch: r.groupByBranch,
	status: r.status,
	memberCount: r._count.employees,
	periodCount: r._count.periods,
	createdAt: r.createdAt,
	updatedAt: r.updatedAt
});

const basisError = () =>
	Errors.badRequest(
		'PAYROLL_BASIS_NOT_SUPPORTED',
		'ຍັງບໍ່ຮອງຮັບຮອບເງິນເດືອນແບບລາຍວັນ — ໃຊ້ໄດ້ສະເພາະລາຍເດືອນ'
	);

// ============================================================================================
// reads
// ============================================================================================

export async function listSchedules(query: ScheduleListQuery) {
	const where: Prisma.PayrollScheduleWhereInput = {
		...(query.companyId ? { companyId: query.companyId } : {}),
		...(query.status ? { status: query.status } : {})
	};
	const [rows, total] = await Promise.all([
		prisma.payrollSchedule.findMany({
			where,
			include: INCLUDE,
			orderBy: [{ status: 'asc' }, { code: 'asc' }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.payrollSchedule.count({ where })
	]);
	return {
		items: rows.map(present),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getSchedule(id: number) {
	const row = await prisma.payrollSchedule.findUnique({ where: { id }, include: INCLUDE });
	if (!row) throw Errors.notFound('ບໍ່ພົບຮອບການຈ່າຍເງິນເດືອນ');
	const members =
		row.employeeScope === 'SELECTED'
			? await prisma.payrollScheduleEmployee.findMany({
					where: { payrollScheduleId: id },
					select: { employee: { select: EMPLOYEE_BRIEF } },
					orderBy: { employee: { employeeCode: 'asc' } }
				})
			: [];
	return { ...present(row), employees: members.map((m) => m.employee) };
}

// ============================================================================================
// writes
// ============================================================================================

/** members must exist and belong to the schedule's company (current placement) */
async function assertMembers(
	tx: Prisma.TransactionClient,
	companyId: number,
	employeeIds: number[]
) {
	const unique = [...new Set(employeeIds)];
	if (unique.length === 0) return unique;
	const found = await tx.employee.count({ where: { id: { in: unique }, companyId } });
	if (found !== unique.length) {
		throw Errors.badRequest(
			'INVALID_SCHEDULE_EMPLOYEES',
			'ມີພະນັກງານທີ່ບໍ່ພົບ ຫຼື ບໍ່ໄດ້ຢູ່ໃນບໍລິສັດຂອງຮອບການຈ່າຍນີ້'
		);
	}
	return unique;
}

export async function createSchedule(input: ScheduleCreateInput, actorUserId: number) {
	await assertCompanyExists(input.companyId);
	try {
		const created = await prisma.$transaction(async (tx) => {
			const taken = await tx.payrollSchedule.findUnique({
				where: { companyId_code: { companyId: input.companyId, code: input.code } }
			});
			if (taken)
				throw Errors.conflict('PAYROLL_SCHEDULE_CODE_TAKEN', 'ລະຫັດນີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');
			const employeeIds = await assertMembers(tx, input.companyId, input.employeeIds);
			const { employeeIds: _ids, ...data } = input;
			void _ids;
			const row = await tx.payrollSchedule.create({
				data: { ...data, splitDay: input.splitDay ?? null, createdByUserId: actorUserId }
			});
			if (employeeIds.length > 0) {
				await tx.payrollScheduleEmployee.createMany({
					data: employeeIds.map((employeeId) => ({ payrollScheduleId: row.id, employeeId }))
				});
			}
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_SCHEDULE_CREATED,
				entityType: AuditEntity.PAYROLL_SCHEDULE,
				entityId: row.id,
				companyId: row.companyId,
				actorUserId,
				metadata: {
					code: row.code,
					payBasis: row.payBasis,
					paymentsPerMonth: row.paymentsPerMonth,
					splitDay: row.splitDay,
					monthlyAllocationMethod: row.monthlyAllocationMethod,
					anchorDate: formatDateOnly(row.anchorDate),
					employeeScope: row.employeeScope,
					memberCount: employeeIds.length,
					groupByBranch: row.groupByBranch
				}
			});
			return row;
		});
		return getSchedule(created.id);
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict('PAYROLL_SCHEDULE_CODE_TAKEN', 'ລະຫັດນີ້ຖືກໃຊ້ແລ້ວໃນບໍລິສັດນີ້');
		}
		throw err;
	}
}

const STRUCTURAL = [
	'payBasis',
	'paymentsPerMonth',
	'anchorDate',
	'splitDay',
	'payDateRule'
] as const;
const CONFIG_FIELDS = [
	'nameLao',
	'nameEnglish',
	'payBasis',
	'paymentsPerMonth',
	'anchorDate',
	'splitDay',
	'payDateRule',
	'monthlyAllocationMethod',
	'employeeScope',
	'groupByBranch',
	'status'
] as const;

export async function updateSchedule(id: number, input: ScheduleUpdateInput, actorUserId: number) {
	const found = await prisma.payrollSchedule.findUnique({
		where: { id },
		select: { companyId: true }
	});
	if (!found) throw Errors.notFound('ບໍ່ພົບຮອບການຈ່າຍເງິນເດືອນ');
	await prisma.$transaction(async (tx) => {
		const existing = await tx.payrollSchedule.findUniqueOrThrow({
			where: { id },
			include: { _count: { select: { employees: true, periods: true } } }
		});
		const { employeeIds, ...fields } = input;
		const merged: PayrollSchedule = { ...existing, ...stripUndefined(fields) } as PayrollSchedule;
		// merged shape must still be valid
		const splitIssue = splitDayIssue(merged.paymentsPerMonth, merged.splitDay);
		if (splitIssue) throw Errors.badRequest('INVALID_SPLIT_DAY', splitIssue);
		// an update never FORCES a method onto an existing TWO schedule (§5) — only rejects an invalid shape
		const allocIssue = allocationMethodIssue(
			merged.paymentsPerMonth,
			merged.monthlyAllocationMethod
		);
		if (allocIssue) throw Errors.badRequest('INVALID_ALLOCATION_METHOD', allocIssue);
		// structure is frozen once periods were generated (history is never re-interpreted)
		const structuralChange = STRUCTURAL.some(
			(f) => f in input && !sameValue(existing[f], (merged as Record<string, unknown>)[f])
		);
		if (structuralChange && existing._count.periods > 0) {
			throw Errors.conflict(
				'PAYROLL_SCHEDULE_HAS_PERIODS',
				'ຮອບການຈ່າຍນີ້ໄດ້ສ້າງງວດແລ້ວ — ບໍ່ສາມາດປ່ຽນປະເພດ, ຈຳນວນຮອບ, ວັນແບ່ງ ຫຼື ວັນເລີ່ມນຳໃຊ້'
			);
		}
		// the allocation method has its OWN lock (§6): editable until this schedule's FIRST finalized run,
		// then frozen — finalized payroll is never reinterpreted, even though periods may still be generated
		if (
			'monthlyAllocationMethod' in input &&
			!sameValue(existing.monthlyAllocationMethod, merged.monthlyAllocationMethod)
		) {
			const finalized = await tx.payrollRun.findFirst({
				where: { payrollScheduleId: id, status: 'FINALIZED' },
				select: { id: true }
			});
			if (finalized) {
				throw Errors.conflict(
					'PAYROLL_CYCLE_ALLOCATION_METHOD_LOCKED',
					'ຮອບການຈ່າຍນີ້ມີການຢືນຢັນເງິນເດືອນແລ້ວ — ປ່ຽນວິທີແບ່ງເງິນເດືອນລາຍເດືອນບໍ່ໄດ້'
				);
			}
		}
		let memberIds: number[] | null = null;
		if (merged.employeeScope === 'SELECTED') {
			if (employeeIds !== undefined) {
				memberIds = await assertMembers(tx, existing.companyId, employeeIds);
				if (memberIds.length === 0) {
					throw Errors.badRequest(
						'INVALID_SCHEDULE_EMPLOYEES',
						'ກະລຸນາເລືອກພະນັກງານຢ່າງໜ້ອຍ 1 ຄົນ'
					);
				}
			} else if (existing._count.employees === 0) {
				throw Errors.badRequest('INVALID_SCHEDULE_EMPLOYEES', 'ກະລຸນາເລືອກພະນັກງານຢ່າງໜ້ອຍ 1 ຄົນ');
			}
		} else {
			if (employeeIds !== undefined && employeeIds.length > 0) {
				throw Errors.badRequest('INVALID_SCHEDULE_EMPLOYEES', 'ຂອບເຂດ "ທຸກຄົນ" ບໍ່ຕ້ອງລະບຸລາຍຊື່');
			}
			memberIds = []; // scope ALL keeps no membership rows
		}
		const after = await tx.payrollSchedule.update({
			where: { id },
			data: {
				...stripUndefined(fields),
				...(fields.splitDay !== undefined ? { splitDay: fields.splitDay } : {})
			}
		});
		let memberCountAfter = existing._count.employees;
		if (memberIds !== null) {
			await tx.payrollScheduleEmployee.deleteMany({ where: { payrollScheduleId: id } });
			if (memberIds.length > 0) {
				await tx.payrollScheduleEmployee.createMany({
					data: memberIds.map((employeeId) => ({ payrollScheduleId: id, employeeId }))
				});
			}
			memberCountAfter = memberIds.length;
		}
		const changes: Record<string, unknown> = {
			...(buildChanges(existing, after, CONFIG_FIELDS) ?? {})
		};
		if (memberCountAfter !== existing._count.employees) {
			changes.memberCount = { before: existing._count.employees, after: memberCountAfter };
		}
		if (Object.keys(changes).length > 0) {
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_SCHEDULE_UPDATED,
				entityType: AuditEntity.PAYROLL_SCHEDULE,
				entityId: id,
				companyId: existing.companyId,
				actorUserId,
				changes,
				metadata: { code: existing.code }
			});
		}
	});
	return getSchedule(id);
}

const stripUndefined = <T extends object>(o: T) =>
	Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const sameValue = (a: unknown, b: unknown) =>
	a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

// ============================================================================================
// period generation
// ============================================================================================

export interface PlannedPeriod {
	code: string;
	name: string;
	startDate: Date;
	endDate: Date;
	payDate: Date;
	cycleNumber: number;
	/** deterministic identity per schedule: year*24 + (month-1)*2 + (cycle-1) */
	sequenceNumber: number;
	/** Phase 12A.1 - the statutory/payroll month both cycles of a TWO/month schedule share ("2026-10") */
	payrollMonth: string;
}

/** PURE: the periods a schedule defines for the months [fromMonth, toMonth] (anchor date applied). */
export function planPeriods(
	schedule: Pick<
		PayrollSchedule,
		'code' | 'nameLao' | 'paymentsPerMonth' | 'splitDay' | 'anchorDate' | 'payBasis'
	>,
	fromMonth: string,
	toMonth: string
): { periods: PlannedPeriod[]; skippedBeforeAnchor: number } {
	if (schedule.payBasis !== 'MONTHLY') throw basisError();
	const count = monthsBetween(fromMonth, toMonth);
	let year = Number(fromMonth.slice(0, 4));
	let month = Number(fromMonth.slice(5, 7));
	const periods: PlannedPeriod[] = [];
	let skippedBeforeAnchor = 0;
	for (let i = 0; i < count; i++) {
		const ym = formatPayrollMonth(year, month);
		const ranges = monthCycleRanges(schedule.paymentsPerMonth, schedule.splitDay, year, month);
		const two = ranges.length === 2;
		for (const { cycleNumber: cycle, start: startDate, end: endDate } of ranges) {
			if (startDate < schedule.anchorDate) {
				skippedBeforeAnchor++;
				continue;
			}
			periods.push({
				code: two ? `${schedule.code}-${ym}-${cycle}` : `${schedule.code}-${ym}`,
				name: two ? `${schedule.nameLao} ${ym} (${cycle}/2)` : `${schedule.nameLao} ${ym}`,
				startDate,
				endDate,
				payDate: endDate, // PERIOD_END
				cycleNumber: cycle,
				sequenceNumber: year * 24 + (month - 1) * 2 + (cycle - 1),
				payrollMonth: ym
			});
		}
		month += 1;
		if (month > 12) {
			month = 1;
			year += 1;
		}
	}
	return { periods, skippedBeforeAnchor };
}

type PlanState = 'NEW' | 'EXISTS' | 'CONFLICT';
interface Classified extends PlannedPeriod {
	state: PlanState;
	conflict?: string;
}

/** Compares the plan with the database (reads only). */
async function classify(
	db: Prisma.TransactionClient | typeof prisma,
	schedule: PayrollSchedule,
	planned: PlannedPeriod[]
): Promise<Classified[]> {
	const out: Classified[] = [];
	for (const p of planned) {
		const same = await db.payrollPeriod.findUnique({
			where: {
				payrollScheduleId_sequenceNumber: {
					payrollScheduleId: schedule.id,
					sequenceNumber: p.sequenceNumber
				}
			},
			select: { id: true }
		});
		if (same) {
			out.push({ ...p, state: 'EXISTS' });
			continue;
		}
		const codeTaken = await db.payrollPeriod.findUnique({
			where: { companyId_code: { companyId: schedule.companyId, code: p.code } },
			select: { id: true }
		});
		if (codeTaken) {
			out.push({ ...p, state: 'CONFLICT', conflict: 'PAYROLL_PERIOD_CODE_TAKEN' });
			continue;
		}
		const overlap = await db.payrollPeriod.findFirst({
			where: {
				companyId: schedule.companyId,
				startDate: { lte: p.endDate },
				endDate: { gte: p.startDate }
			},
			select: { code: true }
		});
		out.push(
			overlap
				? { ...p, state: 'CONFLICT', conflict: `PAYROLL_PERIOD_OVERLAP:${overlap.code}` }
				: { ...p, state: 'NEW' }
		);
	}
	return out;
}

const presentPlanned = (p: Classified) => ({
	code: p.code,
	name: p.name,
	startDate: formatDateOnly(p.startDate),
	endDate: formatDateOnly(p.endDate),
	payDate: formatDateOnly(p.payDate),
	cycleNumber: p.cycleNumber,
	payrollMonth: p.payrollMonth,
	state: p.state,
	conflict: p.conflict ?? null
});

async function loadSchedule(id: number) {
	const schedule = await prisma.payrollSchedule.findUnique({ where: { id } });
	if (!schedule) throw Errors.notFound('ບໍ່ພົບຮອບການຈ່າຍເງິນເດືອນ');
	return schedule;
}

/** No database mutation: what generate WOULD do, with NEW / EXISTS / CONFLICT per period. */
export async function previewPeriods(id: number, input: GeneratePeriodsInput) {
	const schedule = await loadSchedule(id);
	const { periods, skippedBeforeAnchor } = planPeriods(schedule, input.fromMonth, input.toMonth);
	const classified = await classify(prisma, schedule, periods);
	return {
		scheduleId: id,
		fromMonth: input.fromMonth,
		toMonth: input.toMonth,
		skippedBeforeAnchor,
		periods: classified.map(presentPlanned)
	};
}

/**
 * Creates the missing periods (idempotent: EXISTS are skipped, a retry creates nothing). All-or-nothing:
 * if ANY planned period collides with an existing one (overlap / taken code) nothing is created.
 */
export async function generatePeriods(
	id: number,
	input: GeneratePeriodsInput,
	actorUserId: number
) {
	const found = await loadSchedule(id);
	if (found.payBasis !== 'MONTHLY') throw basisError();
	if (found.status !== 'ACTIVE') {
		throw Errors.conflict(
			'PAYROLL_SCHEDULE_INACTIVE',
			'ຮອບການຈ່າຍນີ້ປິດການນຳໃຊ້ — ບໍ່ສາມາດສ້າງງວດໃໝ່ໄດ້'
		);
	}
	const result = await prisma.$transaction(async (tx) => {
		await lockCompany(tx, found.companyId);
		const schedule = await tx.payrollSchedule.findUniqueOrThrow({ where: { id } });
		if (schedule.status !== 'ACTIVE') {
			throw Errors.conflict(
				'PAYROLL_SCHEDULE_INACTIVE',
				'ຮອບການຈ່າຍນີ້ປິດການນຳໃຊ້ — ບໍ່ສາມາດສ້າງງວດໃໝ່ໄດ້'
			);
		}
		const { periods } = planPeriods(schedule, input.fromMonth, input.toMonth);
		const classified = await classify(tx, schedule, periods);
		const conflicts = classified.filter((p) => p.state === 'CONFLICT');
		if (conflicts.length > 0) {
			throw Errors.conflict(
				'PAYROLL_PERIOD_OVERLAP',
				'ມີງວດທີ່ຊ້ອນກັບງວດທີ່ມີຢູ່ແລ້ວ — ບໍ່ໄດ້ສ້າງງວດໃດເລີຍ',
				{ conflicts: conflicts.map(presentPlanned) }
			);
		}
		const created: { id: number; code: string }[] = [];
		for (const p of classified.filter((x) => x.state === 'NEW')) {
			await assertNoOverlap(tx, schedule.companyId, p.startDate, p.endDate); // defence in depth
			const row = await tx.payrollPeriod.create({
				data: {
					companyId: schedule.companyId,
					code: p.code,
					name: p.name,
					startDate: p.startDate,
					endDate: p.endDate,
					payDate: p.payDate,
					payrollScheduleId: schedule.id,
					cycleNumber: p.cycleNumber,
					sequenceNumber: p.sequenceNumber,
					generatedBySchedule: true,
					payrollMonth: p.payrollMonth,
					statutoryMonthEligible: true,
					createdByUserId: actorUserId
				},
				select: { id: true, code: true }
			});
			created.push(row);
		}
		const skipped = classified.filter((p) => p.state === 'EXISTS').length;
		if (created.length > 0) {
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_SCHEDULE_PERIODS_GENERATED,
				entityType: AuditEntity.PAYROLL_SCHEDULE,
				entityId: schedule.id,
				companyId: schedule.companyId,
				actorUserId,
				metadata: {
					fromMonth: input.fromMonth,
					toMonth: input.toMonth,
					createdCount: created.length,
					skippedCount: skipped,
					periodIds: created.slice(0, 50).map((c) => c.id)
				}
			});
		}
		return { created, skipped, classified };
	});
	return {
		scheduleId: id,
		createdCount: result.created.length,
		skippedCount: result.skipped,
		periods: result.classified.map((p) => ({
			...presentPlanned(p),
			created: result.created.some((c) => c.code === p.code)
		}))
	};
}
