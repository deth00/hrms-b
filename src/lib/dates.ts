/** Date-only helpers. Employee dates are calendar dates (MySQL DATE), stored/serialized at UTC midnight. */

const LAOS_UTC_OFFSET_HOURS = 7;

/** "Today" as a calendar date in Laos (UTC+7) — not the server's UTC date. */
export function todayInLaos(now: Date = new Date()): Date {
	const shifted = new Date(now.getTime() + LAOS_UTC_OFFSET_HOURS * 60 * 60 * 1000);
	return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** Parses a strict YYYY-MM-DD string; returns null for anything malformed or non-existent (e.g. 2026-02-30). */
export function parseDateOnly(value: string): Date | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const date = new Date(`${value}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString().slice(0, 10) === value ? date : null;
}

export function formatDateOnly(date: Date): string {
	return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Laos time layer (Asia/Vientiane = UTC+7, no DST). Everything that needs "the local
// date/time in Laos" goes through here — never `new Date().toISOString().slice(...)`,
// which yields the UTC date and is wrong for 00:00–07:00 Laos time.
// ---------------------------------------------------------------------------

export const DAY_NAMES = [
	'SUNDAY',
	'MONDAY',
	'TUESDAY',
	'WEDNESDAY',
	'THURSDAY',
	'FRIDAY',
	'SATURDAY'
] as const;
export type DayName = (typeof DAY_NAMES)[number];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Laos wall-clock components of an absolute instant. */
export function laosParts(instant: Date): { date: Date; minutesOfDay: number } {
	const shifted = new Date(instant.getTime() + LAOS_UTC_OFFSET_HOURS * 60 * 60 * 1000);
	return {
		date: new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())),
		minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
	};
}

/** The Laos calendar date (as a UTC-midnight Date) of an absolute instant. */
export function laosDateOf(instant: Date): Date {
	return laosParts(instant).date;
}

export function addDays(date: Date, days: number): Date {
	return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Day of week of a calendar date (a UTC-midnight Date), e.g. 2026-09-19 -> SATURDAY. */
export function dayOfWeekOf(date: Date): DayName {
	return DAY_NAMES[date.getUTCDay()] as DayName;
}

/** "HH:mm" -> minutes since midnight. */
export function timeToMinutes(time: string): number {
	const [h, m] = time.split(':').map(Number);
	return (h as number) * 60 + (m as number);
}

/** True when a shift running startTime -> endTime ends on the following day (e.g. 22:00 -> 06:00). */
export function shiftCrossesMidnight(startTime: string, endTime: string): boolean {
	return timeToMinutes(endTime) < timeToMinutes(startTime);
}

/** Length of a shift in minutes, correctly handling overnight shifts. */
export function shiftDurationMinutes(startTime: string, endTime: string): number {
	return (timeToMinutes(endTime) - timeToMinutes(startTime) + 1440) % 1440;
}

/**
 * The work date a Laos-local instant belongs to for a shift. For an overnight shift, the early
 * hours after midnight (up to and including the shift end) belong to the day the shift STARTED:
 * 03:00 on 2026-09-20 belongs to the 22:00-06:00 shift of 2026-09-19. (Groundwork for Attendance.)
 */
export function workDateForInstant(
	instant: Date,
	shift: { startTime: string; endTime: string }
): Date {
	const { date, minutesOfDay } = laosParts(instant);
	if (
		shiftCrossesMidnight(shift.startTime, shift.endTime) &&
		minutesOfDay <= timeToMinutes(shift.endTime)
	) {
		return addDays(date, -1);
	}
	return date;
}
