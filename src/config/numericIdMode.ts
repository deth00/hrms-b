/**
 * Numeric-ID migration, stage M6 (see NUMERIC_ID_M6_STRATEGY.md).
 *
 * NUMERIC_ID_REHEARSAL=1 runs the app against the post-M4 rehearsal copy `hr_db_idmig_rehearsal`, whose
 * numeric ids still live in the `*_new` columns next to the legacy CUID columns. In that mode the Prisma
 * client generated from prisma/m6-rehearsal/schema.prisma (same models, `@map` → `*_new`) is used, and
 * raw SQL addresses the `*_new` columns (idCol). The app refuses to start in that mode unless
 * DATABASE_URL names exactly that database — it can never be pointed at hr_db by accident.
 */
export const REHEARSAL_DATABASE = 'hr_db_idmig_rehearsal';

export const numericIdRehearsal = process.env.NUMERIC_ID_REHEARSAL === '1';

/** Database name of a mysql:// URL (undefined when it cannot be parsed). */
export function databaseNameOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || undefined;
	} catch {
		return undefined;
	}
}

/** Minimal raw-query surface shared by the default and the rehearsal Prisma clients. */
interface RawQueryClient {
	$queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * Checks the PHYSICAL key shape before anything reads or writes: canonical mode → employees.id must be
 * INT; rehearsal mode → employees.id_new must be INT (the post-M4 dual-column copy). Before M8 the live
 * hr_db still has VARCHAR (CUID) keys, so every entry point (server, seed, scripts) refuses it.
 *
 * `COLUMN_NAME` is matched as a literal `IN (...)`, never a bound parameter: on production MariaDB,
 * `information_schema.COLUMNS` reliably matches a literal `COLUMN_NAME` but returns zero rows for the
 * same filter sent as a prepared-statement parameter (confirmed — a plain `mysql` client query finds the
 * row; the identical query through `$queryRawUnsafe(..., column)` does not), which made this guard report
 * "missing" even though `employees.id` was already INT. `TABLE_SCHEMA`/`TABLE_NAME` were never the bound
 * value here, so they are unaffected and stay as literals.
 */
export async function assertNumericSchemaShapeOf(client: RawQueryClient): Promise<void> {
	const column = numericIdRehearsal ? 'id_new' : 'id';
	const rows = await client.$queryRawUnsafe<{ COLUMN_NAME: string; DATA_TYPE: string }[]>(
		`SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME IN ('id', 'id_new')`
	);
	const matched = rows.find((r) => r.COLUMN_NAME?.toLowerCase() === column.toLowerCase());
	const type = matched?.DATA_TYPE?.toLowerCase();
	if (type !== 'int') {
		throw new Error(
			`Numeric-ID schema check failed: employees.${column} is "${type ?? 'missing'}" in database "${databaseNameOf(process.env.DATABASE_URL) ?? '?'}", expected INT. ` +
				'This build requires the numeric-ID migration (M8) — or NUMERIC_ID_REHEARSAL=1 against hr_db_idmig_rehearsal. Refusing to start.'
		);
	}
}

/** Throws unless the rehearsal flag and DATABASE_URL agree. Called before the Prisma client is created. */
export function assertNumericIdMode(url = process.env.DATABASE_URL): void {
	const db = databaseNameOf(url);
	if (numericIdRehearsal && db !== REHEARSAL_DATABASE) {
		throw new Error(
			`NUMERIC_ID_REHEARSAL=1 requires DATABASE_URL to name "${REHEARSAL_DATABASE}" (got "${db ?? '?'}"). Refusing to start.`
		);
	}
	if (!numericIdRehearsal && db === REHEARSAL_DATABASE) {
		throw new Error(
			`DATABASE_URL names the dual-column rehearsal "${REHEARSAL_DATABASE}" but NUMERIC_ID_REHEARSAL is not 1 — the canonical client cannot read it. Refusing to start.`
		);
	}
}
