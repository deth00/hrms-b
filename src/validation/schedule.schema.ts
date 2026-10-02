import { z } from 'zod';
import { shiftDurationMinutes } from '../lib/dates.js';
import { dateField, nullableDateField, optionalDateField } from './employee.schema.js';
import {
	codeField,
	idField,
	nameField,
	nullableText,
	optionalId,
	orgStatusEnum,
	paginationQuerySchema
} from './common.schema.js';

// ---------- shared ----------

/** "HH:mm", 24-hour. Stored as a string so no timezone can ever shift it. */
export const timeField = z
	.string()
	.trim()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'ເວລາບໍ່ຖືກຕ້ອງ (ຮູບແບບ HH:mm)');

const minutes = (max = 1440) =>
	z.number().int('ຕ້ອງເປັນເລກຈຳນວນເຕັມ').min(0, 'ຕ້ອງບໍ່ຕິດລົບ').max(max, `ຕ້ອງບໍ່ເກີນ ${max}`);

export const dayOfWeekEnum = z.enum([
	'MONDAY',
	'TUESDAY',
	'WEDNESDAY',
	'THURSDAY',
	'FRIDAY',
	'SATURDAY',
	'SUNDAY'
]);
export const DAYS = dayOfWeekEnum.options;

// ---------- shift ----------

const workDaySchema = z.object({
	dayOfWeek: dayOfWeekEnum,
	isWorkingDay: z.boolean(),
	startTimeOverride: z.preprocess((v) => (v === '' ? null : v), timeField.nullable().optional()),
	endTimeOverride: z.preprocess((v) => (v === '' ? null : v), timeField.nullable().optional()),
	breakMinutesOverride: minutes().nullable().optional()
});
export type WorkDayInput = z.infer<typeof workDaySchema>;

const workDaysSchema = z
	.array(workDaySchema)
	.max(7)
	.refine((days) => new Set(days.map((d) => d.dayOfWeek)).size === days.length, {
		message: 'ມື້ໃນອາທິດຊ້ຳກັນ'
	});

const shiftBase = {
	shiftType: z.enum(['FIXED', 'FLEXIBLE']).default('FIXED'),
	startTime: timeField,
	endTime: timeField,
	breakMinutes: minutes().default(0),
	lateGraceMinutes: minutes().default(0),
	earlyCheckInMinutes: minutes().nullable().optional(),
	earlyLeaveGraceMinutes: minutes().default(0),
	minimumWorkMinutes: minutes().nullable().optional(),
	nameLao: nameField(150),
	nameEnglish: nullableText(150),
	description: nullableText(255),
	workDays: workDaysSchema.optional()
};

export interface TimeIssue {
	path: string;
	message: string;
}

/** Cross-field rules shared by create (schema) and update (service, on the merged values). */
export function shiftTimeIssues(d: {
	startTime: string;
	endTime: string;
	breakMinutes: number;
	minimumWorkMinutes?: number | null;
}): TimeIssue[] {
	if (d.startTime === d.endTime) {
		return [{ path: 'endTime', message: 'ເວລາເລີ່ມ ແລະ ເວລາເລີກ ຕ້ອງບໍ່ເທົ່າກັນ' }];
	}
	const issues: TimeIssue[] = [];
	const duration = shiftDurationMinutes(d.startTime, d.endTime);
	if (d.breakMinutes >= duration) {
		issues.push({ path: 'breakMinutes', message: 'ເວລາພັກຕ້ອງໜ້ອຍກວ່າໄລຍະເວລາຂອງກະ' });
	}
	if (d.minimumWorkMinutes != null && d.minimumWorkMinutes > duration) {
		issues.push({
			path: 'minimumWorkMinutes',
			message: 'ເວລາເຮັດວຽກຂັ້ນຕ່ຳຕ້ອງບໍ່ເກີນໄລຍະເວລາຂອງກະ'
		});
	}
	return issues;
}

export const shiftCreateSchema = z
	.object({
		companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
		code: codeField(30),
		...shiftBase,
		status: orgStatusEnum.default('ACTIVE')
	})
	.superRefine((d, ctx) => {
		for (const issue of shiftTimeIssues(d)) {
			ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
		}
	});
export type ShiftCreateInput = z.infer<typeof shiftCreateSchema>;

