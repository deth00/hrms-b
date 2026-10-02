import { Prisma } from '@prisma/client';
import { Errors } from '../../utils/AppError.js';
import type { AuthContext } from '../../types/express.js';
import { detailQuerySchema } from '../../validation/reporting.schema.js';
import type { ColumnDef, DetailRow, ReportDefinition, RowValue } from './reportDefinitions.js';

/**
 * Phase 17B — the ONE detail pipeline: filters → the report's loader (scope / permission / range guards
 * inside) → whitelisted, stable sort → page slice. Exports call `loadSortedRows` too, so the UI table
 * and CSV / XLSX / PDF are the same rows in the same order.
 *
 * Pagination is done on the SERVER over the (bounded) loaded set: sorting may use canonical, computed
 * values (a daily result, a resolved settlement status, OT eligible minutes) that the database cannot
 * order by. The loaders refuse sets above MAX_DETAIL_ROWS before loading them.
 */
export const MAX_DETAIL_ROWS = 25_000;

export const DetailErrors = {
	sortInvalid: (allowed: string[]) =>
		Errors.badRequest('REPORT_SORT_INVALID', 'ການລຽງລຳດັບບໍ່ຖືກຕ້ອງ', { allowed }),
	tooLarge: (estimatedRows: number) =>
		Errors.badRequest('REPORT_DETAIL_TOO_LARGE', 'ຂໍ້ມູນຫຼາຍເກີນໄປ — ກະລຸນາກັ່ນຕອງໃຫ້ແຄບລົງ', {
			estimatedRows,
			maxRows: MAX_DETAIL_ROWS
		}),
	columnInvalid: (key: string) =>
		Errors.badRequest('REPORT_COLUMN_INVALID', `ຄໍລຳບໍ່ຖືກຕ້ອງ: ${key}`, { column: key }),
	columnsRequired: () => Errors.badRequest('REPORT_COLUMNS_REQUIRED', 'ກະລຸນາເລືອກຢ່າງໜ້ອຍໜຶ່ງຄໍລຳ')
};

export interface SortSpec {
	by: string;
	dir: 'asc' | 'desc';
}

/** Whitelisted sort (a sortable catalogue column) or the documented default. */
export function resolveSort(
	def: ReportDefinition,
	sortBy: string | undefined | null,
	sortDir: 'asc' | 'desc' | undefined | null
): SortSpec {
	const sortable = def.columns.filter((c) => c.sortable).map((c) => c.key);
	if (!sortBy) return { by: def.defaultSort.by, dir: sortDir ?? def.defaultSort.dir };
	if (!sortable.includes(sortBy)) throw DetailErrors.sortInvalid(sortable);
	return { by: sortBy, dir: sortDir ?? 'asc' };
}

/** Selected columns must be catalogue columns (exportable when exporting); none → default columns. */
export function resolveColumns(
	def: ReportDefinition,
	keys: string[] | undefined | null,
	o: { forExport: boolean }
): ColumnDef[] {
	if (keys === undefined || keys === null) return def.columns.filter((c) => c.defaultVisible);
	if (keys.length === 0) throw DetailErrors.columnsRequired();
	const out: ColumnDef[] = [];
	for (const k of new Set(keys)) {
		const c = def.columns.find((x) => x.key === k);
		if (!c || (o.forExport && !c.exportable)) throw DetailErrors.columnInvalid(k);
		out.push(c);
	}
	return out;
}

function compareValues(type: ColumnDef['type'], a: RowValue, b: RowValue): number {
	if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1; // nulls last
	if (b === null || b === undefined) return -1;
	if (type === 'money' || type === 'decimal') {
		return new Prisma.Decimal(String(a)).comparedTo(new Prisma.Decimal(String(b)));
	}
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
	return String(a).localeCompare(String(b), 'en');
}

export function sortRows(def: ReportDefinition, rows: DetailRow[], sort: SortSpec): DetailRow[] {
	const typeOf = (k: string) => def.columns.find((c) => c.key === k)?.type ?? 'text';
	const primary = typeOf(sort.by);
	return [...rows].sort((x, y) => {
		const a = x[sort.by] ?? null;
		const b = y[sort.by] ?? null;
		let d = compareValues(primary, a, b);
		// nulls stay last in both directions; only real values are reversed
		if (a !== null && b !== null && sort.dir === 'desc') d = -d;
		if (d !== 0) return d;
		for (const k of def.tieBreak) {
			const t = compareValues(typeOf(k), x[k] ?? null, y[k] ?? null);
			if (t !== 0) return t;
		}
		return 0;
	});
}

/** Parses the report's filters (the SAME schema for UI, export and saved filters). */
export const parseFilters = (def: ReportDefinition, raw: Record<string, unknown>) =>
	def.filterSchema.parse(raw) as Record<string, unknown>;

/** Loads every matching row (guarded) and sorts it — the detail table AND every export. */
export async function loadSortedRows(
	auth: AuthContext,
	def: ReportDefinition,
	filters: Record<string, unknown>,
	sort: SortSpec,
	guard: (count: number) => void
) {
	const { context, rows } = await def.load(auth, filters, guard);
	return { context, rows: sortRows(def, rows, sort) };
}

/** GET /reports/:type/detail */
export async function getReportDetail(
	auth: AuthContext,
	def: ReportDefinition,
	rawQuery: Record<string, unknown>
) {
	const q = detailQuerySchema(def.type).parse(rawQuery) as Record<string, unknown> & {
		page: number;
		pageSize: number;
		sortBy?: string;
		sortDir?: 'asc' | 'desc';
	};
	const sort = resolveSort(def, q.sortBy, q.sortDir);
	const { page, pageSize, sortBy: _s, sortDir: _d, ...filters } = q;
	void _s;
	void _d;
	const { context, rows } = await loadSortedRows(auth, def, filters, sort, (n) => {
		if (n > MAX_DETAIL_ROWS) throw DetailErrors.tooLarge(n);
	});
	const totalRows = rows.length;
	return {
		generatedAt: new Date(),
		context: { ...context, reportType: def.type, sortBy: sort.by, sortDir: sort.dir },
		columns: def.columns.map((c) => ({
			key: c.key,
			label: c.label,
			type: c.type,
			sortable: c.sortable,
			defaultVisible: c.defaultVisible
		})),
		page: {
			number: page,
			size: pageSize,
			totalRows,
			totalPages: Math.max(1, Math.ceil(totalRows / pageSize))
		},
		rows: rows.slice((page - 1) * pageSize, page * pageSize)
	};
}
