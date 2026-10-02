import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import { resolveEmployeeScope } from '../lib/employeeScope.js';
import * as leaveService from '../services/leave.service.js';
import * as leaveTypeService from '../services/leaveType.service.js';
import * as balanceService from '../services/leaveBalance.service.js';
import * as approvalService from '../services/approval.service.js';
import { actorOf } from './approval.controller.js';

function authOf(req: Request) {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth;
}
const userIdOf = (req: Request) => authOf(req).user.id;
const scopeOf = (req: Request) => resolveEmployeeScope(authOf(req));

// ---------- self ----------

export async function myBalances(req: Request, res: Response): Promise<void> {
	const { year } = req.query as unknown as { year?: number };
	sendSuccess(res, await balanceService.getMyBalances(userIdOf(req), year));
}
export async function myRequests(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await leaveService.listMyLeave(userIdOf(req), req.query as never));
}
export async function myRequest(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await leaveService.getMyLeave(userIdOf(req), idParam(req)));
}
export async function previewMy(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await leaveService.previewMyLeave(userIdOf(req), req.body));
}
export async function createMy(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await leaveService.createMyLeave(userIdOf(req), req.body), 201);
}
export async function cancelMy(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await leaveService.cancelMyLeave(userIdOf(req), idParam(req)));
}

// ---------- review ----------

export async function listRequests(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await leaveService.listLeaveRequests(req.query as never, await scopeOf(req)));
}
export async function getRequest(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await leaveService.getLeaveRequest(idParam(req), await scopeOf(req), userIdOf(req))
	);
}
/** Legacy review endpoints are WRAPPERS over the approval workflow (never a second system). */
async function review(req: Request, res: Response, action: 'approve' | 'reject'): Promise<void> {
	const scope = await scopeOf(req);
	await leaveService.preflightLeaveReview(idParam(req), scope, userIdOf(req));
	await approvalService.actOnTarget(
		'LEAVE',
		idParam(req),
		actorOf(req),
		action,
		req.body.reviewNote,
		'LEAVE_ALREADY_REVIEWED'
	);
	sendSuccess(res, await leaveService.getLeaveRequest(idParam(req), scope, userIdOf(req)));
}
export const approve = (req: Request, res: Response) => review(req, res, 'approve');
export const reject = (req: Request, res: Response) => review(req, res, 'reject');

// ---------- leave types ----------

export async function listTypes(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await leaveTypeService.listLeaveTypes(req.query as never));
}
export async function getType(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await leaveTypeService.getLeaveTypeById(idParam(req)));
}
export async function createType(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await leaveTypeService.createLeaveType(req.body), 201);
}
export async function updateType(req: Request, res: Response): Promise<void> {
	// Status changes (ACTIVE <-> INACTIVE) need the more sensitive `.disable` permission.
	if (req.body.status !== undefined && !authOf(req).permissions.includes('leave_types.disable')) {
		throw Errors.forbidden();
	}
	sendSuccess(res, await leaveTypeService.updateLeaveType(idParam(req), req.body));
}

// ---------- balances ----------

export async function listBalances(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await balanceService.listBalances(req.query as never, await scopeOf(req)));
}
export async function upsertBalance(req: Request, res: Response): Promise<void> {
	const result = await balanceService.upsertBalance(req.body, await scopeOf(req), userIdOf(req));
	sendSuccess(res, result.item, result.created ? 201 : 200);
}
export async function updateBalance(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await balanceService.updateBalance(idParam(req), req.body, await scopeOf(req), userIdOf(req))
	);
}
export async function addAdjustment(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await balanceService.addAdjustment(idParam(req), req.body, await scopeOf(req), userIdOf(req)),
		201
	);
}
export async function listAdjustments(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await balanceService.listAdjustments(idParam(req), req.query as never, await scopeOf(req))
	);
}
