import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { assertNumericIdMode, numericIdRehearsal } from './numericIdMode.js';

/**
 * Single shared Prisma client.
 *
 * Numeric-ID migration M6: with NUMERIC_ID_REHEARSAL=1 the client generated from
 * prisma/m6-rehearsal/schema.prisma is used instead — the SAME models and fields, mapped onto the
 * post-M4 dual-column rehearsal database (`id` → `id_new`, …). assertNumericIdMode() refuses to start
 * unless that mode and DATABASE_URL agree, so the rehearsal client can never touch another database.
 */
assertNumericIdMode();

function createClient(): PrismaClient {
	if (!numericIdRehearsal) return new PrismaClient();
	const require = createRequire(import.meta.url);
	// The generated rehearsal client ships its OWN copy of the Prisma runtime (./runtime/library.js; same
	// 6.12 code, plus a generated header). Its classes would then differ from the `Prisma` namespace the
	// services import: Prisma.DbNull/JsonNull would be written as `{}`, and `instanceof
	// PrismaClientKnownRequestError` (P2002 → 409 …) / `instanceof Prisma.Decimal` would never match. Load
	// it against the canonical runtime module instead, so both clients share one set of classes.
	const canonicalRuntime = require.resolve('@prisma/client/runtime/library.js');
	const rehearsalRuntime =
		require.resolve('../../node_modules/.prisma-m6-rehearsal/client/runtime/library.js');
	require(canonicalRuntime);
	require.cache[rehearsalRuntime] = require.cache[canonicalRuntime];
	const rehearsal = require('../../node_modules/.prisma-m6-rehearsal/client/index.js') as {
		PrismaClient: typeof PrismaClient;
	};
	return new rehearsal.PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
}

export const prisma = createClient();
