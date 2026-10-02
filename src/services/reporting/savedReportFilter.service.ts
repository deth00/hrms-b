import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { prisma } from '../../config/prisma.js';
import { parseId } from '../../validation/common.schema.js';
import { AppError, Errors } from '../../utils/AppError.js';
import type { AuthContext } from '../../types/express.js';
import type {
	ReportTypeKey,
	SavedFilterCreateInput,
	SavedFilterUpdateInput
} from '../../validation/reporting.schema.js';
import { canViewReport, resolveReportingContext } from './reportingScope.service.js';
import { REPORT_DEFINITIONS, type ReportDefinition } from './reportDefinitions.js';
import { resolveColumns, resolveSort } from './reportDetail.service.js';
import { EMPLOYEE_GROUP_BY } from './employeeReporting.service.js';
import { ATTENDANCE_GROUP_BY } from './attendanceReporting.service.js';
import { LEAVE_GROUP_BY } from './leaveReporting.service.js';
import { OVERTIME_GROUP_BY } from './overtimeReporting.service.js';
import { PAYROLL_GROUP_BY } from './payrollReporting.service.js';
import { PAYMENT_GROUP_BY } from './paymentReporting.service.js';
import { ACCOUNTING_GROUP_BY } from './accountingReporting.service.js';

/**
 * Phase 17B — SAVED REPORT FILTERS: a private per-user convenience. A saved filter stores only safe report
 * STATE (whitelisted filter keys, groupBy, sort, column keys) — never rows, amounts, bank / statutory
 * data or free text — and it NEVER stores authorization:
 *   - create / update validate the state against the report's schemas AND the user's CURRENT scope;
 *   - every read re-validates (schema, report permission, company / branch / department / employee scope)
 *     and reports `usable: false` + a problem code when it no longer fits — the report endpoints validate
 *     again on use, so a stale saved filter can narrow the current access but never widen it.
 * Ownership: every query is by (id, userId); another user's filter is simply "not found".
 */
export const SAVED_FILTER_MAX = 25;

const GROUP_BY: Record<ReportTypeKey, readonly string[]> = {
	employees: EMPLOYEE_GROUP_BY,
	attendance: ATTENDANCE_GROUP_BY,
	leave: LEAVE_GROUP_BY,
	overtime: OVERTIME_GROUP_BY,
	payroll: PAYROLL_GROUP_BY,
	payments: PAYMENT_GROUP_BY,
	accounting: ACCOUNTING_GROUP_BY
};
const TYPE_OF_ENUM = Object.fromEntries(
	Object.values(REPORT_DEFINITIONS).map((d) => [d.enumValue, d.type])
) as Record<string, ReportTypeKey>;

const SavedErrors = {
	invalid: (field: string) =>
		Errors.badRequest('REPORT_SAVED_FILTER_INVALID', 'ຕົວກອງທີ່ບັນທຶກບໍ່ຖືກຕ້ອງ', { field }),
	limit: () =>
		Errors.conflict(
			'REPORT_SAVED_FILTER_LIMIT',
			`ບັນທຶກຕົວກອງໄດ້ສູງສຸດ ${SAVED_FILTER_MAX} ລາຍການຕໍ່ລາຍງານ`,
			{ max: SAVED_FILTER_MAX }
		),
	nameTaken: () =>
		Errors.conflict('REPORT_SAVED_FILTER_NAME_TAKEN', 'ມີຕົວກອງຊື່ນີ້ໃນລາຍງານນີ້ແລ້ວ'),
	notFound: () => Errors.notFound('ບໍ່ພົບຕົວກອງທີ່ບັນທຶກ')
};

function assertAccess(auth: AuthContext, def: ReportDefinition) {
	if (!canViewReport(auth.permissions, def.domain)) throw Errors.forbidden();
}

/** Saved filter values: every `…Id` key holds a numeric entity id, everything else its text value. */
type SavedFilters = Record<string, string | number>;

/**
 * Canonical stored form: `…Id` keys → strictly parsed numeric ids (a CUID or malformed value is rejected),
 * other keys → text. Applied on every create / update, so filtersJson never holds a string id.
 */
