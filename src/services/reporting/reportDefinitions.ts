import type { ZodObject } from 'zod';
import type { AuthContext } from '../../types/express.js';
import {
	REPORT_FILTER_SCHEMAS,
	REPORT_TYPES,
	type ReportTypeKey
} from '../../validation/reporting.schema.js';
import { Errors } from '../../utils/AppError.js';
import type { ReportDomain } from './reportingScope.service.js';
import { employeeDetailRows } from './employeeReporting.service.js';
import { attendanceDetailRows } from './attendanceReporting.service.js';
import { leaveDetailRows } from './leaveReporting.service.js';
import { overtimeDetailRows, OVERTIME_TYPE_LABEL } from './overtimeReporting.service.js';
import { payrollDetailRows } from './payrollReporting.service.js';
import { paymentDetailRows } from './paymentReporting.service.js';
import { accountingDetailRows, JOURNAL_TYPE_LABEL } from './accountingReporting.service.js';

/**
 * Phase 17B — the BACKEND-OWNED report catalogue. One definition per report ties together:
 *   - the column catalogue (key, label, type, defaultVisible, sortable, exportable, sensitive);
 *   - the sort whitelist (sortable columns) + the documented default stable sort + tie-breakers;
 *   - the ONE row loader (a function in the report's own Phase 17A service) used by the detail table,
 *     every export format and the saved-filter validation — so a filter means the same everywhere.
 * Client column / sort keys are only ever looked up in this catalogue; they are never used as database
 * identifiers (rows are plain objects keyed by catalogue keys).
 */
export type ColumnType =
	'text' | 'date' | 'datetime' | 'integer' | 'minutes' | 'money' | 'decimal' | 'status';

export interface ColumnDef {
	key: string;
	label: string;
	type: ColumnType;
	defaultVisible: boolean;
	sortable: boolean;
	exportable: boolean;
	/** financial / personal data — shown only on reports that already require the sensitive permission */
	sensitive: boolean;
	/** display labels of a status column (code → Lao) */
	labels?: Record<string, string>;
}

export type RowValue = string | number | boolean | null;
export type DetailRow = Record<string, RowValue>;
export interface DetailResult {
	context: Record<string, unknown>;
	rows: DetailRow[];
}

export interface ReportDefinition {
	type: ReportTypeKey;
	/** the Prisma ReportType enum value (saved filters) */
	enumValue:
		'EMPLOYEES' | 'ATTENDANCE' | 'LEAVE' | 'OVERTIME' | 'PAYROLL' | 'PAYMENTS' | 'ACCOUNTING';
	domain: ReportDomain;
	title: string;
	sensitive: boolean;
	columns: ColumnDef[];
	defaultSort: { by: string; dir: 'asc' | 'desc' };
	/** stable secondary ordering (always ascending) */
	tieBreak: string[];
	filterSchema: ZodObject;
	statusOptions: { value: string; label: string }[];
	/** money columns totalled in the PDF (Decimal) */
	totals: string[];
	load(
		auth: AuthContext,
		filters: Record<string, unknown>,
		guard: (count: number) => void
	): Promise<DetailResult>;
}

const col = (
	key: string,
	label: string,
	type: ColumnType,
	o: Partial<Omit<ColumnDef, 'key' | 'label' | 'type'>> = {}
): ColumnDef => ({
	key,
	label,
	type,
	defaultVisible: o.defaultVisible ?? true,
	sortable: o.sortable ?? false,
	exportable: o.exportable ?? true,
	sensitive: o.sensitive ?? false,
	...(o.labels ? { labels: o.labels } : {})
});
const options = (labels: Record<string, string>) =>
	Object.entries(labels).map(([value, label]) => ({ value, label }));

