import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import * as approvalService from '../services/approval.service.js';
import * as workflowService from '../services/approvalWorkflow.service.js';

function authOf(req: Request) {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth;
}
export const actorOf = (req: Request): approvalService.Actor => {
	const auth = authOf(req);
	return { userId: auth.user.id, permissions: auth.permissions };
};
// ---------- engine ----------

export async function inbox(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await approvalService.listInbox(actorOf(req), req.query as never));
}
export async function history(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await approvalService.listHistory(actorOf(req), req.query as never));
}
export async function detail(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await approvalService.getApprovalDetail(idParam(req), authOf(req)));
}
export async function approve(req: Request, res: Response): Promise<void> {
	await approvalService.actOnInstance(idParam(req), actorOf(req), 'approve', req.body.note);
	sendSuccess(res, await approvalService.getApprovalDetail(idParam(req), authOf(req)));
}
export async function reject(req: Request, res: Response): Promise<void> {
	await approvalService.actOnInstance(idParam(req), actorOf(req), 'reject', req.body.note);
	sendSuccess(res, await approvalService.getApprovalDetail(idParam(req), authOf(req)));
}
export async function reassign(req: Request, res: Response): Promise<void> {
	await approvalService.reassignCurrentStep(idParam(req), authOf(req).user.id, req.body.userId);
	sendSuccess(res, await approvalService.getApprovalDetail(idParam(req), authOf(req)));
}

// ---------- workflow configuration ----------

export async function listWorkflows(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await workflowService.listWorkflows(req.query as never));
}
export async function getWorkflow(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await workflowService.getWorkflow(idParam(req)));
}
export async function createWorkflow(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await workflowService.createWorkflow(req.body), 201);
}
export async function updateWorkflow(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await workflowService.updateWorkflow(idParam(req), req.body));
}
export async function previewWorkflow(req: Request, res: Response): Promise<void> {
	const { targetType, employeeId } = req.query as unknown as {
		targetType: 'LEAVE' | 'OVERTIME' | 'ATTENDANCE_CORRECTION' | 'PAYROLL_RUN';
		employeeId?: number;
	};
	sendSuccess(res, await workflowService.previewWorkflow(targetType, authOf(req), employeeId));
}
