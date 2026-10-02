import { Router, type NextFunction, type Request, type Response } from 'express';
import * as employeeController from '../controllers/employee.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePermission } from '../middlewares/requirePermission.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import {
	LINK_USER_FIELDS,
	STATUS_FIELDS,
	TRANSFER_FIELDS,
	availableUsersQuerySchema,
	employeeCreateSchema,
	employeeListQuerySchema,
	employeeLookupQuerySchema,
	employeeStatusSchema,
	employeeTransferSchema,
	employeeUpdateSchema,
	employmentTypeCreateSchema,
	employmentTypeListQuerySchema,
	employmentTypeLookupQuerySchema,
	employmentTypeUpdateSchema,
	historyQuerySchema
} from '../validation/employee.schema.js';
import { Errors } from '../utils/AppError.js';

export const employeeRouter = Router();

employeeRouter.use(requireAuth);

const view = requirePermission('employees.view');
const create = requirePermission('employees.create');
const update = requirePermission('employees.update');
const status = requirePermission('employees.status');
const transfer = requirePermission('employees.transfer');

/**
 * The generic PATCH only edits profile/contact data. Sensitive field groups have their own
 * permission AND their own endpoint, so `employees.update` alone can never bypass them:
 * - assignment fields   -> 403 without employees.transfer, else 400 (use POST /:id/transfer)
 * - status/endDate      -> 403 without employees.status,   else 400 (use PATCH /:id/status)
 * - userId (link/unlink)-> allowed only with employees.link_user
 * Runs BEFORE body validation so a forbidden caller learns nothing about field validity.
 */
function guardEmployeePatch(req: Request, _res: Response, next: NextFunction): void {
	const body = (req.body ?? {}) as Record<string, unknown>;
	const has = (fields: readonly string[]) => fields.some((f) => body[f] !== undefined);
	const permissions = req.auth?.permissions ?? [];

	if (has(TRANSFER_FIELDS)) {
		if (!permissions.includes('employees.transfer')) return next(Errors.forbidden());
		return next(
			Errors.badRequest(
				'USE_TRANSFER_ENDPOINT',
				'ການປ່ຽນໂຄງສ້າງ/ຕຳແໜ່ງ/ຫົວໜ້າ ຕ້ອງໃຊ້ການຍ້າຍ (POST /employees/:id/transfer) ເພື່ອບັນທຶກປະຫວັດ'
			)
		);
	}
	if (has(STATUS_FIELDS)) {
		if (!permissions.includes('employees.status')) return next(Errors.forbidden());
		return next(
			Errors.badRequest(
				'USE_STATUS_ENDPOINT',
				'ການປ່ຽນສະຖານະການຈ້າງງານຕ້ອງໃຊ້ PATCH /employees/:id/status'
			)
		);
	}
	if (has(LINK_USER_FIELDS) && !permissions.includes('employees.link_user')) {
		return next(Errors.forbidden());
	}
	next();
}

// ---------- Employment Type (registered first: static paths before /employees/:id) ----------

employeeRouter.get(
	'/employment-types/lookup',
	view,
	validateQuery(employmentTypeLookupQuerySchema),
	employeeController.lookupEmploymentTypes
);
employeeRouter.get(
	'/employment-types',
	view,
	validateQuery(employmentTypeListQuerySchema),
	employeeController.listEmploymentTypes
);
employeeRouter.get(
	'/employment-types/:id',
	view,
	validateParams(idParamSchema),
	employeeController.getEmploymentType
);
employeeRouter.post(
	'/employment-types',
	create,
	validateBody(employmentTypeCreateSchema),
	employeeController.createEmploymentType
);
employeeRouter.patch(
	'/employment-types/:id',
	update,
	validateParams(idParamSchema),
	validateBody(employmentTypeUpdateSchema),
	employeeController.updateEmploymentType
);

// ---------- Employee ----------

employeeRouter.get(
	'/employees/lookup',
	view,
	validateQuery(employeeLookupQuerySchema),
	employeeController.lookupEmployees
);
employeeRouter.get(
	'/employees/lookups/available-users',
	requirePermission('employees.link_user'),
	validateQuery(availableUsersQuerySchema),
	employeeController.availableUsers
);
employeeRouter.get(
	'/employees',
	view,
	validateQuery(employeeListQuerySchema),
	employeeController.listEmployees
);
employeeRouter.post(
	'/employees',
	create,
	validateBody(employeeCreateSchema),
	employeeController.createEmployee
);
employeeRouter.get(
	'/employees/:id',
	view,
	validateParams(idParamSchema),
	employeeController.getEmployee
);
employeeRouter.get(
	'/employees/:id/assignment-history',
	view,
	validateParams(idParamSchema),
	validateQuery(historyQuerySchema),
	employeeController.getAssignmentHistory
);
employeeRouter.patch(
	'/employees/:id',
	update,
	guardEmployeePatch,
	validateParams(idParamSchema),
	validateBody(employeeUpdateSchema),
	employeeController.updateEmployee
);
employeeRouter.post(
	'/employees/:id/transfer',
	transfer,
	validateParams(idParamSchema),
	validateBody(employeeTransferSchema),
	employeeController.transferEmployee
);
employeeRouter.patch(
	'/employees/:id/status',
	status,
	validateParams(idParamSchema),
	validateBody(employeeStatusSchema),
	employeeController.changeEmployeeStatus
);
