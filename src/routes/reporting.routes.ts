import { Router } from 'express';
import * as controller from '../controllers/reporting.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePermission } from '../middlewares/requirePermission.js';
import { requireReport, requireReportParam } from '../middlewares/requireReport.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import {
	accountingReportQuerySchema,
	exportBodySchema,
	savedFilterCreateSchema,
	savedFilterListQuerySchema,
	savedFilterUpdateSchema,
	attendanceReportQuerySchema,
	dashboardQuerySchema,
	employeeReportQuerySchema,
	leaveReportQuerySchema,
	overtimeReportQuerySchema,
	paymentReportQuerySchema,
	payrollReportQuerySchema
} from '../validation/reporting.schema.js';

/**
 * Phase 17A — READ-ONLY dashboard + summary reports. There are only GET routes: reporting never writes.
 * Each report needs `reports.view` AND its domain permission(s) (requireReport); the money reports also
 * need `employees.view_all`. Data scope and company isolation are enforced again in the services.
 */
export const reportingRouter = Router();
reportingRouter.use('/dashboard', requireAuth);
reportingRouter.use('/reports', requireAuth);

reportingRouter.get(
	'/dashboard/summary',
	requirePermission('dashboard.view'),
	validateQuery(dashboardQuerySchema),
	controller.dashboard
);

reportingRouter.get(
	'/reports/filter-options',
	requirePermission('reports.view'),
	controller.filterOptions
);
reportingRouter.get(
	'/reports/employees/summary',
	requireReport('employees'),
	validateQuery(employeeReportQuerySchema),
	controller.employees
);
reportingRouter.get(
	'/reports/attendance/summary',
	requireReport('attendance'),
	validateQuery(attendanceReportQuerySchema),
	controller.attendance
);
reportingRouter.get(
	'/reports/leave/summary',
	requireReport('leave'),
	validateQuery(leaveReportQuerySchema),
	controller.leave
);
reportingRouter.get(
	'/reports/overtime/summary',
	requireReport('overtime'),
	validateQuery(overtimeReportQuerySchema),
	controller.overtime
);
reportingRouter.get(
	'/reports/payroll/summary',
	requireReport('payroll'),
	validateQuery(payrollReportQuerySchema),
	controller.payroll
);
reportingRouter.get(
	'/reports/payments/summary',
	requireReport('payments'),
	validateQuery(paymentReportQuerySchema),
	controller.payments
);
reportingRouter.get(
	'/reports/accounting/summary',
	requireReport('accounting'),
	validateQuery(accountingReportQuerySchema),
	controller.accounting
);

// ---------- Phase 17B — saved filters (own only; reports.view + the report's domain, checked in the
// service), then the per-report detail / catalogue / export routes ----------
reportingRouter.get(
	'/reports/saved-filters',
	requirePermission('reports.view'),
	validateQuery(savedFilterListQuerySchema),
	controller.listSaved
);
reportingRouter.get(
	'/reports/saved-filters/:id',
	requirePermission('reports.view'),
	validateParams(idParamSchema),
	controller.getSaved
);
reportingRouter.post(
	'/reports/saved-filters',
	requirePermission('reports.view'),
	validateBody(savedFilterCreateSchema),
	controller.createSaved
);
reportingRouter.put(
	'/reports/saved-filters/:id',
	requirePermission('reports.view'),
	validateParams(idParamSchema),
	validateBody(savedFilterUpdateSchema),
	controller.updateSaved
);
reportingRouter.delete(
	'/reports/saved-filters/:id',
	requirePermission('reports.view'),
	validateParams(idParamSchema),
	controller.deleteSaved
);

reportingRouter.get('/reports/:reportType/fields', requireReportParam(), controller.fields);
reportingRouter.get('/reports/:reportType/detail', requireReportParam(), controller.detail);
reportingRouter.post(
	'/reports/:reportType/export',
	requireReportParam({ export: true }),
	validateBody(exportBodySchema),
	controller.exportFile
);
