import { z } from 'zod';
import { parseDateOnly } from '../lib/dates.js';
import {
	codeField,
	idField,
	nameField,
	nullableEmail,
	nullableText,
	optionalId,
	optionalIdField,
	orgStatusEnum,
	paginationQuerySchema
} from './common.schema.js';

// ---------- shared field builders ----------

const DATE_MESSAGE = 'ວັນທີ່ບໍ່ຖືກຕ້ອງ (ຮູບແບບ YYYY-MM-DD)';

/** A required calendar date given as "YYYY-MM-DD"; output is a Date at UTC midnight. */
export function dateField() {
	return z
		.string()
		.trim()
		.refine((v) => parseDateOnly(v) !== null, DATE_MESSAGE)
		.transform((v) => parseDateOnly(v) as Date);
}

/** An optional calendar date; "" and null clear it. */
export function nullableDateField() {
	return z.preprocess((v) => (v === '' ? null : v), dateField().nullable().optional());
}

/** An optional calendar date where "" means "not provided". */
export function optionalDateField() {
	return z.preprocess((v) => (v === '' ? undefined : v), dateField().optional());
}

const genderEnum = z.enum(['MALE', 'FEMALE', 'OTHER']);
const maritalStatusEnum = z.enum(['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED']);
export const employmentStatusEnum = z.enum([
	'ACTIVE',
	'PROBATION',
	'ON_LEAVE',
	'SUSPENDED',
	'RESIGNED',
	'TERMINATED'
]);

function nullableEnum<T extends z.ZodEnum>(schema: T) {
	return z.preprocess((v) => (v === '' ? null : v), schema.nullable().optional());
}

/** Profile/contact fields — editable with `employees.update` and never create assignment history. */
const profileShape = {
	title: nullableText(30),
	firstNameLao: nameField(100),
	lastNameLao: nameField(100),
	firstNameEnglish: nullableText(100),
	lastNameEnglish: nullableText(100),
	nickname: nullableText(60),
	gender: nullableEnum(genderEnum),
	dateOfBirth: nullableDateField(),
	nationalId: nullableText(50),
	passportNumber: nullableText(50),
	maritalStatus: nullableEnum(maritalStatusEnum),
	phone: nullableText(30),
	personalEmail: nullableEmail(),
	workEmail: nullableEmail(),
	address: nullableText(500),
	province: nullableText(100),
	district: nullableText(100),
	village: nullableText(100),
	avatarUrl: nullableText(500),
	note: nullableText(2000)
};

// ---------- create ----------

export const employeeCreateSchema = z
	.object({
		employeeCode: codeField(30),
		...profileShape,
		startDate: dateField(),
		probationEndDate: nullableDateField(),
		employmentStatus: z
			.enum(['ACTIVE', 'PROBATION', 'ON_LEAVE', 'SUSPENDED'], {
				error: 'ສະຖານະເລີ່ມຕົ້ນຕ້ອງເປັນສະຖານະທີ່ຍັງເຮັດວຽກຢູ່'
			})
			.default('ACTIVE'),
		employmentTypeId: idField('ກະລຸນາເລືອກປະເພດການຈ້າງງານ'),
		companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
		branchId: optionalIdField(),
		departmentId: optionalIdField(),
		divisionId: optionalIdField(),
		unitId: optionalIdField(),
		positionId: optionalIdField(),
		managerEmployeeId: optionalIdField(),
		userId: optionalIdField()
	})
	.refine((d) => !d.probationEndDate || d.probationEndDate >= d.startDate, {
		path: ['probationEndDate'],
		message: 'ວັນສິ້ນສຸດທົດລອງງານຕ້ອງບໍ່ກ່ອນວັນເລີ່ມງານ'
	});
export type EmployeeCreateInput = z.infer<typeof employeeCreateSchema>;

// ---------- update (profile/contact + user link only) ----------

