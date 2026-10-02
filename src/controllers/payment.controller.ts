import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import * as employeePaymentService from '../services/employeePayment.service.js';
import * as paymentService from '../services/payrollPayment.service.js';
import * as exportService from '../services/bankExport.service.js';

const userIdOf = (req: Request) => {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth.user.id;
};
/** payment users see amounts only when they also hold payroll.view (payroll money permission) */
const canSeeAmounts = (req: Request) => !!req.auth?.permissions.includes('payroll.view');

type AccountReq = Request;
type ItemReq = Request;

// ---------- employee payment profile / bank accounts (employee_bank.* + employees.view_all) ----------
export async function getPaymentProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await employeePaymentService.getPaymentProfile(idParam(req)));
}
export async function updatePaymentProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await employeePaymentService.updatePaymentProfile(idParam(req), req.body, userIdOf(req))
	);
}
export async function createBankAccount(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await employeePaymentService.createBankAccount(idParam(req), req.body, userIdOf(req)),
		201
	);
}
export async function updateBankAccount(req: AccountReq, res: Response): Promise<void> {
	sendSuccess(
		res,
		await employeePaymentService.updateBankAccount(
			idParam(req),
			idParam(req, 'accountId'),
			req.body,
			userIdOf(req)
		)
	);
}
export async function activateBankAccount(req: AccountReq, res: Response): Promise<void> {
	sendSuccess(
		res,
		await employeePaymentService.activateBankAccount(
			idParam(req),
			idParam(req, 'accountId'),
			userIdOf(req)
		)
	);
}
export async function deactivateBankAccount(req: AccountReq, res: Response): Promise<void> {
	sendSuccess(
		res,
		await employeePaymentService.deactivateBankAccount(
			idParam(req),
			idParam(req, 'accountId'),
			userIdOf(req)
		)
	);
}

// ---------- payment batches ----------
export async function getRunBatch(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await paymentService.getRunBatch(idParam(req)));
}
export async function createBatch(req: Request, res: Response): Promise<void> {
	const id = await paymentService.createBatch(idParam(req), req.body, userIdOf(req));
	sendSuccess(res, await paymentService.getBatch(id, canSeeAmounts(req)), 201);
}
export async function listBatches(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await paymentService.listBatches(req.query as never, canSeeAmounts(req)));
}
export async function getBatch(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await paymentService.getBatch(idParam(req), canSeeAmounts(req)));
}
export async function validateBatch(req: Request, res: Response): Promise<void> {
	const outcome = await paymentService.validateBatch(idParam(req), userIdOf(req));
	sendSuccess(res, {
		...outcome,
		batch: await paymentService.getBatch(idParam(req), canSeeAmounts(req))
	});
}
export async function rebuildBatch(req: Request, res: Response): Promise<void> {
	await paymentService.rebuildBatch(idParam(req), userIdOf(req));
	sendSuccess(res, await paymentService.getBatch(idParam(req), canSeeAmounts(req)));
}
export async function cancelBatch(req: Request, res: Response): Promise<void> {
	await paymentService.cancelBatch(idParam(req), userIdOf(req));
	sendSuccess(res, await paymentService.getBatch(idParam(req), canSeeAmounts(req)));
}
export async function confirmItem(req: ItemReq, res: Response): Promise<void> {
	await paymentService.confirmItem(idParam(req), idParam(req, 'itemId'), req.body, userIdOf(req));
	sendSuccess(res, await paymentService.getBatch(idParam(req), canSeeAmounts(req)));
}

// ---------- export (payroll.payment.export + employees.view_all) ----------
export async function exportPreview(req: Request, res: Response): Promise<void> {
	const { bankExportProfileId } = req.query as unknown as { bankExportProfileId: number };
	sendSuccess(res, await exportService.exportPreview(idParam(req), bankExportProfileId));
}
/** The bank file itself: attachment, never cached; the SHA-256 travels in X-Export-Hash. */
export async function exportFile(req: Request, res: Response): Promise<void> {
	const file = await exportService.exportBatch(
		idParam(req),
		req.body.bankExportProfileId,
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

// ---------- bank export profiles ----------
export async function exportFields(_req: Request, res: Response): Promise<void> {
	sendSuccess(res, exportService.exportFieldCatalog());
}
export async function listProfiles(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await exportService.listProfiles(req.query as never));
}
export async function getProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await exportService.getProfile(idParam(req)));
}
export async function createProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await exportService.createProfile(req.body, userIdOf(req)), 201);
}
export async function updateProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await exportService.updateProfile(idParam(req), req.body, userIdOf(req)));
}

// ---------- self (payroll_payment.view_self): employee from the SESSION, never from the client ----------
export async function listMyPayments(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await paymentService.listMyPayments(userIdOf(req)));
}
