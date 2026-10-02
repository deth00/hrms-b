import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import { resolveEmployeeScope } from '../lib/employeeScope.js';
import * as attendanceService from '../services/attendance.service.js';
import * as workLocationService from '../services/workLocation.service.js';
import * as dailyService from '../services/attendanceDaily.service.js';
import * as calendarService from '../services/attendanceSelfCalendar.service.js';
import * as correctionService from '../services/attendanceCorrection.service.js';
import * as policyService from '../services/attendancePolicy.service.js';
import * as approvalService from '../services/approval.service.js';
import { actorOf } from './approval.controller.js';

function authOf(req: Request) {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth;
}

/** Self-service ALWAYS acts on the employee linked to the authenticated user — no id is ever accepted. */
const userIdOf = (req: Request) => authOf(req).user.id;
const metaOf = (req: Request): attendanceService.RequestMeta => ({
	ipAddress: req.ip ?? null,
	userAgent: req.get('user-agent') ?? null
});

// ---------- self ----------

export async function myToday(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await attendanceService.getMyToday(userIdOf(req)));
}
export async function myCheckIn(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await attendanceService.checkIn(userIdOf(req), req.body, metaOf(req)), 201);
}
export async function myCheckOut(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await attendanceService.checkOut(userIdOf(req), req.body, metaOf(req)));
}
export async function myHistory(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await attendanceService.getMyHistory(userIdOf(req), req.query as never));
}
export async function myCalendar(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await calendarService.getMyCalendar(userIdOf(req), req.query as never));
}

// ---------- admin ----------

export async function list(req: Request, res: Response): Promise<void> {
	const scope = await resolveEmployeeScope(authOf(req));
	sendSuccess(res, await attendanceService.listAttendance(req.query as never, scope));
}
export async function detail(req: Request, res: Response): Promise<void> {
	const scope = await resolveEmployeeScope(authOf(req));
	sendSuccess(res, await attendanceService.getAttendanceById(idParam(req), scope));
}

// ---------- work locations ----------

export async function listWorkLocations(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await workLocationService.listWorkLocations(req.query as never));
}
export async function getWorkLocation(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await workLocationService.getWorkLocationById(idParam(req)));
}
export async function createWorkLocation(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await workLocationService.createWorkLocation(req.body), 201);
}
export async function updateWorkLocation(req: Request, res: Response): Promise<void> {
	if (
		req.body.status !== undefined &&
		!authOf(req).permissions.includes('work_locations.disable')
	) {
		throw Errors.forbidden();
	}
	sendSuccess(res, await workLocationService.updateWorkLocation(idParam(req), req.body));
}

// ---------- daily result ----------

export async function daily(req: Request, res: Response): Promise<void> {
	const scope = await resolveEmployeeScope(authOf(req));
	sendSuccess(res, await dailyService.listDailyAttendance(req.query as never, scope));
}

// ---------- policy ----------

export async function getPolicy(req: Request, res: Response): Promise<void> {
	const { companyId } = req.query as unknown as { companyId: number };
	sendSuccess(res, await policyService.getPolicyForCompany(companyId));
}
export async function updatePolicy(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await policyService.updatePolicy(idParam(req, 'companyId'), req.body));
}

// ---------- corrections: self (employee always comes from the session) ----------

export async function myCorrectionContext(req: Request, res: Response): Promise<void> {
	const { workDate } = req.query as unknown as { workDate: string };
	sendSuccess(res, await correctionService.getSelfCorrectionContext(userIdOf(req), workDate));
}
export async function myCorrections(req: Request, res: Response): Promise<void> {
	const { page, pageSize, status } = req.query as unknown as {
		page: number;
		pageSize: number;
		status?: never;
	};
	sendSuccess(
		res,
		await correctionService.listMyCorrections(userIdOf(req), page, pageSize, status)
	);
}
export async function createMyCorrection(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await correctionService.createCorrection(userIdOf(req), req.body), 201);
}
export async function getMyCorrection(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await correctionService.getMyCorrection(userIdOf(req), idParam(req)));
}
export async function cancelMyCorrection(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await correctionService.cancelMyCorrection(userIdOf(req), idParam(req)));
}

// ---------- corrections: review ----------

export async function listCorrections(req: Request, res: Response): Promise<void> {
	const scope = await resolveEmployeeScope(authOf(req));
	sendSuccess(res, await correctionService.listCorrections(req.query as never, scope));
}
export async function getCorrection(req: Request, res: Response): Promise<void> {
	const scope = await resolveEmployeeScope(authOf(req));
	sendSuccess(
		res,
		await correctionService.getCorrection(idParam(req), scope, { userId: userIdOf(req) })
	);
}
/**
 * Legacy review endpoints are WRAPPERS over the approval workflow (never a second approval system):
 * scope + own-request checks first, then the acting user must be a candidate of the current step.
 */
async function reviewCorrection(
	req: Request,
	res: Response,
	action: 'approve' | 'reject'
): Promise<void> {
	const scope = await resolveEmployeeScope(authOf(req));
	await correctionService.preflightCorrectionReview(idParam(req), scope, {
		userId: userIdOf(req)
	});
	await approvalService.actOnTarget(
		'ATTENDANCE_CORRECTION',
		idParam(req),
		actorOf(req),
		action,
		req.body.reviewNote,
		'CORRECTION_ALREADY_REVIEWED'
	);
	sendSuccess(
		res,
		await correctionService.getCorrection(idParam(req), scope, { userId: userIdOf(req) })
	);
}
export const approveCorrection = (req: Request, res: Response) =>
	reviewCorrection(req, res, 'approve');
export const rejectCorrection = (req: Request, res: Response) =>
	reviewCorrection(req, res, 'reject');
