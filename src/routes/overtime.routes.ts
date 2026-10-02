import { Router } from 'express';
import * as controller from '../controllers/overtime.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePermission } from '../middlewares/requirePermission.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import {
	overtimeApproveSchema,
	overtimeCreateSchema,
	overtimeListQuerySchema,
	overtimePolicyQuerySchema,
	overtimePolicyUpdateSchema,
	overtimePreviewSchema,
	overtimeRejectSchema,
	selfOvertimeListQuerySchema
} from '../validation/overtime.schema.js';

export const overtimeRouter = Router();
overtimeRouter.use(requireAuth);

const self = requirePermission('overtime.self');

// ---------- self service (registered before /overtime/requests/:id) ----------
overtimeRouter.get(
	'/overtime/me/requests',
	self,
	validateQuery(selfOvertimeListQuerySchema),
	controller.myRequests
);
overtimeRouter.post(
	'/overtime/me/requests/preview',
	self,
	validateBody(overtimePreviewSchema),
	controller.previewMy
);
overtimeRouter.post(
	'/overtime/me/requests',
	self,
	validateBody(overtimeCreateSchema),
	controller.createMy
);
overtimeRouter.get(
	'/overtime/me/requests/:id',
	self,
	validateParams(idParamSchema),
	controller.myRequest
);
overtimeRouter.post(
	'/overtime/me/requests/:id/cancel',
	self,
	validateParams(idParamSchema),
	controller.cancelMy
);

// ---------- review ----------
overtimeRouter.get(
	'/overtime/requests',
	requirePermission('overtime.view'),
	validateQuery(overtimeListQuerySchema),
	controller.listRequests
);
overtimeRouter.get(
	'/overtime/requests/:id',
	requirePermission('overtime.view'),
	validateParams(idParamSchema),
	controller.getRequest
);
overtimeRouter.post(
	'/overtime/requests/:id/approve',
	requirePermission('overtime.review'),
	validateParams(idParamSchema),
	validateBody(overtimeApproveSchema),
	controller.approve
);
overtimeRouter.post(
	'/overtime/requests/:id/reject',
	requirePermission('overtime.review'),
	validateParams(idParamSchema),
	validateBody(overtimeRejectSchema),
	controller.reject
);

// ---------- policy (one per company) ----------
overtimeRouter.get(
	'/overtime-policies',
	requirePermission('overtime_rules.view'),
	validateQuery(overtimePolicyQuerySchema),
	controller.getPolicy
);
overtimeRouter.put(
	'/overtime-policies',
	requirePermission('overtime_rules.update'),
	validateQuery(overtimePolicyQuerySchema),
	validateBody(overtimePolicyUpdateSchema),
	controller.updatePolicy
);
