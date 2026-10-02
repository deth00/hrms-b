import { z } from 'zod';
import {
	idField,
	idSchema,
	nameField,
	nullableText,
	paginationQuerySchema
} from './common.schema.js';
import { dateField } from './employee.schema.js';

export const prorationMethodEnum = z.enum(['CALENDAR_DAYS', 'WORKING_DAYS']);
export const minuteBasisEnum = z.enum(['SCHEDULED_DAILY_MINUTES', 'STANDARD_DAILY_MINUTES']);
export const overtimeTypeEnum = z.enum(['BEFORE_SHIFT', 'AFTER_SHIFT', 'OFF_DAY', 'HOLIDAY']);
export const overtimeRateBasisEnum = z.enum(['BASE_SALARY_DIVISOR']);

export const ruleListQuerySchema = paginationQuerySchema.extend({
	companyId: idSchema.optional()
});
export type RuleListQuery = z.infer<typeof ruleListQuerySchema>;

const MULTIPLIER = /^\d{1,4}(\.\d{1,4})?$/;
/** a plain decimal string / number, at most 4 fraction digits, > 0. Never a legal constant. */
const multiplierField = () =>
	z.union([z.string(), z.number()]).transform((v, ctx) => {
		const text = typeof v === 'number' ? String(v) : v.trim();
		if (!MULTIPLIER.test(text) || Number(text) <= 0) {
			ctx.addIssue({
				code: 'custom',
				message: 'ຕົວຄູນຕ້ອງເປັນຕົວເລກຫຼາຍກວ່າ 0 (ສູງສຸດ 4 ຕຳແໜ່ງທົດສະນິຍົມ)'
			});
			return z.NEVER;
		}
		return text;
	});
const positiveInt = (max: number) => z.number().int().min(1).max(max);

/**
 * OT rule rows are stored even when the divisor settings are still empty (the run then BLOCKS the
 * employees that actually have such OT with OT_COMPENSATION_RULE_INCOMPLETE — nothing is guessed).
 */
export const overtimeRuleInput = z
	.object({
		overtimeType: overtimeTypeEnum,
		multiplier: multiplierField(),
		rateBasis: overtimeRateBasisEnum.default('BASE_SALARY_DIVISOR'),
		monthlyDivisorDays: positiveInt(31).nullable().optional(),
		standardDailyMinutes: positiveInt(1440).nullable().optional()
	})
	.strict();

export const ruleCreateSchema = z
	.object({
		companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
		nameLao: nameField(),
		nameEnglish: nullableText(150),
		effectiveFrom: dateField(),
		prorationMethod: prorationMethodEnum,
		absenceDeductionEnabled: z.boolean().default(false),
		unpaidLeaveDeductionEnabled: z.boolean().default(false),
		lateDeductionEnabled: z.boolean().default(false),
		earlyLeaveDeductionEnabled: z.boolean().default(false),
		minuteDeductionBasis: minuteBasisEnum.default('SCHEDULED_DAILY_MINUTES'),
		standardMonthlyDays: positiveInt(31).nullable().optional(),
		standardDailyMinutes: positiveInt(1440).nullable().optional(),
		overtimeRules: z.array(overtimeRuleInput).max(4).default([])
	})
	.strict()
	.superRefine((d, ctx) => {
		if (d.minuteDeductionBasis === 'STANDARD_DAILY_MINUTES' && !d.standardDailyMinutes) {
			ctx.addIssue({
				code: 'custom',
				path: ['standardDailyMinutes'],
				message: 'ຕ້ອງລະບຸນາທີຕໍ່ວັນມາດຕະຖານ ເມື່ອເລືອກຖານ "ນາທີມາດຕະຖານ"'
			});
		}
		const seen = new Set<string>();
		d.overtimeRules.forEach((r, i) => {
			if (seen.has(r.overtimeType)) {
				ctx.addIssue({
					code: 'custom',
					path: ['overtimeRules', i, 'overtimeType'],
					message: 'ປະເພດ OT ຊ້ຳກັນ'
				});
			}
			seen.add(r.overtimeType);
		});
	});
export type RuleCreateInput = z.infer<typeof ruleCreateSchema>;
