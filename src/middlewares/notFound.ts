import type { Request, Response } from 'express';
import { sendError } from '../utils/response.js';

export function notFoundHandler(req: Request, res: Response): void {
	sendError(res, 404, 'NOT_FOUND', `No route matches ${req.method} ${req.originalUrl}`);
}