// Written out (not .partial()) so no create-time default (status, breakMinutes, ...) leaks into a PATCH.
export const shiftUpdateSchema = z
	.object({
		shiftType: z.enum(['FIXED', 'FLEXIBLE']).optional(),
		startTime: timeField.optional(),
		endTime: timeField.optional(),
		breakMinutes: minutes().optional(),
		lateGraceMinutes: minutes().optional(),
		earlyCheckInMinutes: minutes().nullable().optional(),
		earlyLeaveGraceMinutes: minutes().optional(),
		minimumWorkMinutes: minutes().nullable().optional(),
		nameLao: nameField(150).optional(),
		nameEnglish: nullableText(150),
		description: nullableText(255),
		workDays: workDaysSchema.optional(),
		status: orgStatusEnum.optional()
	})
	.refine((d) => Object.keys(d).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type ShiftUpdateInput = z.infer<typeof shiftUpdateSchema>;

export const shiftListQuerySchema = paginationQuerySchema.extend({
	companyId: optionalId(),
	status: orgStatusEnum.optional(),
	type: z.enum(['FIXED', 'FLEXIBLE']).optional(),
	search: z.string().trim().max(120).optional()
});
export type ShiftListQuery = z.infer<typeof shiftListQuerySchema>;

export const shiftLookupQuerySchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
	status: orgStatusEnum.optional()
});

// ---------- holiday ----------

export const holidayCreateSchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
	holidayDate: dateField(),
	nameLao: nameField(150),
	nameEnglish: nullableText(150),
	type: z.enum(['PUBLIC', 'COMPANY']).default('PUBLIC'),
	isPaid: z.boolean().default(true),
	description: nullableText(255),
	status: orgStatusEnum.default('ACTIVE')
});
export type HolidayCreateInput = z.infer<typeof holidayCreateSchema>;

export const holidayUpdateSchema = z
	.object({
		holidayDate: dateField().optional(),
		nameLao: nameField(150).optional(),
		nameEnglish: nullableText(150),
		type: z.enum(['PUBLIC', 'COMPANY']).optional(),
		isPaid: z.boolean().optional(),
		description: nullableText(255),
		status: orgStatusEnum.optional()
	})
	.refine((d) => Object.keys(d).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type HolidayUpdateInput = z.infer<typeof holidayUpdateSchema>;

export const holidayListQuerySchema = paginationQuerySchema
	.extend({
		companyId: optionalId(),
		year: z.coerce.number().int().min(1900).max(2200).optional(),
		month: z.coerce.number().int().min(1).max(12).optional(),
		type: z.enum(['PUBLIC', 'COMPANY']).optional(),
		status: orgStatusEnum.optional(),
		search: z.string().trim().max(120).optional()
	})
	.refine((q) => q.month === undefined || q.year !== undefined, {
		path: ['year'],
		message: 'ຕ້ອງລະບຸປີພ້ອມກັບເດືອນ'
	});
export type HolidayListQuery = z.infer<typeof holidayListQuerySchema>;

// ---------- schedule assignment ----------

export const scheduleAssignSchema = z
	.object({
		shiftId: idField('ກະລຸນາເລືອກກະເຮັດວຽກ'),
		effectiveFrom: dateField(),
		effectiveTo: nullableDateField(),
		reason: nullableText(500)
	})
	.refine((d) => !d.effectiveTo || d.effectiveTo >= d.effectiveFrom, {
		path: ['effectiveTo'],
		message: 'ວັນສິ້ນສຸດຕ້ອງບໍ່ກ່ອນວັນເລີ່ມ'
	});
export type ScheduleAssignInput = z.infer<typeof scheduleAssignSchema>;

/** Safe correction only: the end of the period and the reason. Shift/start cannot be rewritten. */
export const scheduleUpdateSchema = z
	.object({ effectiveTo: nullableDateField(), reason: nullableText(500) })
	.refine((d) => Object.keys(d).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type ScheduleUpdateInput = z.infer<typeof scheduleUpdateSchema>;

export const scheduleListQuerySchema = paginationQuerySchema.extend({
	employeeId: optionalId(),
	companyId: optionalId(),
	departmentId: optionalId(),
	shiftId: optionalId(),
	date: optionalDateField(),
	search: z.string().trim().max(120).optional(),
	/** include ended (RESIGNED/TERMINATED) employees; default excludes them */
	includeEnded: z.enum(['true', 'false']).optional()
});
export type ScheduleListQuery = z.infer<typeof scheduleListQuerySchema>;

export const scheduleResolveQuerySchema = z.object({ date: optionalDateField() });
