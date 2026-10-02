import { z } from 'zod';
import { idField, optionalId, paginationQuerySchema } from './common.schema.js';
import { dateField, optionalDateField } from './employee.schema.js';

const yearQuery = z.coerce.number().int().min(2000).max(2100);

// ---------- policy (NO pay rates / multipliers — those belong to a later Payroll phase) ----------

export const overtimePolicyQuerySchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ')
});

export const overtimePolicyUpdateSchema = z
	.object({
		minimumRequestMinutes: z.number().int().min(1).max(1440).optional(),
		maximumRequestMinutesPerDay: z.number().int().min(1).max(1440).optional(),
		allowBeforeShift: z.boolean().optional(),
		allowAfterShift: z.boolean().optional(),
		allowOffDay: z.boolean().optional(),
		allowHoliday: z.boolean().optional(),
		checkInEarlyMinutes: z.number().int().min(0).max(720).optional()
	})
	.strict()
	.refine((d) => Object.keys(d).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type OvertimePolicyUpdateInput = z.infer<typeof overtimePolicyUpdateSchema>;

// ---------- requests ----------

/** ISO instant WITH an explicit offset (the UI sends e.g. 2026-09-19T17:30:00+07:00). */
const instantField = z
	.string()
	.trim()
	.datetime({ offset: true, message: 'ເວລາບໍ່ຖືກຕ້ອງ (ຕ້ອງເປັນ ISO ພ້ອມ timezone)' })
	.transform((v) => new Date(v));

/**
 * Only the window is accepted. `employeeId`, `type`, `plannedMinutes`, `actualMinutes`,
 * `eligibleMinutes`, status and reviewer are all derived by the backend — `.strict()` rejects them.
 */
export const overtimePreviewSchema = z
	.object({
		workDate: dateField(),
		requestedStartAt: instantField,
		requestedEndAt: instantField
	})
	.strict();
export type OvertimePreviewInput = z.infer<typeof overtimePreviewSchema>;

export const overtimeCreateSchema = z
	.object({
		workDate: dateField(),
		requestedStartAt: instantField,
		requestedEndAt: instantField,
		reason: z.string().trim().min(3, 'ກະລຸນາລະບຸເຫດຜົນ').max(1000)
	})
	.strict();
export type OvertimeCreateInput = z.infer<typeof overtimeCreateSchema>;

const statusEnum = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);
const typeEnum = z.enum(['BEFORE_SHIFT', 'AFTER_SHIFT', 'OFF_DAY', 'HOLIDAY']);

export const selfOvertimeListQuerySchema = paginationQuerySchema.extend({
	year: yearQuery.optional(),
	status: statusEnum.optional()
});
export type SelfOvertimeListQuery = z.infer<typeof selfOvertimeListQuerySchema>;

export const overtimeListQuerySchema = paginationQuerySchema.extend({
	status: statusEnum.optional(),
	type: typeEnum.optional(),
	year: yearQuery.optional(),
	from: optionalDateField(),
	to: optionalDateField(),
	employeeId: optionalId(),
	companyId: optionalId(),
	departmentId: optionalId(),
	search: z.string().trim().max(120).optional()
});
export type OvertimeListQuery = z.infer<typeof overtimeListQuerySchema>;

export const overtimeApproveSchema = z
	.object({ reviewNote: z.string().trim().max(1000).optional() })
	.strict();
export const overtimeRejectSchema = z
	.object({ reviewNote: z.string().trim().min(3, 'ກະລຸນາລະບຸເຫດຜົນທີ່ປະຕິເສດ').max(1000) })
	.strict();
