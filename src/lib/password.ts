import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
	return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
	return bcrypt.compare(password, hash);
}

/**
 * A pre-computed hash of an unusable password, used to run a bcrypt
 * compare even when no matching user was found — keeps the login
 * endpoint's response time independent of whether the account exists.
 */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-timing-guard', SALT_ROUNDS);

export function compareAgainstDummyHash(): Promise<boolean> {
	return bcrypt.compare('irrelevant', DUMMY_HASH);
}
