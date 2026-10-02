import { Router } from 'express';
import * as roleController from '../controllers/role.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePermission } from '../middlewares/requirePermission.js';
import { validateBody, validateParams } from '../middlewares/validate.js';
import { createRoleSchema, updateRoleSchema } from '../validation/role.schema.js';
import { idParamSchema } from '../validation/common.schema.js';

export const roleRouter = Router();

roleRouter.use(requireAuth);

roleRouter.get('/roles', requirePermission('roles.view'), roleController.list);
roleRouter.get('/permissions', requirePermission('roles.view'), roleController.listPermissions);

roleRouter.get(
	'/roles/:id',
	requirePermission('roles.view'),
	validateParams(idParamSchema),
	roleController.getById
);

roleRouter.post(
	'/roles',
	requirePermission('roles.create'),
	validateBody(createRoleSchema),
	roleController.create
);

roleRouter.patch(
	'/roles/:id',
	requirePermission('roles.update'),
	validateParams(idParamSchema),
	validateBody(updateRoleSchema),
	roleController.update
);
