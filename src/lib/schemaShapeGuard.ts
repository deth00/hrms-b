import { prisma } from '../config/prisma.js';
import { assertNumericSchemaShapeOf } from '../config/numericIdMode.js';

/**
 * Numeric-ID migration: this build expects numeric primary keys. Before M8, the live database still has
 * VARCHAR (CUID) keys — running this code against it would fail on every query and could misbehave on
 * writes. Startup therefore checks the PHYSICAL shape once and refuses to serve when it does not match
 * (see assertNumericSchemaShapeOf).
 */
export async function assertNumericSchemaShape(): Promise<void> {
	await assertNumericSchemaShapeOf(prisma);
}
