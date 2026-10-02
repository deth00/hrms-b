import { parse as parseCsv, CsvError } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

/**
 * BANK RESULT FILE READER (Phase 15 §14-15, §18). Bank result files are UNTRUSTED input.
 *
 *  - Parsing uses MATURE libraries: `csv-parse` (CSV) and SheetJS CE `xlsx` (XLSX). There is no
 *    hand-written spreadsheet reader here. The small ZIP scan below reads only the ZIP central
 *    directory (entry names + declared sizes) to refuse macro-enabled / oversized workbooks BEFORE
 *    the workbook is handed to the parser.
 *  - Only .csv and .xlsx. .xls / .xlsm / .xlsb / a bare zip / anything else is refused, by extension
 *    AND by content (magic bytes), so a renamed file does not get through.
 *  - Macros are never executed (none are ever loaded); formulas are never evaluated: a FORMULA in a
 *    MAPPED cell rejects the whole file (FORMULA_CELL_NOT_ALLOWED).
 *  - Size / row / uncompressed-size limits bound the work an upload can cause.
 *  - Returns ONLY the cells of the columns the profile maps; unknown columns never leave this module.
 */
export const RECON_LIMITS = {
	maxBytes: 5 * 1024 * 1024,
	maxRows: 10_000,
	/** sum of the declared uncompressed sizes of all XLSX parts (zip-bomb guard) */
	maxUncompressedBytes: 60 * 1024 * 1024,
	maxZipEntries: 2_000,
	maxCsvRecordBytes: 64 * 1024
} as const;

export const RECON_FIELDS = [
	'INSTRUCTION_REFERENCE',
	'BANK_TRANSACTION_REFERENCE',
	'STATUS',
	'AMOUNT',
	'CURRENCY',
	'PAID_DATE',
	'FAILURE_CODE',
	'FAILURE_REASON'
] as const;
export type ReconField = (typeof RECON_FIELDS)[number];

export interface ReconFileConfig {
	format: 'CSV' | 'XLSX';
	delimiter: string | null;
	sheetName: string | null;
	hasHeader: boolean;
	/** column = header text (hasHeader) or the 1-based column number */
	columns: { field: ReconField; column: string }[];
}

/** a raw mapped cell: text, a number (XLSX numeric cell) or a spreadsheet error cell */
export type RawCell = string | number | { error: string } | null;

export interface RawRow {
	/** data row number in the file (header = row 1) */
	rowNumber: number;
	values: Partial<Record<ReconField, RawCell>>;
}

export class ReconFileError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly details?: Record<string, unknown>
	) {
		super(message);
		this.name = 'ReconFileError';
	}
}

/** Only .csv / .xlsx names are accepted (case-insensitive). */
export function extensionOf(fileName: string): 'csv' | 'xlsx' | null {
	const lower = fileName.toLowerCase().trim();
	if (lower.endsWith('.csv')) return 'csv';
	if (lower.endsWith('.xlsx')) return 'xlsx';
	return null;
}

/** "../../evil name?.csv" → "evil_name_.csv" (ASCII, no path, ≤ 150 chars). */
export function safeFileName(fileName: string): string {
	const base = fileName.split(/[\\/]/).pop() ?? 'file';
	const cleaned = base
		.normalize('NFKD')
		.replace(/[^A-Za-z0-9._-]+/g, '_')
		.replace(/^[._]+/, '')
		.slice(-150);
	return cleaned || 'bank-result';
}

const unsupported = () =>
	new ReconFileError(
		'UNSUPPORTED_FILE_TYPE',
		'ຮອງຮັບສະເພາະໄຟລ໌ .csv ແລະ .xlsx (ບໍ່ຮັບ .xls, .xlsm, zip ຫຼື ໄຟລ໌ອື່ນ)'
	);
const malformed = (why: string) => new ReconFileError('MALFORMED_FILE', `ອ່ານໄຟລ໌ບໍ່ໄດ້ — ${why}`);

const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

// ============================================================================================
// entry point
// ============================================================================================

