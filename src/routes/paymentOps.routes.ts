import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePayrollAccess, requirePayrollAccessAny } from '../middlewares/requirePermission.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import { AppError } from '../utils/AppError.js';
import { extensionOf, RECON_LIMITS } from '../lib/reconciliationFile.js';
import * as controller from '../controllers/paymentOps.controller.js';
import { batchItemParams } from '../validation/payment.schema.js';
import {
	reconIgnoreSchema,
	reconImportBodySchema,
	reconMatchSchema,
	reconProfileCreateSchema,
	reconProfileListQuerySchema,
	reconProfileUpdateSchema,
	reconRowParams,
	retrySchema,
	reverseSchema
} from '../validation/reconciliation.schema.js';

/**
 * Phase 15 — bank reconciliation, payment reversal, retry / reissue. Every endpoint needs its
 * dedicated permission AND employees.view_all (requirePayrollAccess); there is NO manager-tree access.
 * Account numbers are never returned (masked "••••1234"). No DELETE routes; a reversal has no
 * update / delete endpoint at all (append-only).
 */
export const paymentOpsRouter = Router();

const reconcile = requirePayrollAccess('payroll.payment.reconcile');
const reverse = requirePayrollAccess('payroll.payment.reverse');
const payManage = requirePayrollAccess('payroll.payment.manage');
const payView = requirePayrollAccess('payroll.payment.view');
const reconRead = requirePayrollAccessAny(['payroll.payment.view', 'payroll.payment.reconcile']);
const idParams = validateParams(idParamSchema);

/**
 * The bank result file: multipart, ONE file, in memory only (never written to disk, never stored),
 * ≤ 5 MB, .csv / .xlsx names only. Runs AFTER authentication + permission, so an unauthorized caller
 * never gets a body parsed.
 */
const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: RECON_LIMITS.maxBytes,
		files: 1,
		fields: 4,
		fieldSize: 1024,
		parts: 6
	},
	fileFilter: (_req, file, cb) => {
		if (!extensionOf(file.originalname)) {
			cb(
				new AppError(
					400,
					'UNSUPPORTED_FILE_TYPE',
					'ຮອງຮັບສະເພາະໄຟລ໌ .csv ແລະ .xlsx (ບໍ່ຮັບ .xls, .xlsm, zip ຫຼື ໄຟລ໌ອື່ນ)'
				)
			);
			return;
		}
		cb(null, true);
	}
});
function uploadResultFile(req: Request, res: Response, next: NextFunction) {
	upload.single('file')(req, res, (err: unknown) => {
		if (!err) return next();
		if (err instanceof AppError) return next(err);
		if (err instanceof multer.MulterError) {
			return next(
				err.code === 'LIMIT_FILE_SIZE'
					? new AppError(413, 'FILE_TOO_LARGE', 'ໄຟລ໌ໃຫຍ່ເກີນ 5 MB')
					: new AppError(400, 'INVALID_UPLOAD', 'ການອັບໂຫຼດບໍ່ຖືກຕ້ອງ (ໄຟລ໌ດຽວ, ຊ່ອງ "file")')
			);
		}
		return next(new AppError(400, 'INVALID_UPLOAD', 'ການອັບໂຫຼດບໍ່ຖືກຕ້ອງ'));
	});
}

// ---------- reconciliation profiles ----------
paymentOpsRouter.get(
	'/payment-reconciliation-profiles/fields',
	requireAuth,
	reconcile,
	controller.reconFields
);
paymentOpsRouter.get(
	'/payment-reconciliation-profiles',
	requireAuth,
	reconcile,
	validateQuery(reconProfileListQuerySchema),
	controller.listReconProfiles
);
paymentOpsRouter.get(
	'/payment-reconciliation-profiles/:id',
	requireAuth,
	reconcile,
	idParams,
	controller.getReconProfile
);
paymentOpsRouter.post(
	'/payment-reconciliation-profiles',
	requireAuth,
	reconcile,
	validateBody(reconProfileCreateSchema),
	controller.createReconProfile
);
paymentOpsRouter.put(
	'/payment-reconciliation-profiles/:id',
	requireAuth,
	reconcile,
	idParams,
	validateBody(reconProfileUpdateSchema),
	controller.updateReconProfile
);

// ---------- reconciliation imports ----------
paymentOpsRouter.post(
	'/payroll/payment-batches/:id/reconciliations/import',
	requireAuth,
	reconcile,
	idParams,
	uploadResultFile,
	validateBody(reconImportBodySchema),
	controller.importReconciliation
);
paymentOpsRouter.get(
	'/payroll/payment-batches/:id/reconciliations',
	requireAuth,
	reconRead,
	idParams,
	controller.listBatchReconciliations
);
paymentOpsRouter.get(
	'/payroll/reconciliations/:id',
	requireAuth,
	reconcile,
	idParams,
	controller.getReconciliation
);
paymentOpsRouter.post(
	'/payroll/reconciliations/:id/rows/:rowId/match',
	requireAuth,
	reconcile,
	validateParams(reconRowParams),
	validateBody(reconMatchSchema),
	controller.matchReconRow
);
paymentOpsRouter.post(
	'/payroll/reconciliations/:id/rows/:rowId/ignore',
	requireAuth,
	reconcile,
	validateParams(reconRowParams),
	validateBody(reconIgnoreSchema),
	controller.ignoreReconRow
);
paymentOpsRouter.post(
	'/payroll/reconciliations/:id/apply',
	requireAuth,
	reconcile,
	idParams,
	controller.applyReconciliation
);
paymentOpsRouter.post(
	'/payroll/reconciliations/:id/cancel',
	requireAuth,
	reconcile,
	idParams,
	controller.cancelReconciliation
);

// ---------- reversal / retry / lineage ----------
paymentOpsRouter.post(
	'/payroll/payment-batches/:id/items/:itemId/reverse',
	requireAuth,
	reverse,
	validateParams(batchItemParams),
	validateBody(reverseSchema),
	controller.reverseItem
);
paymentOpsRouter.post(
	'/payroll/payment-batches/:id/retry',
	requireAuth,
	payManage,
	idParams,
	validateBody(retrySchema),
	controller.retryBatch
);
paymentOpsRouter.get(
	'/payroll/payment-items/:id/lineage',
	requireAuth,
	payView,
	idParams,
	controller.itemLineage
);
