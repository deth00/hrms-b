import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import * as payslipService from '../services/payslip.service.js';
import { renderPayslipPdf } from '../services/payslipPdf.js';

const userIdOf = (req: Request) => {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth.user.id;
};
/** PDF bytes rendered from the stored snapshot only; safe ASCII filename, never cached by proxies. */
async function sendPdf(
	res: Response,
	payslip: Awaited<ReturnType<typeof payslipService.getPayslip>>
) {
	const pdf = await renderPayslipPdf(payslip.snapshot);
	res.setHeader('Content-Type', 'application/pdf');
	res.setHeader(
		'Content-Disposition',
		`attachment; filename="${payslipService.payslipFileName(payslip.payslipNumber)}"`
	);
	res.setHeader('Cache-Control', 'private, no-store');
	res.setHeader('Content-Length', String(pdf.length));
	res.end(pdf);
}

// ---------- self (payslip.view_self): the employee comes from the SESSION, never from the client ----------
export async function listMine(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await payslipService.listMyPayslips(userIdOf(req)));
}
export async function getMine(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await payslipService.getMyPayslip(userIdOf(req), idParam(req)));
}
export async function getMinePdf(req: Request, res: Response): Promise<void> {
	await sendPdf(res, await payslipService.getMyPayslip(userIdOf(req), idParam(req)));
}

// ---------- admin (payroll.view + employees.view_all) ----------
export async function getOne(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await payslipService.getPayslip(idParam(req)));
}
export async function getOnePdf(req: Request, res: Response): Promise<void> {
	await sendPdf(res, await payslipService.getPayslip(idParam(req)));
}
