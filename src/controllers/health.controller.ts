import type { Request, Response } from 'express';
import { sendSuccess } from '../utils/response.js';
import { checkDatabase } from '../services/health.service.js';

export async function getHealth(_req: Request, res: Response): Promise<void> {
	const database = await checkDatabase();

	sendSuccess(res, {
		service: 'hr-api',
		status: 'ok',
		database
	});
}
