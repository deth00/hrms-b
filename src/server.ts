import { app } from './app.js';
import { env, isProduction } from './config/env.js';
import { assertEncryptionConfig } from './lib/sensitiveCrypto.js';
import { prisma } from './config/prisma.js';
import { assertNumericSchemaShape } from './lib/schemaShapeGuard.js';

// Phase 14 — an INVALID bank-account encryption key (or a missing one in production) stops startup
if (!assertEncryptionConfig({ production: isProduction })) {
	console.warn(
		'BANK_ACCOUNT_ENCRYPTION_KEY is not set — employee bank-account features are disabled until it is configured'
	);
}

// numeric-ID migration: never serve against a database whose keys are not numeric (e.g. hr_db before M8)
await assertNumericSchemaShape();

// Production Docker runs with --network host, so binding 0.0.0.0 would expose the API on every host
// interface (including the public one) instead of only to the local reverse proxy. Non-production keeps
// 0.0.0.0 so it stays reachable the way it already is today (e.g. from another container / device on dev).
const host = isProduction ? '127.0.0.1' : '0.0.0.0';
const server = app.listen(env.port, host, () => {
	console.log(`hr-api listening on ${host}:${env.port} (${env.nodeEnv})`);
});

async function shutdown(signal: string) {
	console.log(`${signal} received, shutting down gracefully...`);
	server.close(async () => {
		await prisma.$disconnect();
		process.exit(0);
	});
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
