import { z } from 'zod';
import { codeField, idField, idSchema, nullableText, orgStatusEnum } from './common.schema.js';
import { RECON_FIELDS } from '../lib/reconciliationFile.js';
import { CSV_DELIMITERS, DATE_FORMATS } from './payment.schema.js';

/**
 * Phase 15 — reconciliation / reversal / retry request schemas. A reconciliation profile can ONLY map
 * the predefined safe fields (RECON_FIELDS); it never names a database field, SQL or an expression.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const plainText = (max: number, empty: string) =>
	z
		.string()
		.trim()
		.min(1, empty)
		.max(max)
		.refine((v) => !CONTROL.test(v), 'ມີຕົວອັກສອນທີ່ບໍ່ອະນຸຍາດ');

const reconColumn = z
	.object({
		/** ONLY a predefined safe field */
		field: z.enum(RECON_FIELDS),
		/** header text in the bank file, or the 1-based column number when there is no header */
		column: plainText(100, 'ກະລຸນາປ້ອນຊື່ຖັນໃນໄຟລ໌')
	})
	.strict();

const statusValues = z
	.array(plainText(50, 'ຄ່າສະຖານະຫວ່າງເປົ່າ'))
	.max(20, 'ສູງສຸດ 20 ຄ່າ')
	.default([]);

export const statusMappingSchema = z
	.object({ PAID: statusValues, FAILED: statusValues, REVERSED: statusValues })
	.strict()
	.superRefine((m, ctx) => {
		if (m.PAID.length === 0) {
			ctx.addIssue({ code: 'custom', path: ['PAID'], message: 'ຕ້ອງມີຢ່າງໜ້ອຍ 1 ຄ່າສຳລັບ PAID' });
		}
		if (m.FAILED.length === 0) {
			ctx.addIssue({
				code: 'custom',
				path: ['FAILED'],
				message: 'ຕ້ອງມີຢ່າງໜ້ອຍ 1 ຄ່າສຳລັບ FAILED'
			});
		}
		// trim + case-insensitive: one bank value may mean ONE thing only
		const seen = new Map<string, string>();
		for (const group of ['PAID', 'FAILED', 'REVERSED'] as const) {
			for (const v of m[group]) {
				const key = v.trim().toUpperCase();
				if (seen.has(key)) {
					ctx.addIssue({
						code: 'custom',
						path: [group],
						message: `ຄ່າສະຖານະ "${v}" ຊ້ຳກັນ (${seen.get(key)} / ${group})`
					});
				} else seen.set(key, group);
			}
		}
	});
export type StatusMapping = z.infer<typeof statusMappingSchema>;

const reconProfileBase = {
	name: z.string().trim().min(1, 'ກະລຸນາປ້ອນຊື່').max(150),
	format: z.enum(['CSV', 'XLSX']),
	delimiter: z.enum(CSV_DELIMITERS).nullable().optional(),
	sheetName: nullableText(100),
	hasHeader: z.boolean().default(true),
	dateFormat: z.enum(DATE_FORMATS).default('YYYY-MM-DD'),
	columns: z.array(reconColumn).min(2, 'ຕ້ອງມີຢ່າງໜ້ອຍ 2 ຖັນ').max(RECON_FIELDS.length),
	statusMapping: statusMappingSchema,
	status: orgStatusEnum.optional()
};