function normalizeSavedFilters(filters: SavedFilters): SavedFilters {
	const out: SavedFilters = {};
	for (const [k, v] of Object.entries(filters)) {
		if (k.endsWith('Id')) {
			const id = parseId(v);
			if (id === null) throw SavedErrors.invalid(k);
			out[k] = id;
		} else out[k] = String(v);
	}
	return out;
}
const filterId = (filters: SavedFilters, k: string) => parseId(filters[k]) ?? undefined;

interface SavedState {
	filters: SavedFilters;
	groupBy: string | null;
	sortBy: string | null;
	sortDir: 'asc' | 'desc' | null;
	columns: string[] | null;
}

/** Schema-level validation (keys, formats, groupBy / sort / column whitelists). */
function validateShape(def: ReportDefinition, s: SavedState) {
	const allowed = Object.keys(def.filterSchema.shape);
	for (const k of Object.keys(s.filters)) if (!allowed.includes(k)) throw SavedErrors.invalid(k);
	def.filterSchema.parse(s.filters);
	if (s.groupBy && !GROUP_BY[def.type].includes(s.groupBy)) throw SavedErrors.invalid('groupBy');
	if (s.sortBy) resolveSort(def, s.sortBy, s.sortDir);
	if (s.columns) resolveColumns(def, s.columns, { forExport: false });
}

/** The user's CURRENT scope must allow the saved org filter (same check as every report endpoint). */
async function validateScope(auth: AuthContext, filters: SavedFilters) {
	await resolveReportingContext(auth, {
		companyId: filterId(filters, 'companyId'),
		branchId: filterId(filters, 'branchId'),
		departmentId: filterId(filters, 'departmentId'),
		employeeId: filterId(filters, 'employeeId')
	});
}

/** Re-validation on read: never throws — reports whether the saved state is usable right now. */
async function usability(auth: AuthContext, def: ReportDefinition, s: SavedState) {
	if (!canViewReport(auth.permissions, def.domain)) return 'REPORT_PERMISSION_REMOVED';
	try {
		validateShape(def, s);
		await validateScope(auth, s.filters);
		return null;
	} catch (err) {
		if (err instanceof AppError) return err.code;
		if (err instanceof ZodError) return 'REPORT_SAVED_FILTER_INVALID';
		throw err;
	}
}

type Row = Prisma.SavedReportFilterGetPayload<object>;

const stateOf = (r: Row): SavedState => ({
	filters: (r.filtersJson ?? {}) as SavedFilters,
	groupBy: r.groupBy,
	sortBy: r.sortBy,
	sortDir: (r.sortDir as 'asc' | 'desc' | null) ?? null,
	columns: (r.columnsJson as string[] | null) ?? null
});

async function present(auth: AuthContext, r: Row) {
	const def = REPORT_DEFINITIONS[TYPE_OF_ENUM[r.reportType]!];
	const state = stateOf(r);
	const problem = await usability(auth, def, state);
	return {
		id: r.id,
		reportType: def.type,
		name: r.name,
		...state,
		isDefault: r.isDefault,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
		usable: problem === null,
		problem
	};
}

const defaultKey = (userId: number, def: ReportDefinition) => `${userId}:${def.enumValue}`;

async function loadOwn(auth: AuthContext, id: number) {
	const row = await prisma.savedReportFilter.findFirst({ where: { id, userId: auth.user.id } });
	if (!row) throw SavedErrors.notFound();
	const def = REPORT_DEFINITIONS[TYPE_OF_ENUM[row.reportType]!];
	assertAccess(auth, def);
	return { row, def };
}

function mapUnique(err: unknown): never {
	if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
		const target = String(err.meta?.target ?? '');
		if (target.includes('default')) {
			throw Errors.conflict('REPORT_SAVED_FILTER_DEFAULT_CONFLICT', 'ກະລຸນາລອງໃໝ່ອີກຄັ້ງ');
		}
		throw SavedErrors.nameTaken();
	}
	throw err;
}

export async function listSavedFilters(auth: AuthContext, reportType: ReportTypeKey) {
	const def = REPORT_DEFINITIONS[reportType];
	assertAccess(auth, def);
	const rows = await prisma.savedReportFilter.findMany({
		where: { userId: auth.user.id, reportType: def.enumValue },
		orderBy: [{ isDefault: 'desc' }, { name: 'asc' }]
	});
	return { items: await Promise.all(rows.map((r) => present(auth, r))), max: SAVED_FILTER_MAX };
}

