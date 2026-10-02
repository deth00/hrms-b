import { z } from 'zod';
import {
	codeField,
	idField,
	idSchema,
	nullableText,
	orgStatusEnum,
	paginationQuerySchema
} from './common.schema.js';

/**
 * Phase 14 — payment preparation request schemas. Account numbers arrive ONLY in write bodies; they are
 * encrypted immediately by the service and never echoed back (responses carry "••••" + last4).
 */

const currencyField = () =>
	z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[A-Z]{3}$/, 'ສະກຸນເງິນຕ້ອງເປັນລະຫັດ ISO 3 ຕົວອັກສອນ');

/**
 * Spaces are removed ("0012 3456 7890" → "001234567890"); leading zeros are kept (it is a string, never
 * a number). Letters / digits / hyphen, starting with a letter or digit — so it can never start with a
 * spreadsheet formula character.
 */
export const accountNumberField = () =>
	z
		.string()
		.transform((v) => v.replace(/\s+/g, ''))
		.pipe(
			z
				.string()
				.min(4, 'ເລກບັນຊີຕ້ອງມີຢ່າງໜ້ອຍ 4 ຕົວ')
				.max(40, 'ເລກບັນຊີຍາວເກີນໄປ')
				.regex(/^[0-9A-Za-z][0-9A-Za-z-]*$/, 'ເລກບັນຊີໃຊ້ໄດ້ສະເພາະຕົວເລກ, ຕົວອັກສອນ ແລະ -')
		);

/** "" / missing → keep the stored (encrypted) number */
const optionalAccountNumber = () =>
	z.preprocess(
		(v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
		accountNumberField().optional()
	);

const bankFields = {
	bankCode: z.string().trim().min(1, 'ກະລຸນາປ້ອນລະຫັດທະນາຄານ').max(30),
	bankName: z.string().trim().min(1, 'ກະລຸນາປ້ອນຊື່ທະນາຄານ').max(150),
	branchName: nullableText(150),
	accountName: z.string().trim().min(1, 'ກະລຸນາປ້ອນຊື່ບັນຊີ').max(150),
	currencyCode: currencyField()
};

export const bankAccountCreateSchema = z
	.object({
		...bankFields,
		accountNumber: accountNumberField(),
		makePrimary: z.boolean().default(true)
	})
	.strict();
export type BankAccountCreateInput = z.infer<typeof bankAccountCreateSchema>;

export const bankAccountUpdateSchema = z
	.object({ ...bankFields, accountNumber: optionalAccountNumber() })
	.strict();
export type BankAccountUpdateInput = z.infer<typeof bankAccountUpdateSchema>;

export const paymentMethodEnum = z.enum(['BANK_TRANSFER', 'CASH']);

/**
 * One form: the method, and for BANK_TRANSFER optionally the primary account's details. With an
 * existing primary account a blank accountNumber keeps the stored number; without one it is required.
 */
export const paymentProfileUpdateSchema = z
	.object({
		paymentMethod: paymentMethodEnum,
		bankAccount: z
			.object({ ...bankFields, accountNumber: optionalAccountNumber() })
			.strict()
			.nullable()
			.optional()
	})
	.strict();
export type PaymentProfileUpdateInput = z.infer<typeof paymentProfileUpdateSchema>;

export const employeeAccountParams = z.object({
	id: idSchema,
	accountId: idSchema
});

// ---------- payment batches ----------
const dateOnly = () =>
	z
		.string()
		.trim()
		.regex(/^\d{4}-\d{2}-\d{2}$/, 'ວັນທີບໍ່ຖືກຕ້ອງ (YYYY-MM-DD)')
		.refine((v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()), 'ວັນທີບໍ່ຖືກຕ້ອງ');

export const batchCreateSchema = z
	.object({
		/** defaults to the period's pay date */
		paymentDate: dateOnly().optional(),
		notes: nullableText(1000)
	})
	.strict();
export type BatchCreateInput = z.infer<typeof batchCreateSchema>;

export const batchListQuerySchema = paginationQuerySchema.extend({
	companyId: idSchema.optional(),
	batchKind: z.enum(['ORIGINAL', 'RETRY']).optional(),
	status: z
		.enum([
			'DRAFT',
			'VALIDATED',
			'EXPORTED',
			'PARTIALLY_PAID',
			'PAID',
			'CANCELLED',
			'PARTIALLY_REVERSED',
			'REVERSED'
		])
		.optional()
});
export type BatchListQuery = z.infer<typeof batchListQuerySchema>;

export const batchItemParams = z.object({
	id: idSchema,
	itemId: idSchema
});

export const itemConfirmSchema = z.discriminatedUnion('status', [
	z
		.object({
			status: z.literal('PAID'),
			paymentReference: z.preprocess(
				(v) => (v === '' ? null : v),
				z.string().trim().max(100).nullable().optional()
			),
			/** YYYY-MM-DD or ISO date-time; defaults to now */
			paidAt: z
				.string()
				.trim()
				.refine((v) => !Number.isNaN(new Date(v).getTime()), 'ວັນທີຈ່າຍບໍ່ຖືກຕ້ອງ')
				.optional()
		})
		.strict(),
	z
		.object({
			status: z.literal('FAILED'),
			failureCode: z.string().trim().min(1, 'ກະລຸນາປ້ອນລະຫັດຄວາມຜິດພາດ').max(50),
			failureReason: z.string().trim().min(3, 'ກະລຸນາລະບຸເຫດຜົນ (ຢ່າງໜ້ອຍ 3 ຕົວອັກສອນ)').max(500)
		})
		.strict()
]);
export type ItemConfirmInput = z.infer<typeof itemConfirmSchema>;

export const exportBodySchema = z
	.object({ bankExportProfileId: idField('ກະລຸນາເລືອກຮູບແບບໄຟລ໌') })
	.strict();

export const exportPreviewQuerySchema = z.object({
	bankExportProfileId: idSchema
});

// ---------- bank export profiles ----------
export const EXPORT_FIELDS = [
	'BATCH_NUMBER',
	'PAYMENT_DATE',
	'EMPLOYEE_CODE',
	'EMPLOYEE_NAME',
	'BANK_CODE',
	'BANK_NAME',
	'ACCOUNT_NAME',
	'ACCOUNT_NUMBER',
	'AMOUNT',
	'CURRENCY',
	'PAYMENT_REFERENCE',
	/** Phase 15 — appended LAST so existing profiles / frozen exports are untouched */
	'INSTRUCTION_REFERENCE'
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];

export const DATE_FORMATS = [
	'YYYY-MM-DD',
	'DD/MM/YYYY',
	'DD-MM-YYYY',
	'MM/DD/YYYY',
	'YYYYMMDD'
] as const;
export const CSV_DELIMITERS = [',', ';', '|', 'TAB'] as const;
export const ENCODINGS = ['UTF-8', 'UTF-8-BOM'] as const;

const columnSchema = z
	.object({
		/** ONLY a predefined safe field — never a database column / expression */
		field: z.enum(EXPORT_FIELDS),
		header: z
			.string()
			.trim()
			.min(1, 'ກະລຸນາປ້ອນຫົວຖັນ')
			.max(100)
			// eslint-disable-next-line no-control-regex
			.refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'ຫົວຖັນມີຕົວອັກສອນທີ່ບໍ່ອະນຸຍາດ')
	})
	.strict();

