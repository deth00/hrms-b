import { z } from 'zod';
import { optionalId } from './common.schema.js';
import { optionalDateField } from './employee.schema.js';

/**
 * Phase 17A — READ-ONLY reporting queries. Like every other list query in the project, unknown query
 * parameters are stripped (not rejected). `groupBy` is accepted as a short string here and WHITELISTED
 * per report in the service (stable REPORT_GROUP_BY_INVALID code) — it is never used as a column name.
 */
const groupByField = () => z.string().trim().max(40).optional();

/** "2026-09" — a payroll month (the same string PayrollRun.payrollMonth stores). */
const payrollMonthField = () =>
	z
		.string()
		.trim()
		.regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'ເດືອນເງິນເດືອນຕ້ອງເປັນຮູບແບບ YYYY-MM')
		.optional();

const orgFilter = {
	companyId: optionalId(),
	branchId: optionalId(),
	departmentId: optionalId()
};

export const dashboardQuerySchema = z.object({
	date: optionalDateField(),
	...orgFilter
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export const employeeReportQuerySchema = z.object({
	...orgFilter,
	/** only "today" is supported — see HISTORICAL_HEADCOUNT_NOT_AVAILABLE in the service */
	asOf: optionalDateField(),
	groupBy: groupByField()
});
export type EmployeeReportQuery = z.infer<typeof employeeReportQuerySchema>;

export const attendanceReportQuerySchema = z.object({
	...orgFilter,
	employeeId: optionalId(),
	from: optionalDateField(),
	to: optionalDateField(),
	groupBy: groupByField()
});
export type AttendanceReportQuery = z.infer<typeof attendanceReportQuerySchema>;

export const leaveReportQuerySchema = z.object({
	...orgFilter,
	employeeId: optionalId(),
	leaveTypeId: optionalId(),
	from: optionalDateField(),
	to: optionalDateField(),
	groupBy: groupByField()
});
export type LeaveReportQuery = z.infer<typeof leaveReportQuerySchema>;

export const overtimeReportQuerySchema = z.object({
	...orgFilter,
	employeeId: optionalId(),
	from: optionalDateField(),
	to: optionalDateField(),
	groupBy: groupByField()
});
export type OvertimeReportQuery = z.infer<typeof overtimeReportQuerySchema>;

export const payrollReportQuerySchema = z.object({
	...orgFilter,
	payrollMonth: payrollMonthField(),
	scheduleId: optionalId(),
	groupBy: groupByField()
});
export type PayrollReportQuery = z.infer<typeof payrollReportQuerySchema>;

export const paymentReportQuerySchema = z.object({
	...orgFilter,
	payrollMonth: payrollMonthField(),
	groupBy: groupByField()
});
export type PaymentReportQuery = z.infer<typeof paymentReportQuerySchema>;

export const JOURNAL_TYPES = ['PAYROLL_ACCRUAL', 'PAYMENT_SETTLEMENT', 'PAYMENT_REVERSAL'] as const;

export const accountingReportQuerySchema = z.object({
	companyId: optionalId(),
	from: optionalDateField(),
	to: optionalDateField(),
	journalType: z.enum(JOURNAL_TYPES).optional(),
	groupBy: groupByField()
});
export type AccountingReportQuery = z.infer<typeof accountingReportQuerySchema>;

// ============================================================================================
// Phase 17B — detail reports, exports, saved filters
// ============================================================================================

export const REPORT_TYPES = [
	'employees',
	'attendance',
	'leave',
	'overtime',
	'payroll',
	'payments',
	'accounting'
] as const;
export type ReportTypeKey = (typeof REPORT_TYPES)[number];

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const EXPORT_FORMATS = ['CSV', 'XLSX', 'PDF'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const EMPLOYEE_STATUS_FILTERS = [
	'CURRENT',
	'ALL',
	'ACTIVE',
	'PROBATION',
	'ON_LEAVE',
	'SUSPENDED',
	'RESIGNED',
	'TERMINATED'
] as const;
const DAILY_RESULT_FILTERS = [
	'PENDING',
	'IN_PROGRESS',
	'PRESENT',
	'LATE',
	'EARLY_LEAVE',
	'LATE_AND_EARLY',
	'INCOMPLETE',
	'ABSENT',
	'OFF_DAY',
	'HOLIDAY',
	'LEAVE',
	'NO_SCHEDULE'
] as const;
const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
const OBLIGATION_STATUSES = ['UNPAID', 'IN_PROGRESS', 'PAID', 'REVERSED', 'FAILED'] as const;
const JOURNAL_STATUSES = ['DRAFT', 'VALIDATED', 'POSTED', 'CANCELLED'] as const;

/**
 * The filter keys of each report (the SAME keys for summary, detail, export and saved filters). Status
 * filters exist on the detail / export surfaces only (a summary already breaks down by status).
 */
export const REPORT_FILTER_SCHEMAS = {
	employees: z.object({ ...orgFilter, status: z.enum(EMPLOYEE_STATUS_FILTERS).optional() }),
	attendance: z.object({
		...orgFilter,
		employeeId: optionalId(),
		from: optionalDateField(),
		to: optionalDateField(),
		status: z.enum(DAILY_RESULT_FILTERS).optional()
	}),
	leave: z.object({
		...orgFilter,
		employeeId: optionalId(),
		leaveTypeId: optionalId(),
		from: optionalDateField(),
		to: optionalDateField(),
		status: z.enum(REQUEST_STATUSES).optional()
	}),
	overtime: z.object({
		...orgFilter,
		employeeId: optionalId(),
		from: optionalDateField(),
		to: optionalDateField(),
		status: z.enum(REQUEST_STATUSES).optional()
	}),
	payroll: z.object({ ...orgFilter, payrollMonth: payrollMonthField(), scheduleId: optionalId() }),
	payments: z.object({
		...orgFilter,
		payrollMonth: payrollMonthField(),
		status: z.enum(OBLIGATION_STATUSES).optional()
	}),
	accounting: z.object({
		companyId: optionalId(),
		from: optionalDateField(),
		to: optionalDateField(),
		journalType: z.enum(JOURNAL_TYPES).optional(),
		status: z.enum(JOURNAL_STATUSES).optional()
	})
} as const;

const sortFields = {
	sortBy: z.string().trim().max(40).optional(),
	sortDir: z.enum(['asc', 'desc']).optional()
};

/** Detail query = the report's filters + server pagination (whitelisted page sizes) + sort. */
export const detailQuerySchema = (type: ReportTypeKey) =>
	REPORT_FILTER_SCHEMAS[type].extend({
		page: z.coerce.number().int().min(1).max(1_000_000).default(1),
		pageSize: z.coerce
			.number()
			.int()
			.refine((v) => (PAGE_SIZES as readonly number[]).includes(v), {
				message: 'pageSize ຕ້ອງເປັນ 10, 25, 50 ຫຼື 100'
			})
			.default(25),
		...sortFields
	});

/** a saved / exported filter value: text (dates, month, status …) or a numeric entity id */
const filterValue = z.union([z.string().trim().max(64), z.number()]);
const filterValues = z.record(z.string().max(40), filterValue).default({});
const columnKeys = z.array(z.string().trim().min(1).max(40)).max(40);

export const exportBodySchema = z
	.object({
		format: z.enum(EXPORT_FORMATS),
		filters: filterValues,
		/** accepted for symmetry with the UI state; exports are detail rows (never grouped) */
		groupBy: z.string().trim().max(40).optional(),
		...sortFields,
		/** omitted → the catalog's default columns; [] → REPORT_COLUMNS_REQUIRED */
		columns: columnKeys.optional()
	})
	.strict();
export type ExportBody = z.infer<typeof exportBodySchema>;

const savedName = z
	.string()
	.trim()
	.min(1, 'ກະລຸນາປ້ອນຊື່')
	.max(80, 'ຊື່ຍາວເກີນໄປ (ສູງສຸດ 80 ຕົວອັກສອນ)')
	// eslint-disable-next-line no-control-regex
	.refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'ຊື່ມີຕົວອັກສອນທີ່ບໍ່ອະນຸຍາດ');

const savedState = {
	filters: filterValues,
	groupBy: z.string().trim().max(40).nullable().optional(),
	sortBy: z.string().trim().max(40).nullable().optional(),
	sortDir: z.enum(['asc', 'desc']).nullable().optional(),
	columns: columnKeys.nullable().optional(),
	isDefault: z.boolean().optional()
};

export const savedFilterCreateSchema = z
	.object({ reportType: z.enum(REPORT_TYPES), name: savedName, ...savedState })
	.strict();
export type SavedFilterCreateInput = z.infer<typeof savedFilterCreateSchema>;

export const savedFilterUpdateSchema = z
	.object({
		name: savedName.optional(),
		...savedState,
		// NO default here: an update that omits `filters` (e.g. only isDefault) must keep the saved ones
		filters: z.record(z.string().max(40), filterValue).optional()
	})
	.strict();
export type SavedFilterUpdateInput = z.infer<typeof savedFilterUpdateSchema>;

export const savedFilterListQuerySchema = z.object({ reportType: z.enum(REPORT_TYPES) });
