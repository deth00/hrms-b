import { createHash } from 'node:crypto';
import { prisma } from '../../config/prisma.js';
import { Errors } from '../../utils/AppError.js';
import type { AuthContext } from '../../types/express.js';
import type { ExportBody, ExportFormat } from '../../validation/reporting.schema.js';
import { AuditAction, AuditEntity, writeAuditEvent } from '../audit.service.js';
import type { ReportDefinition } from './reportDefinitions.js';
import {
	loadSortedRows,
	parseFilters,
	resolveColumns,
	resolveSort
} from './reportDetail.service.js';
import { buildReportCsv } from './reportCsv.service.js';
import { buildReportXlsx } from './reportXlsx.service.js';
import { PDF_MAX_COLUMNS, renderReportPdf } from './reportPdf.service.js';
import { reportToday } from './reportingCommon.js';

/**
 * Phase 17B — the ONE export pipeline. It is the detail pipeline plus a file writer:
 *   the SAME filter schema → the SAME report loader (permission, data scope, company isolation, range /
 *   employee-day guards inside) → the SAME whitelisted sort → validated catalogue columns → CSV / XLSX /
 *   PDF. There is no second authorization path: the route adds `reports.export` on top of the report's
 *   own `reports.view` + domain permission guard.
 *
 * Every matching authorized row is exported (not the UI page); above the format limit the export is
 * refused (REPORT_EXPORT_TOO_LARGE) — never silently truncated. Exports are POINT-IN-TIME artefacts of a
 * live report (a later export may differ if the source changed); the file is not stored. The response
 * carries X-Report-Rows / X-Report-Hash (SHA-256) and a REPORT.EXPORTED audit event records ids, counts,
 * column keys and hashes only — never amounts, names or row data.
 */
export const EXPORT_MAX_ROWS: Record<ExportFormat, number> = {
	CSV: 25_000,
	XLSX: 25_000,
	PDF: 5_000
};

const CONTENT_TYPE: Record<ExportFormat, string> = {
	CSV: 'text/csv; charset=utf-8',
	XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	PDF: 'application/pdf'
};
const EXT: Record<ExportFormat, string> = { CSV: 'csv', XLSX: 'xlsx', PDF: 'pdf' };
const SHEET: Record<string, string> = {
	employees: 'Employees',
	attendance: 'Attendance',
	leave: 'Leave',
	overtime: 'Overtime',
	payroll: 'Payroll',
	payments: 'Payments',
	accounting: 'Accounting'
};

export const ExportErrors = {
	tooLarge: (format: ExportFormat, estimatedRows: number) =>
		Errors.badRequest(
			'REPORT_EXPORT_TOO_LARGE',
			`ລາຍງານມີ ${estimatedRows} ແຖວ ເກີນຂີດຈຳກັດ ${EXPORT_MAX_ROWS[format]} ແຖວ ສຳລັບ ${format} — ກະລຸນາກັ່ນຕອງວັນທີ, ບໍລິສັດ ຫຼື ສາຂາໃຫ້ແຄບລົງ`,
			{ format, estimatedRows, maxRows: EXPORT_MAX_ROWS[format] }
		),
	pdfColumns: (selected: number) =>
		Errors.badRequest(
			'REPORT_PDF_TOO_MANY_COLUMNS',
			`PDF ເລືອກໄດ້ສູງສຸດ ${PDF_MAX_COLUMNS} ຄໍລຳ (ເລືອກ ${selected})`,
			{ maxColumns: PDF_MAX_COLUMNS, selected }
		)
};

const compact = (iso: unknown) => (typeof iso === 'string' ? iso.replace(/-/g, '') : null);

/** Safe ASCII file name built from report type + dates only (no user-controlled segment). */
export function exportFileName(
	def: ReportDefinition,
	context: Record<string, unknown>,
	format: ExportFormat
) {
	let suffix: string;
	if (def.type === 'payroll' || def.type === 'payments') {
		suffix = typeof context.payrollMonth === 'string' ? context.payrollMonth : 'NONE';
	} else if (compact(context.from) && compact(context.to)) {
		suffix = `${compact(context.from)}-${compact(context.to)}`;
	} else {
		suffix = compact(reportToday().toISOString().slice(0, 10))!;
	}
	const safe = `REPORT-${def.type.toUpperCase()}-${suffix}`.replace(/[^A-Za-z0-9-]/g, '');
	return `${safe}.${EXT[format]}`;
}

