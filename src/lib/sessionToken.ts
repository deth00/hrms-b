import { randomBytes, createHash } from 'node:crypto';

/** Opaque, cryptographically-random session token — this is what the browser holds in its cookie. */
export function generateSessionToken(): string {
	return randomBytes(32).toString('hex');
}

/** Only this hash is ever persisted; the raw token never touches the database. */
export function hashSessionToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}