export async function getSavedFilter(auth: AuthContext, id: number) {
	const { row } = await loadOwn(auth, id);
	return present(auth, row);
}

export async function createSavedFilter(auth: AuthContext, input: SavedFilterCreateInput) {
	const def = REPORT_DEFINITIONS[input.reportType];
	assertAccess(auth, def);
	const state: SavedState = {
		filters: normalizeSavedFilters(input.filters),
		groupBy: input.groupBy ?? null,
		sortBy: input.sortBy ?? null,
		sortDir: input.sortDir ?? null,
		columns: input.columns ?? null
	};
	validateShape(def, state);
	await validateScope(auth, state.filters);
	const count = await prisma.savedReportFilter.count({
		where: { userId: auth.user.id, reportType: def.enumValue }
	});
	if (count >= SAVED_FILTER_MAX) throw SavedErrors.limit();
	try {
		const row = await prisma.$transaction(async (tx) => {
			if (input.isDefault) {
				await tx.savedReportFilter.updateMany({
					where: { userId: auth.user.id, reportType: def.enumValue, isDefault: true },
					data: { isDefault: false, defaultKey: null }
				});
			}
			return tx.savedReportFilter.create({
				data: {
					userId: auth.user.id,
					reportType: def.enumValue,
					name: input.name,
					filtersJson: state.filters,
					groupBy: state.groupBy,
					sortBy: state.sortBy,
					sortDir: state.sortDir,
					columnsJson: state.columns ?? Prisma.DbNull,
					isDefault: input.isDefault ?? false,
					defaultKey: input.isDefault ? defaultKey(auth.user.id, def) : null
				}
			});
		});
		return present(auth, row);
	} catch (err) {
		mapUnique(err);
	}
}

export async function updateSavedFilter(
	auth: AuthContext,
	id: number,
	input: SavedFilterUpdateInput
) {
	const { row, def } = await loadOwn(auth, id);
	const current = stateOf(row);
	const state: SavedState = {
		filters: input.filters !== undefined ? normalizeSavedFilters(input.filters) : current.filters,
		groupBy: input.groupBy !== undefined ? input.groupBy : current.groupBy,
		sortBy: input.sortBy !== undefined ? input.sortBy : current.sortBy,
		sortDir: input.sortDir !== undefined ? input.sortDir : current.sortDir,
		columns: input.columns !== undefined ? input.columns : current.columns
	};
	const stateChanged =
		input.filters !== undefined ||
		input.groupBy !== undefined ||
		input.sortBy !== undefined ||
		input.sortDir !== undefined ||
		input.columns !== undefined;
	if (stateChanged) {
		validateShape(def, state);
		await validateScope(auth, state.filters);
	}
	try {
		const updated = await prisma.$transaction(async (tx) => {
			if (input.isDefault === true) {
				await tx.savedReportFilter.updateMany({
					where: {
						userId: auth.user.id,
						reportType: def.enumValue,
						isDefault: true,
						id: { not: id }
					},
					data: { isDefault: false, defaultKey: null }
				});
			}
			return tx.savedReportFilter.update({
				where: { id },
				data: {
					...(input.name !== undefined ? { name: input.name } : {}),
					...(stateChanged
						? {
								filtersJson: state.filters,
								groupBy: state.groupBy,
								sortBy: state.sortBy,
								sortDir: state.sortDir,
								columnsJson: state.columns ?? Prisma.DbNull
							}
						: {}),
					...(input.isDefault !== undefined
						? {
								isDefault: input.isDefault,
								defaultKey: input.isDefault ? defaultKey(auth.user.id, def) : null
							}
						: {})
				}
			});
		});
		return present(auth, updated);
	} catch (err) {
		mapUnique(err);
	}
}

export async function deleteSavedFilter(auth: AuthContext, id: number) {
	const { row } = await loadOwn(auth, id);
	await prisma.savedReportFilter.delete({ where: { id: row.id } });
	return { id: row.id, deleted: true };
}
