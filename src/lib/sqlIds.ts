import { Prisma } from '@prisma/client';
import { numericIdRehearsal } from '../config/numericIdMode.js';

/**
 * The physical column that holds numeric id `name` in raw SQL. Prisma queries go through `@map`, but raw
 * SQL names columns directly: on the M6 rehearsal (dual-column, pre-M8) the numeric value lives in
 * `<name>_new`; everywhere else (tests, post-M8) in `<name>`. Always alias the result back to `name`.
 */
export function idCol(name = 'id'): Prisma.Sql {
	return Prisma.raw(numericIdRehearsal ? `\`${name}_new\`` : `\`${name}\``);
}
