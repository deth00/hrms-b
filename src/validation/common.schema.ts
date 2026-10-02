import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────
// Numeric entity ids (numeric-ID migration, M6). Every entity id — path, query or body — is parsed by
// parseId ONLY: a canonical positive decimal integer (no sign, no leading zero, no whitespace, no
// exponent, no fraction) within MySQL INT range. Never z.coerce.number() (it accepts "", " 15 ", "1e3").
// Audit `entityId` is NOT an entity id (it is polymorphic history) and stays a string.
// ─────────────────────────────────────────────────────────────────

/** Largest MySQL signed INT — the upper bound of every AUTO_INCREMENT id. */
export const ID_MAX = 2147483647;
const ID_PATTERN = /^[1-9]\d{0,9}$/;
const ID_MESSAGE = 'ID ບໍ່ຖືກຕ້ອງ';

/** Strict id parser: a valid id as a number, or null. Accepts a canonical decimal string or a safe integer. */
export function parseId(value: unknown): number | null {
	if (typeof value === 'number') {
		return Number.isSafeInteger(value) && value >= 1 && value <= ID_MAX ? value : null;
	}
	if (typeof value !== 'string' || !ID_PATTERN.test(value)) return null;
	const n = Number(value);
	return n <= ID_MAX ? n : null;
}

/** A required entity id with a custom (Lao) message. Output: number. */
export function idField(message = ID_MESSAGE) {
	return z.union([z.string(), z.number()]).transform((v, ctx) => {
		const n = parseId(v);
		if (n === null) {
			ctx.addIssue({ code: 'custom', message });
			return z.NEVER;
		}
		return n;
	});
}

/** A required entity id. Output: number. */
export const idSchema = idField();

/** Path params `:id` → number (400 when malformed; the service answers 404 when it does not exist). */
export const idParamSchema = z.object({ id: idSchema });

/** Path params with several ids, e.g. idParamsSchema('id', 'itemId'). */
export function idParamsSchema<const K extends string>(...names: K[]) {
	return z.object(
		Object.fromEntries(names.map((n) => [n, idSchema])) as Record<K, typeof idSchema>
	);
}

export const orgStatusEnum = z.enum(['ACTIVE', 'INACTIVE']);

export const paginationQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

/** A short machine code: letters, numbers, underscore, dash. */
export function codeField(max = 30) {
	return z
		.string()
		.trim()
		.min(1, 'ກະລຸນາປ້ອນລະຫັດ')
		.max(max, `ລະຫັດຍາວເກີນໄປ (ສູງສຸດ ${max} ຕົວອັກສອນ)`)
		.regex(/^[A-Za-z0-9_-]+$/, 'ລະຫັດໃຊ້ໄດ້ສະເພາະ A-Z, 0-9, _ -');
}

/** A required display name (e.g. nameLao). */
export function nameField(max = 150) {
	return z.string().trim().min(1, 'ກະລຸນາປ້ອນຊື່').max(max);
}

/** An optional text field where "" from a form is normalized to null (clears it) on update. */
export function nullableText(max = 255) {
	return z.preprocess(
		(v) => (v === '' ? null : v),
		z.string().trim().max(max).nullable().optional()
	);
}

export function nullableEmail() {
	return z.preprocess(
		(v) => (v === '' ? null : v),
		z.string().trim().toLowerCase().max(190).email('ອີເມວບໍ່ຖືກຕ້ອງ').nullable().optional()
	);
}

export function nullableFloat(min: number, max: number) {
	return z
		.number()
		.min(min, `ຄ່າຕ້ອງບໍ່ໜ້ອຍກວ່າ ${min}`)
		.max(max, `ຄ່າຕ້ອງບໍ່ເກີນ ${max}`)
		.nullable()
		.optional();
}

/** An optional id that a form may clear: "" / null → null (clears it), absent → undefined. Output: number | null | undefined. */
export function optionalIdField() {
	return z.preprocess((v) => (v === '' ? null : v), idSchema.nullable().optional());
}

/** An optional id filter (query string or body): absent → undefined. Output: number | undefined. */
export function optionalId() {
	return idSchema.optional();
}
