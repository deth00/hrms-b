import type { NextFunction, Request, Response } from 'express';
import { Errors } from '../utils/AppError.js';
import { canViewReport, type ReportDomain } from '../services/reporting/reportingScope.service.js';
import { REPORT_DEFINITIONS } from '../services/reporting/reportDefinitions.js';
import { REPORT_TYPES, type ReportTypeKey } from '../validation/reporting.schema.js';

export const EXPORT_PERMISSION = 'reports.export';

/** Phase 17A — reports.view + the report's domain permission(s) (403 FORBIDDEN otherwise). */
export function requireReport(domain: ReportDomain) {
	return (req: Request, _res: Response, next: NextFunction): void => {
		if (!req.auth) {
			next(Errors.unauthenticated());
			return;
		}
		if (!canViewReport(req.auth.permissions, domain)) {
			next(Errors.forbidden());
			return;
		}
		next();
	};
}

/**
 * Phase 17B — `/reports/:reportType/...` routes: unknown type → 404; otherwise reports.view + the
 * report's domain permission(s), and for exports ALSO reports.export (which never grants data alone).
 */
export function requireReportParam(o: { export?: boolean } = {}) {
	return (req: Request, _res: Response, next: NextFunction): void => {
		if (!req.auth) {
			next(Errors.unauthenticated());
			return;
		}
		const type = String(req.params.reportType ?? '');
		if (!(REPORT_TYPES as readonly string[]).includes(type)) {
			next(Errors.notFound('ບໍ່ພົບປະເພດລາຍງານ'));
			return;
		}
		const def = REPORT_DEFINITIONS[type as ReportTypeKey];
		if (
			!canViewReport(req.auth.permissions, def.domain) ||
			(o.export && !req.auth.permissions.includes(EXPORT_PERMISSION))
		) {
			next(Errors.forbidden());
			return;
		}
		next();
	};
}
