import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import * as auditQuery from '../services/auditQuery.service.js';

const authOf = (req: Request) => {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth;
};

export async function list(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await auditQuery.listAuditEvents(req.query as never, authOf(req)));
}
export async function detail(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await auditQuery.getAuditEvent(idParam(req), authOf(req)));
}