type ReconProfileShape = {
	hasHeader: boolean;
	columns: { field: string; column: string }[];
};
function refineColumns(p: ReconProfileShape, ctx: z.RefinementCtx) {
	const fields = p.columns.map((c) => c.field);
	if (new Set(fields).size !== fields.length) {
		ctx.addIssue({
			code: 'custom',
			path: ['columns'],
			message: 'ຂໍ້ມູນຊ້ຳກັນ — ແຕ່ລະຂໍ້ມູນໃຊ້ໄດ້ຄັ້ງດຽວ'
		});
	}
	for (const required of ['INSTRUCTION_REFERENCE', 'STATUS']) {
		if (!fields.includes(required)) {
			ctx.addIssue({ code: 'custom', path: ['columns'], message: `ຕ້ອງມີຖັນ ${required}` });
		}
	}
	const cols = p.columns.map((c) => c.column.trim().toLowerCase());
	if (new Set(cols).size !== cols.length) {
		ctx.addIssue({
			code: 'custom',
			path: ['columns'],
			message: 'ຖັນໃນໄຟລ໌ຊ້ຳກັນ — ແຕ່ລະຖັນ map ໄດ້ຄັ້ງດຽວ'
		});
	}
	if (!p.hasHeader) {
		p.columns.forEach((c, i) => {
			if (!/^[1-9]\d{0,2}$/.test(c.column.trim())) {
				ctx.addIssue({
					code: 'custom',
					path: ['columns', i, 'column'],
					message: 'ໄຟລ໌ບໍ່ມີແຖວຫົວ — ໃຊ້ເລກລຳດັບຖັນ (1, 2, 3 …)'
				});
			}
		});
	}
}

export const reconProfileCreateSchema = z
	.object({ companyId: idSchema, code: codeField(30), ...reconProfileBase })
	.strict()
	.superRefine(refineColumns);
export type ReconProfileCreateInput = z.infer<typeof reconProfileCreateSchema>;

export const reconProfileUpdateSchema = z
	.object(reconProfileBase)
	.strict()
	.superRefine(refineColumns);
export type ReconProfileUpdateInput = z.infer<typeof reconProfileUpdateSchema>;

export const reconProfileListQuerySchema = z.object({
	companyId: idSchema.optional(),
	status: orgStatusEnum.optional()
});

/** multipart text field next to the uploaded file */
export const reconImportBodySchema = z
	.object({ reconciliationProfileId: idField('ກະລຸນາເລືອກຮູບແບບຜົນການຈ່າຍ') })
	.strict();

export const reconRowParams = z.object({
	id: idSchema,
	rowId: idSchema
});

export const reconMatchSchema = z
	.object({ paymentItemId: idField('ກະລຸນາເລືອກລາຍການຈ່າຍ') })
	.strict();

export const reconIgnoreSchema = z
	.object({
		reason: z.string().trim().min(3, 'ກະລຸນາລະບຸເຫດຜົນ (ຢ່າງໜ້ອຍ 3 ຕົວອັກສອນ)').max(500)
	})
	.strict();

const dateOnly = () =>
	z
		.string()
		.trim()
		.regex(/^\d{4}-\d{2}-\d{2}$/, 'ວັນທີບໍ່ຖືກຕ້ອງ (YYYY-MM-DD)')
		.refine((v) => {
			const d = new Date(`${v}T00:00:00Z`);
			return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
		}, 'ວັນທີບໍ່ຖືກຕ້ອງ');

export const reverseSchema = z
	.object({
		reason: z.string().trim().min(3, 'ກະລຸນາລະບຸເຫດຜົນ (ຢ່າງໜ້ອຍ 3 ຕົວອັກສອນ)').max(500),
		bankReference: z.preprocess(
			(v) => (v === '' ? null : v),
			z.string().trim().max(100).nullable().optional()
		),
		effectiveDate: dateOnly()
	})
	.strict();
export type ReverseInput = z.infer<typeof reverseSchema>;

export const retrySchema = z
	.object({
		sourceItemIds: z
			.array(idSchema)
			.min(1, 'ກະລຸນາເລືອກຢ່າງໜ້ອຍ 1 ລາຍການ')
			.max(500)
			.refine((ids) => new Set(ids).size === ids.length, 'ລາຍການຊ້ຳກັນ'),
		/** defaults to today (Laos) */
		paymentDate: dateOnly().optional(),
		notes: nullableText(1000)
	})
	.strict();
export type RetryInput = z.infer<typeof retrySchema>;
