import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import { resolveEmployeeScope } from '../lib/employeeScope.js';
import * as overtimeService from '../services/overtime.service.js';
import * as policyService from '../services/overtimePolicy.service.js';
import * as approvalService from '../services/approval.service.js';
import { actorOf } from './approval.controller.js';

function authOf(req: Request) {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth;
}
/** Self-service ALWAYS acts on the employee linked to the session — no employee id is accepted. */
const userIdOf = (req: Request) => authOf(req).user.id;
const scopeOf = (req: Request) => resolveEmployeeScope(authOf(req));
// ---------- self ----------

export async function myRequests(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await overtimeService.listMyOvertime(userIdOf(req), req.query as never));
}
export async function myRequest(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await overtimeService.getMyOvertime(userIdOf(req), idParam(req)));
}
export async function previewMy(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await overtimeService.previewMyOvertime(userIdOf(req), req.body));
}
export async function createMy(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await overtimeService.createMyOvertime(userIdOf(req), req.body), 201);
}
export async function cancelMy(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await overtimeService.cancelMyOvertime(userIdOf(req), idParam(req)));
}

// ---------- review ----------

export async function listRequests(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await overtimeService.listOvertimeRequests(req.query as never, await scopeOf(req))
	);
}
export async function getRequest(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await overtimeService.getOvertimeRequest(idParam(req), await scopeOf(req), userIdOf(req))
	);
}
/** Legacy review endpoints are WRAPPERS over the approval workflow (never a second system). */
async function review(req: Request, res: Response, action: 'approve' | 'reject'): Promise<void> {
	const scope = await scopeOf(req);
	await overtimeService.preflightOvertimeReview(idParam(req), scope, userIdOf(req));
	await approvalService.actOnTarget(
		'OVERTIME',
		idParam(req),
		actorOf(req),
		action,
		req.body.reviewNote,
		'OVERTIME_ALREADY_REVIEWED'
	);
	sendSuccess(res, await overtimeService.getOvertimeRequest(idParam(req), scope, userIdOf(req)));
}
export const approve = (req: Request, res: Response) => review(req, res, 'approve');
export const reject = (req: Request, res: Response) => review(req, res, 'reject');

// ---------- policy ----------

export async function getPolicy(req: Request, res: Response): Promise<void> {
	const { companyId } = req.query as unknown as { companyId: number };
	sendSuccess(res, await policyService.getOvertimePolicyForCompany(companyId));
}
export async function updatePolicy(req: Request, res: Response): Promise<void> {
	const { companyId } = req.query as unknown as { companyId: number };
	sendSuccess(res, await policyService.updateOvertimePolicy(companyId, req.body));
}
