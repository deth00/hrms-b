import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { formatDateOnly, todayInLaos } from '../lib/dates.js';
import { isInScope, scopeToWhere, type EmployeeScope } from '../lib/employeeScope.js';
import { revokeAllUserSessions } from './session.service.js';
import { buildChanges } from '../lib/auditRedaction.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { assertUserCanBeDisabled } from './user.service.js';
import {
	assignmentsEqual,
	pickAssignment,
	validateAssignment,
	type AssignmentTarget
} from './employeeAssignment.service.js';
import type {
	EmployeeCreateInput,
	EmployeeListQuery,
	EmployeeStatusInput,
	EmployeeTransferInput,
	EmployeeUpdateInput
} from '../validation/employee.schema.js';

/** The authenticated user performing a mutation (stored as `createdByUserId` on history rows). */
export interface Actor {
	userId: number;
}

const PERSON_SELECT = {
	id: true,
	employeeCode: true,
	firstNameLao: true,
	lastNameLao: true,
	firstNameEnglish: true,
	lastNameEnglish: true
} satisfies Prisma.EmployeeSelect;

const ORG_SELECT = { select: { id: true, code: true, nameLao: true } } as const;

const RELATIONS = {
	company: ORG_SELECT,
	branch: ORG_SELECT,
	department: ORG_SELECT,
	division: ORG_SELECT,
	unit: ORG_SELECT,
	position: {
		select: {
			id: true,
			code: true,
			nameLao: true,
			nameEnglish: true,
			positionLevel: { select: { id: true, code: true, nameLao: true, rank: true } }
		}
	},
	manager: { select: PERSON_SELECT },
	employmentType: { select: { id: true, code: true, nameLao: true, nameEnglish: true } }
} satisfies Prisma.EmployeeInclude;

/** Linked-user summary. Deliberately excludes passwordHash and anything session-related. */
const USER_SUMMARY = {
	select: {
		id: true,
		username: true,
		email: true,
		displayName: true,
		status: true,
		roles: { select: { role: { select: { id: true, code: true, name: true } } } }
	}
} as const;

const DETAIL_INCLUDE = { ...RELATIONS, user: USER_SUMMARY } satisfies Prisma.EmployeeInclude;

/** The directory list leaves out the more sensitive personal identifiers; the detail page has them. */
const LIST_OMIT = {
	nationalId: true,
	passportNumber: true,
	dateOfBirth: true,
	address: true,
	village: true,
	district: true,
	note: true
} satisfies Prisma.EmployeeOmit;

type EmployeeDetailRow = Prisma.EmployeeGetPayload<{ include: typeof DETAIL_INCLUDE }>;

function toDetail(row: EmployeeDetailRow) {
	const { user, ...rest } = row;
	return {
		...rest,
		user: user
			? {
					id: user.id,
					username: user.username,
					email: user.email,
					displayName: user.displayName,
					status: user.status,
					roles: user.roles.map((r) => r.role)
				}
			: null
	};
}

function assertInScope(scope: EmployeeScope, employeeId: number): void {
	if (!isInScope(scope, employeeId)) throw Errors.forbidden();
}

function isUniqueViolation(err: unknown, field: string): boolean {
	return (
		err instanceof Prisma.PrismaClientKnownRequestError &&
		err.code === 'P2002' &&
		String(err.meta?.target ?? '').includes(field)
	);
}

/** A user may be linked to at most one Employee. `exceptEmployeeId` lets an employee keep its own link. */
async function assertUserLinkable(userId: number, exceptEmployeeId?: number): Promise<void> {
	const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
	if (!user) throw Errors.badRequest('INVALID_USER', 'ບໍ່ພົບບັນຊີຜູ້ໃຊ້ງານ');

	const linked = await prisma.employee.findUnique({
		where: { userId },
		select: { id: true }
	});
	if (linked && linked.id !== exceptEmployeeId) {
		throw Errors.conflict(
			'USER_ALREADY_LINKED',
			'ບັນຊີຜູ້ໃຊ້ງານນີ້ຖືກເຊື່ອມກັບພະນັກງານຄົນອື່ນແລ້ວ'
		);
	}
}

