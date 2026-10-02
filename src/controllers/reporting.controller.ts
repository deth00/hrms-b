import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import { getDashboardSummary } from '../services/reporting/dashboardReporting.service.js';
import { reportFilterOptions } from '../services/reporting/reportingScope.service.js';
import { getEmployeeSummary } from '../services/reporting/employeeReporting.service.js';
import { getAttendanceSummary } from '../services/reporting/attendanceReporting.service.js';
import { getLeaveSummary } from '../services/reporting/leaveReporting.service.js';
import { getOvertimeSummary } from '../services/reporting/overtimeReporting.service.js';
import { getPayrollSummary } from '../services/reporting/payrollReporting.service.js';
import { getPaymentSummary } from '../services/reporting/paymentReporting.service.js';
import { getAccountingSummary } from '../services/reporting/accountingReporting.service.js';
import { definitionOf, presentCatalog } from '../services/reporting/reportDefinitions.js';
import { getReportDetail } from '../services/reporting/reportDetail.service.js';
import { exportReport } from '../services/reporting/reportExport.service.js';
import {
	createSavedFilter,
	deleteSavedFilter,
	getSavedFilter,
	listSavedFilters,
	updateSavedFilter
} from '../services/reporting/savedReportFilter.service.js';

function authOf(req: Request) {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth;
}

export async function dashboard(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await getDashboardSummary(authOf(req), req.query as never));
}
export async function filterOptions(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await reportFilterOptions(authOf(req)));
}
export async function employees(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await getEmployeeSummary(authOf(req), req.query as never));
}
export async function attendance(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await getAttendanceSummary(authOf(req), req.query as never));
}
export async function leave(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await getLeaveSummary(authOf(req), req.query as never));
}
export async function overtime(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await getOvertimeSummary(authOf(req), req.query as never));
}
export async function payroll(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await getPayrollSummary(authOf(req), req.query as never));
}
export async function payments(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await getPaymentSummary(authOf(req), req.query as never));
}
export async function accounting(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await getAccountingSummary(authOf(req), req.query as never));
}

// ---------- Phase 17B: detail, catalogue, export, saved filters ----------

type TypeReq = Request;
export async function fields(req: TypeReq, res: Response): Promise<void> {
	sendSuccess(res, presentCatalog(definitionOf(String(req.params.reportType))));
}
export async function detail(req: TypeReq, res: Response): Promise<void> {
	sendSuccess(
		res,
		await getReportDetail(
			authOf(req),
			definitionOf(String(req.params.reportType)),
			req.query as never
		)
	);
}
export async function exportFile(req: TypeReq, res: Response): Promise<void> {
	const file = await exportReport(
		authOf(req),
		definitionOf(String(req.params.reportType)),
		req.body
	);
	res.setHeader('Content-Type', file.contentType);
	res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
	res.setHeader('Cache-Control', 'private, no-store');
	res.setHeader('X-Report-Rows', String(file.rowCount));
	res.setHeader('X-Report-Hash', file.fileHash);
	res.setHeader('Content-Length', String(file.bytes.length));
	res.status(200).end(file.bytes);
}
export async function listSaved(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await listSavedFilters(authOf(req), (req.query as { reportType: never }).reportType)
	);
}
export async function getSaved(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await getSavedFilter(authOf(req), idParam(req)));
}
export async function createSaved(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await createSavedFilter(authOf(req), req.body), 201);
}
export async function updateSaved(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await updateSavedFilter(authOf(req), idParam(req), req.body));
}
export async function deleteSaved(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await deleteSavedFilter(authOf(req), idParam(req)));
}
