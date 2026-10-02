import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { VIEW_ALL_PERMISSION } from '../lib/employeeScope.js';
import { sanitizeForAudit } from '../lib/auditRedaction.js';
import type { AuthContext } from '../types/express.js';
import type { AuditListQuery } from '../validation/audit.schema.js';
import { auditEntityIdAliases } from './auditEntityAlias.js';

/**
 * READ side of the audit trail. The global log names users and employees across the whole
 * organisation, so on top of `audit.view` (checked by the route) the caller must also hold the
 * company-wide employee scope (`employees.view_all`). Output is sanitised again on the way out.
 */
const LAOS_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

const INCLUDE = {
	actor: { select: { id: true, username: true, displayName: true } },
	employee: {
		select: {
			id: true,
			employeeCode: true,
			firstNameLao: true,
			lastNameLao: true,
			firstNameEnglish: true,
			lastNameEnglish: true
		}
	},
	company: { select: { id: true, code: true, nameLao: true } }
} satisfies Prisma.AuditEventInclude;
type Row = Prisma.AuditEventGetPayload<{ include: typeof INCLUDE }>;

function assertAuditScope(auth: AuthContext) {
	if (!auth.permissions.includes('audit.view') || !auth.permissions.includes(VIEW_ALL_PERMISSION)) {
		throw Errors.forbidden();
	}
}

function presentList(r: Row) {
	const changes = r.changesJson as Record<string, unknown> | null;
	return {
		id: r.id,
		createdAt: r.createdAt,
		action: r.action,
		entityType: r.entityType,
		entityId: r.entityId,
		requestId: r.requestId,
		ipAddress: r.ipAddress,
		actor: r.actor,
		employee: r.employee,
		company: r.company,
		changedFields: changes && typeof changes === 'object' ? Object.keys(changes) : []
	};
}

function presentDetail(r: Row) {
	return {
		...presentList(r),
		userAgent: r.userAgent,
		changes: r.changesJson === null ? null : sanitizeForAudit(r.changesJson),
		metadata: r.metadataJson === null ? null : sanitizeForAudit(r.metadataJson)
	};
}

export async function listAuditEvents(query: AuditListQuery, auth: AuthContext) {
	assertAuditScope(auth);
	const and: Prisma.AuditEventWhereInput[] = [];
	// a Laos calendar day: [00:00, 24:00) at UTC+7
	if (query.from) and.push({ createdAt: { gte: new Date(query.from.getTime() - LAOS_OFFSET_MS) } });
	if (query.to) {
		and.push({ createdAt: { lt: new Date(query.to.getTime() + DAY_MS - LAOS_OFFSET_MS) } });
	}
	if (query.actorUserId) and.push({ actorUserId: query.actorUserId });
	if (query.action) {
		// "LEAVE" (a module) or a full code "LEAVE.APPROVED"
		and.push(
			query.action.includes('.')
				? { action: query.action }
				: { action: { startsWith: `${query.action}.` } }
		);
	}
	if (query.entityType) and.push({ entityType: query.entityType });
	if (query.entityId) {
		// numeric-ID migration (M9): one entity's history = events keyed by its numeric id AND by its legacy CUID
		and.push({ entityId: { in: await auditEntityIdAliases(query.entityId, query.entityType) } });
	}
	if (query.companyId) and.push({ companyId: query.companyId });
	if (query.employeeId) and.push({ employeeId: query.employeeId });
	if (query.search) {
		const s = query.search;
		and.push({
			OR: [
				{ action: { contains: s } },
				{ entityType: { contains: s } },
				{ entityId: s },
				{
					actor: { is: { OR: [{ displayName: { contains: s } }, { username: { contains: s } }] } }
				},
				{
					employee: {
						is: {
							OR: [
								{ employeeCode: { contains: s } },
								{ firstNameLao: { contains: s } },
								{ lastNameLao: { contains: s } },
								{ firstNameEnglish: { contains: s } },
								{ lastNameEnglish: { contains: s } }
							]
						}
					}
				}
			]
		});
	}
	const where: Prisma.AuditEventWhereInput = and.length ? { AND: and } : {};
	const [rows, total] = await Promise.all([
		prisma.auditEvent.findMany({
			where,
			include: INCLUDE,
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.auditEvent.count({ where })
	]);
	return {
		items: rows.map(presentList),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function getAuditEvent(id: number, auth: AuthContext) {
	assertAuditScope(auth);
	const row = await prisma.auditEvent.findUnique({ where: { id }, include: INCLUDE });
	if (!row) throw Errors.notFound('ບໍ່ພົບບັນທຶກປະຫວັດການໃຊ້ງານ');
	return presentDetail(row);
}
