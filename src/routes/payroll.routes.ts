import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/payroll.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import {
	requirePayrollAccess,
	requirePayrollAccessAny,
	requirePermission
} from '../middlewares/requirePermission.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import {
	adjustmentCreateSchema,
	compensationCreateSchema,
	payComponentCreateSchema,
	payComponentListQuerySchema,
	payComponentUpdateSchema,
	payrollSettingsQuerySchema,
	payrollSettingsUpdateSchema,
	periodCreateSchema,
	periodListQuerySchema,
	periodUpdateSchema,
	recurringAssignSchema,
	recurringEndSchema,
	resultListQuerySchema,
	runCreateSchema,
	runFinalizeSchema,
	runListQuerySchema
} from '../validation/payroll.schema.js';
import {
	generatePeriodsSchema,
	scheduleCreateSchema,
	scheduleListQuerySchema,
	scheduleUpdateSchema
} from '../validation/payrollSchedule.schema.js';
import { ruleCreateSchema, ruleListQuerySchema } from '../validation/payrollRules.schema.js';
import {
	statutoryRuleCreateSchema,
	statutoryRuleListQuerySchema
} from '../validation/payrollStatutoryRule.schema.js';
import { statutoryProfileUpdateSchema } from '../validation/employeeStatutoryProfile.schema.js';

/**
 * PAYROLL. Every salary-bearing endpoint needs its dedicated permission AND the company-wide
 * employee scope (`employees.view_all`) — see requirePayrollAccess. Only the Pay Component master
 * data (no employee amounts) needs the plain permission. There is NO delete route anywhere.
 */
export const payrollRouter = Router();
payrollRouter.use(requireAuth);

const runEmployeeParams = z.object({
	runId: z.string().trim().min(1),
	employeeId: z.string().trim().min(1)
});

// ---------- settings ----------
payrollRouter.get(
	'/payroll/settings',
	requirePayrollAccess('payroll.view'),
	validateQuery(payrollSettingsQuerySchema),
	controller.getSettings
);
payrollRouter.put(
	'/payroll/settings',
	requirePayrollAccess('payroll.manage'),
	validateQuery(payrollSettingsQuerySchema),
	validateBody(payrollSettingsUpdateSchema),
	controller.updateSettings
);

// ---------- pay components ----------
payrollRouter.get(
	'/pay-components',
	requirePermission('pay_components.view'),
	validateQuery(payComponentListQuerySchema),
	controller.listComponents
);
payrollRouter.get(
	'/pay-components/:id',
	requirePermission('pay_components.view'),
	validateParams(idParamSchema),
	controller.getComponent
);
payrollRouter.post(
	'/pay-components',
	requirePermission('pay_components.manage'),
	validateBody(payComponentCreateSchema),
	controller.createComponent
);
payrollRouter.patch(
	'/pay-components/:id',
	requirePermission('pay_components.manage'),
	validateParams(idParamSchema),
	validateBody(payComponentUpdateSchema),
	controller.updateComponent
);

// ---------- employee compensation ----------
payrollRouter.get(
	'/employees/:id/compensation',
	requirePayrollAccess('compensation.view'),
	validateParams(idParamSchema),
	controller.getCompensation
);
payrollRouter.get(
	'/employees/:id/compensation-history',
	requirePayrollAccess('compensation.view'),
	validateParams(idParamSchema),
	controller.compensationHistory
);
payrollRouter.post(
	'/employees/:id/compensation',
	requirePayrollAccess('compensation.manage'),
	validateParams(idParamSchema),
	validateBody(compensationCreateSchema),
	controller.createCompensation
);
payrollRouter.get(
	'/employees/:id/recurring-pay-components',
	requirePayrollAccess('compensation.view'),
	validateParams(idParamSchema),
	controller.listRecurring
);
payrollRouter.post(
	'/employees/:id/recurring-pay-components',
	requirePayrollAccess('compensation.manage'),
	validateParams(idParamSchema),
	validateBody(recurringAssignSchema),
	controller.assignRecurring
);
payrollRouter.post(
	'/employee-recurring-pay-components/:id/end',
	requirePayrollAccess('compensation.manage'),
	validateParams(idParamSchema),
	validateBody(recurringEndSchema),
	controller.endRecurring
);

