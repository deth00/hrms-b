import { z } from 'zod';
import { nullableText } from './common.schema.js';
import { nullableDateField } from './employee.schema.js';

/** trimmed, "" clears it. Format is deliberately unconstrained (Lao TIN / SSN formats are not validated here). */
const nullableIdentifier = (max: number) =>
	z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(max).nullable().optional());

export const statutoryProfileUpdateSchema = z
	.object({
		pitApplicable: z.boolean(),
		socialSecurityApplicable: z.boolean(),
		tin: nullableIdentifier(50),
		socialSecurityNumber: nullableIdentifier(50),
		socialSecurityEffectiveFrom: nullableDateField(),
		socialSecurityEffectiveTo: nullableDateField(),
		notes: nullableText(2000)
	})
	.strict()
	.refine(
		(d) =>
			!d.socialSecurityEffectiveFrom ||
			!d.socialSecurityEffectiveTo ||
			d.socialSecurityEffectiveFrom <= d.socialSecurityEffectiveTo,
		{
			message: 'ວັນສິ້ນສຸດປະກັນສັງຄົມຕ້ອງບໍ່ກ່ອນວັນເລີ່ມ',
			path: ['socialSecurityEffectiveTo']
		}
	);
export type StatutoryProfileUpdateInput = z.infer<typeof statutoryProfileUpdateSchema>;
