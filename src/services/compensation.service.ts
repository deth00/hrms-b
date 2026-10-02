import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { addDays, formatDateOnly, todayInLaos } from '../lib/dates.js';
import { moneyString } from '../lib/money.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { lockEmployee } from './leaveBalance.service.js';
import { requirePayrollSettings } from './payrollSettings.service.js';
import type {
	CompensationCreateInput,
	RecurringAssignInput,
	RecurringEndInput
} from '../validation/payroll.schema.js';

/**
 * EFFECTIVE-DATED compensation (base salary) and recurring earnings / deductions.
 *
 *  - Rows are never edited in place and never deleted. A change closes the previous row
 *    (`effectiveTo = newFrom − 1 day`) and inserts a new one, in ONE transaction that holds the
 *    employee row lock, so two concurrent changes cannot produce overlapping periods.
 *  - A new period must start AFTER the latest existing start (no back-dating into history).
 *  - Dates are Laos calendar dates (DATE columns); amounts are Decimal and serialised as strings.
 *  - Salary is exposed ONLY through these dedicated endpoints (payroll permission + broad scope).
 */
const EMPLOYEE_BRIEF = {
	id: true,
	employeeCode: true,
	firstNameLao: true,
	lastNameLao: true,
	companyId: true,
	startDate: true,
	endDate: true
} satisfies Prisma.EmployeeSelect;

async function loadEmployee(db: Prisma.TransactionClient | typeof prisma, id: number) {
	const employee = await db.employee.findUnique({ where: { id }, select: EMPLOYEE_BRIEF });
	if (!employee) throw Errors.notFound('ບໍ່ພົບພະນັກງານ');
	return employee;
}

/** effectiveFrom cannot precede the employment start, nor follow the employment end. */
function assertWithinEmployment(
	employee: { startDate: Date; endDate: Date | null },
	effectiveFrom: Date
) {
	if (effectiveFrom < employee.startDate) {
		throw Errors.badRequest(
			'EFFECTIVE_DATE_BEFORE_EMPLOYMENT',
			`ວັນທີ່ມີຜົນຕ້ອງບໍ່ກ່ອນວັນເລີ່ມງານຂອງພະນັກງານ (${formatDateOnly(employee.startDate)})`
		);
	}
	if (employee.endDate && effectiveFrom > employee.endDate) {
		throw Errors.badRequest(
			'EFFECTIVE_DATE_AFTER_EMPLOYMENT',
			`ວັນທີ່ມີຜົນຕ້ອງບໍ່ຫຼັງວັນສິ້ນສຸດການຈ້າງງານ (${formatDateOnly(employee.endDate)})`
		);
	}
}

const isUnique = (err: unknown) =>
	err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

const USER_BRIEF = { select: { id: true, displayName: true } } as const;

const presentCompensation = (
	r: Prisma.EmployeeCompensationGetPayload<{ include: { createdBy: typeof USER_BRIEF } }>
) => ({
	id: r.id,
	employeeId: r.employeeId,
	companyId: r.companyId,
	baseSalary: moneyString(r.baseSalary),
	currencyCode: r.currencyCode,
	effectiveFrom: r.effectiveFrom,
	effectiveTo: r.effectiveTo,
	reason: r.reason,
	createdBy: r.createdBy,
	createdAt: r.createdAt
});

type RecurringRow = Prisma.EmployeeRecurringPayComponentGetPayload<{
	include: {
		createdBy: typeof USER_BRIEF;
		payComponent: {
			select: { id: true; code: true; nameLao: true; nameEnglish: true; type: true; status: true };
		};
	};
}>;
const RECURRING_INCLUDE = {
	createdBy: USER_BRIEF,
	payComponent: {
		select: { id: true, code: true, nameLao: true, nameEnglish: true, type: true, status: true }
	}
} as const;

