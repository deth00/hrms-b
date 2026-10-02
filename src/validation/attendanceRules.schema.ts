import { z } from 'zod';
import { optionalDateField } from './employee.schema.js';
import { idField, idSchema, optionalId, paginationQuerySchema } from './common.schema.js';

// ---------- policy ----------

export const attendancePolicyUpdateSchema = z
	.object({
		deductScheduledBreak: z.boolean().optional(),
		missingCheckOutGraceMinutes: z.number().int().min(0).max(2880).optional(),
		allowEmployeeCorrection: z.boolean().optional(),
		correctionRequestWindowDays: z.number().int().min(0).max(365).optional()
	})
	.strict();
export type AttendancePolicyUpdateInput = z.infer<typeof attendancePolicyUpdateSchema>;

export const policyQuerySchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ')
});
export const policyParamSchema = z.object({ companyId: idSchema });

// ---------- daily ----------

export const DAILY_RESULTS = [
	'PENDING',
	'IN_PROGRESS',
	'PRESENT',
	'LATE',
	'EARLY_LEAVE',
	'LATE_AND_EARLY',
	'INCOMPLETE',
	'ABSENT',
	'OFF_DAY',
	'HOLIDAY',
	'LEAVE',
	'NO_SCHEDULE'
] as const;
export type DailyResult = (typeof DAILY_RESULTS)[number];

export const dailyQuerySchema = paginationQuerySchema.extend({
	date: optionalDateField(),
	companyId: optionalId(),
	branchId: optionalId(),
	departmentId: optionalId(),
	employeeId: optionalId(),
	result: z.enum(DAILY_RESULTS).optional(),
	search: z.string().trim().max(120).optional()
});
export type DailyQuery = z.infer<typeof dailyQuerySchema>;

// ---------- corrections ----------

const correctionTypeEnum = z.enum([
	'MISSING_CHECK_IN',
	'MISSING_CHECK_OUT',
	'TIME_ADJUSTMENT',
	'MISSING_BOTH'
]);

/** ISO instant WITH an explicit offset (the UI sends e.g. 2026-09-19T08:05:00+07:00). */
const instantField = z
	.string()
	.trim()
	.datetime({ offset: true, message: 'ເວລາບໍ່ຖືກຕ້ອງ (ຕ້ອງເປັນ ISO ພ້ອມ timezone)' })
	.transform((v) => new Date(v));

export const correctionCreateSchema = z
	.object({
		workDate: z
			.string()
			.trim()
			.regex(/^\d{4}-\d{2}-\d{2}$/, 'ວັນທີ່ບໍ່ຖືກຕ້ອງ (YYYY-MM-DD)'),
		type: correctionTypeEnum,
		requestedCheckInAt: instantField.optional(),
		requestedCheckOutAt: instantField.optional(),
		reason: z.string().trim().min(3, 'ກະລຸນາລະບຸເຫດຜົນ').max(1000)
	})
	.strict();
export type CorrectionCreateInput = z.infer<typeof correctionCreateSchema>;

export const correctionContextQuerySchema = z.object({
	workDate: z
		.string()
		.trim()
		.regex(/^\d{4}-\d{2}-\d{2}$/, 'ວັນທີ່ບໍ່ຖືກຕ້ອງ (YYYY-MM-DD)')
});

export const correctionStatusEnum = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);

export const correctionListQuerySchema = paginationQuerySchema.extend({
	status: correctionStatusEnum.optional(),
	date: optionalDateField(),
	from: optionalDateField(),
	to: optionalDateField(),
	employeeId: optionalId(),
	departmentId: optionalId(),
	search: z.string().trim().max(120).optional()
});
export type CorrectionListQuery = z.infer<typeof correctionListQuerySchema>;

export const selfCorrectionListQuerySchema = paginationQuerySchema.extend({
	status: correctionStatusEnum.optional()
});

export const approveBodySchema = z
	.object({ reviewNote: z.string().trim().max(1000).optional() })
	.strict();
export const rejectBodySchema = z
	.object({ reviewNote: z.string().trim().min(1, 'ກະລຸນາລະບຸເຫດຜົນທີ່ປະຕິເສດ').max(1000) })
	.strict();
