import { z } from 'zod';
import { idField, idSchema, optionalId, paginationQuerySchema } from './common.schema.js';
import { optionalDateField } from './employee.schema.js';
import { codeField, nameField, nullableText, orgStatusEnum } from './common.schema.js';
import { APPROVAL_TARGET_TYPES, MAX_MANAGER_LEVEL } from '../lib/approvalTargets.js';

export const targetTypeEnum = z.enum(APPROVAL_TARGET_TYPES);

// ---------- actions ----------

export const approvalApproveSchema = z
	.object({ note: z.string().trim().max(1000).optional() })
	.strict();
export const approvalRejectSchema = z
	.object({ note: z.string().trim().min(3, 'ກະລຸນາລະບຸເຫດຜົນທີ່ປະຕິເສດ').max(1000) })
	.strict();
export const reassignSchema = z.object({ userId: idField('ກະລຸນາເລືອກຜູ້ໃຊ້') }).strict();

// ---------- inbox / history ----------

export const inboxQuerySchema = paginationQuerySchema.extend({
	targetType: targetTypeEnum.optional(),
	companyId: optionalId(),
	/** only "current" (the pending steps assigned to me) exists in Phase 9 */
	status: z.enum(['current']).optional(),
	search: z.string().trim().max(120).optional()
});
export type InboxQuery = z.infer<typeof inboxQuerySchema>;

export const historyQuerySchema = paginationQuerySchema.extend({
	targetType: targetTypeEnum.optional(),
	from: optionalDateField(),
	to: optionalDateField(),
	action: z.enum(['APPROVED', 'REJECTED']).optional()
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

// ---------- workflow configuration ----------

export const workflowStepSchema = z
	.object({
		stepOrder: z.number().int().min(1).optional(),
		nameLao: nameField(150),
		nameEnglish: nullableText(150),
		approverType: z.enum(['MANAGER', 'ROLE', 'USER', 'PERMISSION']),
		managerLevel: z.number().int().min(1).max(MAX_MANAGER_LEVEL).nullable().optional(),
		roleId: idSchema.nullable().optional(),
		userId: idSchema.nullable().optional(),
		permissionCode: z.string().trim().min(1).nullable().optional()
	})
	.strict()
	.superRefine((s, ctx) => {
		const need = (ok: boolean, path: string, message: string) => {
			if (!ok) ctx.addIssue({ code: 'custom', path: [path], message });
		};
		if (s.approverType === 'MANAGER')
			need(!!s.managerLevel, 'managerLevel', 'ກະລຸນາລະບຸລະດັບຫົວໜ້າ (≥ 1)');
		if (s.approverType === 'ROLE') need(!!s.roleId, 'roleId', 'ກະລຸນາເລືອກບົດບາດ');
		if (s.approverType === 'USER') need(!!s.userId, 'userId', 'ກະລຸນາເລືອກຜູ້ໃຊ້');
		if (s.approverType === 'PERMISSION')
			need(!!s.permissionCode, 'permissionCode', 'ກະລຸນາເລືອກສິດອະນຸຍາດ');
	});
export type WorkflowStepInput = z.infer<typeof workflowStepSchema>;

const stepsField = z.array(workflowStepSchema).min(1, 'ຕ້ອງມີຢ່າງໜ້ອຍ 1 ຂັ້ນຕອນ').max(10);

export const workflowListQuerySchema = paginationQuerySchema.extend({
	companyId: optionalId(),
	targetType: targetTypeEnum.optional()
});
export type WorkflowListQuery = z.infer<typeof workflowListQuerySchema>;

export const workflowCreateSchema = z
	.object({
		companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
		targetType: targetTypeEnum,
		code: codeField(60),
		nameLao: nameField(150),
		nameEnglish: nullableText(150),
		description: nullableText(500),
		status: orgStatusEnum.default('ACTIVE'),
		steps: stepsField
	})
	.strict();
export type WorkflowCreateInput = z.infer<typeof workflowCreateSchema>;

// Written out (not `.partial()`) so create-time defaults never leak into an update.
export const workflowUpdateSchema = z
	.object({
		nameLao: nameField(150).optional(),
		nameEnglish: nullableText(150),
		description: nullableText(500),
		status: orgStatusEnum.optional(),
		steps: stepsField.optional()
	})
	.strict()
	.refine((d) => Object.keys(d).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type WorkflowUpdateInput = z.infer<typeof workflowUpdateSchema>;

export const workflowPreviewQuerySchema = z.object({
	targetType: targetTypeEnum,
	employeeId: optionalId()
});
export type WorkflowPreviewQuery = z.infer<typeof workflowPreviewQuerySchema>;
