import { Router } from 'express';
import * as controller from '../controllers/leave.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePermission } from '../middlewares/requirePermission.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import {
	adjustmentListQuerySchema,
	leaveAdjustmentSchema,
	leaveApproveSchema,
	leaveBalanceCreateSchema,
	leaveBalanceListQuerySchema,
	leaveBalanceUpdateSchema,
	leaveCreateSchema,
	leaveListQuerySchema,
	leavePreviewSchema,
	leaveRejectSchema,
	leaveTypeCreateSchema,
	leaveTypeListQuerySchema,
	leaveTypeUpdateSchema,
	selfBalanceQuerySchema,
	selfLeaveListQuerySchema
} from '../validation/leave.schema.js';

export const leaveRouter = Router();
leaveRouter.use(requireAuth);

const self = requirePermission('leave.self');

// ---------- self service (the employee is ALWAYS resolved from the session) ----------
leaveRouter.get(
	'/leave/me/balances',
	self,
	validateQuery(selfBalanceQuerySchema),
	controller.myBalances
);
leaveRouter.get(
	'/leave/me/requests',
	self,
	validateQuery(selfLeaveListQuerySchema),
	controller.myRequests
);
leaveRouter.post(
	'/leave/me/requests/preview',
	self,
	validateBody(leavePreviewSchema),
	controller.previewMy
);
leaveRouter.post('/leave/me/requests', self, validateBody(leaveCreateSchema), controller.createMy);
leaveRouter.get(
	'/leave/me/requests/:id',
	self,
	validateParams(idParamSchema),
	controller.myRequest
);
leaveRouter.post(
	'/leave/me/requests/:id/cancel',
	self,
	validateParams(idParamSchema),
	controller.cancelMy
);

// ---------- review ----------
leaveRouter.get(
	'/leave/requests',
	requirePermission('leave.view'),
	validateQuery(leaveListQuerySchema),
	controller.listRequests
);
leaveRouter.get(
	'/leave/requests/:id',
	requirePermission('leave.view'),
	validateParams(idParamSchema),
	controller.getRequest
);
leaveRouter.post(
	'/leave/requests/:id/approve',
	requirePermission('leave.review'),
	validateParams(idParamSchema),
	validateBody(leaveApproveSchema),
	controller.approve
);
leaveRouter.post(
	'/leave/requests/:id/reject',
	requirePermission('leave.review'),
	validateParams(idParamSchema),
	validateBody(leaveRejectSchema),
	controller.reject
);

// ---------- leave types (no DELETE) ----------
leaveRouter.get(
	'/leave-types',
	requirePermission('leave_types.view'),
	validateQuery(leaveTypeListQuerySchema),
	controller.listTypes
);
leaveRouter.get(
	'/leave-types/:id',
	requirePermission('leave_types.view'),
	validateParams(idParamSchema),
	controller.getType
);
leaveRouter.post(
	'/leave-types',
	requirePermission('leave_types.create'),
	validateBody(leaveTypeCreateSchema),
	controller.createType
);
leaveRouter.patch(
	'/leave-types/:id',
	requirePermission('leave_types.update'),
	validateParams(idParamSchema),
	validateBody(leaveTypeUpdateSchema),
	controller.updateType
);

// ---------- balances ----------
leaveRouter.get(
	'/leave-balances',
	requirePermission('leave_balances.view'),
	validateQuery(leaveBalanceListQuerySchema),
	controller.listBalances
);
leaveRouter.post(
	'/leave-balances',
	requirePermission('leave_balances.manage'),
	validateBody(leaveBalanceCreateSchema),
	controller.upsertBalance
);
leaveRouter.patch(
	'/leave-balances/:id',
	requirePermission('leave_balances.manage'),
	validateParams(idParamSchema),
	validateBody(leaveBalanceUpdateSchema),
	controller.updateBalance
);
leaveRouter.post(
	'/leave-balances/:id/adjustments',
	requirePermission('leave_balances.manage'),
	validateParams(idParamSchema),
	validateBody(leaveAdjustmentSchema),
	controller.addAdjustment
);
leaveRouter.get(
	'/leave-balances/:id/adjustments',
	requirePermission('leave_balances.view'),
	validateParams(idParamSchema),
	validateQuery(adjustmentListQuerySchema),
	controller.listAdjustments
);
