import { Prisma } from '@prisma/client';

/**
 * AUDIT REDACTION POLICY (documented in PHASE_10_IMPLEMENTATION_REPORT.md)
 *
 *  1. CREDENTIALS are never persisted — any key that looks like a password, token, hash, cookie,
 *     authorization header, secret, API key or DB URL becomes "[REDACTED]" (the value is dropped).
 *  2. HIGH-SENSITIVITY personal data (national id, passport number …), free-text reasons/notes and
 *     precise GPS values are recorded as `{ changed: true }` in diffs — never the value.
 *  3. ORDINARY fields (department, position, status, dates, ids) are stored as before/after.
 *  4. Request bodies are never dumped; callers pass explicit, whitelisted fields only.
 *
 * `sanitizeForAudit` runs on every write AND again when events are read back (defence in depth).
 */
export const REDACTED = '[REDACTED]';

const norm = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const SECRET_FRAGMENTS = [
	'password',
	'passwd',
	'secret',
	'token',
	'cookie',
	'authorization',
	'apikey',
	'privatekey',
	'databaseurl',
	'credential',
	// Phase 14 — encrypted bank-account material is never written anywhere else
	'encrypted',
	'authtag',
	'encryptionkey'
];
// exact (normalised) names that are secrets although they contain no fragment above
const SECRET_EXACT = new Set([
	'hash',
	'passwordhash',
	'sessionhash',
	'seedpassword',
	'iv',
	'accountnumberiv',
	'accountnumberivsnapshot'
]);

/** Payroll amounts: the audit trail may say THAT a salary changed, never the number. */
const MONEY_KEYS = new Set(
	['baseSalary', 'salary', 'amount', 'netPay', 'totalEarnings', 'totalDeductions'].map(norm)
);
export const isMoneyKey = (key: string) => MONEY_KEYS.has(norm(key));

export const isSecretKey = (key: string) => {
	const k = norm(key);
	return SECRET_EXACT.has(k) || SECRET_FRAGMENTS.some((f) => k.includes(f));
};

/** Fields whose VALUE must never be stored; a diff only says that they changed. */
const MASKED_FIELDS = new Set(
	[
		'nationalId',
		'passportNumber',
		'taxNumber',
		'tin',
		'socialSecurityNumber',
		'bankAccount',
		'accountNumber',
		'bankAccountNumber',
		'reason',
		'note',
		'actionNote',
		'rejectionNote',
		'remark',
		'latitude',
		'longitude',
		'lat',
		'lng',
		'gpsAccuracy',
		'accuracyMeters',
		'address',
		'baseSalary',
		'salary',
		'amount',
		'netPay',
		'totalEarnings',
		'totalDeductions'
	].map(norm)
);
export const isMaskedField = (key: string) => MASKED_FIELDS.has(norm(key));

const BCRYPT_LIKE = /^\$2[aby]\$\d{2}\$/;
const BEARER_LIKE = /^(Bearer|Basic)\s+\S+/i;
const MAX_DEPTH = 6;
const MAX_STRING = 500;

function toPlain(value: unknown): unknown {
	if (value === undefined) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	if (value instanceof Prisma.Decimal) return value.toString();
	if (typeof value === 'bigint') return value.toString();
	return value;
}

/** Deep-copies a value into JSON-safe data with all credential-like keys/values redacted. */
export function sanitizeForAudit(value: unknown, depth = 0): Prisma.JsonValue {
	const v = toPlain(value);
	if (v === null || typeof v === 'boolean' || typeof v === 'number') return v as Prisma.JsonValue;
	if (typeof v === 'string') {
		if (BCRYPT_LIKE.test(v) || BEARER_LIKE.test(v)) return REDACTED;
		return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
	}
	if (depth >= MAX_DEPTH) return REDACTED;
	if (Array.isArray(v)) return v.slice(0, 100).map((x) => sanitizeForAudit(x, depth + 1));
	if (typeof v === 'object') {
		const out: Record<string, Prisma.JsonValue> = {};
		for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
			if (raw === undefined) continue;
			if (isSecretKey(k)) out[k] = REDACTED;
			// a money field may only appear as the marker { changed: true } — never as a value
			else if (isMoneyKey(k))
				out[k] =
					raw && typeof raw === 'object' && (raw as { changed?: unknown }).changed === true
						? { changed: true }
						: REDACTED;
			else out[k] = sanitizeForAudit(raw, depth + 1);
		}
		return out;
	}
	return null;
}

export interface FieldChange {
	before?: Prisma.JsonValue;
	after?: Prisma.JsonValue;
	changed?: true;
}

const comparable = (v: unknown) => JSON.stringify(sanitizeForAudit(v));

/**
 * Builds the normalised `{ field: { before, after } }` diff for the listed fields, keeping ONLY the
 * fields that actually changed. Masked fields yield `{ changed: true }`. Returns null when nothing
 * changed. Values are converted to JSON-safe primitives (Date → ISO, Decimal → string).
 */
export function buildChanges(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	fields: readonly string[]
): Record<string, FieldChange> | null {
	const out: Record<string, FieldChange> = {};
	for (const f of fields) {
		if (!(f in after)) continue;
		if (comparable(before[f]) === comparable(after[f])) continue;
		if (isSecretKey(f) || isMaskedField(f)) {
			out[f] = { changed: true };
		} else {
			out[f] = { before: sanitizeForAudit(before[f]), after: sanitizeForAudit(after[f]) };
		}
	}
	return Object.keys(out).length > 0 ? out : null;
}
