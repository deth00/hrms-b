import { Router } from 'express';
import * as controller from '../controllers/approval.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePermission } from '../middlewares/requirePermission.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import {
	approvalApproveSchema,
	approvalRejectSchema,
	historyQuerySchema,
	inboxQuerySchema,
	reassignSchema,
	workflowCreateSchema,
	workflowListQuerySchema,
	workflowPreviewQuerySchema,
	workflowUpdateSchema
} from '../validation/approval.schema.js';

export const approvalRouter = Router();
approvalRouter.use(requireAuth);

// ---------- generic approvals (access is decided per request in the service: candidate / actor /
// requester / scoped viewer) — static paths before /approvals/:id ----------
approvalRouter.get('/approvals/inbox', validateQuery(inboxQuerySchema), controller.inbox);
approvalRouter.get('/approvals/history', validateQuery(historyQuerySchema), controller.history);
approvalRouter.get('/approvals/:id', validateParams(idParamSchema), controller.detail);
approvalRouter.post(
	'/approvals/:id/approve',
	validateParams(idParamSchema),
	validateBody(approvalApproveSchema),
	controller.approve
);
approvalRouter.post(
	'/approvals/:id/reject',
	validateParams(idParamSchema),
	validateBody(approvalRejectSchema),
	controller.reject
);
approvalRouter.post(
	'/approvals/:id/current-step/reassign',
	requirePermission('approval_workflows.manage'),
	validateParams(idParamSchema),
	validateBody(reassignSchema),
	controller.reassign
);

// ---------- workflow configuration ----------
approvalRouter.get(
	'/approval-workflows',
	requirePermission('approval_workflows.view'),
	validateQuery(workflowListQuerySchema),
	controller.listWorkflows
);
// the preview is open to any signed-in employee (own context) — see the service for scoping
approvalRouter.get(
	'/approval-workflows/preview',
	validateQuery(workflowPreviewQuerySchema),
	controller.previewWorkflow
);
approvalRouter.get(
	'/approval-workflows/:id',
	requirePermission('approval_workflows.view'),
	validateParams(idParamSchema),
	controller.getWorkflow
);
approvalRouter.post(
	'/approval-workflows',
	requirePermission('approval_workflows.manage'),
	validateBody(workflowCreateSchema),
	controller.createWorkflow
);
approvalRouter.patch(
	'/approval-workflows/:id',
	requirePermission('approval_workflows.manage'),
	validateParams(idParamSchema),
	validateBody(workflowUpdateSchema),
	controller.updateWorkflow
);
approvalRouter.put(
	'/approval-workflows/:id',
	requirePermission('approval_workflows.manage'),
	validateParams(idParamSchema),
	validateBody(workflowUpdateSchema),
	controller.updateWorkflow
);