export function readReconciliationFile(
	bytes: Buffer,
	fileName: string,
	cfg: ReconFileConfig
): RawRow[] {
	if (bytes.length > RECON_LIMITS.maxBytes) {
		throw new ReconFileError('FILE_TOO_LARGE', 'ໄຟລ໌ໃຫຍ່ເກີນ 5 MB');
	}
	const ext = extensionOf(fileName);
	if (!ext) throw unsupported();
	if ((ext === 'csv' ? 'CSV' : 'XLSX') !== cfg.format) {
		throw new ReconFileError(
			'FILE_FORMAT_MISMATCH',
			`ຮູບແບບຜົນການຈ່າຍນີ້ຮັບໄຟລ໌ ${cfg.format} ເທົ່ານັ້ນ`
		);
	}
	if (bytes.length === 0) throw new ReconFileError('EMPTY_FILE', 'ໄຟລ໌ຫວ່າງເປົ່າ');
	const grid = ext === 'csv' ? readCsvGrid(bytes, cfg) : readXlsxGrid(bytes, cfg);
	return mapGrid(grid, cfg);
}

// ============================================================================================
// CSV (csv-parse)
// ============================================================================================

type Grid = { cells: RawCell[][]; formulas: boolean[][] };

function readCsvGrid(bytes: Buffer, cfg: ReconFileConfig): Grid {
	const head = bytes.subarray(0, 4);
	if (head.equals(PK) || head.equals(CFB)) throw malformed('ໄຟລ໌ນີ້ບໍ່ແມ່ນ CSV (ເປັນໄຟລ໌ binary)');
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw malformed('ໄຟລ໌ຕ້ອງເປັນ UTF-8');
	}
	if (text.includes('\u0000')) throw malformed('ໄຟລ໌ມີຕົວອັກສອນ NUL (binary)');
	let records: string[][];
	try {
		records = parseCsv(text, {
			delimiter: cfg.delimiter === 'TAB' ? '\t' : (cfg.delimiter ?? ','),
			bom: true,
			relax_column_count: true,
			skip_empty_lines: true,
			max_record_size: RECON_LIMITS.maxCsvRecordBytes,
			// NEVER: cast (no type guessing — "001234" stays text), no comment / quote relaxing
			cast: false,
			// stop reading well past the limit so a huge file cannot tie up the parser
			to: RECON_LIMITS.maxRows + 2
		}) as string[][];
	} catch (err) {
		if (err instanceof CsvError) throw malformed(`CSV ບໍ່ຖືກຮູບແບບ (${err.code})`);
		throw malformed('CSV ບໍ່ຖືກຮູບແບບ');
	}
	return { cells: records, formulas: records.map((r) => r.map(() => false)) };
}

// ============================================================================================
// XLSX (SheetJS CE) — guarded by a ZIP central-directory scan
// ============================================================================================