// ---------- periods ----------
payrollRouter.get(
	'/payroll/periods',
	requirePayrollAccess('payroll.view'),
	validateQuery(periodListQuerySchema),
	controller.listPeriods
);
payrollRouter.get(
	'/payroll/periods/:id',
	requirePayrollAccess('payroll.view'),
	validateParams(idParamSchema),
	controller.getPeriod
);
payrollRouter.post(
	'/payroll/periods',
	requirePayrollAccess('payroll.manage'),
	validateBody(periodCreateSchema),
	controller.createPeriod
);
payrollRouter.patch(
	'/payroll/periods/:id',
	requirePayrollAccess('payroll.manage'),
	validateParams(idParamSchema),
	validateBody(periodUpdateSchema),
	controller.updatePeriod
);

// ---------- runs ----------
payrollRouter.get(
	'/payroll/runs',
	requirePayrollAccess('payroll.view'),
	validateQuery(runListQuerySchema),
	controller.listRuns
);
payrollRouter.post(
	'/payroll/runs',
	requirePayrollAccess('payroll.manage'),
	validateBody(runCreateSchema),
	controller.createRun
);
// payroll viewers AND payroll approvers (who must see the figures they approve)
const runReader = requirePayrollAccessAny(['payroll.view', 'payroll.approve']);
payrollRouter.get('/payroll/runs/:id', runReader, validateParams(idParamSchema), controller.getRun);
payrollRouter.post(
	'/payroll/runs/:id/calculate',
	requirePayrollAccess('payroll.calculate'),
	validateParams(idParamSchema),
	controller.calculateRun
);
payrollRouter.post(
	'/payroll/runs/:id/finalize',
	requirePayrollAccess('payroll.finalize'),
	validateParams(idParamSchema),
	validateBody(runFinalizeSchema),
	controller.finalizeRun
);
payrollRouter.get(
	'/payroll/runs/:id/results',
	runReader,
	validateParams(idParamSchema),
	validateQuery(resultListQuerySchema),
	controller.listResults
);
payrollRouter.get(
	'/payroll/results/:id',
	runReader,
	validateParams(idParamSchema),
	controller.getResult
);

// ---------- Phase 13: approval (the generic engine does approve / reject: /approvals/:id/…) ----------
payrollRouter.get(
	'/payroll/runs/:id/approval',
	runReader,
	validateParams(idParamSchema),
	controller.getRunApproval
);
payrollRouter.post(
	'/payroll/runs/:id/submit-approval',
	requirePayrollAccess('payroll.manage'),
	validateParams(idParamSchema),
	controller.submitApproval
);
payrollRouter.post(
	'/payroll/runs/:id/cancel-approval',
	requirePayrollAccess('payroll.manage'),
	validateParams(idParamSchema),
	controller.cancelApproval
);
payrollRouter.post(
	'/payroll/runs/:id/reopen',
	requirePayrollAccess('payroll.manage'),
	validateParams(idParamSchema),
	controller.reopenRun
);

// ---------- Phase 13: payslips of a run (admin) ----------
payrollRouter.get(
	'/payroll/runs/:id/payslips',
	requirePayrollAccess('payroll.view'),
	validateParams(idParamSchema),
	controller.listRunPayslips
);
payrollRouter.post(
	'/payroll/runs/:id/generate-payslips',
	requirePayrollAccess('payslip.generate'),
	validateParams(idParamSchema),
	controller.generatePayslips
);

// ---------- manual adjustments (append-only: no update / delete) ----------
payrollRouter.get(
	'/payroll/runs/:runId/employees/:employeeId/adjustments',
	requirePayrollAccess('payroll.view'),
	validateParams(runEmployeeParams),
	controller.listAdjustments
);
payrollRouter.post(
	'/payroll/runs/:runId/employees/:employeeId/adjustments',
	requirePayrollAccess('payroll.manage'),
	validateParams(runEmployeeParams),
	validateBody(adjustmentCreateSchema),
	controller.addAdjustment
);