function assignmentOf(input: {
	companyId: number;
	branchId?: number | null;
	departmentId?: number | null;
	divisionId?: number | null;
	unitId?: number | null;
	positionId?: number | null;
	managerEmployeeId?: number | null;
	employmentTypeId?: number | null;
}): AssignmentTarget {
	return {
		companyId: input.companyId,
		branchId: input.branchId ?? null,
		departmentId: input.departmentId ?? null,
		divisionId: input.divisionId ?? null,
		unitId: input.unitId ?? null,
		positionId: input.positionId ?? null,
		managerEmployeeId: input.managerEmployeeId ?? null,
		employmentTypeId: input.employmentTypeId ?? null
	};
}

// ---------- read ----------

export async function listEmployees(query: EmployeeListQuery, scope: EmployeeScope) {
	const search = query.search;
	const where: Prisma.EmployeeWhereInput = {
		AND: [
			scopeToWhere(scope),
			{
				...(query.status ? { employmentStatus: query.status } : {}),
				...(query.companyId ? { companyId: query.companyId } : {}),
				...(query.branchId ? { branchId: query.branchId } : {}),
				...(query.departmentId ? { departmentId: query.departmentId } : {}),
				...(query.divisionId ? { divisionId: query.divisionId } : {}),
				...(query.unitId ? { unitId: query.unitId } : {}),
				...(query.positionId ? { positionId: query.positionId } : {}),
				...(query.employmentTypeId ? { employmentTypeId: query.employmentTypeId } : {})
			},
			search
				? {
						OR: [
							{ employeeCode: { contains: search } },
							{ firstNameLao: { contains: search } },
							{ lastNameLao: { contains: search } },
							{ firstNameEnglish: { contains: search } },
							{ lastNameEnglish: { contains: search } },
							{ workEmail: { contains: search } },
							{ phone: { contains: search } }
						]
					}
				: {}
		]
	};

	const [items, total] = await Promise.all([
		prisma.employee.findMany({
			where,
			include: RELATIONS,
			omit: LIST_OMIT,
			orderBy: { employeeCode: 'asc' },
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.employee.count({ where })
	]);

	return {
		items,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getEmployeeById(id: number, scope: EmployeeScope) {
	assertInScope(scope, id);
	const employee = await prisma.employee.findUnique({ where: { id }, include: DETAIL_INCLUDE });
	if (!employee) throw Errors.notFound('ບໍ່ພົບພະນັກງານ');
	return toDetail(employee);
}

export async function listAssignmentHistory(
	employeeId: number,
	page: number,
	pageSize: number,
	scope: EmployeeScope
) {
	assertInScope(scope, employeeId);
	const exists = await prisma.employee.count({ where: { id: employeeId } });
	if (!exists) throw Errors.notFound('ບໍ່ພົບພະນັກງານ');

	const where = { employeeId };
	const [items, total] = await Promise.all([
		prisma.employeeAssignmentHistory.findMany({
			where,
			include: {
				company: ORG_SELECT,
				branch: ORG_SELECT,
				department: ORG_SELECT,
				division: ORG_SELECT,
				unit: ORG_SELECT,
				position: ORG_SELECT,
				manager: { select: PERSON_SELECT },
				employmentType: { select: { id: true, code: true, nameLao: true } },
				createdBy: { select: { id: true, displayName: true } }
			},
			orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
			skip: (page - 1) * pageSize,
			take: pageSize
		}),
		prisma.employeeAssignmentHistory.count({ where })
	]);

	return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Compact picker used by the manager selector. Honors the caller's data scope. */
export function listEmployeeLookup(
	scope: EmployeeScope,
	options: { search?: string; companyId?: number }
) {
	const { search, companyId } = options;
	return prisma.employee.findMany({
		where: {
			AND: [
				scopeToWhere(scope),
				{ employmentStatus: { in: ['ACTIVE', 'PROBATION'] } },
				companyId ? { companyId } : {},
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
		select: {
			...PERSON_SELECT,
			employmentStatus: true,
			position: { select: { id: true, nameLao: true } },
			department: { select: { id: true, nameLao: true } }
		},
		orderBy: { employeeCode: 'asc' },
		take: 50
	});
}

/** Active users that are not yet linked to any Employee (plus, when editing, that employee's own user). */
export async function listAvailableUsers(options: {
	search?: string;
	includeForEmployeeId?: number;
}) {
	const { search, includeForEmployeeId } = options;
	const users = await prisma.user.findMany({
		where: {
			AND: [
				{
					OR: [
						{ status: 'ACTIVE', employee: null },
						...(includeForEmployeeId ? [{ employee: { id: includeForEmployeeId } }] : [])
					]
				},
				search
					? {
							OR: [
								{ username: { contains: search } },
								{ email: { contains: search } },
								{ displayName: { contains: search } }
							]
						}
					: {}
			]
		},
		select: {
			id: true,
			username: true,
			email: true,
			displayName: true,
			status: true,
			roles: { select: { role: { select: { id: true, code: true, name: true } } } }
		},
		orderBy: { username: 'asc' },
		take: 50
	});
	return users.map(({ roles, ...user }) => ({ ...user, roles: roles.map((r) => r.role) }));
}

// ---------- audit helpers ----------

const ASSIGNMENT_FIELDS = [
	'companyId',
	'branchId',
	'departmentId',
	'divisionId',
	'unitId',
	'positionId',
	'managerEmployeeId',
	'employmentTypeId'
] as const;

/** "{ id, label }" for an assignment target so the audit trail reads "IT → HR", not just cuids. */
async function assignmentLabel(tx: Prisma.TransactionClient, field: string, id: number | null) {
	if (!id) return null;
	let label: string | null | undefined;
	switch (field) {
		case 'companyId':
			label = (await tx.company.findUnique({ where: { id }, select: { nameLao: true } }))?.nameLao;
			break;
		case 'branchId':
			label = (await tx.branch.findUnique({ where: { id }, select: { nameLao: true } }))?.nameLao;
			break;
		case 'departmentId':
			label = (await tx.department.findUnique({ where: { id }, select: { nameLao: true } }))
				?.nameLao;
			break;
		case 'divisionId':
			label = (await tx.division.findUnique({ where: { id }, select: { nameLao: true } }))?.nameLao;
			break;
		case 'unitId':
			label = (await tx.unit.findUnique({ where: { id }, select: { nameLao: true } }))?.nameLao;
			break;
		case 'positionId':
			label = (await tx.position.findUnique({ where: { id }, select: { nameLao: true } }))?.nameLao;
			break;
		case 'employmentTypeId':
			label = (await tx.employmentType.findUnique({ where: { id }, select: { nameLao: true } }))
				?.nameLao;
			break;
		case 'managerEmployeeId': {
			const m = await tx.employee.findUnique({
				where: { id },
				select: { employeeCode: true, firstNameLao: true, lastNameLao: true }
			});
			label = m ? `${m.employeeCode} ${m.firstNameLao} ${m.lastNameLao}` : null;
			break;
		}
	}
	return { id, label: label ?? null };
}

// ---------- create ----------

export async function createEmployee(input: EmployeeCreateInput, actor: Actor) {
	const codeTaken = await prisma.employee.findUnique({
		where: { employeeCode: input.employeeCode },
		select: { id: true }
	});
	if (codeTaken) throw Errors.conflict('EMPLOYEE_CODE_TAKEN', 'ລະຫັດພະນັກງານນີ້ຖືກໃຊ້ແລ້ວ');

	const target = assignmentOf(input);
	await validateAssignment(target, { requireEmploymentType: true });
	if (input.userId) await assertUserLinkable(input.userId);

	try {
		const created = await prisma.$transaction(async (tx) => {
			const employee = await tx.employee.create({ data: input });
			// First assignment-history row: the employee's starting placement.
			await tx.employeeAssignmentHistory.create({
				data: {
					employeeId: employee.id,
					...target,
					effectiveFrom: input.startDate,
					reason: 'ເລີ່ມຕົ້ນການຈ້າງງານ',
					createdByUserId: actor.userId
				}
			});
			await writeAuditEvent(tx, {
				action: AuditAction.EMPLOYEE_CREATED,
				entityType: AuditEntity.EMPLOYEE,
				entityId: employee.id,
				companyId: employee.companyId,
				employeeId: employee.id,
				actorUserId: actor.userId,
				// identifiers only — no national id / passport / contact details
				metadata: {
					employeeCode: employee.employeeCode,
					departmentId: employee.departmentId,
					positionId: employee.positionId,
					linkedUserId: employee.userId
				}
			});
			return employee;
		});
		return await getEmployeeDetail(created.id);
	} catch (err) {
		if (isUniqueViolation(err, 'employee_code')) {
			throw Errors.conflict('EMPLOYEE_CODE_TAKEN', 'ລະຫັດພະນັກງານນີ້ຖືກໃຊ້ແລ້ວ');
		}
		if (isUniqueViolation(err, 'user_id')) {
			throw Errors.conflict(
				'USER_ALREADY_LINKED',
				'ບັນຊີຜູ້ໃຊ້ງານນີ້ຖືກເຊື່ອມກັບພະນັກງານຄົນອື່ນແລ້ວ'
			);
		}
		throw err;
	}
}

async function getEmployeeDetail(id: number) {
	const employee = await prisma.employee.findUniqueOrThrow({
		where: { id },
		include: DETAIL_INCLUDE
	});
	return toDetail(employee);
}

// ---------- profile update (never touches assignment) ----------

export async function updateEmployee(id: number, input: EmployeeUpdateInput, scope: EmployeeScope) {
	assertInScope(scope, id);
	const existing = await prisma.employee.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບພະນັກງານ');

	const startDate = input.startDate ?? existing.startDate;
	const probationEndDate =
		input.probationEndDate !== undefined ? input.probationEndDate : existing.probationEndDate;
	if (probationEndDate && probationEndDate < startDate) {
		throw Errors.badRequest(
			'INVALID_PROBATION_END_DATE',
			'ວັນສິ້ນສຸດທົດລອງງານຕ້ອງບໍ່ກ່ອນວັນເລີ່ມງານ'
		);
	}
	if (existing.endDate && existing.endDate < startDate) {
		throw Errors.badRequest('INVALID_START_DATE', 'ວັນເລີ່ມງານຕ້ອງບໍ່ຫຼັງວັນສິ້ນສຸດການຈ້າງງານ');
	}

	if (input.userId) await assertUserLinkable(input.userId, id);

	try {
		await prisma.$transaction(async (tx) => {
			const updated = await tx.employee.update({ where: { id }, data: input });
			const { userId: nextUserId, ...profile } = input;
			void nextUserId;
			const changes = buildChanges(
				existing as unknown as Record<string, unknown>,
				updated as unknown as Record<string, unknown>,
				Object.keys(profile)
			);
			const base = {
				entityType: AuditEntity.EMPLOYEE,
				entityId: id,
				companyId: existing.companyId,
				employeeId: id
			} as const;
			if (changes) {
				await writeAuditEvent(tx, {
					...base,
					action: AuditAction.EMPLOYEE_UPDATED,
					changes,
					metadata: { employeeCode: existing.employeeCode }
				});
			}
			if (updated.userId !== existing.userId) {
				await writeAuditEvent(tx, {
					...base,
					action: AuditAction.EMPLOYEE_USER_LINK_CHANGED,
					changes: { userId: { before: existing.userId, after: updated.userId } },
					metadata: { employeeCode: existing.employeeCode }
				});
			}
		});
	} catch (err) {
		if (isUniqueViolation(err, 'user_id')) {
			throw Errors.conflict(
				'USER_ALREADY_LINKED',
				'ບັນຊີຜູ້ໃຊ້ງານນີ້ຖືກເຊື່ອມກັບພະນັກງານຄົນອື່ນແລ້ວ'
			);
		}
		throw err;
	}
	return getEmployeeDetail(id);
}

// ---------- transfer / assignment change ----------

export async function transferEmployee(
	id: number,
	input: EmployeeTransferInput,
	actor: Actor,
	scope: EmployeeScope
) {
	assertInScope(scope, id);
	const existing = await prisma.employee.findUnique({ where: { id } });
	if (!existing) throw Errors.notFound('ບໍ່ພົບພະນັກງານ');

	if (existing.employmentStatus === 'RESIGNED' || existing.employmentStatus === 'TERMINATED') {
		throw Errors.badRequest(
			'EMPLOYEE_ENDED',
			'ບໍ່ສາມາດຍ້າຍ ຫຼື ປ່ຽນຕຳແໜ່ງພະນັກງານທີ່ລາອອກ ຫຼື ຢຸດຈ້າງແລ້ວ'
		);
	}

	const current = pickAssignment(existing);
	// Omitted field = keep the current value; explicit null = clear it.
	const target: AssignmentTarget = {
		companyId: input.companyId ?? current.companyId,
		branchId: input.branchId !== undefined ? input.branchId : current.branchId,
		departmentId: input.departmentId !== undefined ? input.departmentId : current.departmentId,
		divisionId: input.divisionId !== undefined ? input.divisionId : current.divisionId,
		unitId: input.unitId !== undefined ? input.unitId : current.unitId,
		positionId: input.positionId !== undefined ? input.positionId : current.positionId,
		managerEmployeeId:
			input.managerEmployeeId !== undefined ? input.managerEmployeeId : current.managerEmployeeId,
		employmentTypeId:
			input.employmentTypeId !== undefined ? input.employmentTypeId : current.employmentTypeId
	};

	if (assignmentsEqual(current, target)) {
		throw Errors.badRequest('NO_CHANGES', 'ບໍ່ມີການປ່ຽນແປງຂໍ້ມູນການມອບໝາຍ');
	}

	await validateAssignment(target, { employeeId: id, current });

	const effectiveDate = input.effectiveDate ?? todayInLaos();
	if (effectiveDate > todayInLaos()) {
		throw Errors.badRequest('INVALID_EFFECTIVE_DATE', 'ວັນທີ່ມີຜົນບໍ່ສາມາດເປັນວັນໃນອະນາຄົດ');
	}

	await prisma.$transaction(async (tx) => {
		const open = await tx.employeeAssignmentHistory.findFirst({
			where: { employeeId: id, effectiveTo: null },
			orderBy: { effectiveFrom: 'desc' }
		});

		if (open) {
			// Rejecting a date before the open row's start keeps intervals from overlapping.
			if (effectiveDate < open.effectiveFrom) {
				throw Errors.badRequest(
					'INVALID_EFFECTIVE_DATE',
					`ວັນທີ່ມີຜົນຕ້ອງບໍ່ກ່ອນວັນທີ່ການມອບໝາຍປັດຈຸບັນເລີ່ມ (${formatDateOnly(open.effectiveFrom)})`
				);
			}
			await tx.employeeAssignmentHistory.update({
				where: { id: open.id },
				data: { effectiveTo: effectiveDate }
			});
		}

		await tx.employeeAssignmentHistory.create({
			data: {
				employeeId: id,
				...target,
				effectiveFrom: effectiveDate,
				reason: input.reason ?? null,
				createdByUserId: actor.userId
			}
		});

		await tx.employee.update({ where: { id }, data: target });

		const changes: Record<string, unknown> = {};
		for (const field of ASSIGNMENT_FIELDS) {
			const before = current[field] ?? null;
			const after = target[field] ?? null;
			if (before === after) continue;
			changes[field] = {
				before: await assignmentLabel(tx, field, before),
				after: await assignmentLabel(tx, field, after)
			};
		}
		await writeAuditEvent(tx, {
			action: AuditAction.EMPLOYEE_TRANSFERRED,
			entityType: AuditEntity.EMPLOYEE,
			entityId: id,
			companyId: target.companyId,
			employeeId: id,
			actorUserId: actor.userId,
			changes,
			metadata: {
				employeeCode: existing.employeeCode,
				effectiveDate: formatDateOnly(effectiveDate)
			}
		});
	});

	return getEmployeeDetail(id);
}

// ---------- employment status ----------

export async function changeEmployeeStatus(
	id: number,
	input: EmployeeStatusInput,
	actor: Actor,
	scope: EmployeeScope
) {
	assertInScope(scope, id);
	const existing = await prisma.employee.findUnique({
		where: { id },
		select: {
			id: true,
			startDate: true,
			note: true,
			userId: true,
			employmentStatus: true,
			endDate: true,
			companyId: true,
			employeeCode: true
		}
	});
	if (!existing) throw Errors.notFound('ບໍ່ພົບພະນັກງານ');

	const ending = input.status === 'RESIGNED' || input.status === 'TERMINATED';
	const endDate = ending ? (input.endDate ?? null) : null;
	if (endDate && endDate < existing.startDate) {
		throw Errors.badRequest('INVALID_END_DATE', 'ວັນທີ່ສິ້ນສຸດການຈ້າງງານຕ້ອງບໍ່ກ່ອນວັນເລີ່ມງານ');
	}

	if (input.disableLinkedUser) {
		if (!existing.userId) {
			throw Errors.badRequest('NO_LINKED_USER', 'ພະນັກງານນີ້ບໍ່ມີບັນຊີເຂົ້າລະບົບທີ່ເຊື່ອມໂຍງ');
		}
		if (existing.userId === actor.userId) {
			throw Errors.badRequest('CANNOT_DISABLE_SELF', 'ບໍ່ສາມາດປິດບັນຊີເຂົ້າລະບົບຂອງຕົນເອງໄດ້');
		}
		await assertUserCanBeDisabled(existing.userId);
	}

	const stamp = formatDateOnly(input.effectiveDate ?? todayInLaos());
	const noteLine = input.reason ? `[${stamp}] ${input.status}: ${input.reason}` : null;
	const note = noteLine ? [existing.note, noteLine].filter(Boolean).join('\n') : undefined;

	// Employee + linked User change together or not at all.
	await prisma.$transaction(async (tx) => {
		await tx.employee.update({
			where: { id },
			data: { employmentStatus: input.status, endDate, ...(note !== undefined ? { note } : {}) }
		});

		if (input.disableLinkedUser && existing.userId) {
			await tx.user.update({ where: { id: existing.userId }, data: { status: 'INACTIVE' } });
			await revokeAllUserSessions(existing.userId, undefined, tx);
		}

		await writeAuditEvent(tx, {
			action: AuditAction.EMPLOYEE_STATUS_CHANGED,
			entityType: AuditEntity.EMPLOYEE,
			entityId: id,
			companyId: existing.companyId,
			employeeId: id,
			actorUserId: actor.userId,
			// the free-text reason stays in the employee note — it is not copied into the audit trail
			changes: buildChanges(
				{ employmentStatus: existing.employmentStatus, endDate: existing.endDate },
				{ employmentStatus: input.status, endDate },
				['employmentStatus', 'endDate']
			),
			metadata: {
				employeeCode: existing.employeeCode,
				linkedUserDisabled: !!(input.disableLinkedUser && existing.userId)
			}
		});
		if (input.disableLinkedUser && existing.userId) {
			await writeAuditEvent(tx, {
				action: AuditAction.USER_DISABLED,
				entityType: AuditEntity.USER,
				entityId: existing.userId,
				actorUserId: actor.userId,
				employeeId: id,
				changes: { status: { before: 'ACTIVE', after: 'INACTIVE' } },
				metadata: { via: 'EMPLOYEE_STATUS_CHANGE', sessionsRevoked: true }
			});
		}
	});

	return getEmployeeDetail(id);
}
