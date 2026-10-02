import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import * as notificationService from '../services/notification.service.js';

/** Notifications are ALWAYS the authenticated user's own — there is no employeeId / userId param. */
const userIdOf = (req: Request) => {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth.user.id;
};

export async function list(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await notificationService.listNotifications(userIdOf(req), req.query as never));
}
export async function unreadCount(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await notificationService.unreadCount(userIdOf(req)));
}
export async function read(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await notificationService.markRead(userIdOf(req), idParam(req)));
}
export async function readAll(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await notificationService.markAllRead(userIdOf(req)));
}
