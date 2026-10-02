import { Router } from 'express';
import * as controller from '../controllers/notification.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import { notificationListQuerySchema } from '../validation/notification.schema.js';

/** Any authenticated user; ownership is enforced in the service. No DELETE by design. */
export const notificationRouter = Router();
notificationRouter.use(requireAuth);

notificationRouter.get(
	'/notifications',
	validateQuery(notificationListQuerySchema),
	controller.list
);
notificationRouter.get('/notifications/unread-count', controller.unreadCount);
notificationRouter.post('/notifications/read-all', controller.readAll);
notificationRouter.post('/notifications/:id/read', validateParams(idParamSchema), controller.read);
