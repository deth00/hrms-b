import { z } from 'zod';
import {
	idField,
	idSchema,
	nameField,
	nullableText,
	paginationQuerySchema
} from './common.schema.js';
import { dateField, nullableDateField } from './employee.schema.js';
import { currencyCodeField } from './payroll.schema.js';

export const statutoryRuleStatusEnum = z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']);
export const thresholdComparisonEnum = z.enum(['LESS_THAN']);

export const statutoryRuleListQuerySchema = paginationQuerySchema.extend({
	companyId: idSchema.optional(),
	status: statutoryRuleStatusEnum.optional()
});
export type StatutoryRuleListQuery = z.infer<typeof statutoryRuleListQuerySchema>;

/** a plain decimal string/number, at most 2 fraction digits, >= 0 — never a legal constant itself. */
const boundField = () =>
	z.union([z.string(), z.number()]).transform((v, ctx) => {
		const text = typeof v === 'number' ? String(v) : v.trim();
		if (!/^\d{1,16}(\.\d{1,2})?$/.test(text)) {
			ctx.addIssue({ code: 'custom', message: 'ຈຳນວນເງິນບໍ່ຖືກຕ້ອງ' });
			return z.NEVER;
		}
		return text;
	});

/** a plain fraction 0 < rate <= 1, at most 4 fraction digits ("0.05" = 5%, never a whole-number percent). */
/** a fraction 0 <= rate <= 1 — a PIT bracket's rate MAY legitimately be 0 (a tax-exempt bracket). */
const bracketRateField = () =>
	z.union([z.string(), z.number()]).transform((v, ctx) => {
		const text = typeof v === 'number' ? String(v) : v.trim();
		if (!/^0(\.\d{1,4})?$|^1(\.0{1,4})?$/.test(text)) {
			ctx.addIssue({
				code: 'custom',
				message: 'ອັດຕາຕ້ອງເປັນຕົວເລກທົດສະນິຍົມລະຫວ່າງ 0 ແລະ 1 (ເຊັ່ນ 0.05 ສຳລັບ 5%)'
			});
			return z.NEVER;
		}
		return text;
	});
/** a fraction 0 < rate <= 1 — a Social Security rate must be strictly positive. */
const rateField = () =>
	z.union([z.string(), z.number()]).transform((v, ctx) => {
		const text = typeof v === 'number' ? String(v) : v.trim();
		if (!/^0(\.\d{1,4})?$|^1(\.0{1,4})?$/.test(text) || Number(text) <= 0) {
			ctx.addIssue({
				code: 'custom',
				message: 'ອັດຕາຕ້ອງເປັນຕົວເລກທົດສະນິຍົມລະຫວ່າງ 0 ແລະ 1 (ເຊັ່ນ 0.05 ສຳລັບ 5%)'
			});
			return z.NEVER;
		}
		return text;
	});

export const pitBracketInput = z
	.object({
		order: z.number().int().min(1).max(20),
		lowerBound: boundField(),
		upperBound: boundField().nullable(),
		rate: bracketRateField()
	})
	.strict();

export const socialSecurityInput = z
	.object({
		employeeRate: rateField(),
		employerRate: rateField(),
		minimumBase: boundField().nullable().optional(),
		maximumBase: boundField().nullable().optional(),
		employeeContributionPitDeductible: z.boolean().default(true)
	})
	.strict();

export const statutoryRuleCreateSchema = z
	.object({
		companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
		jurisdictionCode: z.string().trim().toUpperCase().max(8).default('LA'),
		currencyCode: currencyCodeField(),
		nameLao: nameField(),
		nameEnglish: nullableText(150),
		effectiveFrom: dateField(),
		/** disambiguates a mid-month transition (§3) — the payroll month ("2026-08") this version starts */
		effectivePayrollMonth: z
			.string()
			.trim()
			.regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'ຮູບແບບເດືອນຕ້ອງເປັນ YYYY-MM')
			.nullable()
			.optional(),
		legalReference: nullableText(255),
		sourceDescription: nullableText(2000),
		verifiedAt: nullableDateField(),
		notes: nullableText(2000),
		pitEnabled: z.boolean().default(true),
		socialSecurityEnabled: z.boolean().default(true),
		pitBrackets: z.array(pitBracketInput).max(20).default([]),
		socialSecurity: socialSecurityInput.nullable().optional(),
		overtimePitTreatmentEnabled: z.boolean().default(false),
		overtimePitExemptionBaseSalaryThreshold: boundField().nullable().optional()
	})
	.strict()
	.superRefine((d, ctx) => {
		if (d.pitEnabled && d.pitBrackets.length === 0) {
			ctx.addIssue({
				code: 'custom',
				path: ['pitBrackets'],
				message: 'ຕ້ອງມີຢ່າງນ້ອຍໜຶ່ງຂັ້ນອັດຕາພາສີ ເມື່ອເປີດໃຊ້ພາສີເງິນໄດ້'
			});
		}
		if (d.socialSecurityEnabled && !d.socialSecurity) {
			ctx.addIssue({
				code: 'custom',
				path: ['socialSecurity'],
				message: 'ກະລຸນາຕັ້ງຄ່າອັດຕາປະກັນສັງຄົມ ເມື່ອເປີດໃຊ້ປະກັນສັງຄົມ'
			});
		}
		if (d.overtimePitTreatmentEnabled && !d.overtimePitExemptionBaseSalaryThreshold) {
			ctx.addIssue({
				code: 'custom',
				path: ['overtimePitExemptionBaseSalaryThreshold'],
				message: 'ກະລຸນາລະບຸເກນເງິນເດືອນ ເມື່ອເປີດໃຊ້ການຍົກເວັ້ນພາສີ OT'
			});
		}
	});
export type StatutoryRuleCreateInput = z.infer<typeof statutoryRuleCreateSchema>;
