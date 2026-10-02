import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import { resolveEmployeeScope } from '../lib/employeeScope.js';
import * as shiftService from '../services/shift.service.js';
import * as holidayService from '../services/holiday.service.js';
import * as scheduleService from '../services/schedule.service.js';

function authOf(req: Request) {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth;
}
const scopeOf = (req: Request) => resolveEmployeeScope(authOf(req));
const actorOf = (req: Request) => ({ userId: authOf(req).user.id });

/** Status changes (ACTIVE <-> INACTIVE) need the more sensitive `.disable` permission. */
function assertCanChangeStatus(req: Request, permission: string): void {
	if (req.body.status !== undefined && !authOf(req).permissions.includes(permission)) {
		throw Errors.forbidden();
	}
}

// ---------- Shift ----------

export async function listShifts(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await shiftService.listShifts(req.query as never));
}
export async function getShift(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await shiftService.getShiftById(idParam(req)));
}
export async function createShift(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await shiftService.createShift(req.body), 201);
}
export async function updateShift(req: Request, res: Response): Promise<void> {
	assertCanChangeStatus(req, 'shifts.disable');
	sendSuccess(res, await shiftService.updateShift(idParam(req), req.body));
}
export async function lookupShifts(req: Request, res: Response): Promise<void> {
	const { companyId, status } = req.query as unknown as {
		companyId: number;
		status?: 'ACTIVE' | 'INACTIVE';
	};
	sendSuccess(res, await shiftService.listShiftLookup(companyId, status));
}

// ---------- Holiday ----------

export async function listHolidays(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await holidayService.listHolidays(req.query as never));
}
export async function getHoliday(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await holidayService.getHolidayById(idParam(req)));
}
export async function createHoliday(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await holidayService.createHoliday(req.body), 201);
}
export async function updateHoliday(req: Request, res: Response): Promise<void> {
	assertCanChangeStatus(req, 'holidays.disable');
	sendSuccess(res, await holidayService.updateHoliday(idParam(req), req.body));
}

// ---------- Employee schedule ----------

export async function listSchedules(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await scheduleService.listSchedules(req.query as never, await scopeOf(req)));
}
export async function employeeHistory(req: Request, res: Response): Promise<void> {
	const { page, pageSize } = req.query as unknown as { page: number; pageSize: number };
	sendSuccess(
		res,
		await scheduleService.listEmployeeSchedules(idParam(req), page, pageSize, await scopeOf(req))
	);
}
export async function assign(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await scheduleService.assignSchedule(idParam(req), req.body, actorOf(req), await scopeOf(req)),
		201
	);
}
export async function updateAssignment(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await scheduleService.updateAssignment(
			idParam(req, 'assignmentId'),
			req.body,
			await scopeOf(req)
		)
	);
}
export async function resolve(req: Request, res: Response): Promise<void> {
	const { date } = req.query as unknown as { date?: Date };
	sendSuccess(res, await scheduleService.resolveSchedule(idParam(req), date, await scopeOf(req)));
}
