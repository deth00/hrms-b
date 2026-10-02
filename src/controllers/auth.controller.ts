import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import * as authService from '../services/auth.service.js';
import { loadAuthContext, sessionCookieOptions } from '../services/session.service.js';
import type { LoginInput, ChangePasswordInput } from '../validation/auth.schema.js';

export async function login(
	req: Request<unknown, unknown, LoginInput>,
	res: Response
): Promise<void> {
	const session = await authService.login(req.body);
	const auth = await loadAuthContext(session.token);

	if (!auth) {
		// Cannot happen in practice — the session was just created — but keep the response type honest.
		throw Errors.invalidCredentials();
	}

	res.cookie(env.sessionCookieName, session.token, sessionCookieOptions(session.expiresAt));
	sendSuccess(res, { user: auth.user, roles: auth.roles, permissions: auth.permissions });
}

export function me(req: Request, res: Response): void {
	if (!req.auth) throw Errors.unauthenticated();
	sendSuccess(res, {
		user: req.auth.user,
		roles: req.auth.roles,
		permissions: req.auth.permissions
	});
}

export async function logout(req: Request, res: Response): Promise<void> {
	const token = (req.cookies as Record<string, string | undefined> | undefined)?.[
		env.sessionCookieName
	];
	if (!req.auth) throw Errors.unauthenticated();
	await authService.logout(req.auth.user.id, token);
	res.clearCookie(env.sessionCookieName, sessionCookieOptions());
	sendSuccess(res, { loggedOut: true });
}

export async function changePassword(
	req: Request<unknown, unknown, ChangePasswordInput>,
	res: Response
): Promise<void> {
	if (!req.auth) throw Errors.unauthenticated();
	await authService.changePassword(req.auth.user.id, req.auth.sessionId, req.body);
	sendSuccess(res, { changed: true });
}