/** Reads ONLY the ZIP central directory: entry names + declared uncompressed sizes. */
export function zipEntries(bytes: Buffer): { name: string; size: number }[] {
	const EOCD = 0x06054b50;
	const CEN = 0x02014b50;
	const minEocd = 22;
	let eocd = -1;
	const stop = Math.max(0, bytes.length - minEocd - 0xffff);
	for (let i = bytes.length - minEocd; i >= stop; i--) {
		if (bytes.readUInt32LE(i) === EOCD) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw malformed('ບໍ່ແມ່ນໄຟລ໌ .xlsx ທີ່ຖືກຕ້ອງ');
	const total = bytes.readUInt16LE(eocd + 10);
	const cdOffset = bytes.readUInt32LE(eocd + 16);
	if (total === 0xffff || cdOffset === 0xffffffff) throw malformed('ZIP64 ບໍ່ຮອງຮັບ');
	if (total > RECON_LIMITS.maxZipEntries) throw malformed('ມີສ່ວນປະກອບຫຼາຍເກີນໄປ');
	const out: { name: string; size: number }[] = [];
	let p = cdOffset;
	for (let n = 0; n < total; n++) {
		if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== CEN) {
			throw malformed('ໂຄງສ້າງ ZIP ເສຍຫາຍ');
		}
		const size = bytes.readUInt32LE(p + 24);
		const nameLen = bytes.readUInt16LE(p + 28);
		const extraLen = bytes.readUInt16LE(p + 30);
		const commentLen = bytes.readUInt16LE(p + 32);
		if (size === 0xffffffff) throw malformed('ZIP64 ບໍ່ຮອງຮັບ');
		out.push({ name: bytes.toString('utf8', p + 46, p + 46 + nameLen), size });
		p += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

function guardXlsxContainer(bytes: Buffer) {
	const head = bytes.subarray(0, 4);
	if (head.equals(CFB)) throw unsupported(); // a legacy .xls (or other OLE file) renamed .xlsx
	if (!head.equals(PK)) throw malformed('ບໍ່ແມ່ນໄຟລ໌ .xlsx ທີ່ຖືກຕ້ອງ');
	const entries = zipEntries(bytes);
	const names = entries.map((e) => e.name.toLowerCase());
	if (
		names.some(
			(n) =>
				n.endsWith('vbaproject.bin') ||
				n.startsWith('xl/macrosheets/') ||
				n.startsWith('xl/activex/') ||
				n.startsWith('xl/embeddings/')
		)
	) {
		throw new ReconFileError(
			'MACRO_NOT_ALLOWED',
			'ໄຟລ໌ມີ Macro / ວັດຖຸຝັງ — ບໍ່ອະນຸຍາດ (ໃຊ້ .xlsx ທຳມະດາ)'
		);
	}
	if (names.includes('xl/workbook.bin')) throw unsupported(); // .xlsb
	if (!names.includes('xl/workbook.xml')) throw unsupported(); // a zip that is not a workbook
	const declared = entries.reduce((s, e) => s + e.size, 0);
	if (declared > RECON_LIMITS.maxUncompressedBytes) {
		throw new ReconFileError('FILE_TOO_LARGE', 'ເນື້ອໃນໄຟລ໌ (ຫຼັງແຕກ ZIP) ໃຫຍ່ເກີນກຳນົດ');
	}
}

function readXlsxGrid(bytes: Buffer, cfg: ReconFileConfig): Grid {
	guardXlsxContainer(bytes);
	let wb: XLSX.WorkBook;
	try {
		wb = XLSX.read(bytes, {
			type: 'buffer',
			cellFormula: true, // keep formula TEXT so a formula cell can be REFUSED (never evaluated)
			cellHTML: false,
			cellNF: false,
			cellStyles: false,
			cellDates: false,
			bookVBA: false,
			bookDeps: false,
			sheetStubs: false,
			// never parse more rows than the limit allows (+ header + 1 to detect overflow)
			sheetRows: RECON_LIMITS.maxRows + 2
		});
	} catch {
		throw malformed('ບໍ່ແມ່ນໄຟລ໌ .xlsx ທີ່ຖືກຕ້ອງ');
	}
	const sheetName = cfg.sheetName
		? (wb.SheetNames.find((n) => n === cfg.sheetName) ??
			wb.SheetNames.find((n) => n.toLowerCase() === cfg.sheetName!.toLowerCase()))
		: wb.SheetNames[0];
	const ws = sheetName ? wb.Sheets[sheetName] : undefined;
	if (!ws) {
		throw new ReconFileError(
			'SHEET_NOT_FOUND',
			cfg.sheetName ? `ບໍ່ພົບແຜ່ນງານ "${cfg.sheetName}"` : 'ໄຟລ໌ບໍ່ມີແຜ່ນງານ'
		);
	}
	const full = ws['!fullref'] ?? ws['!ref'];
	if (!full) return { cells: [], formulas: [] };
	const fullRange = XLSX.utils.decode_range(full);
	if (fullRange.e.r - fullRange.s.r + 1 > RECON_LIMITS.maxRows + 1) throw rowLimit();
	const range = XLSX.utils.decode_range(ws['!ref'] ?? full);
	const cells: RawCell[][] = [];
	const formulas: boolean[][] = [];
	for (let r = range.s.r; r <= range.e.r; r++) {
		const row: RawCell[] = [];
		const frow: boolean[] = [];
		for (let c = 0; c <= range.e.c; c++) {
			const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
			frow.push(!!cell?.f);
			if (!cell || cell.v === undefined || cell.v === null) row.push(null);
			else if (cell.t === 'e') row.push({ error: String(cell.w ?? '#ERROR') });
			else if (cell.t === 'n') row.push(Number(cell.v));
			else if (cell.t === 'b') row.push(cell.v ? 'TRUE' : 'FALSE');
			else row.push(String(cell.v));
		}
		cells.push(row);
		formulas.push(frow);
	}
	return { cells, formulas };
}

const rowLimit = () =>
	new ReconFileError(
		'ROW_LIMIT_EXCEEDED',
		`ໄຟລ໌ມີຫຼາຍກວ່າ ${RECON_LIMITS.maxRows.toLocaleString('en-US')} ແຖວ`
	);

// ============================================================================================
// header / column mapping → mapped rows only
// ============================================================================================

const isBlank = (c: RawCell) => c === null || (typeof c === 'string' && c.trim() === '');

function mapGrid(grid: Grid, cfg: ReconFileConfig): RawRow[] {
	const { cells, formulas } = grid;
	const firstData = cfg.hasHeader ? 1 : 0;
	if (cells.length <= firstData) throw new ReconFileError('EMPTY_FILE', 'ໄຟລ໌ບໍ່ມີແຖວຂໍ້ມູນ');

	// resolve each mapped field to a 0-based column index
	const index: Partial<Record<ReconField, number>> = {};
	if (cfg.hasHeader) {
		const header = (cells[0] ?? []).map((h) =>
			typeof h === 'string' || typeof h === 'number' ? String(h).trim().toLowerCase() : ''
		);
		for (const m of cfg.columns) {
			const want = m.column.trim().toLowerCase();
			const hits = header.flatMap((h, i) => (h === want ? [i] : []));
			if (hits.length === 0) {
				throw new ReconFileError(
					'MAPPED_COLUMN_NOT_FOUND',
					`ບໍ່ພົບຖັນ "${m.column}" ໃນແຖວຫົວຂອງໄຟລ໌`,
					{ column: m.column }
				);
			}
			if (hits.length > 1) {
				throw new ReconFileError('DUPLICATE_HEADER', `ຖັນ "${m.column}" ມີຫຼາຍກວ່າ 1 ຖັນ`, {
					column: m.column
				});
			}
			if (formulas[0]?.[hits[0]!]) throw formulaError(1, m.column);
			index[m.field] = hits[0]!;
		}
	} else {
		for (const m of cfg.columns) index[m.field] = Number(m.column) - 1;
	}

	const rows: RawRow[] = [];
	for (let r = firstData; r < cells.length; r++) {
		const line = cells[r] ?? [];
		const values: Partial<Record<ReconField, RawCell>> = {};
		let any = false;
		for (const m of cfg.columns) {
			const i = index[m.field]!;
			if (formulas[r]?.[i]) throw formulaError(r + 1, m.column);
			const v = line[i] ?? null;
			values[m.field] = v;
			if (!isBlank(v)) any = true;
		}
		if (!any) continue; // an empty (or unmapped-only) row is not a result row
		rows.push({ rowNumber: r + 1, values });
		if (rows.length > RECON_LIMITS.maxRows) throw rowLimit();
	}
	if (rows.length === 0) throw new ReconFileError('EMPTY_FILE', 'ໄຟລ໌ບໍ່ມີແຖວຂໍ້ມູນ');
	return rows;
}

const formulaError = (rowNumber: number, column: string) =>
	new ReconFileError(
		'FORMULA_CELL_NOT_ALLOWED',
		`ແຖວ ${rowNumber}, ຖັນ "${column}" ເປັນສູດ (formula) — ບໍ່ອະນຸຍາດ; ກະລຸນາໃຊ້ຄ່າທຳມະດາ`,
		{ rowNumber, column }
	);

/** Excel serial date (1900 system) → UTC calendar date, via SheetJS's own date code parser. */
export function excelSerialToDate(serial: number): Date | null {
	const d = XLSX.SSF.parse_date_code(serial);
	if (!d || !d.y) return null;
	const date = new Date(Date.UTC(d.y, d.m - 1, d.d));
	return Number.isNaN(date.getTime()) ? null : date;
}
