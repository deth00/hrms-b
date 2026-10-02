import { z } from 'zod';
import {
	codeField,
	idField,
	idSchema,
	nameField,
	nullableText,
	optionalIdField,
	orgStatusEnum,
	paginationQuerySchema
} from './common.schema.js';

// ---------- Position Level ----------

export const positionLevelCreateSchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
	code: codeField(30),
	nameLao: nameField(150),
	nameEnglish: nullableText(150),
	rank: z.number().int('rank ຕ້ອງເປັນເລກຈຳນວນເຕັມ').positive('rank ຕ້ອງເປັນຕົວເລກບວກ'),
	description: nullableText(255),
	status: orgStatusEnum.default('ACTIVE')
});
export type PositionLevelCreateInput = z.infer<typeof positionLevelCreateSchema>;

export const positionLevelUpdateSchema = positionLevelCreateSchema
	.omit({ companyId: true, code: true })
	.partial()
	// .partial() keeps the create schema's status DEFAULT, which would silently reset status on every PATCH.
	.extend({ status: orgStatusEnum.optional() })
	.refine((data) => Object.keys(data).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type PositionLevelUpdateInput = z.infer<typeof positionLevelUpdateSchema>;

export const positionLevelListQuerySchema = paginationQuerySchema.extend({
	companyId: idSchema.optional(),
	status: orgStatusEnum.optional(),
	search: z.string().trim().max(120).optional()
});
export type PositionLevelListQuery = z.infer<typeof positionLevelListQuerySchema>;

export const positionLevelLookupQuerySchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
	status: orgStatusEnum.optional()
});

// ---------- Position ----------

export const positionCreateSchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
	positionLevelId: optionalIdField(),
	code: codeField(30),
	nameLao: nameField(150),
	nameEnglish: nullableText(150),
	description: nullableText(255),
	status: orgStatusEnum.default('ACTIVE')
});
export type PositionCreateInput = z.infer<typeof positionCreateSchema>;

export const positionUpdateSchema = positionCreateSchema
	.omit({ companyId: true, code: true })
	.partial()
	// .partial() keeps the create schema's status DEFAULT, which would silently reset status on every PATCH.
	.extend({ status: orgStatusEnum.optional() })
	.refine((data) => Object.keys(data).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type PositionUpdateInput = z.infer<typeof positionUpdateSchema>;

export const positionListQuerySchema = paginationQuerySchema.extend({
	companyId: idSchema.optional(),
	positionLevelId: idSchema.optional(),
	status: orgStatusEnum.optional(),
	search: z.string().trim().max(120).optional()
});
export type PositionListQuery = z.infer<typeof positionListQuerySchema>;