const presentRecurring = (r: RecurringRow, today: Date) => ({
	id: r.id,
	employeeId: r.employeeId,
	payComponent: r.payComponent,
	amount: moneyString(r.amount),
	effectiveFrom: r.effectiveFrom,
	effectiveTo: r.effectiveTo,
	note: r.note,
	state:
		r.effectiveFrom > today
			? 'UPCOMING'
			: r.effectiveTo && r.effectiveTo < today
				? 'ENDED'
				: 'CURRENT',
	createdBy: r.createdBy,
	createdAt: r.createdAt
});

// ============================================================================================
// reads
// ============================================================================================

export async function getEmployeeCompensation(employeeId: number) {
	const employee = await loadEmployee(prisma, employeeId);
	const today = todayInLaos(serverNow());
	const settings = await prisma.payrollSettings.findUnique({
		where: { companyId: employee.companyId }
	});
	const [current, upcoming, recurring] = await Promise.all([
		prisma.employeeCompensation.findFirst({
			where: {
				employeeId,
				effectiveFrom: { lte: today },
				OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }]
			},
			include: { createdBy: USER_BRIEF }
		}),
		prisma.employeeCompensation.findFirst({
			where: { employeeId, effectiveFrom: { gt: today } },
			orderBy: { effectiveFrom: 'asc' },
			include: { createdBy: USER_BRIEF }
		}),
		prisma.employeeRecurringPayComponent.findMany({
			where: {
				employeeId,
				effectiveFrom: { lte: today },
				OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }]
			},
			include: RECURRING_INCLUDE,
			orderBy: [{ payComponent: { type: 'asc' } }, { effectiveFrom: 'asc' }]
		})
	]);
	return {
		employee: {
			id: employee.id,
			employeeCode: employee.employeeCode,
			firstNameLao: employee.firstNameLao,
			lastNameLao: employee.lastNameLao,
			startDate: employee.startDate,
			endDate: employee.endDate
		},
		currencyCode: settings?.currencyCode ?? null,
		payrollConfigured: !!settings,
		current: current ? presentCompensation(current) : null,
		upcoming: upcoming ? presentCompensation(upcoming) : null,
		recurring: recurring.map((r) => presentRecurring(r, today))
	};
}

export async function listCompensationHistory(employeeId: number) {
	await loadEmployee(prisma, employeeId);
	const rows = await prisma.employeeCompensation.findMany({
		where: { employeeId },
		include: { createdBy: USER_BRIEF },
		orderBy: { effectiveFrom: 'desc' }
	});
	return { items: rows.map(presentCompensation) };
}

export async function listRecurringPayComponents(employeeId: number) {
	await loadEmployee(prisma, employeeId);
	const today = todayInLaos(serverNow());
	const rows = await prisma.employeeRecurringPayComponent.findMany({
		where: { employeeId },
		include: RECURRING_INCLUDE,
		orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }]
	});
	return { items: rows.map((r) => presentRecurring(r, today)) };
}

// ============================================================================================
// base salary change
// ============================================================================================

