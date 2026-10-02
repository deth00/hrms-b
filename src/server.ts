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

const server = app.listen(env.port, () => {
	console.log(`hr-api listening on port ${env.port} (${env.nodeEnv})`);
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