// ---------- payroll schedules (how periods are generated) ----------
payrollRouter.get(
	'/payroll-schedules',
	requirePayrollAccess('payroll.view'),
	validateQuery(scheduleListQuerySchema),
	controller.listSchedules
);
payrollRouter.post(
	'/payroll-schedules',
	requirePayrollAccess('payroll.manage'),
	validateBody(scheduleCreateSchema),
	controller.createSchedule
);
payrollRouter.get(
	'/payroll-schedules/:id',
	requirePayrollAccess('payroll.view'),
	validateParams(idParamSchema),
	controller.getSchedule
);
payrollRouter.patch(
	'/payroll-schedules/:id',
	requirePayrollAccess('payroll.manage'),
	validateParams(idParamSchema),
	validateBody(scheduleUpdateSchema),
	controller.updateSchedule
);
// preview is read-only (no DB mutation) → payroll.view; generate creates rows → payroll.manage
payrollRouter.post(
	'/payroll-schedules/:id/preview-periods',
	requirePayrollAccess('payroll.view'),
	validateParams(idParamSchema),
	validateBody(generatePeriodsSchema),
	controller.previewSchedulePeriods
);
payrollRouter.post(
	'/payroll-schedules/:id/generate-periods',
	requirePayrollAccess('payroll.manage'),
	validateParams(idParamSchema),
	validateBody(generatePeriodsSchema),
	controller.generateSchedulePeriods
);

// ---------- payroll rules (immutable effective-dated versions: no PATCH / PUT / DELETE) ----------
payrollRouter.get(
	'/payroll-rules',
	requirePayrollAccess('payroll.view'),
	validateQuery(ruleListQuerySchema),
	controller.listRules
);
payrollRouter.post(
	'/payroll-rules',
	requirePayrollAccess('payroll.manage'),
	validateBody(ruleCreateSchema),
	controller.createRule
);
payrollRouter.get(
	'/payroll-rules/:id',
	requirePayrollAccess('payroll.view'),
	validateParams(idParamSchema),
	controller.getRule
);

// ---------- statutory rules (Phase 12B: Lao PIT + Social Security) — DRAFT until explicitly activated ----------
payrollRouter.get(
	'/payroll-statutory-rules',
	requirePayrollAccess('payroll.view'),
	validateQuery(statutoryRuleListQuerySchema),
	controller.listStatutoryRules
);
// read-only §8 reference template - registered BEFORE '/:id' so it is never matched as an id
payrollRouter.get(
	'/payroll-statutory-rules/reference-template',
	requirePayrollAccess('payroll.manage'),
	controller.statutoryReferenceTemplate
);
payrollRouter.post(
	'/payroll-statutory-rules',
	requirePayrollAccess('payroll.manage'),
	validateBody(statutoryRuleCreateSchema),
	controller.createStatutoryRule
);
payrollRouter.get(
	'/payroll-statutory-rules/:id',
	requirePayrollAccess('payroll.view'),
	validateParams(idParamSchema),
	controller.getStatutoryRule
);
payrollRouter.post(
	'/payroll-statutory-rules/:id/activate',
	requirePayrollAccess('payroll.manage'),
	validateParams(idParamSchema),
	controller.activateStatutoryRule
);

// ---------- employee statutory profile (Phase 12B) — TIN / social security number: never in general views ----------
payrollRouter.get(
	'/employees/:id/statutory-profile',
	requirePayrollAccess('payroll.view'),
	validateParams(idParamSchema),
	controller.getStatutoryProfile
);
payrollRouter.put(
	'/employees/:id/statutory-profile',
	requirePayrollAccess('payroll.manage'),
	validateParams(idParamSchema),
	validateBody(statutoryProfileUpdateSchema),
	controller.updateStatutoryProfile
);
