/**
 * The ONE source of "now" for attendance. Punch timestamps always come from here — the server
 * clock — never from the client. Tests may install a fixed clock to exercise specific instants
 * (overnight shifts, midnight boundaries); the override is refused outside NODE_ENV=test so it
 * can never be used to forge times in a real deployment.
 */
let override: (() => Date) | null = null;

export function serverNow(): Date {
	return override ? override() : new Date();
}

export function setServerClockForTests(fn: (() => Date) | null): void {
	if (process.env.NODE_ENV !== 'test') {
		throw new Error('setServerClockForTests is only available when NODE_ENV=test');
	}
	override = fn;
}
