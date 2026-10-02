import { defineConfig } from 'vitest/config';
import 'dotenv/config';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export default defineConfig({
	test: {
		environment: 'node',
		globals: false,
		globalSetup: ['./tests/globalSetup.ts'],
		env: {
			NODE_ENV: 'test',
			// Phase 14 — a fixed, TEST-ONLY bank-account encryption key (never used anywhere else)
			BANK_ACCOUNT_ENCRYPTION_KEY:
				'00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
			BANK_ACCOUNT_ENCRYPTION_KEY_VERSION: '1',
			...(testDatabaseUrl ? { DATABASE_URL: testDatabaseUrl } : {})
		},
		fileParallelism: false,
		testTimeout: 20000,
		hookTimeout: 30000
	}
});
