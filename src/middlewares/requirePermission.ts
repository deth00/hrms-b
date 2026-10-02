import type { NextFunction, Request, Response } from 'express';
import { Errors } from '../utils/AppError.js';

export function requirePermission(code: string) {
	return (req: Request, _res: Response, next: NextFunction): void => {
		if (!req.auth) {
			next(Errors.unauthenticated());
			return;
		}
		if (!req.auth.permissions.includes(code)) {
			next(Errors.forbidden());
			return;
		}
		next();
	};
}

/**
 * Payroll / compensation gate. Salary is more sensitive than ordinary employee data, so on top of the
 * dedicated payroll permission the caller MUST hold the company-wide employee scope
 * (`employees.view_all`). There is deliberately NO fallback to the manager-tree scope: a manager who
 * can see their team's employee records never gains salary access through it.
 */
export function requirePayrollAccess(code: string) {
	return (req: Request, _res: Response, next: NextFunction): void => {
		if (!req.auth) {
			next(Errors.unauthenticated());
			return;
		}
		const held = req.auth.permissions;
		if (!held.includes(code) || !held.includes('employees.view_all')) {
			next(Errors.forbidden());
			return;
		}
		next();
	};
}

/**
 * Phase 13 — like requirePayrollAccess, but ANY of the codes will do (always + employees.view_all).
 * Used where a payroll APPROVER (payroll.approve) must be able to read the run they are approving.
 */
export function requirePayrollAccessAny(codes: string[]) {
	return (req: Request, _res: Response, next: NextFunction): void => {
		if (!req.auth) {
			next(Errors.unauthenticated());
			return;
		}
		const held = req.auth.permissions;
		if (!codes.some((c) => held.includes(c)) || !held.includes('employees.view_all')) {
			next(Errors.forbidden());
			return;
		}
		next();
	};
}
