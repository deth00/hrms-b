import { Router } from 'express';
import * as organizationController from '../controllers/organization.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePermission } from '../middlewares/requirePermission.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import {
	branchCreateSchema,
	branchListQuerySchema,
	branchLookupQuerySchema,
	branchUpdateSchema,
	companyCreateSchema,
	companyListQuerySchema,
	companyLookupQuerySchema,
	companyUpdateSchema,
	departmentCreateSchema,
	departmentListQuerySchema,
	departmentLookupQuerySchema,
	departmentUpdateSchema,
	divisionCreateSchema,
	divisionListQuerySchema,
	divisionLookupQuerySchema,
	divisionUpdateSchema,
	unitCreateSchema,
	unitListQuerySchema,
	unitUpdateSchema
} from '../validation/organization.schema.js';

export const organizationRouter = Router();

organizationRouter.use(requireAuth);

const view = requirePermission('organization.view');
const create = requirePermission('organization.create');
const update = requirePermission('organization.update');

// ---------- Lookups (lightweight dropdown data) ----------
organizationRouter.get(
	'/organization/lookups/companies',
	view,
	validateQuery(companyLookupQuerySchema),
	organizationController.lookupCompanies
);
organizationRouter.get(
	'/organization/lookups/branches',
	view,
	validateQuery(branchLookupQuerySchema),
	organizationController.lookupBranches
);
organizationRouter.get(
	'/organization/lookups/departments',
	view,
	validateQuery(departmentLookupQuerySchema),
	organizationController.lookupDepartments
);
organizationRouter.get(
	'/organization/lookups/divisions',
	view,
	validateQuery(divisionLookupQuerySchema),
	organizationController.lookupDivisions
);

// ---------- Company ----------
organizationRouter.get(
	'/organization/companies',
	view,
	validateQuery(companyListQuerySchema),
	organizationController.listCompanies
);
organizationRouter.get(
	'/organization/companies/:id',
	view,
	validateParams(idParamSchema),
	organizationController.getCompany
);
organizationRouter.post(
	'/organization/companies',
	create,
	validateBody(companyCreateSchema),
	organizationController.createCompany
);
organizationRouter.patch(
	'/organization/companies/:id',
	update,
	validateParams(idParamSchema),
	validateBody(companyUpdateSchema),
	organizationController.updateCompany
);

// ---------- Branch ----------
organizationRouter.get(
	'/organization/branches',
	view,
	validateQuery(branchListQuerySchema),
	organizationController.listBranches
);
organizationRouter.get(
	'/organization/branches/:id',
	view,
	validateParams(idParamSchema),
	organizationController.getBranch
);
organizationRouter.post(
	'/organization/branches',
	create,
	validateBody(branchCreateSchema),
	organizationController.createBranch
);
organizationRouter.patch(
	'/organization/branches/:id',
	update,
	validateParams(idParamSchema),
	validateBody(branchUpdateSchema),
	organizationController.updateBranch
);

// ---------- Department ----------
organizationRouter.get(
	'/organization/departments',
	view,
	validateQuery(departmentListQuerySchema),
	organizationController.listDepartments
);
organizationRouter.get(
	'/organization/departments/:id',
	view,
	validateParams(idParamSchema),
	organizationController.getDepartment
);
organizationRouter.post(
	'/organization/departments',
	create,
	validateBody(departmentCreateSchema),
	organizationController.createDepartment
);
organizationRouter.patch(
	'/organization/departments/:id',
	update,
	validateParams(idParamSchema),
	validateBody(departmentUpdateSchema),
	organizationController.updateDepartment
);

// ---------- Division ----------
organizationRouter.get(
	'/organization/divisions',
	view,
	validateQuery(divisionListQuerySchema),
	organizationController.listDivisions
);
organizationRouter.get(
	'/organization/divisions/:id',
	view,
	validateParams(idParamSchema),
	organizationController.getDivision
);
organizationRouter.post(
	'/organization/divisions',
	create,
	validateBody(divisionCreateSchema),
	organizationController.createDivision
);
organizationRouter.patch(
	'/organization/divisions/:id',
	update,
	validateParams(idParamSchema),
	validateBody(divisionUpdateSchema),
	organizationController.updateDivision
);

// ---------- Unit ----------
organizationRouter.get(
	'/organization/units',
	view,
	validateQuery(unitListQuerySchema),
	organizationController.listUnits
);
organizationRouter.get(
	'/organization/units/:id',
	view,
	validateParams(idParamSchema),
	organizationController.getUnit
);
organizationRouter.post(
	'/organization/units',
	create,
	validateBody(unitCreateSchema),
	organizationController.createUnit
);
organizationRouter.patch(
	'/organization/units/:id',
	update,
	validateParams(idParamSchema),
	validateBody(unitUpdateSchema),
	organizationController.updateUnit
);
