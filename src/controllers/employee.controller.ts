import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import { resolveEmployeeScope } from '../lib/employeeScope.js';
import * as employeeService from '../services/employee.service.js';
import * as employmentTypeService from '../services/employmentType.service.js';

function authOf(req: Request) {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth;
}

const scopeOf = (req: Request) => resolveEmployeeScope(authOf(req));
const actorOf = (req: Request) => ({ userId: authOf(req).user.id });

// ---------- Employee ----------

export async function listEmployees(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await employeeService.listEmployees(req.query as never, await scopeOf(req)));
}

export async function lookupEmployees(req: Request, res: Response): Promise<void> {
	const { search, companyId } = req.query as unknown as { search?: string; companyId?: number };
	sendSuccess(
		res,
		await employeeService.listEmployeeLookup(await scopeOf(req), { search, companyId })
	);
}

export async function availableUsers(req: Request, res: Response): Promise<void> {
	const { search, includeForEmployeeId } = req.query as unknown as {
		search?: string;
		includeForEmployeeId?: number;
	};
	sendSuccess(res, await employeeService.listAvailableUsers({ search, includeForEmployeeId }));
}

export async function getEmployee(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await employeeService.getEmployeeById(idParam(req), await scopeOf(req)));
}

export async function getAssignmentHistory(req: Request, res: Response): Promise<void> {
	const { page, pageSize } = req.query as unknown as { page: number; pageSize: number };
	sendSuccess(
		res,
		await employeeService.listAssignmentHistory(idParam(req), page, pageSize, await scopeOf(req))
	);
}

export async function createEmployee(req: Request, res: Response): Promise<void> {
	// Linking a login account at creation is the same sensitive act as linking later.
	if (req.body.userId && !authOf(req).permissions.includes('employees.link_user')) {
		throw Errors.forbidden();
	}
	sendSuccess(res, await employeeService.createEmployee(req.body, actorOf(req)), 201);
}

export async function updateEmployee(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await employeeService.updateEmployee(idParam(req), req.body, await scopeOf(req))
	);
}

export async function transferEmployee(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await employeeService.transferEmployee(idParam(req), req.body, actorOf(req), await scopeOf(req))
	);
}

export async function changeEmployeeStatus(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await employeeService.changeEmployeeStatus(
			idParam(req),
			req.body,
			actorOf(req),
			await scopeOf(req)
		)
	);
}

// ---------- Employment Type ----------

/** Status changes (ACTIVE <-> INACTIVE) on an employment type need `employees.status`. */
function assertCanChangeTypeStatus(req: Request): void {
	if (req.body.status !== undefined && !authOf(req).permissions.includes('employees.status')) {
		throw Errors.forbidden();
	}
}

export async function listEmploymentTypes(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await employmentTypeService.listEmploymentTypes(req.query as never));
}
export async function getEmploymentType(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await employmentTypeService.getEmploymentTypeById(idParam(req)));
}
export async function createEmploymentType(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await employmentTypeService.createEmploymentType(req.body), 201);
}
export async function updateEmploymentType(req: Request, res: Response): Promise<void> {
	assertCanChangeTypeStatus(req);
	sendSuccess(res, await employmentTypeService.updateEmploymentType(idParam(req), req.body));
}
export async function lookupEmploymentTypes(req: Request, res: Response): Promise<void> {
	const { companyId, status } = req.query as unknown as {
		companyId: number;
		status?: 'ACTIVE' | 'INACTIVE';
	};
	sendSuccess(res, await employmentTypeService.listEmploymentTypeLookup(companyId, status));
}