/** Human filter summary for the PDF header (names are looked up for ids that were already validated). */
async function filterLines(def: ReportDefinition, context: Record<string, unknown>) {
	const id = (k: string) => (typeof context[k] === 'number' ? context[k] : undefined);
	const [company, branch, department, employee] = await Promise.all([
		id('companyId')
			? prisma.company.findUnique({ where: { id: id('companyId') }, select: { nameLao: true } })
			: null,
		id('branchId')
			? prisma.branch.findUnique({ where: { id: id('branchId') }, select: { nameLao: true } })
			: null,
		id('departmentId')
			? prisma.department.findUnique({
					where: { id: id('departmentId') },
					select: { nameLao: true }
				})
			: null,
		id('employeeId')
			? prisma.employee.findUnique({
					where: { id: id('employeeId') },
					select: { employeeCode: true }
				})
			: null
	]);
	const dmy = (v: unknown) =>
		typeof v === 'string' ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : null;
	const parts: string[] = [];
	if (context.from || context.to)
		parts.push(`ຊ່ວງວັນທີ: ${dmy(context.from) ?? '…'} – ${dmy(context.to) ?? '…'}`);
	if (context.asOf) parts.push(`ວັນທີ: ${dmy(context.asOf)}`);
	if (typeof context.payrollMonth === 'string')
		parts.push(`ເດືອນເງິນເດືອນ: ${context.payrollMonth}`);
	parts.push(`ບໍລິສັດ: ${company?.nameLao ?? 'ທຸກບໍລິສັດ'}`);
	if (branch) parts.push(`ສາຂາ: ${branch.nameLao}`);
	if (department) parts.push(`ພະແນກ: ${department.nameLao}`);
	if (employee) parts.push(`ພະນັກງານ: ${employee.employeeCode}`);
	const status = typeof context.status === 'string' ? context.status : null;
	if (status) {
		parts.push(`ສະຖານະ: ${def.statusOptions.find((o) => o.value === status)?.label ?? status}`);
	}
	if (context.scope === 'TEAM') parts.push('ຂອບເຂດ: ທີມຂອງຜູ້ສົ່ງອອກ');
	return [parts.join(' · ')];
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** POST /reports/:type/export */
export async function exportReport(auth: AuthContext, def: ReportDefinition, body: ExportBody) {
	const filters = parseFilters(def, body.filters);
	const sort = resolveSort(def, body.sortBy, body.sortDir);
	const columns = resolveColumns(def, body.columns, { forExport: true });
	if (body.format === 'PDF' && columns.length > PDF_MAX_COLUMNS) {
		throw ExportErrors.pdfColumns(columns.length);
	}
	const max = EXPORT_MAX_ROWS[body.format];
	const guard = (n: number) => {
		if (n > max) throw ExportErrors.tooLarge(body.format, n);
	};
	const { context, rows } = await loadSortedRows(auth, def, filters, sort, guard);
	guard(rows.length);

	const generatedAt = new Date();
	const bytes =
		body.format === 'CSV'
			? buildReportCsv(columns, rows)
			: body.format === 'XLSX'
				? buildReportXlsx(columns, rows, SHEET[def.type] ?? 'Report')
				: await renderReportPdf({
						title: def.title,
						sensitive: def.sensitive,
						generatedAt,
						filterLines: await filterLines(def, context),
						columns,
						rows,
						totals: def.totals
					});
	const fileHash = sha256(bytes);
	const fileName = exportFileName(def, context, body.format);
	const normalizedFilterHash = sha256(
		JSON.stringify(
			Object.keys(body.filters)
				.sort()
				.map((k) => [k, body.filters[k]])
				.concat([
					['sortBy', sort.by],
					['sortDir', sort.dir]
				])
		)
	);

	await writeAuditEvent(prisma, {
		action: AuditAction.REPORT_EXPORTED,
		entityType: AuditEntity.REPORT,
		entityId: def.type,
		companyId: typeof context.companyId === 'number' ? context.companyId : null,
		actorUserId: auth.user.id,
		metadata: {
			reportType: def.type,
			format: body.format,
			rowCount: rows.length,
			columnKeys: columns.map((c) => c.key),
			companyId: typeof context.companyId === 'number' ? context.companyId : null,
			generatedAt: generatedAt.toISOString(),
			fileHash,
			normalizedFilterHash
		}
	});

	return {
		bytes,
		fileName,
		contentType: CONTENT_TYPE[body.format],
		rowCount: rows.length,
		fileHash
	};
}
