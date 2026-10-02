import 'dotenv/config';

function required(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback;
	if (value === undefined) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

/** TRUST_PROXY: unset → off; a number → hop count; 'true' → 1 hop; anything else → Express subnet keyword */
function parseTrustProxy(raw: string | undefined): number | string | undefined {
	if (!raw) return undefined;
	if (raw === 'true') return 1;
	if (raw === 'false') return undefined;
	const n = Number(raw);
	return Number.isInteger(n) ? n : raw;
}

export const env = {
	nodeEnv: process.env.NODE_ENV ?? 'development',
	port: Number(process.env.PORT ?? 4000),
	frontendOrigin: required('FRONTEND_ORIGIN', 'http://localhost:5173'),
	databaseUrl: process.env.DATABASE_URL,
	trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

	sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'hr_session',
	sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),

	attendance: {
		/** Reject GPS fixes less precise than this (metres) when a location requires GPS. */
		maxGpsAccuracyMeters: Number(process.env.ATTENDANCE_MAX_GPS_ACCURACY_METERS ?? 200),
		/** Used when a shift has no earlyCheckInMinutes of its own. */
		defaultEarlyCheckInMinutes: Number(
			process.env.ATTENDANCE_DEFAULT_EARLY_CHECK_IN_MINUTES ?? 120
		),
		/** How long after the scheduled end an unfinished record can still be checked out by the employee. */
		checkOutGraceHours: Number(process.env.ATTENDANCE_CHECK_OUT_GRACE_HOURS ?? 4)
	},

	seedAdmin: {
		username: process.env.SEED_ADMIN_USERNAME,
		email: process.env.SEED_ADMIN_EMAIL,
		password: process.env.SEED_ADMIN_PASSWORD,
		displayName: process.env.SEED_ADMIN_DISPLAY_NAME
	}
} as const;

export const isProduction = env.nodeEnv === 'production';
export const isTest = env.nodeEnv === 'test';
