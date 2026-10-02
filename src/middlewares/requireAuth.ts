import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { loadAuthContext, sessionCookieOptions } from '../services/session.service.js';
import { Errors } from '../utils/AppError.js';
import { setContextActor } from '../lib/requestContext.js';

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
	const token = (req.cookies as Record<string, string | undefined> | undefined)?.[
		env.sessionCookieName
	];

	if (!token) {
		next(Errors.unauthenticated());
		return;
	}

	const auth = await loadAuthContext(token);

	if (!auth) {
		res.clearCookie(env.sessionCookieName, sessionCookieOptions());
		next(Errors.unauthenticated());
		return;
	}

	req.auth = auth;
	setContextActor(auth.user.id);
	next();
}
