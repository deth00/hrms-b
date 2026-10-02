import { Router } from 'express';
import { requireAuth } from '../middlewares/requireAuth.js';
import { requirePayrollAccess, requirePayrollAccessAny } from '../middlewares/requirePermission.js';
import { validateBody, validateParams, validateQuery } from '../middlewares/validate.js';
import { idParamSchema } from '../validation/common.schema.js';
import * as controller from '../controllers/accounting.controller.js';
import {
	accountingExportProfileCreateSchema,
	accountingExportProfileListQuerySchema,
	accountingExportProfileUpdateSchema,
	emptyBodySchema,
	glAccountCreateSchema,
	glAccountListQuerySchema,
	glAccountUpdateSchema,
	journalExportSchema,
	journalListQuerySchema,
	mappingUpsertSchema,
	ruleSetCreateSchema,
	ruleSetListQuerySchema,
	ruleSetUpdateSchema
} from '../validation/accounting.schema.js';

/**
 * Phase 16 — payroll accounting. Every endpoint needs its payroll.accounting.* permission AND
 * employees.view_all (journal lines carry employee codes); there is NO manager-tree or self access —
 * an EMPLOYEE never reaches accounting. No DELETE routes: accounts / rule sets are deactivated,
 * journals are cancelled (kept). Nothing here talks to an external accounting system or bank.
 */
export const accountingRouter = Router();

const view = requirePayrollAccess('payroll.accounting.view');
const manage = requirePayrollAccess('payroll.accounting.manage');
const post = requirePayrollAccess('payroll.accounting.post');
const exportFile = requirePayrollAccess('payroll.accounting.export');
const settingsWrite = requirePayrollAccess('payroll.accounting.settings');
/** reading the configuration (to understand / export journals) */
const settingsRead = requirePayrollAccessAny([
	'payroll.accounting.settings',
	'payroll.accounting.view',
	'payroll.accounting.manage',
	'payroll.accounting.export'
]);
const idParams = validateParams(idParamSchema);
const noBody = validateBody(emptyBodySchema);

// ---------- settings: source catalog + GL accounts ----------
accountingRouter.get(
	'/payroll/accounting/source-types',
	requireAuth,
	settingsRead,
	controller.sourceTypes
);
accountingRouter.get(
	'/payroll/accounting/gl-accounts',
	requireAuth,
	settingsRead,
	validateQuery(glAccountListQuerySchema),
	controller.listAccounts
);
accountingRouter.post(
	'/payroll/accounting/gl-accounts',
	requireAuth,
	settingsWrite,
	validateBody(glAccountCreateSchema),
	controller.createAccount
);
accountingRouter.patch(
	'/payroll/accounting/gl-accounts/:id',
	requireAuth,
	settingsWrite,
	idParams,
	validateBody(glAccountUpdateSchema),
	controller.updateAccount
);

// ---------- settings: rule sets + mappings ----------
accountingRouter.get(
	'/payroll/accounting/rule-sets',
	requireAuth,
	settingsRead,
	validateQuery(ruleSetListQuerySchema),
	controller.listRuleSets
);
accountingRouter.get(
	'/payroll/accounting/rule-sets/:id',
	requireAuth,
	settingsRead,
	idParams,
	controller.getRuleSet
);
accountingRouter.post(
	'/payroll/accounting/rule-sets',
	requireAuth,
	settingsWrite,
	validateBody(ruleSetCreateSchema),
	controller.createRuleSet
);
accountingRouter.patch(
	'/payroll/accounting/rule-sets/:id',
	requireAuth,
	settingsWrite,
	idParams,
	validateBody(ruleSetUpdateSchema),
	controller.updateRuleSet
);
accountingRouter.post(
	'/payroll/accounting/rule-sets/:id/activate',
	requireAuth,
	settingsWrite,
	idParams,
	noBody,
	controller.activateRuleSet
);
accountingRouter.post(
	'/payroll/accounting/rule-sets/:id/deactivate',
	requireAuth,
	settingsWrite,
	idParams,
	noBody,
	controller.deactivateRuleSet
);
accountingRouter.put(
	'/payroll/accounting/rule-sets/:id/mappings',
	requireAuth,
	settingsWrite,
	idParams,
	validateBody(mappingUpsertSchema),
	controller.upsertMapping
);

// ---------- settings: accounting export profiles ----------
accountingRouter.get(
	'/payroll/accounting/export-fields',
	requireAuth,
	settingsRead,
	controller.exportFields
);
accountingRouter.get(
	'/payroll/accounting/export-profiles',
	requireAuth,
	settingsRead,
	validateQuery(accountingExportProfileListQuerySchema),
	controller.listExportProfiles
);
accountingRouter.get(
	'/payroll/accounting/export-profiles/:id',
	requireAuth,
	settingsRead,
	idParams,
	controller.getExportProfile
);
accountingRouter.post(
	'/payroll/accounting/export-profiles',
	requireAuth,
	settingsWrite,
	validateBody(accountingExportProfileCreateSchema),
	controller.createExportProfile
);
accountingRouter.put(
	'/payroll/accounting/export-profiles/:id',
	requireAuth,
	settingsWrite,
	idParams,
	validateBody(accountingExportProfileUpdateSchema),
	controller.updateExportProfile
);

// ---------- journal creation from payroll / payment sources ----------
accountingRouter.get(
	'/payroll/runs/:id/accounting-journal',
	requireAuth,
	view,
	idParams,
	controller.runAccounting
);
accountingRouter.post(
	'/payroll/runs/:id/accounting-journal',
	requireAuth,
	manage,
	idParams,
	noBody,
	controller.createAccrual
);
accountingRouter.get(
	'/payroll/payment-batches/:id/accounting-status',
	requireAuth,
	view,
	idParams,
	controller.batchStatus
);
accountingRouter.post(
	'/payroll/payment-batches/:id/accounting-journal',
	requireAuth,
	manage,
	idParams,
	noBody,
	controller.createSettlement
);
accountingRouter.post(
	'/payroll/payment-reversals/:id/accounting-journal',
	requireAuth,
	manage,
	idParams,
	noBody,
	controller.createReversal
);

// ---------- journals ----------
accountingRouter.get(
	'/payroll/accounting/journals',
	requireAuth,
	view,
	validateQuery(journalListQuerySchema),
	controller.listJournals
);
accountingRouter.get(
	'/payroll/accounting/journals/:id',
	requireAuth,
	view,
	idParams,
	controller.getJournal
);
accountingRouter.post(
	'/payroll/accounting/journals/:id/validate',
	requireAuth,
	manage,
	idParams,
	noBody,
	controller.validateJournal
);
accountingRouter.post(
	'/payroll/accounting/journals/:id/post',
	requireAuth,
	post,
	idParams,
	noBody,
	controller.postJournal
);
accountingRouter.post(
	'/payroll/accounting/journals/:id/cancel',
	requireAuth,
	manage,
	idParams,
	noBody,
	controller.cancelJournal
);
accountingRouter.post(
	'/payroll/accounting/journals/:id/export',
	requireAuth,
	exportFile,
	idParams,
	validateBody(journalExportSchema),
	controller.exportJournal
);