const profileBase = {
	name: z.string().trim().min(1, 'ກະລຸນາປ້ອນຊື່').max(150),
	format: z.enum(['CSV', 'XLSX']),
	delimiter: z.enum(CSV_DELIMITERS).nullable().optional(),
	includeHeader: z.boolean().default(true),
	encoding: z.enum(ENCODINGS).default('UTF-8'),
	dateFormat: z.enum(DATE_FORMATS).default('YYYY-MM-DD'),
	columns: z
		.array(columnSchema)
		.min(1, 'ຕ້ອງມີຢ່າງໜ້ອຍ 1 ຖັນ')
		.max(20, 'ສູງສຸດ 20 ຖັນ')
		.refine((cols) => new Set(cols.map((c) => c.field)).size === cols.length, {
			message: 'ຖັນຊ້ຳກັນ — ແຕ່ລະຂໍ້ມູນໃຊ້ໄດ້ຄັ້ງດຽວ'
		}),
	status: orgStatusEnum.optional()
};

export const exportProfileCreateSchema = z
	.object({ companyId: idSchema, code: codeField(30), ...profileBase })
	.strict();
export type ExportProfileCreateInput = z.infer<typeof exportProfileCreateSchema>;

export const exportProfileUpdateSchema = z.object(profileBase).strict();
export type ExportProfileUpdateInput = z.infer<typeof exportProfileUpdateSchema>;

export const exportProfileListQuerySchema = z.object({
	companyId: idSchema.optional(),
	status: orgStatusEnum.optional()
});
