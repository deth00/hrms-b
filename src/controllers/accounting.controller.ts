import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import * as settings from '../services/accountingSettings.service.js';
import * as journals from '../services/payrollAccounting.service.js';

/** Phase 16 — payroll accounting: settings, journals (accrual / settlement / reversal), export. */
const userIdOf = (req: Request) => {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth.user.id;
};
// ---------- settings ----------
export async function sourceTypes(_req: Request, res: Response): Promise<void> {
	sendSuccess(res, settings.sourceCatalog());
}
export async function listAccounts(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.listAccounts(req.query as never));
}
export async function createAccount(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.createAccount(req.body, userIdOf(req)), 201);
}
export async function updateAccount(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.updateAccount(idParam(req), req.body, userIdOf(req)));
}
export async function listRuleSets(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.listRuleSets(req.query as never));
}
export async function getRuleSet(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.getRuleSet(idParam(req)));
}
export async function createRuleSet(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.createRuleSet(req.body, userIdOf(req)), 201);
}
export async function updateRuleSet(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.updateRuleSet(idParam(req), req.body, userIdOf(req)));
}
export async function activateRuleSet(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.activateRuleSet(idParam(req), userIdOf(req)));
}
export async function deactivateRuleSet(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.deactivateRuleSet(idParam(req), userIdOf(req)));
}
export async function upsertMapping(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.upsertMapping(idParam(req), req.body, userIdOf(req)));
}
export async function exportFields(_req: Request, res: Response): Promise<void> {
	sendSuccess(res, settings.exportFieldCatalog());
}
export async function listExportProfiles(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.listExportProfiles(req.query as never));
}
export async function getExportProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.getExportProfile(idParam(req)));
}
export async function createExportProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.createExportProfile(req.body, userIdOf(req)), 201);
}
export async function updateExportProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await settings.updateExportProfile(idParam(req), req.body, userIdOf(req)));
}

// ---------- journals ----------
export async function runAccounting(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await journals.runAccounting(idParam(req)));
}
export async function createAccrual(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await journals.createAccrualJournal(idParam(req), userIdOf(req)), 201);
}
export async function batchStatus(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await journals.batchAccountingStatus(idParam(req)));
}
export async function createSettlement(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await journals.createSettlementJournal(idParam(req), userIdOf(req)), 201);
}
export async function createReversal(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await journals.createReversalJournal(idParam(req), userIdOf(req)), 201);
}
export async function listJournals(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await journals.listJournals(req.query as never));
}
export async function getJournal(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await journals.getJournal(idParam(req)));
}
export async function validateJournal(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await journals.validateJournal(idParam(req), userIdOf(req)));
}
export async function postJournal(req: Request, res: Response): Promise<void> {
	const out = await journals.postJournal(idParam(req), userIdOf(req));
	sendSuccess(res, { ...out.journal, alreadyPosted: out.alreadyPosted });
}
export async function cancelJournal(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await journals.cancelJournal(idParam(req), userIdOf(req)));
}
export async function exportJournal(req: Request, res: Response): Promise<void> {
	const file = await journals.exportJournal(
		idParam(req),
		req.body.accountingExportProfileId,
		userIdOf(req)
	);
	res.setHeader('Content-Type', file.contentType);
	res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
	res.setHeader('Cache-Control', 'private, no-store');
	res.setHeader('X-Export-Hash', file.hash);
	res.setHeader('X-Export-Id', file.exportId);
	res.setHeader('Content-Length', String(file.bytes.length));
	res.status(200).end(file.bytes);
}
