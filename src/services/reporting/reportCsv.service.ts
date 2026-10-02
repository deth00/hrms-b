import { buildCsv, type Cell } from '../../lib/bankFile.js';
import type { ColumnDef, DetailRow } from './reportDefinitions.js';
import { fileValue, isNumeric } from './reportFormat.js';

/**
 * Phase 17B CSV — the Phase 14 writer (`buildCsv`): UTF-8 with BOM (Lao text opens correctly in Excel),
 * RFC 4180 quoting, CRLF line endings, and formula-injection neutralisation of every TEXT cell and header
 * (a leading = + - @ TAB or CR gets an apostrophe). Numeric values (money / decimal / minutes / integer)
 * are generated numbers written as plain decimals (no thousands separators) and are not neutralised.
 */
export function buildReportCsv(columns: ColumnDef[], rows: DetailRow[]): Buffer {
	const cells: Cell[][] = rows.map((r) =>
		columns.map((c) => ({
			kind: isNumeric(c) && r[c.key] !== null ? 'amount' : 'text',
			value: fileValue(c, r[c.key] ?? null)
		}))
	);
	return buildCsv(
		columns.map((c) => c.label),
		cells,
		{ delimiter: ',', includeHeader: true, bom: true }
	);
}
