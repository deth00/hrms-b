import type { AuthContext } from '../../types/express.js';
import type { DashboardQuery } from '../../validation/reporting.schema.js';
import { auditListQuerySchema } from '../../validation/audit.schema.js';
import { notificationListQuerySchema } from '../../validation/notification.schema.js';
import { inboxQuerySchema } from '../../validation/approval.schema.js';
import { VIEW_ALL_PERMISSION } from '../../lib/employeeScope.js';
import { listInbox } from '../approval.service.js';
import { listAuditEvents } from '../auditQuery.service.js';
import { listNotifications } from '../notification.service.js';
import { holdsDomain, resolveReportingContext } from './reportingScope.service.js';
import { distribution, headcount } from './employeeReporting.service.js';
import { attendanceSnapshot } from './attendanceReporting.service.js';
import { payrollOperational } from './payrollReporting.service.js';
import { paymentOperational } from './paymentReporting.service.js';
import { accountingOperational } from './accountingReporting.service.js';
import { REPORT_TIMEZONE, ReportErrors, isoDate, reportToday } from './reportingCommon.js';

/**
 * Phase 17A — GET /dashboard/summary: ONE request, widgets computed concurrently on the server.
 *
 * Convention: every widget key is ALWAYS present; a widget the caller may not see is `null` — its data is
 * never computed, so nothing sensitive is ever sent and merely hidden by the UI.
 *   employees      employees.view                 (data scope applies; org filters apply)
 *   attendance     attendance.view                (data scope applies; org filters apply)
 *   approvals      any user — the Approvals "waiting for me" inbox itself (`listInbox`, same candidate
 *                  rules; company filter only)
 *   recentActivity audit.view + employees.view_all → sanitized audit events (same rule as the audit log);
 *                  otherwise the caller's OWN notifications
 *   payroll        payroll.view + employees.view_all            (operational counts, no amounts)
 *   payments       payroll.payment.view + employees.view_all    (settlement counts, no amounts / bank data)
 *   accounting     payroll.accounting.view + employees.view_all (journal counts, no amounts)
 * "Today" is the canonical Laos business date (todayInLaos — the attendance / payroll helper).
 */
const ACTIVITY_LIMIT = 8;

export async function getDashboardSummary(auth: AuthContext, query: DashboardQuery) {
	const today = reportToday();
	const date = query.date ?? today;
	if (date.getTime() > today.getTime()) {
		throw ReportErrors.rangeInvalid('ບໍ່ສາມາດເລືອກວັນທີໃນອະນາຄົດໄດ້');
	}
	const perms = auth.permissions;
	const ctx = await resolveReportingContext(auth, {
		companyId: query.companyId,
		branchId: query.branchId,
		departmentId: query.departmentId
	});
	const companyId = ctx.filter.companyId;
	const auditAllowed = perms.includes('audit.view') && perms.includes(VIEW_ALL_PERMISSION);

	const [employees, attendance, approvals, recentActivity, payroll, payments, accounting] =
		await Promise.all([
			perms.includes('employees.view')
				? Promise.all([
						headcount(ctx),
						distribution(ctx, 'branch'),
						distribution(ctx, 'department')
					]).then(([totals, byBranch, byDepartment]) => ({
						...totals,
						byBranch: byBranch.slice(0, 8),
						byDepartment: byDepartment.slice(0, 8)
					}))
				: null,
			perms.includes('attendance.view') ? attendanceSnapshot(ctx, date) : null,
			listInbox(
				{ userId: auth.user.id, permissions: perms },
				inboxQuerySchema.parse({ pageSize: 5, ...(companyId ? { companyId } : {}) })
			).then((inbox) => ({
				waitingForMe: inbox.total,
				items: inbox.items.map((i) => ({
					id: i.id,
					targetType: i.targetType,
					targetId: i.targetId,
					title: i.summary?.title ?? null,
					employee: i.employee
						? {
								id: i.employee.id,
								employeeCode: i.employee.employeeCode,
								firstNameLao: i.employee.firstNameLao,
								lastNameLao: i.employee.lastNameLao
							}
						: null,
					submittedAt: i.submittedAt,
					currentStep: i.currentStep,
					totalSteps: i.totalSteps,
					waitingMinutes: i.waitingMinutes
				}))
			})),
			auditAllowed
				? listAuditEvents(
						auditListQuerySchema.parse({
							pageSize: ACTIVITY_LIMIT,
							...(companyId ? { companyId } : {})
						}),
						auth
					).then((r) => ({
						source: 'AUDIT' as const,
						items: r.items.map((e) => ({
							id: e.id,
							at: e.createdAt,
							action: e.action,
							entityType: e.entityType,
							actor: e.actor?.displayName ?? null,
							employee: e.employee
								? {
										employeeCode: e.employee.employeeCode,
										firstNameLao: e.employee.firstNameLao,
										lastNameLao: e.employee.lastNameLao
									}
								: null,
							title: null,
							link: null
						}))
					}))
				: listNotifications(
						auth.user.id,
						notificationListQuerySchema.parse({ pageSize: ACTIVITY_LIMIT })
					).then((r) => ({
						source: 'NOTIFICATIONS' as const,
						items: r.items.map((n) => ({
							id: n.id,
							at: n.createdAt,
							action: n.type,
							entityType: null,
							actor: null,
							employee: null,
							title: n.titleLao,
							link: n.link
						}))
					})),
			holdsDomain(perms, 'payroll') ? payrollOperational(companyId) : null,
			holdsDomain(perms, 'payments') ? paymentOperational(companyId) : null,
			holdsDomain(perms, 'accounting') ? accountingOperational(companyId) : null
		]);

	return {
		generatedAt: new Date(),
		context: {
			date: isoDate(date),
			today: isoDate(today),
			timezone: REPORT_TIMEZONE,
			companyId: companyId ?? null,
			branchId: ctx.filter.branchId ?? null,
			departmentId: ctx.filter.departmentId ?? null,
			scope: ctx.scope.all ? 'ALL' : 'TEAM'
		},
		employees,
		attendance,
		approvals,
		recentActivity,
		payroll,
		payments,
		accounting
	};
}
