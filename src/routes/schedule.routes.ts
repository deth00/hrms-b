import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/schedule.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePermission } from '../middlewares/requirePermission.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema, paginationQuerySchema } from '../validation/common.schema.js';
import {
	holidayCreateSchema,
	holidayListQuerySchema,
	holidayUpdateSchema,
	scheduleAssignSchema,
	scheduleListQuerySchema,
	scheduleResolveQuerySchema,
	scheduleUpdateSchema,
	shiftCreateSchema,
	shiftListQuerySchema,
	shiftLookupQuerySchema,
	shiftUpdateSchema
} from '../validation/schedule.schema.js';

export const scheduleRouter = Router();
scheduleRouter.use(requireAuth);

const assignmentIdParam = z.object({ assignmentId: z.string().trim().min(1) });

// ---------- Shift (static paths before /:id) ----------
scheduleRouter.get(
	'/shifts/lookup',
	requirePermission('shifts.view'),
	validateQuery(shiftLookupQuerySchema),
	controller.lookupShifts
);
scheduleRouter.get(
	'/shifts',
	requirePermission('shifts.view'),
	validateQuery(shiftListQuerySchema),
	controller.listShifts
);
scheduleRouter.get(
	'/shifts/:id',
	requirePermission('shifts.view'),
	validateParams(idParamSchema),
	controller.getShift
);
scheduleRouter.post(
	'/shifts',
	requirePermission('shifts.create'),
	validateBody(shiftCreateSchema),
	controller.createShift
);
scheduleRouter.patch(
	'/shifts/:id',
	requirePermission('shifts.update'),
	validateParams(idParamSchema),
	validateBody(shiftUpdateSchema),
	controller.updateShift
);

// ---------- Holiday ----------
scheduleRouter.get(
	'/holidays',
	requirePermission('holidays.view'),
	validateQuery(holidayListQuerySchema),
	controller.listHolidays
);
scheduleRouter.get(
	'/holidays/:id',
	requirePermission('holidays.view'),
	validateParams(idParamSchema),
	controller.getHoliday
);
scheduleRouter.post(
	'/holidays',
	requirePermission('holidays.create'),
	validateBody(holidayCreateSchema),
	controller.createHoliday
);
scheduleRouter.patch(
	'/holidays/:id',
	requirePermission('holidays.update'),
	validateParams(idParamSchema),
	validateBody(holidayUpdateSchema),
	controller.updateHoliday
);

// ---------- Employee schedule assignment ----------
scheduleRouter.get(
	'/employee-schedules',
	requirePermission('schedules.view'),
	validateQuery(scheduleListQuerySchema),
	controller.listSchedules
);
scheduleRouter.patch(
	'/employee-schedules/:assignmentId',
	requirePermission('schedules.assign'),
	validateParams(assignmentIdParam),
	validateBody(scheduleUpdateSchema),
	controller.updateAssignment
);
scheduleRouter.get(
	'/employees/:id/schedules',
	requirePermission('schedules.view'),
	validateParams(idParamSchema),
	validateQuery(paginationQuerySchema),
	controller.employeeHistory
);
scheduleRouter.post(
	'/employees/:id/schedules',
	requirePermission('schedules.assign'),
	validateParams(idParamSchema),
	validateBody(scheduleAssignSchema),
	controller.assign
);
scheduleRouter.get(
	'/employees/:id/schedule',
	requirePermission('schedules.view'),
	validateParams(idParamSchema),
	validateQuery(scheduleResolveQuerySchema),
	controller.resolve
);
