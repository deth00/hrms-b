import type { Response } from 'express';
import type { ApiError, ApiSuccess } from '../types/api.js';

/** Establishes the { success, data } / { success, error } envelope used by every endpoint. */
export function sendSuccess<T>(res: Response, data: T, status = 200): void {
	const body: ApiSuccess<T> = { success: true, data };
	res.status(status).json(body);
}

export function sendError(
	res: Response,
	status: number,
	code: string,
	message: string,
	details?: Record<string, unknown>
): void {
	const body: ApiError = {
		success: false,
		error: { code, message, ...(details ? { details } : {}) }
	};
	res.status(status).json(body);
}