export const employeeUpdateSchema = z
	.object({
		...profileShape,
		firstNameLao: nameField(100).optional(),
		lastNameLao: nameField(100).optional(),
		startDate: dateField().optional(),
		probationEndDate: nullableDateField(),
		userId: optionalIdField()
	})
	.refine((d) => Object.keys(d).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type EmployeeUpdateInput = z.infer<typeof employeeUpdateSchema>;

/**
 * Field groups that must never be changed through the generic PATCH. Each group has its own
 * dedicated permission + endpoint (see `guardEmployeePatch` in employee.routes.ts).
 */
export const TRANSFER_FIELDS = [
	'companyId',
	'branchId',
	'departmentId',
	'divisionId',
	'unitId',
	'positionId',
	'managerEmployeeId',
	'employmentTypeId'
] as const;
export const STATUS_FIELDS = ['employmentStatus', 'endDate'] as const;
export const LINK_USER_FIELDS = ['userId'] as const;

// ---------- transfer ----------

export const employeeTransferSchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ').optional(),
	branchId: optionalIdField(),
	departmentId: optionalIdField(),
	divisionId: optionalIdField(),
	unitId: optionalIdField(),
	positionId: optionalIdField(),
	managerEmployeeId: optionalIdField(),
	employmentTypeId: optionalIdField(),
	effectiveDate: optionalDateField(),
	reason: nullableText(500)
});
export type EmployeeTransferInput = z.infer<typeof employeeTransferSchema>;

// ---------- status ----------

export const employeeStatusSchema = z
	.object({
		status: employmentStatusEnum,
		effectiveDate: optionalDateField(),
		endDate: nullableDateField(),
		reason: nullableText(500),
		disableLinkedUser: z.boolean().default(false)
	})
	.superRefine((d, ctx) => {
		const ending = d.status === 'RESIGNED' || d.status === 'TERMINATED';
		if (ending && !d.endDate) {
			ctx.addIssue({
				code: 'custom',
				path: ['endDate'],
				message: 'ກະລຸນາລະບຸວັນທີ່ສິ້ນສຸດການຈ້າງງານ'
			});
		}
		if (d.disableLinkedUser && !ending) {
			ctx.addIssue({
				code: 'custom',
				path: ['disableLinkedUser'],
				message: 'ປິດບັນຊີເຂົ້າລະບົບໄດ້ສະເພາະເມື່ອສະຖານະເປັນລາອອກ ຫຼື ຢຸດຈ້າງ'
			});
		}
	});
export type EmployeeStatusInput = z.infer<typeof employeeStatusSchema>;

// ---------- queries ----------

export const employeeListQuerySchema = paginationQuerySchema.extend({
	search: z.string().trim().max(120).optional(),
	status: employmentStatusEnum.optional(),
	companyId: optionalId(),
	branchId: optionalId(),
	departmentId: optionalId(),
	divisionId: optionalId(),
	unitId: optionalId(),
	positionId: optionalId(),
	employmentTypeId: optionalId()
});
export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

export const employeeLookupQuerySchema = z.object({
	search: z.string().trim().max(120).optional(),
	companyId: optionalId()
});

export const availableUsersQuerySchema = z.object({
	search: z.string().trim().max(120).optional(),
	/** The Employee being edited — its own currently-linked user stays in the result. */
	includeForEmployeeId: optionalId()
});

export const historyQuerySchema = paginationQuerySchema;

// ---------- employment types ----------

export const employmentTypeCreateSchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
	code: codeField(30),
	nameLao: nameField(150),
	nameEnglish: nullableText(150),
	description: nullableText(255),
	status: orgStatusEnum.default('ACTIVE')
});
export type EmploymentTypeCreateInput = z.infer<typeof employmentTypeCreateSchema>;

export const employmentTypeUpdateSchema = employmentTypeCreateSchema
	.omit({ companyId: true, code: true })
	.partial()
	// .partial() keeps the create schema's status DEFAULT, which would silently reset status on every PATCH.
	.extend({ status: orgStatusEnum.optional() })
	.refine((d) => Object.keys(d).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type EmploymentTypeUpdateInput = z.infer<typeof employmentTypeUpdateSchema>;

export const employmentTypeListQuerySchema = paginationQuerySchema.extend({
	companyId: optionalId(),
	status: orgStatusEnum.optional(),
	search: z.string().trim().max(120).optional()
});
export type EmploymentTypeListQuery = z.infer<typeof employmentTypeListQuerySchema>;

export const employmentTypeLookupQuerySchema = z.object({
	companyId: idField('ກະລຸນາເລືອກບໍລິສັດ'),
	status: orgStatusEnum.optional()
});
