import { addDays, timeToMinutes } from './dates.js';

const LAOS_OFFSET_MS = 7 * 60 * 60 * 1000;

/** The absolute instant of `HH:mm` Laos wall-clock time on a Laos calendar date (UTC-midnight Date). */
export function laosInstant(date: Date, time: string): Date {
	return new Date(date.getTime() + timeToMinutes(time) * 60_000 - LAOS_OFFSET_MS);
}

/** Scheduled start of a work date's shift, as an absolute instant. */
export function scheduledStartInstant(workDate: Date, startTime: string): Date {
	return laosInstant(workDate, startTime);
}

/** Scheduled end: the next calendar day for an overnight shift. */
export function scheduledEndInstant(
	workDate: Date,
	endTime: string,
	crossesMidnight: boolean
): Date {
	return laosInstant(crossesMidnight ? addDays(workDate, 1) : workDate, endTime);
}

/** "HH:mm:ss" Laos wall-clock time of an instant. */
export function laosClockString(instant: Date): string {
	return new Date(instant.getTime() + LAOS_OFFSET_MS).toISOString().slice(11, 19);
}
