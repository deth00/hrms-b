import { prisma } from '../config/prisma.js';

export type DatabaseStatus = 'ok' | 'error' | 'unconfigured';

/** Runs a trivial query to confirm the MySQL connection is alive, without exposing credentials. */
export async function checkDatabase(): Promise<DatabaseStatus> {
	if (!process.env.DATABASE_URL) return 'unconfigured';

	try {
		await prisma.$queryRaw`SELECT 1`;
		return 'ok';
	} catch {
		return 'error';
	}
}
