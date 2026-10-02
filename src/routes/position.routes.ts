import { Router } from 'express';
import * as positionController from '../controllers/position.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePermission } from '../middlewares/requirePermission.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import {
	positionCreateSchema,
	positionLevelCreateSchema,
	positionLevelListQuerySchema,
	positionLevelLookupQuerySchema,
	positionLevelUpdateSchema,
	positionListQuerySchema,
	positionUpdateSchema
} from '../validation/position.schema.js';

export const positionRouter = Router();

positionRouter.use(requireAuth);

const view = requirePermission('positions.view');
const create = requirePermission('positions.create');
const update = requirePermission('positions.update');

// ---------- Position Level ----------
positionRouter.get(
	'/position-levels/lookup',
	view,
	validateQuery(positionLevelLookupQuerySchema),
	positionController.lookupPositionLevels
);
positionRouter.get(
	'/position-levels',
	view,
	validateQuery(positionLevelListQuerySchema),
	positionController.listPositionLevels
);
positionRouter.get(
	'/position-levels/:id',
	view,
	validateParams(idParamSchema),
	positionController.getPositionLevel
);
positionRouter.post(
	'/position-levels',
	create,
	validateBody(positionLevelCreateSchema),
	positionController.createPositionLevel
);
positionRouter.patch(
	'/position-levels/:id',
	update,
	validateParams(idParamSchema),
	validateBody(positionLevelUpdateSchema),
	positionController.updatePositionLevel
);

// ---------- Position ----------
positionRouter.get(
	'/positions',
	view,
	validateQuery(positionListQuerySchema),
	positionController.listPositions
);
positionRouter.get(
	'/positions/:id',
	view,
	validateParams(idParamSchema),
	positionController.getPosition
);
positionRouter.post(
	'/positions',
	create,
	validateBody(positionCreateSchema),
	positionController.createPosition
);
positionRouter.patch(
	'/positions/:id',
	update,
	validateParams(idParamSchema),
	validateBody(positionUpdateSchema),
	positionController.updatePosition
);
