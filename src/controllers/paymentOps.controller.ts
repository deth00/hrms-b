import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import * as paymentService from '../services/payrollPayment.service.js';
import * as lifecycle from '../services/paymentLifecycle.service.js';
import * as recon from '../services/paymentReconciliation.service.js';

/** Phase 15 — bank reconciliation, payment reversal, retry / reissue, payment lineage. */
const userIdOf = (req: Request) => {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth.user.id;
};
/** amounts only with payroll.view (the payroll money permission), as in Phase 14 */
const canSeeAmounts = (req: Request) => !!req.auth?.permissions.includes('payroll.view');

type ItemReq = Request;
type RowReq = Request;

// ---------- reconciliation profiles ----------
export async function reconFields(_req: Request, res: Response): Promise<void> {
	sendSuccess(res, recon.reconFieldCatalog());
}
export async function listReconProfiles(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await recon.listProfiles(req.query as never));
}
export async function getReconProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await recon.getProfile(idParam(req)));
}
export async function createReconProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await recon.createProfile(req.body, userIdOf(req)), 201);
}
export async function updateReconProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await recon.updateProfile(idParam(req), req.body, userIdOf(req)));
}

// ---------- reconciliation imports ----------
export async function importReconciliation(req: Request, res: Response): Promise<void> {
	const file = req.file;
	if (!file) throw Errors.badRequest('FILE_REQUIRED', 'ກະລຸນາເລືອກໄຟລ໌ຜົນການຈ່າຍຈາກທະນາຄານ');
	const out = await recon.importFile(
		idParam(req),
		req.body.reconciliationProfileId,
		new recon.UploadedFile(file.originalname, file.buffer),
		userIdOf(req)
	);
	sendSuccess(
		res,
		{ duplicate: out.duplicate, import: await recon.getImport(out.importId, canSeeAmounts(req)) },
		out.duplicate ? 200 : 201
	);
}
export async function listBatchReconciliations(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await recon.listBatchImports(idParam(req)));
}
export async function getReconciliation(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await recon.getImport(idParam(req), canSeeAmounts(req)));
}
export async function matchReconRow(req: RowReq, res: Response): Promise<void> {
	await recon.matchRow(idParam(req), idParam(req, 'rowId'), req.body.paymentItemId, userIdOf(req));
	sendSuccess(res, await recon.getImport(idParam(req), canSeeAmounts(req)));
}
export async function ignoreReconRow(req: RowReq, res: Response): Promise<void> {
	await recon.ignoreRow(idParam(req), idParam(req, 'rowId'), req.body.reason, userIdOf(req));
	sendSuccess(res, await recon.getImport(idParam(req), canSeeAmounts(req)));
}
export async function applyReconciliation(req: Request, res: Response): Promise<void> {
	const outcome = await recon.applyImport(idParam(req), userIdOf(req));
	sendSuccess(res, {
		...outcome,
		import: await recon.getImport(idParam(req), canSeeAmounts(req))
	});
}
export async function cancelReconciliation(req: Request, res: Response): Promise<void> {
	await recon.cancelImport(idParam(req), userIdOf(req));
	sendSuccess(res, await recon.getImport(idParam(req), canSeeAmounts(req)));
}

// ---------- reversal / retry / lineage ----------
export async function reverseItem(req: ItemReq, res: Response): Promise<void> {
	await lifecycle.reverseItem(idParam(req), idParam(req, 'itemId'), req.body, userIdOf(req));
	sendSuccess(res, await paymentService.getBatch(idParam(req), canSeeAmounts(req)));
}
export async function retryBatch(req: Request, res: Response): Promise<void> {
	const id = await lifecycle.createRetryBatch(idParam(req), req.body, userIdOf(req));
	sendSuccess(res, await paymentService.getBatch(id, canSeeAmounts(req)), 201);
}
export async function itemLineage(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await lifecycle.getItemLineage(idParam(req), canSeeAmounts(req)));
}