const EMPLOYMENT_STATUS: Record<string, string> = {
	ACTIVE: 'ເຮັດວຽກ',
	PROBATION: 'ທົດລອງງານ',
	ON_LEAVE: 'ພັກງານຍາວ',
	SUSPENDED: 'ໂຈະການເຮັດວຽກ',
	RESIGNED: 'ລາອອກ',
	TERMINATED: 'ຢຸດຈ້າງ'
};
const DAILY_RESULT: Record<string, string> = {
	PENDING: 'ຍັງບໍ່ເຖິງເວລາສະຫຼຸບ',
	IN_PROGRESS: 'ກຳລັງເຮັດວຽກ',
	PRESENT: 'ປົກກະຕິ',
	LATE: 'ມາຊ້າ',
	EARLY_LEAVE: 'ອອກກ່ອນ',
	LATE_AND_EARLY: 'ມາຊ້າ + ອອກກ່ອນ',
	INCOMPLETE: 'ບໍ່ Check-out',
	ABSENT: 'ຂາດວຽກ',
	OFF_DAY: 'ມື້ພັກ',
	HOLIDAY: 'ວັນພັກ',
	LEAVE: 'ລາ',
	NO_SCHEDULE: 'ບໍ່ມີກະ'
};
const REQUEST_STATUS: Record<string, string> = {
	PENDING: 'ລໍຖ້າພິຈາລະນາ',
	APPROVED: 'ອະນຸມັດແລ້ວ',
	REJECTED: 'ປະຕິເສດ',
	CANCELLED: 'ຍົກເລີກ'
};
const OBLIGATION_STATUS: Record<string, string> = {
	UNPAID: 'ຍັງບໍ່ໄດ້ຈ່າຍ',
	IN_PROGRESS: 'ກຳລັງດຳເນີນການ',
	PAID: 'ຈ່າຍສຳເລັດ',
	REVERSED: 'ຖືກຍົກເລີກການຈ່າຍ',
	FAILED: 'ຈ່າຍບໍ່ສຳເລັດ'
};
const PAYMENT_METHOD: Record<string, string> = { BANK_TRANSFER: 'ໂອນຜ່ານທະນາຄານ', CASH: 'ເງິນສົດ' };
const JOURNAL_STATUS: Record<string, string> = {
	DRAFT: 'ຮ່າງ',
	VALIDATED: 'ກວດສອບແລ້ວ',
	POSTED: 'Post ແລ້ວ',
	CANCELLED: 'ຍົກເລີກແລ້ວ'
};
const YES_NO: Record<string, string> = { true: 'ແມ່ນ', false: 'ບໍ່' };

const money = (key: string, label: string, defaultVisible = true) =>
	col(key, label, 'money', { sortable: true, sensitive: true, defaultVisible });

type Loader<F> = (auth: AuthContext, f: F, guard: (n: number) => void) => Promise<DetailResult>;
const loader =
	<F>(fn: Loader<F>): ReportDefinition['load'] =>
	(auth, f, guard) =>
		fn(auth, f as F, guard);

