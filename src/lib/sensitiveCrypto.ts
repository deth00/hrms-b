import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../utils/AppError.js';

/**
 * FIELD-LEVEL ENCRYPTION (Phase 14) — the ONE place sensitive values (bank account numbers) are
 * encrypted or decrypted.
 *
 *  - AES-256-GCM, a fresh random 96-bit IV per encryption, the 128-bit auth tag stored alongside.
 *  - Keys come ONLY from the environment (never hard-coded, never stored in the database):
 *      BANK_ACCOUNT_ENCRYPTION_KEY          the CURRENT key (version BANK_ACCOUNT_ENCRYPTION_KEY_VERSION, default 1)
 *      BANK_ACCOUNT_ENCRYPTION_KEY_V<n>     optional OLDER keys, still needed to decrypt rows of version n
 *    A key is 32 bytes after decoding: 64 hex characters, or base64 ("base64:" prefix optional).
 *  - Every ciphertext records the key version that produced it, so a future rotation can re-encrypt
 *    row by row (decrypt with V<old>, encrypt with the current key). Rotation itself is not automated.
 *  - The plaintext is never logged, audited or returned by this module's errors.
 */
export interface SensitiveCiphertext {
	/** base64 */
	ciphertext: string;
	/** base64, 12 bytes */
	iv: string;
	/** base64, 16 bytes */
	authTag: string;
	keyVersion: number;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** binds a ciphertext to its purpose: a blob copied into another kind of field will not decrypt */
const AAD = Buffer.from('laohr:bank-account-number:v1', 'utf8');

/** Decodes a configured key; throws (message never contains the key) when it is not exactly 32 bytes. */
export function parseEncryptionKey(raw: string, name = 'BANK_ACCOUNT_ENCRYPTION_KEY'): Buffer {
	const value = raw.trim();
	let key: Buffer | null = null;
	if (/^[0-9a-fA-F]{64}$/.test(value)) {
		key = Buffer.from(value, 'hex');
	} else {
		const b64 = value.startsWith('base64:') ? value.slice(7) : value;
		if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) key = Buffer.from(b64, 'base64');
	}
	if (!key || key.length !== 32) {
		throw new Error(
			`${name} is invalid: it must decode to exactly 32 bytes (64 hex characters or base64 of 32 bytes)`
		);
	}
	return key;
}

interface Keyring {
	current: number;
	keys: Map<number, Buffer>;
}

let cached: { signature: string; ring: Keyring | null } | null = null;

/** Reads (and caches) the keyring from process.env; null when no key is configured. Throws if invalid. */
function keyring(): Keyring | null {
	const env = process.env;
	const signature = Object.keys(env)
		.filter((k) => k.startsWith('BANK_ACCOUNT_ENCRYPTION_KEY'))
		.sort()
		.map((k) => `${k}=${env[k]}`)
		.join('\n');
	if (cached && cached.signature === signature) return cached.ring;
	let ring: Keyring | null = null;
	const currentRaw = env.BANK_ACCOUNT_ENCRYPTION_KEY;
	if (currentRaw && currentRaw.trim()) {
		const current = Number(env.BANK_ACCOUNT_ENCRYPTION_KEY_VERSION ?? 1);
		if (!Number.isInteger(current) || current < 1) {
			throw new Error('BANK_ACCOUNT_ENCRYPTION_KEY_VERSION must be a positive integer');
		}
		const keys = new Map<number, Buffer>();
		for (const [k, v] of Object.entries(env)) {
			const m = /^BANK_ACCOUNT_ENCRYPTION_KEY_V(\d+)$/.exec(k);
			if (m && v && v.trim()) keys.set(Number(m[1]), parseEncryptionKey(v, k));
		}
		keys.set(current, parseEncryptionKey(currentRaw));
		ring = { current, keys };
	}
	cached = { signature, ring };
	return ring;
}

/**
 * Startup / config validation. An INVALID key always fails (the server must not start with a key it
 * cannot use). A MISSING key fails in production; elsewhere bank-account features answer
 * BANK_ACCOUNT_ENCRYPTION_NOT_CONFIGURED until one is set. Returns whether encryption is available.
 */
export function assertEncryptionConfig(opts: { production: boolean }): boolean {
	const ring = keyring(); // throws on an invalid key
	if (!ring && opts.production) {
		throw new Error('BANK_ACCOUNT_ENCRYPTION_KEY is required in production');
	}
	return ring !== null;
}

function requireRing(): Keyring {
	let ring: Keyring | null;
	try {
		ring = keyring();
	} catch {
		ring = null;
	}
	if (!ring) {
		throw new AppError(
			503,
			'BANK_ACCOUNT_ENCRYPTION_NOT_CONFIGURED',
			'ຍັງບໍ່ໄດ້ຕັ້ງຄ່າກະແຈເຂົ້າລະຫັດບັນຊີທະນາຄານ (BANK_ACCOUNT_ENCRYPTION_KEY) — ກະລຸນາຕິດຕໍ່ຜູ້ດູແລລະບົບ'
		);
	}
	return ring;
}

export function encryptSensitive(plaintext: string): SensitiveCiphertext {
	const ring = requireRing();
	const key = ring.keys.get(ring.current)!;
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
	cipher.setAAD(AAD);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return {
		ciphertext: ciphertext.toString('base64'),
		iv: iv.toString('base64'),
		authTag: cipher.getAuthTag().toString('base64'),
		keyVersion: ring.current
	};
}

/** Thrown when a ciphertext cannot be decrypted (wrong / missing key, tampered data). Never carries data. */
export class SensitiveDecryptionError extends Error {
	constructor() {
		super('SENSITIVE_DECRYPTION_FAILED');
		this.name = 'SensitiveDecryptionError';
	}
}

export function decryptSensitive(value: SensitiveCiphertext): string {
	const ring = requireRing();
	const key = ring.keys.get(value.keyVersion);
	if (!key) throw new SensitiveDecryptionError();
	try {
		const iv = Buffer.from(value.iv, 'base64');
		const tag = Buffer.from(value.authTag, 'base64');
		if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SensitiveDecryptionError();
		const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
		decipher.setAAD(AAD);
		decipher.setAuthTag(tag);
		return Buffer.concat([
			decipher.update(Buffer.from(value.ciphertext, 'base64')),
			decipher.final()
		]).toString('utf8');
	} catch {
		throw new SensitiveDecryptionError();
	}
}

/** true when the value decrypts (validation) — the plaintext is discarded immediately. */
export function canDecrypt(value: SensitiveCiphertext): boolean {
	try {
		decryptSensitive(value);
		return true;
	} catch (err) {
		if (err instanceof AppError) throw err; // not configured → surface, not "corrupt"
		return false;
	}
}

/** "••••1234" — the ONLY representation of an account number the API ever returns. */
export const maskAccountNumber = (last4: string | null | undefined) =>
	last4 ? `••••${last4}` : null;
