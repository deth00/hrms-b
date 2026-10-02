import { z } from 'zod';
import { optionalDateField } from './employee.schema.js';
import {
	codeField,
	idField,
	nameField,
	nullableText,
	optionalId,
	optionalIdField,
	orgStatusEnum,
	paginationQuerySchema
} from './common.schema.js';

// ---------- self punch ----------

/**
 * `.strict()` on purpose: any attempt to send an authoritative timestamp (`punchedAt`, `time`,
 * …) or a client-computed verdict (`isInside`, …) is rejected outright rather than ignored.
 * The punch instant is ALWAYS the server clock; distance/inside-radius is ALWAYS computed
 * server-side from the coordinates.
 */
export const punchBodySchema = z
	.object({
		latitude: z.number().min(-90).max(90).optional(),
		longitude: z.number().min(-180).max(180).optional(),
		accuracyMeters: z.number().min(0).max(100_000).optional(),
		/** informational only — never trusted */
		source: z.enum(['WEB', 'MOBILE_WEB']).optional()
	})
	.strict()
	.refine((d) => (d.latitude === undefined) === (d.longitude === undefined), {
		path: ['latitude'],
		message: 'ຕ້ອງສົ່ງ latitude ແລະ longitude ພ້ອມກັນ'
	});
export type PunchBody = z.infer<typeof punchBodySchema>;

export const historyQuerySchema = paginationQuerySchema.extend({
	from: optionalDateField(),
	to: optionalDateField()
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

/** Employee portal — one calendar month of the employee's own days (YYYY-MM, 2000–2099). */
export const selfCalendarQuerySchema = z
	.object({
		month: z
			.string()
			.trim()
			.regex(/^20\d{2}-(0[1-9]|1[0-2])$/, 'ເດືອນບໍ່ຖືກຕ້ອງ (YYYY-MM)')
			.optional()
	})
	.strict();
export type SelfCalendarQuery = z.infer<typeof selfCalendarQuerySchema>;

// ---------- admin ----------

export const attendanceListQuerySchema = paginationQuerySchema.extend({
	date: optionalDateField(),
	from: optionalDateField(),
	to: optionalDateField(),
	employeeId: optionalId(),
	companyId: optionalId(),
	branchId: optionalId(),
	departmentId: optionalId(),
	status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'MISSING_CHECK_OUT']).optional(),
	search: z.string().trim().max(120).optional()
});
export type AttendanceListQuery = z.infer<typeof attendanceListQuerySchema>;

// ---------- work location ----------

const latitudeField = z.number().min(-90, 'latitude ຕ້ອງຢູ່ລະຫວ່າງ -90 ຫາ 90').max(90);
const longitudeField = z.number().min(-180, 'longitude ຕ້ອງຢູ່ລະຫວ່າງ -180 ຫາ 180').max(180);
const radiusField = z
	.number()
	.int('ລັດສະໝີຕ້ອງເປັນເລກຈຳນວນເຕັມ')
	.min(10, 'ລັດສະໝີຕ້ອງບໍ່ໜ້ອຍກວ່າ 10 ແມັດ')
	.max(50_000, 'ລັດສະໝີຕ້ອງບໍ່ເກີນ 50,000 ແມັດ');

export const workLocationCreateSchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
	branchId: optionalIdField(),
	code: codeField(30),
	nameLao: nameField(150),
	nameEnglish: nullableText(150),
	latitude: latitudeField,
	longitude: longitudeField,
	radiusMeters: radiusField,
	requireGps: z.boolean().default(false),
	description: nullableText(255),
	status: orgStatusEnum.default('ACTIVE')
});
export type WorkLocationCreateInput = z.infer<typeof workLocationCreateSchema>;

// Written out (not `.partial()`) so create-time defaults can never leak into a PATCH.
export const workLocationUpdateSchema = z
	.object({
		branchId: optionalIdField(),
		nameLao: nameField(150).optional(),
		nameEnglish: nullableText(150),
		latitude: latitudeField.optional(),
		longitude: longitudeField.optional(),
		radiusMeters: radiusField.optional(),
		requireGps: z.boolean().optional(),
		description: nullableText(255),
		status: orgStatusEnum.optional()
	})
	.refine((d) => Object.keys(d).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type WorkLocationUpdateInput = z.infer<typeof workLocationUpdateSchema>;

export const workLocationListQuerySchema = paginationQuerySchema.extend({
	companyId: optionalId(),
	branchId: optionalId(),
	status: orgStatusEnum.optional(),
	search: z.string().trim().max(120).optional()
});
export type WorkLocationListQuery = z.infer<typeof workLocationListQuerySchema>;
