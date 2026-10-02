import { z } from 'zod';
import {
	codeField,
	idField,
	idSchema,
	nameField,
	nullableText,
	optionalId,
	orgStatusEnum,
	paginationQuerySchema
} from './common.schema.js';
import { dateField } from './employee.schema.js';

export const payBasisEnum = z.enum(['MONTHLY', 'DAILY']);
export const paymentsPerMonthEnum = z.enum(['ONE', 'TWO']);
export const payDateRuleEnum = z.enum(['PERIOD_END']);
export const employeeScopeEnum = z.enum(['ALL', 'SELECTED']);
/** Phase 12A.1 - how ONE monthly compensation / recurring amount is split across a TWO/month schedule. */
export const monthlyAllocationMethodEnum = z.enum(['EQUAL_SPLIT', 'PERIOD_UNITS']);

export const scheduleListQuerySchema = paginationQuerySchema.extend({
	companyId: optionalId(),
	status: orgStatusEnum.optional()
});
export type ScheduleListQuery = z.infer<typeof scheduleListQuerySchema>;

interface Shape {
	paymentsPerMonth?: 'ONE' | 'TWO';
	splitDay?: number | null;
	monthlyAllocationMethod?: 'EQUAL_SPLIT' | 'PERIOD_UNITS' | null;
	employeeScope?: 'ALL' | 'SELECTED';
	employeeIds?: number[];
}

/** TWO needs a split day 1..28; ONE must not have one. */
export function splitDayIssue(
	paymentsPerMonth: 'ONE' | 'TWO',
	splitDay: number | null | undefined
) {
	if (paymentsPerMonth === 'TWO') {
		if (splitDay === null || splitDay === undefined)
			return 'ຕ້ອງລະບຸວັນແບ່ງຮອບ (1–28) ເມື່ອຈ່າຍ 2 ຄັ້ງ/ເດືອນ';
		if (!Number.isInteger(splitDay) || splitDay < 1 || splitDay > 28) {
			return 'ວັນແບ່ງຮອບຕ້ອງເປັນເລກ 1–28';
		}
	} else if (splitDay !== null && splitDay !== undefined) {
		return 'ຈ່າຍ 1 ຄັ້ງ/ເດືອນ ບໍ່ຕ້ອງລະບຸວັນແບ່ງຮອບ';
	}
	return null;
}

/**
 * Phase 12A.1 - ONE must not carry a monthly allocation method (there is nothing to split). TWO MAY
 * leave it unset (§5: an existing — or a freshly created — TWO/month schedule is allowed to stay
 * unconfigured; it is never silently assigned one). Calculation BLOCKS with
 * PAYROLL_CYCLE_ALLOCATION_REQUIRED until HR configures it, on new schedules exactly as on old ones.
 */
export function allocationMethodIssue(
	paymentsPerMonth: 'ONE' | 'TWO',
	method: 'EQUAL_SPLIT' | 'PERIOD_UNITS' | null | undefined
) {
	if (paymentsPerMonth !== 'TWO' && method !== null && method !== undefined) {
		return 'ຈ່າຍ 1 ຄັ້ງ/ເດືອນ ບໍ່ຕ້ອງເລືອກວິທີແບ່ງເງິນເດືອນ';
	}
	return null;
}

const shapeChecks = (d: Shape, ctx: z.RefinementCtx) => {
	if (d.paymentsPerMonth) {
		const issue = splitDayIssue(d.paymentsPerMonth, d.splitDay);
		if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['splitDay'] });
		const allocIssue = allocationMethodIssue(d.paymentsPerMonth, d.monthlyAllocationMethod);
		if (allocIssue) {
			ctx.addIssue({ code: 'custom', message: allocIssue, path: ['monthlyAllocationMethod'] });
		}
	}
	if (d.employeeScope === 'SELECTED' && (d.employeeIds?.length ?? 0) === 0) {
		ctx.addIssue({
			code: 'custom',
			message: 'ກະລຸນາເລືອກພະນັກງານຢ່າງໜ້ອຍ 1 ຄົນ',
			path: ['employeeIds']
		});
	}
	if (d.employeeScope === 'ALL' && (d.employeeIds?.length ?? 0) > 0) {
		ctx.addIssue({
			code: 'custom',
			message: 'ຂອບເຂດ "ທຸກຄົນ" ບໍ່ຕ້ອງລະບຸລາຍຊື່ພະນັກງານ',
			path: ['employeeIds']
		});
	}
};

const employeeIdsField = () => z.array(idSchema).max(2000);

export const scheduleCreateSchema = z
	.object({
		companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
		code: codeField(30),
		nameLao: nameField(150),
		nameEnglish: nullableText(150),
		payBasis: payBasisEnum.default('MONTHLY'),
		paymentsPerMonth: paymentsPerMonthEnum.default('ONE'),
		anchorDate: dateField(),
		splitDay: z.number().int().nullable().optional(),
		payDateRule: payDateRuleEnum.default('PERIOD_END'),
		monthlyAllocationMethod: monthlyAllocationMethodEnum.nullable().optional(),
		employeeScope: employeeScopeEnum.default('ALL'),
		employeeIds: employeeIdsField().default([]),
		groupByBranch: z.boolean().default(false),
		status: orgStatusEnum.default('ACTIVE')
	})
	.strict()
	.superRefine(shapeChecks);
export type ScheduleCreateInput = z.infer<typeof scheduleCreateSchema>;

/** company + code never change; the structural fields are refused by the service once periods exist. */
export const scheduleUpdateSchema = z
	.object({
		nameLao: nameField(150).optional(),
		nameEnglish: nullableText(150),
		payBasis: payBasisEnum.optional(),
		paymentsPerMonth: paymentsPerMonthEnum.optional(),
		anchorDate: dateField().optional(),
		splitDay: z.number().int().nullable().optional(),
		payDateRule: payDateRuleEnum.optional(),
		monthlyAllocationMethod: monthlyAllocationMethodEnum.nullable().optional(),
		employeeScope: employeeScopeEnum.optional(),
		employeeIds: employeeIdsField().optional(),
		groupByBranch: z.boolean().optional(),
		status: orgStatusEnum.optional()
	})
	.strict()
	.refine((d) => Object.keys(d).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type ScheduleUpdateInput = z.infer<typeof scheduleUpdateSchema>;

const monthField = () =>
	z
		.string()
		.trim()
		.regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'ຮູບແບບເດືອນຕ້ອງເປັນ YYYY-MM');
const MAX_MONTHS = 24;
export const monthsBetween = (from: string, to: string) =>
	(Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
	(Number(to.slice(5, 7)) - Number(from.slice(5, 7))) +
	1;

export const generatePeriodsSchema = z
	.object({ fromMonth: monthField(), toMonth: monthField() })
	.strict()
	.superRefine((d, ctx) => {
		const n = monthsBetween(d.fromMonth, d.toMonth);
		if (n < 1)
			ctx.addIssue({
				code: 'custom',
				message: 'ເດືອນສິ້ນສຸດຕ້ອງບໍ່ກ່ອນເດືອນເລີ່ມ',
				path: ['toMonth']
			});
		else if (n > MAX_MONTHS) {
			ctx.addIssue({
				code: 'custom',
				message: `ສ້າງໄດ້ສູງສຸດ ${MAX_MONTHS} ເດືອນຕໍ່ຄັ້ງ`,
				path: ['toMonth']
			});
		}
	});
export type GeneratePeriodsInput = z.infer<typeof generatePeriodsSchema>;
