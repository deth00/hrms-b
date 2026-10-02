import { Router } from 'express';
import * as userController from '../controllers/user.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePermission } from '../middlewares/requirePermission.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import {
	createUserSchema,
	listUsersQuerySchema,
	updateUserSchema
} from '../validation/user.schema.js';
import { idParamSchema } from '../validation/common.schema.js';

export const userRouter = Router();

userRouter.use(requireAuth);

userRouter.get(
	'/users',
	requirePermission('users.view'),
	validateQuery(listUsersQuerySchema),
	userController.list
);

userRouter.get(
	'/users/:id',
	requirePermission('users.view'),
	validateParams(idParamSchema),
	userController.getById
);

userRouter.post(
	'/users',
	requirePermission('users.create'),
	validateBody(createUserSchema),
	userController.create
);

userRouter.patch(
	'/users/:id',
	requirePermission('users.update'),
	validateParams(idParamSchema),
	validateBody(updateUserSchema),
	userController.update
);