export async function createCompensation(
	employeeId: number,
	input: CompensationCreateInput,
	actorUserId: number
) {
	const employee = await loadEmployee(prisma, employeeId);
	assertWithinEmployment(employee, input.effectiveFrom);
	const settings = await requirePayrollSettings(employee.companyId);
	if (input.currencyCode && input.currencyCode !== settings.currencyCode) {
		throw Errors.badRequest(
			'PAYROLL_CURRENCY_MISMATCH',
			`ສະກຸນເງິນຕ້ອງເປັນ ${settings.currencyCode} ຕາມການຕັ້ງຄ່າເງິນເດືອນຂອງບໍລິສັດ`
		);
	}
	try {
		await prisma.$transaction(async (tx) => {
			await lockEmployee(tx, employeeId);
			// re-read the company under the lock: a transfer between the checks above and here must not slip through
			const locked = await loadEmployee(tx, employeeId);
			if (locked.companyId !== employee.companyId) {
				throw Errors.conflict('EMPLOYEE_COMPANY_CHANGED', 'ພະນັກງານຖືກຍ້າຍບໍລິສັດ — ກະລຸນາລອງໃໝ່');
			}
			const last = await tx.employeeCompensation.findFirst({
				where: { employeeId },
				orderBy: { effectiveFrom: 'desc' }
			});
			if (last && input.effectiveFrom <= last.effectiveFrom) {
				throw Errors.conflict(
					'COMPENSATION_PERIOD_OVERLAP',
					`ວັນທີ່ມີຜົນຕ້ອງຫຼັງວັນເລີ່ມຂອງເງິນເດືອນຫຼ້າສຸດ (${formatDateOnly(last.effectiveFrom)})`
				);
			}
			if (last && (last.effectiveTo === null || last.effectiveTo >= input.effectiveFrom)) {
				// the ONLY mutation an existing salary row ever receives: closing its period
				await tx.employeeCompensation.update({
					where: { id: last.id },
					data: { effectiveTo: addDays(input.effectiveFrom, -1) }
				});
			}
			const created = await tx.employeeCompensation.create({
				data: {
					employeeId,
					companyId: employee.companyId,
					baseSalary: input.baseSalary,
					currencyCode: settings.currencyCode,
					effectiveFrom: input.effectiveFrom,
					reason: input.reason ?? null,
					createdByUserId: actorUserId
				}
			});
			await writeAuditEvent(tx, {
				action: last ? AuditAction.COMPENSATION_CHANGED : AuditAction.COMPENSATION_CREATED,
				entityType: AuditEntity.EMPLOYEE_COMPENSATION,
				entityId: created.id,
				companyId: employee.companyId,
				employeeId,
				actorUserId,
				// says THAT the salary changed — never the numbers
				changes: { baseSalary: { changed: true } },
				metadata: {
					effectiveFrom: formatDateOnly(input.effectiveFrom),
					previousCompensationId: last?.id ?? null,
					newCompensationId: created.id
				}
			});
		});
	} catch (err) {
		if (isUnique(err)) {
			throw Errors.conflict('COMPENSATION_PERIOD_OVERLAP', 'ມີເງິນເດືອນທີ່ເລີ່ມໃນວັນທີ່ນີ້ແລ້ວ');
		}
		throw err;
	}
	return getEmployeeCompensation(employeeId);
}

// ============================================================================================
// recurring components
// ============================================================================================

