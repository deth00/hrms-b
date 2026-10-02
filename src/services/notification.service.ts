import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { sanitizeForAudit } from '../lib/auditRedaction.js';
import type { NotificationListQuery } from '../validation/notification.schema.js';

/**
 * In-app notifications. NOT the audit log (that is a compliance trail); these are per-user inbox
 * items. Rows are created inside the SAME transaction as the state change that caused them, with a
 * deterministic `dedupeKey` so a retry or a concurrent duplicate can never notify a user twice.
 * Access is owner-only: every read/update is scoped by the authenticated user's id.
 */
type Db = Prisma.TransactionClient | typeof prisma;

export const NotificationType = {
	APPROVAL_ACTION_REQUIRED: 'APPROVAL_ACTION_REQUIRED',
	REQUEST_APPROVED: 'REQUEST_APPROVED',
	REQUEST_REJECTED: 'REQUEST_REJECTED',
	REQUEST_CANCELLED: 'REQUEST_CANCELLED',
	/** reserved: requester-facing "moved to step N" — not emitted (too noisy) */
	APPROVAL_STEP_ADVANCED: 'APPROVAL_STEP_ADVANCED',
	APPROVAL_STEP_REASSIGNED: 'APPROVAL_STEP_REASSIGNED',
	/** reserved: blocked-workflow alert — needs a scheduler, deliberately not implemented */
	WORKFLOW_BLOCKED: 'WORKFLOW_BLOCKED',
	/** Phase 13 — an employee's payslip was issued (period only, never an amount) */
	PAYSLIP_ISSUED: 'PAYSLIP_ISSUED',
	/** Phase 14 — the employee's payment item was confirmed PAID (period only — no amount, no account) */
	PAYROLL_PAYMENT_PAID: 'PAYROLL_PAYMENT_PAID',
	/** Phase 15 — the employee's PAID payment was reversed (period only — no amount / account / bank ref) */
	PAYROLL_PAYMENT_REVERSED: 'PAYROLL_PAYMENT_REVERSED'
} as const;
export const NOTIFICATION_TYPES = Object.values(NotificationType);
export type NotificationTypeCode = (typeof NOTIFICATION_TYPES)[number];

export interface NewNotification {
	userId: number;
	type: NotificationTypeCode;
	titleLao: string;
	bodyLao?: string | null;
	link?: string | null;
	metadata?: Record<string, unknown> | null;
	dedupeKey?: string | null;
}

/** Idempotent bulk insert: rows whose (userId, dedupeKey) already exists are skipped silently. */
export async function createNotifications(db: Db, items: NewNotification[]) {
	if (items.length === 0) return 0;
	const result = await db.notification.createMany({
		data: items.map((n) => ({
			userId: n.userId,
			type: n.type,
			titleLao: n.titleLao,
			bodyLao: n.bodyLao ?? null,
			link: n.link ?? null,
			metadataJson: n.metadata
				? (sanitizeForAudit(n.metadata) as Prisma.InputJsonObject)
				: Prisma.DbNull,
			dedupeKey: n.dedupeKey ?? null
		})),
		skipDuplicates: true
	});
	return result.count;
}

const SELECT = {
	id: true,
	type: true,
	titleLao: true,
	bodyLao: true,
	link: true,
	metadataJson: true,
	readAt: true,
	createdAt: true
} satisfies Prisma.NotificationSelect;

const present = (n: Prisma.NotificationGetPayload<{ select: typeof SELECT }>) => ({
	id: n.id,
	type: n.type,
	titleLao: n.titleLao,
	bodyLao: n.bodyLao,
	link: n.link,
	metadata: n.metadataJson,
	isRead: n.readAt !== null,
	readAt: n.readAt,
	createdAt: n.createdAt
});

export async function listNotifications(userId: number, query: NotificationListQuery) {
	const where: Prisma.NotificationWhereInput = {
		userId,
		...(query.unreadOnly ? { readAt: null } : {}),
		...(query.type ? { type: query.type } : {})
	};
	const [rows, total, unreadCount] = await Promise.all([
		prisma.notification.findMany({
			where,
			select: SELECT,
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			skip: (query.page - 1) * query.pageSize,
			take: query.pageSize
		}),
		prisma.notification.count({ where }),
		prisma.notification.count({ where: { userId, readAt: null } })
	]);
	return {
		items: rows.map(present),
		unreadCount,
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / query.pageSize))
	};
}

export async function unreadCount(userId: number) {
	return { unreadCount: await prisma.notification.count({ where: { userId, readAt: null } }) };
}

/** Owner-only + idempotent. Somebody else's id is indistinguishable from a missing one (404). */
export async function markRead(userId: number, id: number) {
	const row = await prisma.notification.findFirst({ where: { id, userId }, select: { id: true } });
	if (!row) throw Errors.notFound('ບໍ່ພົບການແຈ້ງເຕືອນ');
	await prisma.notification.updateMany({
		where: { id, userId, readAt: null },
		data: { readAt: new Date() }
	});
	return present(
		await prisma.notification.findFirstOrThrow({ where: { id, userId }, select: SELECT })
	);
}

export async function markAllRead(userId: number) {
	const result = await prisma.notification.updateMany({
		where: { userId, readAt: null },
		data: { readAt: new Date() }
	});
	return { updated: result.count, unreadCount: 0 };
}
