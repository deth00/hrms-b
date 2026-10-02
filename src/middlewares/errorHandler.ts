import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { sendError } from '../utils/response.js';
import { AppError } from '../utils/AppError.js';
import { isProduction } from '../config/env.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies error middleware by its 4-argument arity.
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
	if (err instanceof AppError) {
		sendError(res, err.status, err.code, err.message, err.details);
		return;
	}

	if (err instanceof ZodError) {
		const firstIssue = err.issues[0];
		const message = firstIssue
			? `${firstIssue.path.join('.')}: ${firstIssue.message}`
			: 'ຂໍ້ມູນບໍ່ຖືກຕ້ອງ';
		sendError(res, 400, 'VALIDATION_ERROR', message);
		return;
	}

	console.error(err);

	const message = !isProduction && err instanceof Error ? err.message : 'ເກີດຂໍ້ຜິດພາດທີ່ບໍ່ຄາດຄິດ';

	sendError(res, 500, 'INTERNAL_ERROR', message);
}