export async function assignRecurringPayComponent(
	employeeId: number,
	input: RecurringAssignInput,
	actorUserId: number
) {
	const employee = await loadEmployee(prisma, employeeId);
	assertWithinEmployment(employee, input.effectiveFrom);
	const component = await prisma.payComponent.findUnique({ where: { id: input.payComponentId } });
	if (!component) throw Errors.badRequest('INVALID_PAY_COMPONENT', 'ບໍ່ພົບລາຍການລາຍຮັບ/ລາຍຈ່າຍ');
	if (component.companyId !== employee.companyId) {
		throw Errors.badRequest(
			'PAY_COMPONENT_COMPANY_MISMATCH',
			'ລາຍການນີ້ບໍ່ໄດ້ຢູ່ພາຍໃຕ້ບໍລິສັດຂອງພະນັກງານ'
		);
	}
	if (component.status !== 'ACTIVE') {
		throw Errors.badRequest('PAY_COMPONENT_INACTIVE', 'ລາຍການນີ້ປິດການນຳໃຊ້ແລ້ວ');
	}
	if (!component.isRecurring) {
		throw Errors.badRequest('PAY_COMPONENT_NOT_RECURRING', 'ລາຍການນີ້ບໍ່ແມ່ນລາຍການປະຈຳ');
	}
	try {
		await prisma.$transaction(async (tx) => {
			await lockEmployee(tx, employeeId);
			const last = await tx.employeeRecurringPayComponent.findFirst({
				where: { employeeId, payComponentId: component.id },
				orderBy: { effectiveFrom: 'desc' }
			});
			if (last && input.effectiveFrom <= last.effectiveFrom) {
				throw Errors.conflict(
					'PAY_COMPONENT_PERIOD_OVERLAP',
					`ວັນທີ່ມີຜົນຕ້ອງຫຼັງວັນເລີ່ມຂອງການກຳນົດຫຼ້າສຸດ (${formatDateOnly(last.effectiveFrom)})`
				);
			}
			if (last && (last.effectiveTo === null || last.effectiveTo >= input.effectiveFrom)) {
				await tx.employeeRecurringPayComponent.update({
					where: { id: last.id },
					data: { effectiveTo: addDays(input.effectiveFrom, -1) }
				});
			}
			const created = await tx.employeeRecurringPayComponent.create({
				data: {
					employeeId,
					payComponentId: component.id,
					amount: input.amount,
					effectiveFrom: input.effectiveFrom,
					note: input.note ?? null,
					createdByUserId: actorUserId
				}
			});
			await writeAuditEvent(tx, {
				action: AuditAction.RECURRING_PAY_COMPONENT_ASSIGNED,
				entityType: AuditEntity.RECURRING_PAY_COMPONENT,
				entityId: created.id,
				companyId: employee.companyId,
				employeeId,
				actorUserId,
				changes: { amount: { changed: true } },
				metadata: {
					payComponentId: component.id,
					payComponentCode: component.code,
					type: component.type,
					effectiveFrom: formatDateOnly(input.effectiveFrom),
					previousRecurringId: last?.id ?? null
				}
			});
		});
	} catch (err) {
		if (isUnique(err)) {
			throw Errors.conflict('PAY_COMPONENT_PERIOD_OVERLAP', 'ມີການກຳນົດທີ່ເລີ່ມໃນວັນທີ່ນີ້ແລ້ວ');
		}
		throw err;
	}
	return listRecurringPayComponents(employeeId);
}

export async function endRecurringPayComponent(
	id: number,
	input: RecurringEndInput,
	actorUserId: number
) {
	const found = await prisma.employeeRecurringPayComponent.findUnique({
		where: { id },
		select: { employeeId: true }
	});
	if (!found) throw Errors.notFound('ບໍ່ພົບລາຍການປະຈຳຂອງພະນັກງານ');
	const employeeId = found.employeeId;
	await prisma.$transaction(async (tx) => {
		await lockEmployee(tx, employeeId);
		const row = await tx.employeeRecurringPayComponent.findUniqueOrThrow({
			where: { id },
			include: { payComponent: { select: { code: true, type: true } } }
		});
		if (row.effectiveTo !== null) {
			throw Errors.conflict('PAY_COMPONENT_ALREADY_ENDED', 'ລາຍການນີ້ສິ້ນສຸດແລ້ວ');
		}
		if (input.effectiveTo < row.effectiveFrom) {
			throw Errors.badRequest(
				'INVALID_END_DATE',
				`ວັນສິ້ນສຸດຕ້ອງບໍ່ກ່ອນວັນເລີ່ມ (${formatDateOnly(row.effectiveFrom)})`
			);
		}
		const employee = await loadEmployee(tx, employeeId);
		await tx.employeeRecurringPayComponent.update({
			where: { id },
			data: { effectiveTo: input.effectiveTo }
		});
		await writeAuditEvent(tx, {
			action: AuditAction.RECURRING_PAY_COMPONENT_ENDED,
			entityType: AuditEntity.RECURRING_PAY_COMPONENT,
			entityId: id,
			companyId: employee.companyId,
			employeeId,
			actorUserId,
			metadata: {
				payComponentCode: row.payComponent.code,
				type: row.payComponent.type,
				effectiveTo: formatDateOnly(input.effectiveTo)
			}
		});
	});
	return listRecurringPayComponents(employeeId);
}
