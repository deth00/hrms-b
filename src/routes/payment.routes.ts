import { Router } from 'express';
import * as controller from '../controllers/payment.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import {
	requirePayrollAccess,
	requirePayrollAccessAny,
	requirePermission
} from '../middlewares/requirePermission.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import {
	bankAccountCreateSchema,
	bankAccountUpdateSchema,
	batchCreateSchema,
	batchItemParams,
	batchListQuerySchema,
	employeeAccountParams,
	exportBodySchema,
	exportPreviewQuerySchema,
	exportProfileCreateSchema,
	exportProfileListQuerySchema,
	exportProfileUpdateSchema,
	itemConfirmSchema,
	paymentProfileUpdateSchema
} from '../validation/payment.schema.js';

/**
 * PAYROLL PAYMENT PREPARATION (Phase 14). Every admin endpoint needs its dedicated permission AND the
 * company-wide employee scope (`employees.view_all`, see requirePayrollAccess) — there is NO
 * manager-tree access anywhere. Account numbers are never returned (masked "••••1234"); only the
 * export endpoint (payroll.payment.export) produces a file that contains them. No DELETE routes.
 */
export const paymentRouter = Router();

const bankView = requirePayrollAccess('employee_bank.view');
const bankManage = requirePayrollAccess('employee_bank.manage');
const payView = requirePayrollAccess('payroll.payment.view');
const payManage = requirePayrollAccess('payroll.payment.manage');
const payExport = requirePayrollAccess('payroll.payment.export');
const payConfirm = requirePayrollAccess('payroll.payment.confirm');
const profileRead = requirePayrollAccessAny([
	'payroll.payment.view',
	'payroll.payment.manage',
	'payroll.payment.export'
]);
const idParams = validateParams(idParamSchema);

// ---------- employee payment method + bank accounts ----------
paymentRouter.get(
	'/employees/:id/payment-profile',
	requireAuth,
	bankView,
	idParams,
	controller.getPaymentProfile
);
paymentRouter.put(
	'/employees/:id/payment-profile',
	requireAuth,
	bankManage,
	idParams,
	validateBody(paymentProfileUpdateSchema),
	controller.updatePaymentProfile
);
paymentRouter.post(
	'/employees/:id/bank-accounts',
	requireAuth,
	bankManage,
	idParams,
	validateBody(bankAccountCreateSchema),
	controller.createBankAccount
);
paymentRouter.patch(
	'/employees/:id/bank-accounts/:accountId',
	requireAuth,
	bankManage,
	validateParams(employeeAccountParams),
	validateBody(bankAccountUpdateSchema),
	controller.updateBankAccount
);
paymentRouter.post(
	'/employees/:id/bank-accounts/:accountId/activate',
	requireAuth,
	bankManage,
	validateParams(employeeAccountParams),
	controller.activateBankAccount
);
paymentRouter.post(
	'/employees/:id/bank-accounts/:accountId/deactivate',
	requireAuth,
	bankManage,
	validateParams(employeeAccountParams),
	controller.deactivateBankAccount
);

// ---------- payment batches ----------
paymentRouter.get(
	'/payroll/runs/:id/payment-batch',
	requireAuth,
	payView,
	idParams,
	controller.getRunBatch
);
paymentRouter.post(
	'/payroll/runs/:id/payment-batch',
	requireAuth,
	payManage,
	idParams,
	validateBody(batchCreateSchema),
	controller.createBatch
);
paymentRouter.get(
	'/payroll/payment-batches',
	requireAuth,
	payView,
	validateQuery(batchListQuerySchema),
	controller.listBatches
);
paymentRouter.get(
	'/payroll/payment-batches/:id',
	requireAuth,
	payView,
	idParams,
	controller.getBatch
);
paymentRouter.post(
	'/payroll/payment-batches/:id/validate',
	requireAuth,
	payManage,
	idParams,
	controller.validateBatch
);
paymentRouter.post(
	'/payroll/payment-batches/:id/rebuild',
	requireAuth,
	payManage,
	idParams,
	controller.rebuildBatch
);
paymentRouter.post(
	'/payroll/payment-batches/:id/cancel',
	requireAuth,
	payManage,
	idParams,
	controller.cancelBatch
);
paymentRouter.get(
	'/payroll/payment-batches/:id/export-preview',
	requireAuth,
	payExport,
	idParams,
	validateQuery(exportPreviewQuerySchema),
	controller.exportPreview
);
paymentRouter.post(
	'/payroll/payment-batches/:id/export',
	requireAuth,
	payExport,
	idParams,
	validateBody(exportBodySchema),
	controller.exportFile
);
paymentRouter.post(
	'/payroll/payment-batches/:id/items/:itemId/confirm',
	requireAuth,
	payConfirm,
	validateParams(batchItemParams),
	validateBody(itemConfirmSchema),
	controller.confirmItem
);

// ---------- bank export profiles (generic layouts; predefined safe fields only) ----------
paymentRouter.get(
	'/bank-export-profiles/fields',
	requireAuth,
	profileRead,
	controller.exportFields
);
paymentRouter.get(
	'/bank-export-profiles',
	requireAuth,
	profileRead,
	validateQuery(exportProfileListQuerySchema),
	controller.listProfiles
);
paymentRouter.get(
	'/bank-export-profiles/:id',
	requireAuth,
	profileRead,
	idParams,
	controller.getProfile
);
paymentRouter.post(
	'/bank-export-profiles',
	requireAuth,
	payManage,
	validateBody(exportProfileCreateSchema),
	controller.createProfile
);
paymentRouter.put(
	'/bank-export-profiles/:id',
	requireAuth,
	payManage,
	idParams,
	validateBody(exportProfileUpdateSchema),
	controller.updateProfile
);

// ---------- self-service ----------
paymentRouter.get(
	'/payroll-payments/me',
	requireAuth,
	requirePermission('payroll_payment.view_self'),
	controller.listMyPayments
);
