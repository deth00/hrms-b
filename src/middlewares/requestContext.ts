import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from '../lib/requestContext.js';

const MAX_USER_AGENT = 500;

/**
 * Assigns a server-generated correlation id to every request (`req.requestId`, `X-Request-Id`
 * response header) and opens the AsyncLocalStorage context used by the audit writer. The client's
 * own X-Request-Id header is ignored on purpose. `req.ip` honours Express `trust proxy`, which is
 * only enabled when TRUST_PROXY is configured (see app.ts) — otherwise a spoofed X-Forwarded-For
 * cannot forge the recorded IP.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
	const requestId = randomUUID();
	req.requestId = requestId;
	res.setHeader('X-Request-Id', requestId);
	const ua = req.get('user-agent');
	runWithRequestContext(
		{
			requestId,
			ipAddress: req.ip ?? null,
			userAgent: ua ? ua.slice(0, MAX_USER_AGENT) : null,
			actorUserId: null
		},
		next
	);
}
