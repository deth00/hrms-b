import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import * as companyService from '../services/company.service.js';
import * as branchService from '../services/branch.service.js';
import * as departmentService from '../services/department.service.js';
import * as divisionService from '../services/division.service.js';
import * as unitService from '../services/unit.service.js';

/** Status changes (ACTIVE <-> INACTIVE) require the more sensitive `organization.disable` permission. */
function assertCanChangeStatus(req: Request): void {
	if (req.body.status !== undefined && !req.auth?.permissions.includes('organization.disable')) {
		throw Errors.forbidden();
	}
}

// ---------- Company ----------

export async function listCompanies(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await companyService.listCompanies(req.query as never));
}
export async function getCompany(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await companyService.getCompanyById(idParam(req)));
}
export async function createCompany(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await companyService.createCompany(req.body), 201);
}
export async function updateCompany(req: Request, res: Response): Promise<void> {
	assertCanChangeStatus(req);
	sendSuccess(res, await companyService.updateCompany(idParam(req), req.body));
}
export async function lookupCompanies(req: Request, res: Response): Promise<void> {
	const { status } = req.query as unknown as { status?: 'ACTIVE' | 'INACTIVE' };
	sendSuccess(res, await companyService.listCompanyLookup(status));
}

// ---------- Branch ----------

export async function listBranches(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await branchService.listBranches(req.query as never));
}
export async function getBranch(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await branchService.getBranchById(idParam(req)));
}
export async function createBranch(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await branchService.createBranch(req.body), 201);
}
export async function updateBranch(req: Request, res: Response): Promise<void> {
	assertCanChangeStatus(req);
	sendSuccess(res, await branchService.updateBranch(idParam(req), req.body));
}
export async function lookupBranches(req: Request, res: Response): Promise<void> {
	const { companyId, status } = req.query as unknown as {
		companyId: number;
		status?: 'ACTIVE' | 'INACTIVE';
	};
	sendSuccess(res, await branchService.listBranchLookup(companyId, status));
}

// ---------- Department ----------

export async function listDepartments(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await departmentService.listDepartments(req.query as never));
}
export async function getDepartment(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await departmentService.getDepartmentById(idParam(req)));
}
export async function createDepartment(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await departmentService.createDepartment(req.body), 201);
}
export async function updateDepartment(req: Request, res: Response): Promise<void> {
	assertCanChangeStatus(req);
	sendSuccess(res, await departmentService.updateDepartment(idParam(req), req.body));
}
export async function lookupDepartments(req: Request, res: Response): Promise<void> {
	const { companyId, branchId, status } = req.query as unknown as {
		companyId: number;
		branchId?: number;
		status?: 'ACTIVE' | 'INACTIVE';
	};
	sendSuccess(res, await departmentService.listDepartmentLookup(companyId, branchId, status));
}

// ---------- Division ----------

export async function listDivisions(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await divisionService.listDivisions(req.query as never));
}
export async function getDivision(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await divisionService.getDivisionById(idParam(req)));
}
export async function createDivision(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await divisionService.createDivision(req.body), 201);
}
export async function updateDivision(req: Request, res: Response): Promise<void> {
	assertCanChangeStatus(req);
	sendSuccess(res, await divisionService.updateDivision(idParam(req), req.body));
}
export async function lookupDivisions(req: Request, res: Response): Promise<void> {
	const { departmentId, status } = req.query as unknown as {
		departmentId: number;
		status?: 'ACTIVE' | 'INACTIVE';
	};
	sendSuccess(res, await divisionService.listDivisionLookup(departmentId, status));
}

// ---------- Unit ----------

export async function listUnits(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await unitService.listUnits(req.query as never));
}
export async function getUnit(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await unitService.getUnitById(idParam(req)));
}
export async function createUnit(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await unitService.createUnit(req.body), 201);
}
export async function updateUnit(req: Request, res: Response): Promise<void> {
	assertCanChangeStatus(req);
	sendSuccess(res, await unitService.updateUnit(idParam(req), req.body));
}
