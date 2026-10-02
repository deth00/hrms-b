import { Router } from 'express';
import * as controller from '../controllers/attendance.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePermission } from '../middlewares/requirePermission.js';
import { punchRateLimiter } from '../middlewares/rateLimit.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import {
	attendanceListQuerySchema,
	historyQuerySchema,
	punchBodySchema,
	selfCalendarQuerySchema,
	workLocationCreateSchema,
	workLocationListQuerySchema,
	workLocationUpdateSchema
} from '../validation/attendance.schema.js';
import {
	approveBodySchema,
	attendancePolicyUpdateSchema,
	correctionContextQuerySchema,
	correctionCreateSchema,
	correctionListQuerySchema,
	dailyQuerySchema,
	policyParamSchema,
	policyQuerySchema,
	rejectBodySchema,
	selfCorrectionListQuerySchema
} from '../validation/attendanceRules.schema.js';

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);

const self = requirePermission('attendance.self');
const view = requirePermission('attendance.view');
const requestCorrection = requirePermission('attendance_corrections.request');
const reviewCorrection = requirePermission('attendance_corrections.review');

// ---------- self service (registered before /attendance/:id) ----------
attendanceRouter.get('/attendance/me/today', self, controller.myToday);
attendanceRouter.post(
	'/attendance/me/check-in',
	self,
	punchRateLimiter,
	validateBody(punchBodySchema),
	controller.myCheckIn
);
attendanceRouter.post(
	'/attendance/me/check-out',
	self,
	punchRateLimiter,
	validateBody(punchBodySchema),
	controller.myCheckOut
);
attendanceRouter.get(
	'/attendance/me/history',
	self,
	validateQuery(historyQuerySchema),
	controller.myHistory
);
attendanceRouter.get(
	'/attendance/me/calendar',
	self,
	validateQuery(selfCalendarQuerySchema),
	controller.myCalendar
);

// self corrections (the employee is ALWAYS resolved from the session; no employeeId is accepted)
attendanceRouter.get(
	'/attendance/me/correction-context',
	self,
	requestCorrection,
	validateQuery(correctionContextQuerySchema),
	controller.myCorrectionContext
);
attendanceRouter.get(
	'/attendance/me/corrections',
	self,
	requestCorrection,
	validateQuery(selfCorrectionListQuerySchema),
	controller.myCorrections
);
attendanceRouter.post(
	'/attendance/me/corrections',
	self,
	requestCorrection,
	validateBody(correctionCreateSchema),
	controller.createMyCorrection
);
attendanceRouter.get(
	'/attendance/me/corrections/:id',
	self,
	requestCorrection,
	validateParams(idParamSchema),
	controller.getMyCorrection
);
attendanceRouter.post(
	'/attendance/me/corrections/:id/cancel',
	self,
	requestCorrection,
	validateParams(idParamSchema),
	controller.cancelMyCorrection
);

// ---------- admin view (read-only: no edit / delete of records or punches) ----------
// static /attendance/* paths must be registered BEFORE /attendance/:id
attendanceRouter.get('/attendance/daily', view, validateQuery(dailyQuerySchema), controller.daily);
attendanceRouter.get(
	'/attendance/corrections',
	reviewCorrection,
	validateQuery(correctionListQuerySchema),
	controller.listCorrections
);
attendanceRouter.get(
	'/attendance/corrections/:id',
	reviewCorrection,
	validateParams(idParamSchema),
	controller.getCorrection
);
attendanceRouter.post(
	'/attendance/corrections/:id/approve',
	reviewCorrection,
	validateParams(idParamSchema),
	validateBody(approveBodySchema),
	controller.approveCorrection
);
attendanceRouter.post(
	'/attendance/corrections/:id/reject',
	reviewCorrection,
	validateParams(idParamSchema),
	validateBody(rejectBodySchema),
	controller.rejectCorrection
);

attendanceRouter.get(
	'/attendance',
	view,
	validateQuery(attendanceListQuerySchema),
	controller.list
);
attendanceRouter.get('/attendance/:id', view, validateParams(idParamSchema), controller.detail);

// ---------- work locations ----------
attendanceRouter.get(
	'/work-locations',
	requirePermission('work_locations.view'),
	validateQuery(workLocationListQuerySchema),
	controller.listWorkLocations
);
attendanceRouter.get(
	'/work-locations/:id',
	requirePermission('work_locations.view'),
	validateParams(idParamSchema),
	controller.getWorkLocation
);
attendanceRouter.post(
	'/work-locations',
	requirePermission('work_locations.create'),
	validateBody(workLocationCreateSchema),
	controller.createWorkLocation
);
attendanceRouter.patch(
	'/work-locations/:id',
	requirePermission('work_locations.update'),
	validateParams(idParamSchema),
	validateBody(workLocationUpdateSchema),
	controller.updateWorkLocation
);

// ---------- attendance policy (one per company) ----------
attendanceRouter.get(
	'/attendance-policies',
	requirePermission('attendance_rules.view'),
	validateQuery(policyQuerySchema),
	controller.getPolicy
);
attendanceRouter.patch(
	'/attendance-policies/:companyId',
	requirePermission('attendance_rules.update'),
	validateParams(policyParamSchema),
	validateBody(attendancePolicyUpdateSchema),
	controller.updatePolicy
);
