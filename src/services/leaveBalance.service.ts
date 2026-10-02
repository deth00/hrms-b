import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { idCol } from '../lib/sqlIds.js';
import { Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { todayInLaos } from '../lib/dates.js';
import { isInScope, scopeToWhere, type EmployeeScope } from '../lib/employeeScope.js';
import type {
	LeaveAdjustmentInput,
	LeaveBalanceCreateInput,
	LeaveBalanceListQuery,
	LeaveBalanceUpdateInput
} from '../validation/leave.schema.js';
import { AuditAction, AuditEntity, auditUpdated, writeAuditEvent } from './audit.service.js';

type AdjustmentListQueryLike = { page: number; pageSize: number };

/**
 * Leave BALANCES — one centralized calculation. All business arithmetic uses Prisma.Decimal
 * (decimal.js) so values like 0.1 + 0.2 never drift; numbers appear only at the API boundary.
 *
 *   base                = entitlementDays + carriedForwardDays + SUM(adjustments)
 *   used                = SUM(dayValue of APPROVED LeaveRequestDay in that calendar year)
 *   pending             = SUM(dayValue of PENDING  LeaveRequestDay in that calendar year)
 *   available           = base - used
 *   requestableAvailable = base - used - pending
 *
 * Nothing is cached: totals are derived from the request-day rows every time, so they can never
 * disagree with the requests.
 */

type Db = Prisma.TransactionClient | typeof prisma;
const D = Prisma.Decimal;
const ZERO = new D(0);

export const dec = (n: number) => new D(n.toFixed(2));
export const yearStart = (year: number) => new Date(Date.UTC(year, 0, 1));
export const yearEnd = (year: number) => new Date(Date.UTC(year, 11, 31));

export interface BalanceCalc {
	employeeId: number;
	leaveTypeId: number;
	year: number;
	balanceId: number | null;
	entitled: Prisma.Decimal;
	carriedForward: Prisma.Decimal;
	adjustment: Prisma.Decimal;
	base: Prisma.Decimal;
	used: Prisma.Decimal;
	pending: Prisma.Decimal;
	available: Prisma.Decimal;
	requestableAvailable: Prisma.Decimal;
}

export const balanceKey = (employeeId: number, leaveTypeId: number, year: number) =>
	`${employeeId}|${leaveTypeId}|${year}`;

export async function computeBalances(
	pairs: { employeeId: number; leaveTypeId: number; year: number }[],
	db: Db = prisma
): Promise<Map<string, BalanceCalc>> {
	const result = new Map<string, BalanceCalc>();
	if (pairs.length === 0) return result;

	const balances = await db.leaveBalance.findMany({
		where: {
			OR: pairs.map((p) => ({
				employeeId: p.employeeId,
				leaveTypeId: p.leaveTypeId,
				year: p.year
			}))
		}
	});
	const sums = balances.length
		? await db.leaveBalanceAdjustment.groupBy({
				by: ['leaveBalanceId'],
				where: { leaveBalanceId: { in: balances.map((b) => b.id) } },
				_sum: { days: true }
			})
		: [];
	const adjustmentByBalance = new Map(sums.map((s) => [s.leaveBalanceId, s._sum.days ?? ZERO]));
	const balanceByKey = new Map(
		balances.map((b) => [balanceKey(b.employeeId, b.leaveTypeId, b.year), b])
	);

	const years = pairs.map((p) => p.year);
	const days = await db.leaveRequestDay.findMany({
		where: {
			employeeId: { in: [...new Set(pairs.map((p) => p.employeeId))] },
			leaveDate: { gte: yearStart(Math.min(...years)), lte: yearEnd(Math.max(...years)) },
			leaveRequest: {
				leaveTypeId: { in: [...new Set(pairs.map((p) => p.leaveTypeId))] },
				status: { in: ['PENDING', 'APPROVED'] }
			}
		},
		select: {
			employeeId: true,
			leaveDate: true,
			dayValue: true,
			leaveRequest: { select: { leaveTypeId: true, status: true } }
		}
	});
	const usage = new Map<string, { used: Prisma.Decimal; pending: Prisma.Decimal }>();
	for (const d of days) {
		const key = balanceKey(d.employeeId, d.leaveRequest.leaveTypeId, d.leaveDate.getUTCFullYear());
		const bucket = usage.get(key) ?? { used: ZERO, pending: ZERO };
		if (d.leaveRequest.status === 'APPROVED') bucket.used = bucket.used.plus(d.dayValue);
		else bucket.pending = bucket.pending.plus(d.dayValue);
		usage.set(key, bucket);
	}

	for (const p of pairs) {
		const key = balanceKey(p.employeeId, p.leaveTypeId, p.year);
		const row = balanceByKey.get(key);
		const u = usage.get(key) ?? { used: ZERO, pending: ZERO };
		const entitled = row?.entitlementDays ?? ZERO;
		const carriedForward = row?.carriedForwardDays ?? ZERO;
		const adjustment = row ? (adjustmentByBalance.get(row.id) ?? ZERO) : ZERO;
		const base = entitled.plus(carriedForward).plus(adjustment);
		result.set(key, {
			...p,
			balanceId: row?.id ?? null,
			entitled,
			carriedForward,
			adjustment,
			base,
			used: u.used,
			pending: u.pending,
			available: base.minus(u.used),
			requestableAvailable: base.minus(u.used).minus(u.pending)
		});
	}
	return result;
}

export async function computeBalance(
	employeeId: number,
	leaveTypeId: number,
	year: number,
	db: Db = prisma
) {
	const map = await computeBalances([{ employeeId, leaveTypeId, year }], db);
	return map.get(balanceKey(employeeId, leaveTypeId, year)) as BalanceCalc;
}

export function presentBalance(b: BalanceCalc) {
	return {
		balanceId: b.balanceId,
		year: b.year,
		entitled: b.entitled.toNumber(),
		carriedForward: b.carriedForward.toNumber(),
		adjustment: b.adjustment.toNumber(),
		base: b.base.toNumber(),
		used: b.used.toNumber(),
		pending: b.pending.toNumber(),
		available: b.available.toNumber(),
		requestableAvailable: b.requestableAvailable.toNumber()
	};
}

/** Locks the employee row so that leave creation/approval for one employee is serialized. */
export async function lockEmployee(tx: Prisma.TransactionClient, employeeId: number) {
	await tx.$queryRaw`SELECT ${idCol()} AS id FROM employees WHERE ${idCol()} = ${employeeId} FOR UPDATE`;
}

// ---------- self ----------

export async function getMyBalances(userId: number, year?: number) {
	const employee = await prisma.employee.findUnique({
		where: { userId },
		select: { id: true, companyId: true }
	});
	if (!employee) {
		throw Errors.forbiddenWith('NO_LINKED_EMPLOYEE', 'ບັນຊີນີ້ຍັງບໍ່ໄດ້ເຊື່ອມກັບພະນັກງານ');
	}
	const y = year ?? todayInLaos(serverNow()).getUTCFullYear();
	const types = await prisma.leaveType.findMany({
		where: {
			companyId: employee.companyId,
			OR: [{ status: 'ACTIVE' }, { balances: { some: { employeeId: employee.id, year: y } } }]
		},
		orderBy: { code: 'asc' }
	});
	const calcs = await computeBalances(
		types.map((t) => ({ employeeId: employee.id, leaveTypeId: t.id, year: y }))
	);
	return {
		year: y,
		items: types.map((t) => ({
			leaveType: {
				id: t.id,
				code: t.code,
				nameLao: t.nameLao,
				nameEnglish: t.nameEnglish,
				isPaid: t.isPaid,
				requiresBalance: t.requiresBalance,
				status: t.status
			},
			...presentBalance(calcs.get(balanceKey(employee.id, t.id, y)) as BalanceCalc)
		}))
	};
}

// ---------- admin ----------

const ROW_INCLUDE = {
	employee: {
		select: {
			id: true,
			employeeCode: true,
			firstNameLao: true,
			lastNameLao: true,
			companyId: true,
			department: { select: { id: true, code: true, nameLao: true } }
		}
	},
	leaveType: {
		select: {
			id: true,
			code: true,
			nameLao: true,
			isPaid: true,
			requiresBalance: true,
			status: true
		}
	}
} satisfies Prisma.LeaveBalanceInclude;

type Row = Prisma.LeaveBalanceGetPayload<{ include: typeof ROW_INCLUDE }>;

async function present(rows: Row[]) {
	const calcs = await computeBalances(
		rows.map((r) => ({ employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, year: r.year }))
	);
	return rows.map((r) => ({
		id: r.id,
		employee: r.employee,
		leaveType: r.leaveType,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
		...presentBalance(calcs.get(balanceKey(r.employeeId, r.leaveTypeId, r.year)) as BalanceCalc)
	}));
}

export async function listBalances(query: LeaveBalanceListQuery, scope: EmployeeScope) {
	const year = query.year ?? todayInLaos(serverNow()).getUTCFullYear();
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
	const where: Prisma.LeaveBalanceWhereInput = {
		year,
		...(query.employeeId ? { employeeId: query.employeeId } : {}),
		...(query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {}),
		employee: employeeWhere
	};
	const [rows, total] = await Promise.all([
		prisma.leaveBalance.findMany({
			where,
			include: ROW_INCLUDE,
			orderBy: [{ employee: { employeeCode: 'asc' } }, { leaveType: { code: 'asc' } }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.leaveBalance.count({ where })
	]);
	return {
		year,
		items: await present(rows),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

async function loadRow(id: number, scope: EmployeeScope) {
	const row = await prisma.leaveBalance.findUnique({ where: { id }, include: ROW_INCLUDE });
	if (!row) throw Errors.notFound('ບໍ່ພົບສິດການລາ');
	if (!isInScope(scope, row.employeeId)) throw Errors.forbidden();
	return row;
}

export async function getBalanceById(id: number, scope: EmployeeScope) {
	const [item] = await present([await loadRow(id, scope)]);
	return item;
}

/** Creates the (employee, type, year) entitlement row, or updates it when it already exists. */
export async function upsertBalance(
	input: LeaveBalanceCreateInput,
	scope: EmployeeScope,
	actorUserId: number
) {
	const employee = await prisma.employee.findUnique({ where: { id: input.employeeId } });
	if (!employee) throw Errors.badRequest('INVALID_EMPLOYEE', 'ບໍ່ພົບພະນັກງານ');
	if (!isInScope(scope, employee.id)) throw Errors.forbidden();
	const type = await prisma.leaveType.findUnique({ where: { id: input.leaveTypeId } });
	if (!type) throw Errors.badRequest('INVALID_LEAVE_TYPE', 'ບໍ່ພົບປະເພດການລາ');
	if (type.companyId !== employee.companyId) {
		throw Errors.badRequest(
			'LEAVE_TYPE_COMPANY_MISMATCH',
			'ປະເພດການລານີ້ບໍ່ໄດ້ຢູ່ພາຍໃຕ້ບໍລິສັດດຽວກັບພະນັກງານ'
		);
	}

	const key = {
		employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId: type.id, year: input.year }
	};
	const existing = await prisma.leaveBalance.findUnique({ where: key });
	if (!existing && type.status !== 'ACTIVE') {
		throw Errors.badRequest('LEAVE_TYPE_INACTIVE', 'ປະເພດການລານີ້ປິດການນຳໃຊ້ແລ້ວ');
	}
	const data = {
		entitlementDays: dec(input.entitlementDays),
		carriedForwardDays: dec(input.carriedForwardDays)
	};
	try {
		const row = await prisma.$transaction(async (tx) => {
			const saved = existing
				? await tx.leaveBalance.update({
						where: { id: existing.id },
						data: { ...data, updatedByUserId: actorUserId },
						include: ROW_INCLUDE
					})
				: await tx.leaveBalance.create({
						data: {
							employeeId: employee.id,
							leaveTypeId: type.id,
							year: input.year,
							...data,
							createdByUserId: actorUserId,
							updatedByUserId: actorUserId
						},
						include: ROW_INCLUDE
					});
			const meta = { leaveTypeCode: type.code, year: input.year };
			if (existing) {
				await auditUpdated(tx, {
					action: AuditAction.LEAVE_BALANCE_UPDATED,
					entityType: AuditEntity.LEAVE_BALANCE,
					entityId: saved.id,
					companyId: employee.companyId,
					employeeId: employee.id,
					before: existing,
					after: saved,
					fields: ['entitlementDays', 'carriedForwardDays'],
					metadata: meta
				});
			} else {
				await writeAuditEvent(tx, {
					action: AuditAction.LEAVE_BALANCE_CREATED,
					entityType: AuditEntity.LEAVE_BALANCE,
					entityId: saved.id,
					companyId: employee.companyId,
					employeeId: employee.id,
					metadata: {
						...meta,
						entitlementDays: saved.entitlementDays,
						carriedForwardDays: saved.carriedForwardDays
					}
				});
			}
			return saved;
		});
		const [item] = await present([row]);
		return { item: item as NonNullable<typeof item>, created: !existing };
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict('LEAVE_BALANCE_EXISTS', 'ມີສິດການລານີ້ຢູ່ແລ້ວ');
		}
		throw err;
	}
}

export async function updateBalance(
	id: number,
	input: LeaveBalanceUpdateInput,
	scope: EmployeeScope,
	actorUserId: number
) {
	const before = await loadRow(id, scope);
	const row = await prisma.$transaction(async (tx) => {
		const saved = await tx.leaveBalance.update({
			where: { id },
			data: {
				...(input.entitlementDays !== undefined
					? { entitlementDays: dec(input.entitlementDays) }
					: {}),
				...(input.carriedForwardDays !== undefined
					? { carriedForwardDays: dec(input.carriedForwardDays) }
					: {}),
				updatedByUserId: actorUserId
			},
			include: ROW_INCLUDE
		});
		await auditUpdated(tx, {
			action: AuditAction.LEAVE_BALANCE_UPDATED,
			entityType: AuditEntity.LEAVE_BALANCE,
			entityId: id,
			employeeId: before.employeeId,
			before,
			after: saved,
			fields: ['entitlementDays', 'carriedForwardDays'],
			metadata: { year: before.year }
		});
		return saved;
	});
	const [item] = await present([row]);
	return item;
}

export async function addAdjustment(
	id: number,
	input: LeaveAdjustmentInput,
	scope: EmployeeScope,
	actorUserId: number
) {
	const row = await loadRow(id, scope);
	const created = await prisma.$transaction(async (tx) => {
		await lockEmployee(tx, row.employeeId);
		const before = await computeBalance(row.employeeId, row.leaveTypeId, row.year, tx);
		const after = before.base.plus(dec(input.days));
		if (after.isNegative()) {
			throw Errors.badRequest('BALANCE_NEGATIVE', 'ການປັບຍອດນີ້ເຮັດໃຫ້ສິດການລາຕິດລົບ');
		}
		const adjustment = await tx.leaveBalanceAdjustment.create({
			data: {
				leaveBalanceId: id,
				days: dec(input.days),
				reason: input.reason,
				createdByUserId: actorUserId
			},
			include: { createdBy: { select: { id: true, displayName: true } } }
		});
		// the adjustment REASON is free text and is intentionally not copied into the audit trail
		await writeAuditEvent(tx, {
			action: AuditAction.LEAVE_BALANCE_ADJUSTED,
			entityType: AuditEntity.LEAVE_BALANCE,
			entityId: id,
			employeeId: row.employeeId,
			actorUserId,
			changes: { balanceDays: { before: before.base.toString(), after: after.toString() } },
			metadata: { adjustmentId: adjustment.id, days: dec(input.days).toString(), year: row.year }
		});
		return adjustment;
	});
	return { adjustment: presentAdjustment(created), balance: await getBalanceById(id, scope) };
}

function presentAdjustment(a: {
	id: number;
	days: Prisma.Decimal;
	reason: string;
	createdAt: Date;
	createdBy: { id: number; displayName: string };
}) {
	return {
		id: a.id,
		days: a.days.toNumber(),
		reason: a.reason,
		createdAt: a.createdAt,
		createdBy: a.createdBy
	};
}

export async function listAdjustments(
	id: number,
	query: AdjustmentListQueryLike,
	scope: EmployeeScope
) {
	await loadRow(id, scope);
	const where = { leaveBalanceId: id };
	const [items, total] = await Promise.all([
		prisma.leaveBalanceAdjustment.findMany({
			where,
			include: { createdBy: { select: { id: true, displayName: true } } },
			orderBy: { createdAt: 'desc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.leaveBalanceAdjustment.count({ where })
	]);
	return {
		items: items.map(presentAdjustment),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}
