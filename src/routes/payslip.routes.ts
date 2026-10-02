import { Router } from 'express';
import * as controller from '../controllers/payslip.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePayrollAccess, requirePermission } from '../middlewares/requirePermission.js';
import { validateParams } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';

/**
 * PAYSLIPS (Phase 13). Read-only: there is no PATCH / PUT / DELETE — a payslip is immutable.
 *  - /payslips/me…  own payslips (payslip.view_self). The employee is derived from the session's linked
 *                   Employee; another employee's id answers 404 exactly like a missing one.
 *  - /payslips/:id  HR / payroll (payroll.view + employees.view_all), no manager-tree access.
 * The static "/payslips/me" paths are registered BEFORE "/payslips/:id".
 */
export const payslipRouter = Router();
payslipRouter.use('/payslips', requireAuth);

const self = requirePermission('payslip.view_self');
payslipRouter.get('/payslips/me', self, controller.listMine);
payslipRouter.get('/payslips/me/:id', self, validateParams(idParamSchema), controller.getMine);
payslipRouter.get(
	'/payslips/me/:id/pdf',
	self,
	validateParams(idParamSchema),
	controller.getMinePdf
);

const admin = requirePayrollAccess('payroll.view');
payslipRouter.get('/payslips/:id', admin, validateParams(idParamSchema), controller.getOne);
payslipRouter.get('/payslips/:id/pdf', admin, validateParams(idParamSchema), controller.getOnePdf);
