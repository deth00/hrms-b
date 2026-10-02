import { z } from 'zod';
import {
	codeField,
	idField,
	idSchema,
	nameField,
	nullableEmail,
	nullableFloat,
	nullableText,
	optionalIdField,
	orgStatusEnum,
	paginationQuerySchema
} from './common.schema.js';

// ---------- Company ----------

export const companyCreateSchema = z.object({
	code: codeField(30),
	nameLao: nameField(150),
	nameEnglish: nullableText(150),
	taxNumber: nullableText(50),
	registrationNumber: nullableText(50),
	phone: nullableText(30),
	email: nullableEmail(),
	address: nullableText(255),
	province: nullableText(100),
	district: nullableText(100),
	village: nullableText(100),
	status: orgStatusEnum.default('ACTIVE')
});
export type CompanyCreateInput = z.infer<typeof companyCreateSchema>;

export const companyUpdateSchema = companyCreateSchema
	.omit({ code: true })
	.partial()
	// .partial() keeps the create schema's status DEFAULT, which would silently reset status on every PATCH.
	.extend({ status: orgStatusEnum.optional() })
	.refine((data) => Object.keys(data).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type CompanyUpdateInput = z.infer<typeof companyUpdateSchema>;

export const companyListQuerySchema = paginationQuerySchema.extend({
	status: orgStatusEnum.optional(),
	search: z.string().trim().max(120).optional()
});
export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;

// ---------- Branch ----------

export const branchCreateSchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
	code: codeField(30),
	nameLao: nameField(150),
	nameEnglish: nullableText(150),
	phone: nullableText(30),
	email: nullableEmail(),
	address: nullableText(255),
	province: nullableText(100),
	district: nullableText(100),
	village: nullableText(100),
	latitude: nullableFloat(-90, 90),
	longitude: nullableFloat(-180, 180),
	status: orgStatusEnum.default('ACTIVE')
});
export type BranchCreateInput = z.infer<typeof branchCreateSchema>;

export const branchUpdateSchema = branchCreateSchema
	.omit({ companyId: true, code: true })
	.partial()
	// .partial() keeps the create schema's status DEFAULT, which would silently reset status on every PATCH.
	.extend({ status: orgStatusEnum.optional() })
	.refine((data) => Object.keys(data).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type BranchUpdateInput = z.infer<typeof branchUpdateSchema>;

export const branchListQuerySchema = paginationQuerySchema.extend({
	companyId: idSchema.optional(),
	status: orgStatusEnum.optional(),
	search: z.string().trim().max(120).optional()
});
export type BranchListQuery = z.infer<typeof branchListQuerySchema>;

// ---------- Department ----------

export const departmentCreateSchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
	branchId: optionalIdField(),
	code: codeField(30),
	nameLao: nameField(150),
	nameEnglish: nullableText(150),
	description: nullableText(255),
	status: orgStatusEnum.default('ACTIVE')
});
export type DepartmentCreateInput = z.infer<typeof departmentCreateSchema>;

export const departmentUpdateSchema = departmentCreateSchema
	.omit({ companyId: true, code: true })
	.partial()
	// .partial() keeps the create schema's status DEFAULT, which would silently reset status on every PATCH.
	.extend({ status: orgStatusEnum.optional() })
	.refine((data) => Object.keys(data).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type DepartmentUpdateInput = z.infer<typeof departmentUpdateSchema>;

export const departmentListQuerySchema = paginationQuerySchema.extend({
	companyId: idSchema.optional(),
	branchId: idSchema.optional(),
	status: orgStatusEnum.optional(),
	search: z.string().trim().max(120).optional()
});
export type DepartmentListQuery = z.infer<typeof departmentListQuerySchema>;

// ---------- Division ----------

export const divisionCreateSchema = z.object({
	departmentId: idField('ກະລຸນາເລືອກພະແນກ'),
	code: codeField(30),
	nameLao: nameField(150),
	nameEnglish: nullableText(150),
	description: nullableText(255),
	status: orgStatusEnum.default('ACTIVE')
});
export type DivisionCreateInput = z.infer<typeof divisionCreateSchema>;

export const divisionUpdateSchema = divisionCreateSchema
	.omit({ departmentId: true, code: true })
	.partial()
	// .partial() keeps the create schema's status DEFAULT, which would silently reset status on every PATCH.
	.extend({ status: orgStatusEnum.optional() })
	.refine((data) => Object.keys(data).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type DivisionUpdateInput = z.infer<typeof divisionUpdateSchema>;

export const divisionListQuerySchema = paginationQuerySchema.extend({
	departmentId: idSchema.optional(),
	status: orgStatusEnum.optional(),
	search: z.string().trim().max(120).optional()
});
export type DivisionListQuery = z.infer<typeof divisionListQuerySchema>;

// ---------- Unit ----------

export const unitCreateSchema = z.object({
	departmentId: idField('ກະລຸນາເລືອກພະແນກ'),
	divisionId: optionalIdField(),
	code: codeField(30),
	nameLao: nameField(150),
	nameEnglish: nullableText(150),
	description: nullableText(255),
	status: orgStatusEnum.default('ACTIVE')
});
export type UnitCreateInput = z.infer<typeof unitCreateSchema>;

export const unitUpdateSchema = unitCreateSchema
	.omit({ departmentId: true, code: true })
	.partial()
	// .partial() keeps the create schema's status DEFAULT, which would silently reset status on every PATCH.
	.extend({ status: orgStatusEnum.optional() })
	.refine((data) => Object.keys(data).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type UnitUpdateInput = z.infer<typeof unitUpdateSchema>;

export const unitListQuerySchema = paginationQuerySchema.extend({
	departmentId: idSchema.optional(),
	divisionId: idSchema.optional(),
	status: orgStatusEnum.optional(),
	search: z.string().trim().max(120).optional()
});
export type UnitListQuery = z.infer<typeof unitListQuerySchema>;

// ---------- Lookups ----------

export const companyLookupQuerySchema = z.object({
	status: orgStatusEnum.optional()
});

export const branchLookupQuerySchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
	status: orgStatusEnum.optional()
});

export const departmentLookupQuerySchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
	branchId: idSchema.optional(),
	status: orgStatusEnum.optional()
});

export const divisionLookupQuerySchema = z.object({
	departmentId: idField('ກະລຸນາເລືອກພະແນກ'),
	status: orgStatusEnum.optional()
});
