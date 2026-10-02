import { z } from 'zod';
import {
	codeField,
	idField,
	idSchema,
	optionalIdField,
	nullableText,
	orgStatusEnum,
	paginationQuerySchema
} from './common.schema.js';
import { CSV_DELIMITERS, DATE_FORMATS, ENCODINGS } from './payment.schema.js';
import { ACCOUNTING_EXPORT_FIELDS } from '../lib/accountingSources.js';

/**
 * Phase 16 — payroll accounting request schemas (strict). Mappings / export columns can only name the
 * predefined source types / safe export fields — never a database column or an expression.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const plainText = (max: number, empty = 'ກະລຸນາປ້ອນຂໍ້ມູນ') =>
	z
		.string()
		.trim()
		.min(1, empty)
		.max(max)
		.refine((v) => !CONTROL.test(v), 'ມີຕົວອັກສອນທີ່ບໍ່ອະນຸຍາດ');

const dateOnly = () =>
	z
		.string()
		.trim()
		.regex(/^\d{4}-\d{2}-\d{2}$/, 'ວັນທີບໍ່ຖືກຕ້ອງ (YYYY-MM-DD)')
		.refine((v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()), 'ວັນທີບໍ່ຖືກຕ້ອງ');

export const GL_ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;
export const EVENT_TYPES = ['PAYROLL_ACCRUAL', 'PAYMENT_SETTLEMENT', 'PAYMENT_REVERSAL'] as const;
export const DIMENSIONS = ['COMPANY', 'BRANCH', 'DEPARTMENT', 'EMPLOYEE'] as const;
export const JOURNAL_STATUSES = ['DRAFT', 'VALIDATED', 'POSTED', 'CANCELLED'] as const;

// ---------- GL accounts ----------
const accountBase = {
	name: plainText(150, 'ກະລຸນາປ້ອນຊື່ບັນຊີ'),
	type: z.enum(GL_ACCOUNT_TYPES),
	description: nullableText(500)
};
export const glAccountCreateSchema = z
	.object({ companyId: idSchema, code: codeField(30), ...accountBase })
	.strict();
export type GlAccountCreateInput = z.infer<typeof glAccountCreateSchema>;

/** The code is the account's identity and never changes (history / exports refer to it). */
export const glAccountUpdateSchema = z
	.object({
		name: accountBase.name.optional(),
		type: accountBase.type.optional(),
		description: accountBase.description,
		status: orgStatusEnum.optional()
	})
	.strict();
export type GlAccountUpdateInput = z.infer<typeof glAccountUpdateSchema>;

export const glAccountListQuerySchema = z.object({
	companyId: idSchema.optional(),
	status: orgStatusEnum.optional(),
	type: z.enum(GL_ACCOUNT_TYPES).optional(),
	search: z.string().trim().max(100).optional()
});

// ---------- rule sets ----------
const ruleSetHeader = {
	name: plainText(150, 'ກະລຸນາປ້ອນຊື່ກົດ'),
	effectiveFrom: dateOnly(),
	effectiveTo: z.preprocess((v) => (v === '' ? null : v), dateOnly().nullable().optional())
};
const effectiveOrder = (v: { effectiveFrom?: string; effectiveTo?: string | null }) =>
	!v.effectiveFrom || !v.effectiveTo || v.effectiveTo >= v.effectiveFrom;
const ORDER_MESSAGE = {
	message: 'ວັນທີສິ້ນສຸດຕ້ອງບໍ່ກ່ອນວັນທີເລີ່ມ',
	path: ['effectiveTo']
};

export const ruleSetCreateSchema = z
	.object({
		companyId: idSchema,
		...ruleSetHeader,
		/** copy every mapping of another rule set of the same company (a new version) */
		copyFromRuleSetId: idSchema.optional()
	})
	.strict()
	.refine(effectiveOrder, ORDER_MESSAGE);
export type RuleSetCreateInput = z.infer<typeof ruleSetCreateSchema>;

export const ruleSetUpdateSchema = z
	.object({
		name: ruleSetHeader.name.optional(),
		effectiveFrom: dateOnly().optional(),
		effectiveTo: ruleSetHeader.effectiveTo
	})
	.strict()
	.refine(effectiveOrder, ORDER_MESSAGE);
export type RuleSetUpdateInput = z.infer<typeof ruleSetUpdateSchema>;

export const ruleSetListQuerySchema = z.object({
	companyId: idSchema.optional(),
	status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).optional()
});

export const mappingUpsertSchema = z
	.object({
		eventType: z.enum(EVENT_TYPES),
		sourceType: z.string().trim().min(1).max(40),
		debitAccountId: optionalIdField(),
		creditAccountId: optionalIdField(),
		groupingDimension: z.enum(DIMENSIONS).default('COMPANY'),
		descriptionTemplate: nullableText(200),
		status: orgStatusEnum.default('ACTIVE')
	})
	.strict();
export type MappingUpsertInput = z.infer<typeof mappingUpsertSchema>;

// ---------- journals ----------
export const journalListQuerySchema = paginationQuerySchema.extend({
	companyId: idSchema.optional(),
	journalType: z.enum(EVENT_TYPES).optional(),
	status: z.enum(JOURNAL_STATUSES).optional(),
	periodId: idSchema.optional(),
	dateFrom: dateOnly().optional(),
	dateTo: dateOnly().optional(),
	search: z.string().trim().max(100).optional()
});
export type JournalListQuery = z.infer<typeof journalListQuerySchema>;

export const emptyBodySchema = z.object({}).strict();

export const journalExportSchema = z
	.object({ accountingExportProfileId: idField('ກະລຸນາເລືອກຮູບແບບໄຟລ໌') })
	.strict();

// ---------- accounting export profiles ----------
const exportColumn = z
	.object({
		field: z.enum(ACCOUNTING_EXPORT_FIELDS),
		header: plainText(100, 'ກະລຸນາປ້ອນຫົວຖັນ')
	})
	.strict();

const exportProfileBase = {
	name: plainText(150, 'ກະລຸນາປ້ອນຊື່'),
	format: z.enum(['CSV', 'XLSX']),
	delimiter: z.enum(CSV_DELIMITERS).nullable().optional(),
	includeHeader: z.boolean().default(true),
	encoding: z.enum(ENCODINGS).default('UTF-8'),
	dateFormat: z.enum(DATE_FORMATS).default('YYYY-MM-DD'),
	columns: z
		.array(exportColumn)
		.min(1, 'ຕ້ອງມີຢ່າງໜ້ອຍ 1 ຖັນ')
		.max(20, 'ສູງສຸດ 20 ຖັນ')
		.refine((cols) => new Set(cols.map((c) => c.field)).size === cols.length, {
			message: 'ຖັນຊ້ຳກັນ — ແຕ່ລະຂໍ້ມູນໃຊ້ໄດ້ຄັ້ງດຽວ'
		}),
	status: orgStatusEnum.optional()
};
export const accountingExportProfileCreateSchema = z
	.object({ companyId: idSchema, code: codeField(30), ...exportProfileBase })
	.strict();
export type AccountingExportProfileCreateInput = z.infer<
	typeof accountingExportProfileCreateSchema
>;
export const accountingExportProfileUpdateSchema = z.object(exportProfileBase).strict();
export type AccountingExportProfileUpdateInput = z.infer<
	typeof accountingExportProfileUpdateSchema
>;
export const accountingExportProfileListQuerySchema = z.object({
	companyId: idSchema.optional(),
	status: orgStatusEnum.optional()
});
