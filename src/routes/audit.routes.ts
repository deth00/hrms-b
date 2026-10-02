import { Router } from 'express';
import * as controller from '../controllers/audit.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePermission } from '../middlewares/requirePermission.js';
import { validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import { auditListQuerySchema } from '../validation/audit.schema.js';

/**
 * READ-ONLY. There is intentionally no POST / PATCH / PUT / DELETE for audit events: the trail is
 * append-only and only ever written by the services through writeAuditEvent.
 * The global log needs `audit.view`; the service additionally requires the company-wide employee
 * scope (`employees.view_all`), because events name employees and users across the organisation.
 */
export const auditRouter = Router();
auditRouter.use(requireAuth);

auditRouter.get(
	'/audit-events',
	requirePermission('audit.view'),
	validateQuery(auditListQuerySchema),
	controller.list
);
auditRouter.get(
	'/audit-events/:id',
	requirePermission('audit.view'),
	validateParams(idParamSchema),
	controller.detail
);
