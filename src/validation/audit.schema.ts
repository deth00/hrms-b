import { z } from 'zod';
import { optionalId, paginationQuerySchema } from './common.schema.js';
import { optionalDateField } from './employee.schema.js';

export const auditListQuerySchema = paginationQuerySchema.extend({
	from: optionalDateField(),
	to: optionalDateField(),
	actorUserId: optionalId(),
	action: z.string().trim().max(80).optional(),
	entityType: z.string().trim().max(60).optional(),
	/** NOT an entity id: frozen audit history (legacy CUID or String(numeric id), or a report key) */
	entityId: z.string().trim().min(1).max(191).optional(),
	companyId: optionalId(),
	employeeId: optionalId(),
	search: z.string().trim().max(120).optional()
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