export const REPORT_DEFINITIONS: Record<ReportTypeKey, ReportDefinition> = {
	employees: {
		type: 'employees',
		enumValue: 'EMPLOYEES',
		domain: 'employees',
		title: 'ລາຍງານພະນັກງານ',
		sensitive: false,
		columns: [
			col('employeeCode', 'ລະຫັດພະນັກງານ', 'text', { sortable: true }),
			col('fullName', 'ຊື່ ແລະ ນາມສະກຸນ', 'text', { sortable: true }),
			col('employmentStatus', 'ສະຖານະ', 'status', { sortable: true, labels: EMPLOYMENT_STATUS }),
			col('employmentType', 'ປະເພດການຈ້າງ', 'text', { sortable: true }),
			col('branch', 'ສາຂາ', 'text', { sortable: true }),
			col('department', 'ພະແນກ', 'text', { sortable: true }),
			col('division', 'ຂະແໜງ', 'text', { defaultVisible: false }),
			col('unit', 'ໜ່ວຍງານ', 'text', { defaultVisible: false }),
			col('position', 'ຕຳແໜ່ງ', 'text', { sortable: true }),
			col('startDate', 'ວັນເລີ່ມງານ', 'date', { sortable: true }),
			col('endDate', 'ວັນສິ້ນສຸດ', 'date', { sortable: true })
		],
		defaultSort: { by: 'employeeCode', dir: 'asc' },
		tieBreak: ['employeeCode'],
		filterSchema: REPORT_FILTER_SCHEMAS.employees,
		statusOptions: [
			{ value: 'CURRENT', label: 'ພະນັກງານປັດຈຸບັນ (ບໍ່ລວມລາອອກ)' },
			{ value: 'ALL', label: 'ທຸກສະຖານະ' },
			...options(EMPLOYMENT_STATUS)
		],
		totals: [],
		load: loader(employeeDetailRows)
	},
	attendance: {
		type: 'attendance',
		enumValue: 'ATTENDANCE',
		domain: 'attendance',
		title: 'ລາຍງານການເຂົ້າ-ອອກວຽກ',
		sensitive: false,
		columns: [
			col('date', 'ວັນທີ', 'date', { sortable: true }),
			col('employeeCode', 'ລະຫັດພະນັກງານ', 'text', { sortable: true }),
			col('employeeName', 'ຊື່ພະນັກງານ', 'text', { sortable: true }),
			col('branch', 'ສາຂາ', 'text', { defaultVisible: false }),
			col('department', 'ພະແນກ', 'text'),
			col('shift', 'ກະ', 'text', { defaultVisible: false }),
			col('status', 'ຜົນ', 'status', { sortable: true, labels: DAILY_RESULT }),
			col('checkInAt', 'ເຂົ້າວຽກ', 'datetime'),
			col('checkOutAt', 'ອອກວຽກ', 'datetime'),
			col('lateMinutes', 'ມາຊ້າ (ນາທີ)', 'minutes', { sortable: true }),
			col('earlyLeaveMinutes', 'ອອກກ່ອນ (ນາທີ)', 'minutes'),
			col('workedMinutes', 'ເວລາເຮັດວຽກ (ນາທີ)', 'minutes', { sortable: true })
		],
		defaultSort: { by: 'date', dir: 'desc' },
		tieBreak: ['employeeCode', 'date'],
		filterSchema: REPORT_FILTER_SCHEMAS.attendance,
		statusOptions: options(DAILY_RESULT),
		totals: [],
		load: loader(attendanceDetailRows)
	},
	leave: {
		type: 'leave',
		enumValue: 'LEAVE',
		domain: 'leave',
		title: 'ລາຍງານການລາ',
		sensitive: false,
		columns: [
			col('requestRef', 'ເລກຄຳຂໍ', 'text', { defaultVisible: false }),
			col('employeeCode', 'ລະຫັດພະນັກງານ', 'text', { sortable: true }),
			col('employeeName', 'ຊື່ພະນັກງານ', 'text', { sortable: true }),
			col('branch', 'ສາຂາ', 'text', { defaultVisible: false }),
			col('department', 'ພະແນກ', 'text'),
			col('leaveType', 'ປະເພດການລາ', 'text', { sortable: true }),
			col('startDate', 'ວັນເລີ່ມ', 'date', { sortable: true }),
			col('endDate', 'ວັນສິ້ນສຸດ', 'date', { sortable: true }),
			col('requestedDays', 'ມື້ທີ່ຂໍ', 'decimal', { defaultVisible: false }),
			col('approvedDays', 'ມື້ທີ່ອະນຸມັດ (ໃນຊ່ວງ)', 'decimal', { sortable: true }),
			col('status', 'ສະຖານະ', 'status', { sortable: true, labels: REQUEST_STATUS }),
			col('submittedAt', 'ວັນທີຍື່ນ', 'datetime', { sortable: true })
		],
		defaultSort: { by: 'startDate', dir: 'desc' },
		tieBreak: ['employeeCode', 'requestRef'],
		filterSchema: REPORT_FILTER_SCHEMAS.leave,
		statusOptions: options(REQUEST_STATUS),
		totals: [],
		load: loader(leaveDetailRows)
	},
	overtime: {
		type: 'overtime',
		enumValue: 'OVERTIME',
		domain: 'overtime',
		title: 'ລາຍງານວຽກລ່ວງເວລາ (OT)',
		sensitive: false,
		columns: [
			col('requestRef', 'ເລກຄຳຂໍ', 'text', { defaultVisible: false }),
			col('employeeCode', 'ລະຫັດພະນັກງານ', 'text', { sortable: true }),
			col('employeeName', 'ຊື່ພະນັກງານ', 'text', { sortable: true }),
			col('branch', 'ສາຂາ', 'text', { defaultVisible: false }),
			col('department', 'ພະແນກ', 'text'),
			col('workDate', 'ວັນທີເຮັດວຽກ', 'date', { sortable: true }),
			col('type', 'ປະເພດ OT', 'status', { sortable: true, labels: OVERTIME_TYPE_LABEL }),
			col('plannedMinutes', 'ເວລາທີ່ຂໍ (ນາທີ)', 'minutes', { sortable: true }),
			col('eligibleMinutes', 'ເວລາທີ່ມີສິດ (ນາທີ)', 'minutes', { sortable: true }),
			col('status', 'ສະຖານະ', 'status', { sortable: true, labels: REQUEST_STATUS }),
			col('submittedAt', 'ວັນທີຍື່ນ', 'datetime', { sortable: true })
		],
		defaultSort: { by: 'workDate', dir: 'desc' },
		tieBreak: ['employeeCode', 'requestRef'],
		filterSchema: REPORT_FILTER_SCHEMAS.overtime,
		statusOptions: options(REQUEST_STATUS),
		totals: [],
		load: loader(overtimeDetailRows)
	},
	payroll: {
		type: 'payroll',
		enumValue: 'PAYROLL',
		domain: 'payroll',
		title: 'ລາຍງານເງິນເດືອນ',
		sensitive: true,
		columns: [
			col('payrollMonth', 'ເດືອນເງິນເດືອນ', 'text', { defaultVisible: false }),
			col('periodCode', 'ງວດ', 'text', { sortable: true, defaultVisible: false }),
			col('runNumber', 'ຮອບທີ', 'integer', { defaultVisible: false }),
			col('employeeCode', 'ລະຫັດພະນັກງານ', 'text', { sortable: true }),
			col('employeeName', 'ຊື່ພະນັກງານ', 'text', { sortable: true }),
			col('branch', 'ສາຂາ (ຕອນຄຳນວນ)', 'text', { defaultVisible: false }),
			col('department', 'ພະແນກ (ຕອນຄຳນວນ)', 'text', { sortable: true }),
			money('grossEarnings', 'ລາຍຮັບລວມ'),
			money('totalDeductions', 'ລາຍຫັກລວມ'),
			money('pit', 'ພາສີ (PIT)'),
			money('employeeSso', 'SSO ພະນັກງານ'),
			money('employerSso', 'SSO ນາຍຈ້າງ'),
			money('netPay', 'ສຸດທິ'),
			col('currencyCode', 'ສະກຸນເງິນ', 'text', { defaultVisible: false })
		],
		defaultSort: { by: 'employeeCode', dir: 'asc' },
		tieBreak: ['employeeCode', 'periodCode'],
		filterSchema: REPORT_FILTER_SCHEMAS.payroll,
		statusOptions: [],
		totals: ['grossEarnings', 'totalDeductions', 'pit', 'employeeSso', 'employerSso', 'netPay'],
		load: loader(payrollDetailRows)
	},
	payments: {
		type: 'payments',
		enumValue: 'PAYMENTS',
		domain: 'payments',
		title: 'ລາຍງານການຈ່າຍເງິນ',
		sensitive: true,
		columns: [
			col('payrollMonth', 'ເດືອນເງິນເດືອນ', 'text', { defaultVisible: false }),
			col('periodCode', 'ງວດ', 'text', { sortable: true, defaultVisible: false }),
			col('employeeCode', 'ລະຫັດພະນັກງານ', 'text', { sortable: true }),
			col('employeeName', 'ຊື່ພະນັກງານ', 'text', { sortable: true }),
			col('branch', 'ສາຂາ (ຕອນຄຳນວນ)', 'text', { defaultVisible: false }),
			col('department', 'ພະແນກ (ຕອນຄຳນວນ)', 'text'),
			col('settlementStatus', 'ສະຖານະການຈ່າຍ', 'status', {
				sortable: true,
				labels: OBLIGATION_STATUS
			}),
			col('paymentMethod', 'ວິທີຈ່າຍ', 'status', { labels: PAYMENT_METHOD }),
			col('attemptCount', 'ຄັ້ງທີ່ພະຍາຍາມ', 'integer', { sortable: true }),
			col('retried', 'ຈ່າຍຄືນ', 'status', { labels: YES_NO }),
			col('paidAt', 'ວັນທີຈ່າຍ', 'datetime', { sortable: true }),
			col('reversedOn', 'ວັນທີຍົກເລີກ', 'date', { defaultVisible: false }),
			money('amount', 'ຈຳນວນເງິນ'),
			col('currencyCode', 'ສະກຸນເງິນ', 'text', { defaultVisible: false })
		],
		defaultSort: { by: 'employeeCode', dir: 'asc' },
		tieBreak: ['employeeCode', 'periodCode'],
		filterSchema: REPORT_FILTER_SCHEMAS.payments,
		statusOptions: options(OBLIGATION_STATUS),
		totals: ['amount'],
		load: loader(paymentDetailRows)
	},
	accounting: {
		type: 'accounting',
		enumValue: 'ACCOUNTING',
		domain: 'accounting',
		title: 'ລາຍງານບັນຊີເງິນເດືອນ',
		sensitive: true,
		columns: [
			col('journalNumber', 'ເລກບັນທຶກ', 'text', { sortable: true }),
			col('journalType', 'ປະເພດ', 'status', {
				sortable: true,
				defaultVisible: false,
				labels: JOURNAL_TYPE_LABEL
			}),
			col('accountingDate', 'ວັນທີບັນຊີ', 'date', { sortable: true }),
			col('journalStatus', 'ສະຖານະ', 'status', { sortable: true, labels: JOURNAL_STATUS }),
			col('lineNo', 'ແຖວ', 'integer'),
			col('accountCode', 'ລະຫັດບັນຊີ', 'text', { sortable: true }),
			col('accountName', 'ຊື່ບັນຊີ', 'text'),
			col('description', 'ຄຳອະທິບາຍ', 'text'),
			col('employeeCode', 'ລະຫັດພະນັກງານ', 'text', { defaultVisible: false }),
			col('branchCode', 'ລະຫັດສາຂາ', 'text', { defaultVisible: false }),
			col('departmentCode', 'ລະຫັດພະແນກ', 'text', { defaultVisible: false }),
			money('debit', 'ໜີ້ (Debit)'),
			money('credit', 'ມີ (Credit)'),
			col('currencyCode', 'ສະກຸນເງິນ', 'text', { defaultVisible: false })
		],
		defaultSort: { by: 'accountingDate', dir: 'asc' },
		tieBreak: ['journalNumber', 'lineNo'],
		filterSchema: REPORT_FILTER_SCHEMAS.accounting,
		statusOptions: options(JOURNAL_STATUS),
		totals: ['debit', 'credit'],
		load: loader(accountingDetailRows)
	}
};

export function definitionOf(type: string): ReportDefinition {
	if (!(REPORT_TYPES as readonly string[]).includes(type)) {
		throw Errors.notFound('ບໍ່ພົບປະເພດລາຍງານ');
	}
	return REPORT_DEFINITIONS[type as ReportTypeKey];
}

/** GET /reports/:type/fields — the catalogue (only reachable with the report's permissions). */
export const presentCatalog = (d: ReportDefinition) => ({
	reportType: d.type,
	title: d.title,
	sensitive: d.sensitive,
	columns: d.columns.map(
		({ key, label, type, defaultVisible, sortable, exportable, sensitive, labels }) => ({
			key,
			label,
			type,
			defaultVisible,
			sortable,
			exportable,
			sensitive,
			...(labels ? { labels } : {})
		})
	),
	defaultSort: d.defaultSort,
	statusOptions: d.statusOptions
});
