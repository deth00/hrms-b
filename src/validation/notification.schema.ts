import { z } from 'zod';
import { paginationQuerySchema } from './common.schema.js';
import { NOTIFICATION_TYPES } from '../services/notification.service.js';

/** unreadOnly arrives as a query string ("true" / "1"); anything else is false */
const boolQuery = z
	.union([z.boolean(), z.string()])
	.transform((v) => v === true || v === 'true' || v === '1')
	.optional();

export const notificationListQuerySchema = paginationQuerySchema.extend({
	unreadOnly: boolQuery,
	type: z.enum(NOTIFICATION_TYPES as [string, ...string[]]).optional()
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
