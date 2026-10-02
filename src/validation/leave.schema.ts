import { z } from 'zod';
import {
	codeField,
	idField,
	nameField,
	nullableText,
	optionalId,
	orgStatusEnum,
	paginationQuerySchema
} from './common.schema.js';
import { dateField, optionalDateField } from './employee.schema.js';

/** A day-count with at most two decimals (Decimal(6,2) in the database). */
function daysField(min: number, max: number) {
	return z
		.number()
		.finite()
		.min(min, `ຄ່າຕ້ອງບໍ່ໜ້ອຍກວ່າ ${min}`)
		.max(max, `ຄ່າຕ້ອງບໍ່ເກີນ ${max}`)
		.refine(
			(n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6,
			'ຈຳນວນມື້ມີທົດສະນິຍົມໄດ້ສູງສຸດ 2 ຕຳແໜ່ງ'
		);
}

const yearField = z.number().int().min(2000).max(2100);
const yearQuery = z.coerce.number().int().min(2000).max(2100);

// ---------- leave types ----------

const entitlementField = daysField(0, 366);

export const leaveTypeCreateSchema = z
	.object({
		companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
		code: codeField(30),
		nameLao: nameField(150),
		nameEnglish: nullableText(150),
		isPaid: z.boolean().default(true),
		requiresBalance: z.boolean().default(true),
		defaultEntitlementDays: entitlementField.nullable().optional(),
		minNoticeDays: z.number().int().min(0).max(365).default(0),
		maxConsecutiveDays: z.number().int().min(1).max(366).nullable().optional(),
		description: nullableText(255),
		status: orgStatusEnum.default('ACTIVE')
	})
	.strict();
export type LeaveTypeCreateInput = z.infer<typeof leaveTypeCreateSchema>;

// Written out (not `.partial()`) so create-time defaults can never leak into a PATCH.
export const leaveTypeUpdateSchema = z
	.object({
		nameLao: nameField(150).optional(),
		nameEnglish: nullableText(150),
		isPaid: z.boolean().optional(),
		requiresBalance: z.boolean().optional(),
		defaultEntitlementDays: entitlementField.nullable().optional(),
		minNoticeDays: z.number().int().min(0).max(365).optional(),
		maxConsecutiveDays: z.number().int().min(1).max(366).nullable().optional(),
		description: nullableText(255),
		status: orgStatusEnum.optional()
	})
	.strict()
	.refine((d) => Object.keys(d).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type LeaveTypeUpdateInput = z.infer<typeof leaveTypeUpdateSchema>;

export const leaveTypeListQuerySchema = paginationQuerySchema.extend({
	companyId: optionalId(),
	status: orgStatusEnum.optional(),
	search: z.string().trim().max(120).optional()
});
export type LeaveTypeListQuery = z.infer<typeof leaveTypeListQuerySchema>;

// ---------- balances ----------

export const leaveBalanceCreateSchema = z
	.object({
		employeeId: idField('ກະລຸນາເລືອກພະນັກງານ'),
		leaveTypeId: idField('ກະລຸນາເລືອກປະເພດການລາ'),
		year: yearField,
		entitlementDays: entitlementField,
		carriedForwardDays: entitlementField.default(0)
	})
	.strict();
export type LeaveBalanceCreateInput = z.infer<typeof leaveBalanceCreateSchema>;

export const leaveBalanceUpdateSchema = z
	.object({
		entitlementDays: entitlementField.optional(),
		carriedForwardDays: entitlementField.optional()
	})
	.strict()
	.refine((d) => Object.keys(d).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type LeaveBalanceUpdateInput = z.infer<typeof leaveBalanceUpdateSchema>;

export const leaveAdjustmentSchema = z
	.object({
		days: daysField(-366, 366).refine((n) => n !== 0, 'ຈຳນວນມື້ຕ້ອງບໍ່ເປັນ 0'),
		reason: z.string().trim().min(3, 'ກະລຸນາລະບຸເຫດຜົນ').max(500)
	})
	.strict();
export type LeaveAdjustmentInput = z.infer<typeof leaveAdjustmentSchema>;

export const leaveBalanceListQuerySchema = paginationQuerySchema.extend({
	year: yearQuery.optional(),
	companyId: optionalId(),
	departmentId: optionalId(),
	employeeId: optionalId(),
	leaveTypeId: optionalId(),
	search: z.string().trim().max(120).optional()
});
export type LeaveBalanceListQuery = z.infer<typeof leaveBalanceListQuerySchema>;

export const adjustmentListQuerySchema = paginationQuerySchema;

export const selfBalanceQuerySchema = z.object({ year: yearQuery.optional() });

// ---------- requests ----------

const requestStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);

/** Employee id is deliberately NOT part of these bodies — the employee always comes from the session. */
export const leavePreviewSchema = z
	.object({
		leaveTypeId: idField('ກະລຸນາເລືອກປະເພດການລາ'),
		startDate: dateField(),
		endDate: dateField()
	})
	.strict();
export type LeavePreviewInput = z.infer<typeof leavePreviewSchema>;

export const leaveCreateSchema = z
	.object({
		leaveTypeId: idField('ກະລຸນາເລືອກປະເພດການລາ'),
		startDate: dateField(),
		endDate: dateField(),
		reason: z.string().trim().min(3, 'ກະລຸນາລະບຸເຫດຜົນ').max(1000)
	})
	.strict();
export type LeaveCreateInput = z.infer<typeof leaveCreateSchema>;

export const selfLeaveListQuerySchema = paginationQuerySchema.extend({
	year: yearQuery.optional(),
	status: requestStatus.optional()
});
export type SelfLeaveListQuery = z.infer<typeof selfLeaveListQuerySchema>;

export const leaveListQuerySchema = paginationQuerySchema.extend({
	status: requestStatus.optional(),
	year: yearQuery.optional(),
	from: optionalDateField(),
	to: optionalDateField(),
	employeeId: optionalId(),
	companyId: optionalId(),
	departmentId: optionalId(),
	leaveTypeId: optionalId(),
	search: z.string().trim().max(120).optional()
});
export type LeaveListQuery = z.infer<typeof leaveListQuerySchema>;

export const leaveApproveSchema = z
	.object({ reviewNote: z.string().trim().max(1000).optional() })
	.strict();
export const leaveRejectSchema = z
	.object({ reviewNote: z.string().trim().min(3, 'ກະລຸນາລະບຸເຫດຜົນທີ່ປະຕິເສດ').max(1000) })
	.strict();
