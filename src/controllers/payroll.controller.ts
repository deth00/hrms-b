import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import * as settingsService from '../services/payrollSettings.service.js';
import * as componentService from '../services/payComponent.service.js';
import * as compensationService from '../services/compensation.service.js';
import * as periodService from '../services/payrollPeriod.service.js';
import * as runService from '../services/payrollRun.service.js';
import * as scheduleService from '../services/payrollSchedule.service.js';
import * as rulesService from '../services/payrollRules.service.js';
import * as statutoryRuleService from '../services/payrollStatutoryRule.service.js';
import * as statutoryProfileService from '../services/employeeStatutoryProfile.service.js';
import * as approvalService from '../services/payrollApproval.service.js';
import * as payslipService from '../services/payslip.service.js';

const userIdOf = (req: Request) => {
	if (!req.auth) throw Errors.unauthenticated();
	return req.auth.user.id;
};
// ---------- settings ----------
export async function getSettings(req: Request, res: Response): Promise<void> {
	const { companyId } = req.query as unknown as { companyId: number };
	sendSuccess(res, await settingsService.getPayrollSettings(companyId));
}
export async function updateSettings(req: Request, res: Response): Promise<void> {
	const { companyId } = req.query as unknown as { companyId: number };
	sendSuccess(res, await settingsService.updatePayrollSettings(companyId, req.body));
}

// ---------- pay components ----------
export async function listComponents(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await componentService.listPayComponents(req.query as never));
}
export async function getComponent(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await componentService.getPayComponent(idParam(req)));
}
export async function createComponent(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await componentService.createPayComponent(req.body), 201);
}
export async function updateComponent(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await componentService.updatePayComponent(idParam(req), req.body));
}

// ---------- compensation ----------
export async function getCompensation(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await compensationService.getEmployeeCompensation(idParam(req)));
}
export async function compensationHistory(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await compensationService.listCompensationHistory(idParam(req)));
}
export async function createCompensation(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await compensationService.createCompensation(idParam(req), req.body, userIdOf(req)),
		201
	);
}
export async function listRecurring(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await compensationService.listRecurringPayComponents(idParam(req)));
}
export async function assignRecurring(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await compensationService.assignRecurringPayComponent(idParam(req), req.body, userIdOf(req)),
		201
	);
}
export async function endRecurring(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await compensationService.endRecurringPayComponent(idParam(req), req.body, userIdOf(req))
	);
}

// ---------- periods ----------
export async function listPeriods(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await periodService.listPeriods(req.query as never));
}
export async function getPeriod(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await periodService.getPeriod(idParam(req)));
}
export async function createPeriod(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await periodService.createPeriod(req.body, userIdOf(req)), 201);
}
export async function updatePeriod(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await periodService.updatePeriod(idParam(req), req.body));
}

// ---------- runs ----------
export async function listRuns(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await runService.listRuns(req.query as never));
}
export async function getRun(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await runService.getRun(idParam(req)));
}
export async function createRun(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await runService.createRun(req.body, userIdOf(req)), 201);
}
export async function calculateRun(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await runService.calculateRun(idParam(req), userIdOf(req)));
}
export async function finalizeRun(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await runService.finalizeRun(idParam(req), req.body, userIdOf(req)));
}
// ---------- Phase 13: approval ----------
export async function getRunApproval(req: Request, res: Response): Promise<void> {
	if (!req.auth) throw Errors.unauthenticated();
	sendSuccess(res, await approvalService.getRunApproval(idParam(req), req.auth));
}
export async function submitApproval(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await approvalService.submitForApproval(idParam(req), userIdOf(req)));
}
export async function cancelApproval(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await approvalService.cancelSubmission(idParam(req), userIdOf(req)));
}
export async function reopenRun(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await approvalService.reopenRun(idParam(req), userIdOf(req)));
}

// ---------- Phase 13: payslips of a run ----------
export async function listRunPayslips(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await payslipService.listRunPayslips(idParam(req)));
}
export async function generatePayslips(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await payslipService.generatePayslipsForRun(idParam(req), userIdOf(req)));
}

export async function listResults(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await runService.listResults(idParam(req), req.query as never));
}
export async function getResult(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await runService.getResult(idParam(req)));
}

type RunEmployeeReq = Request;
export async function listAdjustments(req: RunEmployeeReq, res: Response): Promise<void> {
	sendSuccess(
		res,
		await runService.listAdjustments(idParam(req, 'runId'), idParam(req, 'employeeId'))
	);
}
export async function addAdjustment(req: RunEmployeeReq, res: Response): Promise<void> {
	sendSuccess(
		res,
		await runService.addAdjustment(
			idParam(req, 'runId'),
			idParam(req, 'employeeId'),
			req.body,
			userIdOf(req)
		),
		201
	);
}

// ---------- schedules ----------
export async function listSchedules(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await scheduleService.listSchedules(req.query as never));
}
export async function getSchedule(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await scheduleService.getSchedule(idParam(req)));
}
export async function createSchedule(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await scheduleService.createSchedule(req.body, userIdOf(req)), 201);
}
export async function updateSchedule(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await scheduleService.updateSchedule(idParam(req), req.body, userIdOf(req)));
}
export async function previewSchedulePeriods(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await scheduleService.previewPeriods(idParam(req), req.body));
}
export async function generateSchedulePeriods(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await scheduleService.generatePeriods(idParam(req), req.body, userIdOf(req)));
}

// ---------- payroll rules ----------
export async function listRules(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await rulesService.listRules(req.query as never));
}
export async function getRule(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await rulesService.getRule(idParam(req)));
}
export async function createRule(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await rulesService.createRule(req.body, userIdOf(req)), 201);
}

// ---------- statutory rules (Phase 12B) ----------
export async function listStatutoryRules(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await statutoryRuleService.listStatutoryRules(req.query as never));
}
export async function statutoryReferenceTemplate(_req: Request, res: Response): Promise<void> {
	sendSuccess(res, statutoryRuleService.currentLaoReferenceTemplate());
}
export async function getStatutoryRule(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await statutoryRuleService.getStatutoryRule(idParam(req)));
}
export async function createStatutoryRule(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await statutoryRuleService.createStatutoryRule(req.body, userIdOf(req)), 201);
}
export async function activateStatutoryRule(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await statutoryRuleService.activateStatutoryRule(idParam(req), userIdOf(req)));
}

// ---------- employee statutory profile (Phase 12B) ----------
export async function getStatutoryProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await statutoryProfileService.getStatutoryProfile(idParam(req)));
}
export async function updateStatutoryProfile(req: Request, res: Response): Promise<void> {
	sendSuccess(
		res,
		await statutoryProfileService.updateStatutoryProfile(idParam(req), req.body, userIdOf(req))
	);
}
