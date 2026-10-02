import { crc32 } from 'node:zlib';

/**
 * BANK FILE WRITERS (Phase 14 §29-31, §56-57) — CSV and XLSX from already-resolved cell values.
 *
 * DETERMINISTIC BY DESIGN: the same rows + profile always produce the same bytes, so a re-export has
 * the same SHA-256 as the first export. Nothing time- or environment-dependent is written: the XLSX
 * zip entries carry a fixed 1980-01-01 timestamp and use the STORE method (no compression, so the
 * output does not even depend on the zlib version). No workbook "created/modified" properties.
 *
 * FORMULA INJECTION: every TEXT cell (headers included) that starts with = + - @ TAB or CR gets a
 * leading apostrophe, so no spreadsheet program can evaluate it. Amounts are generated numbers.
 *
 * ACCOUNT NUMBERS are TEXT: in XLSX an inline string with the "@" (text) number format, so Excel can
 * never turn "001234567890" into 1234567890 or 1.23457E+11. (A CSV has no types: its bytes keep the
 * exact digits; opening a CSV directly in Excel may still re-interpret it — use XLSX or import as text.)
 */
export type CellKind = 'text' | 'account' | 'amount';
export interface Cell {
	kind: CellKind;
	value: string;
}

const FORMULA_START = /^[=+\-@\t\r]/;
/** Neutralizes spreadsheet formula syntax at the start of a text value. */
export const neutralizeFormula = (v: string) => (FORMULA_START.test(v) ? `'${v}` : v);

const cellText = (c: Cell) => (c.kind === 'amount' ? c.value : neutralizeFormula(c.value));

// ============================================================================================
// CSV
// ============================================================================================

export interface CsvOptions {
	delimiter: string;
	includeHeader: boolean;
	bom: boolean;
}

function csvField(value: string, delimiter: string) {
	const needsQuotes =
		value.includes(delimiter) ||
		value.includes('"') ||
		value.includes('\n') ||
		value.includes('\r') ||
		/^\s|\s$/.test(value);
	return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC 4180 style: CRLF line endings, quotes doubled, UTF-8 (optionally with a BOM for Excel). */
export function buildCsv(headers: string[], rows: Cell[][], o: CsvOptions): Buffer {
	const lines: string[] = [];
	if (o.includeHeader) {
		lines.push(headers.map((h) => csvField(neutralizeFormula(h), o.delimiter)).join(o.delimiter));
	}
	for (const row of rows) {
		lines.push(row.map((c) => csvField(cellText(c), o.delimiter)).join(o.delimiter));
	}
	const text = lines.map((l) => `${l}\r\n`).join('');
	const body = Buffer.from(text, 'utf8');
	return o.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

// ============================================================================================
// XLSX (minimal SpreadsheetML: one worksheet, inline strings, 3 cell styles)
// ============================================================================================

// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
export const xmlEscape = (v: string) =>
	v
		.replace(INVALID_XML, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

export function colName(i: number) {
	let n = i + 1;
	let s = '';
	while (n > 0) {
		const r = (n - 1) % 26;
		s = String.fromCharCode(65 + r) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}

/** A number cell only when it round-trips exactly through an IEEE double (≤ 15 significant digits). */
export const numericSafe = (v: string) =>
	/^-?\d+(\.\d+)?$/.test(v) && v.replace(/[-.]/g, '').replace(/^0+/, '').length <= 15;

const STYLE_TEXT = 1; // numFmtId 49 = "@"
const STYLE_AMOUNT = 2; // numFmtId 4 = "#,##0.00"

function cellXml(ref: string, c: Cell) {
	if (c.kind === 'amount' && numericSafe(c.value)) {
		return `<c r="${ref}" s="${STYLE_AMOUNT}"><v>${c.value}</v></c>`;
	}
	const text = cellText(c);
	return `<c r="${ref}" t="inlineStr" s="${STYLE_TEXT}"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

export function buildXlsx(
	headers: string[],
	rows: Cell[][],
	o: { includeHeader: boolean; sheetName?: string }
): Buffer {
	const all: Cell[][] = [
		...(o.includeHeader ? [headers.map((h) => ({ kind: 'text' as const, value: h }))] : []),
		...rows
	];
	const width = Math.max(headers.length, 1);
	const sheetRows = all
		.map((row, r) => {
			const cells = row.map((c, i) => cellXml(`${colName(i)}${r + 1}`, c)).join('');
			return `<row r="${r + 1}">${cells}</row>`;
		})
		.join('');
	const sheet =
		`${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
		`<cols><col min="1" max="${width}" width="22" customWidth="1"/></cols>` +
		`<sheetData>${sheetRows}</sheetData></worksheet>`;
	const sheetName = xmlEscape((o.sheetName ?? 'Payments').slice(0, 31));
	const workbook =
		`${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
		`<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
	const workbookRels =
		`${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
		`<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
		`<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
		`</Relationships>`;
	const styles =
		`${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">` +
		`<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>` +
		`<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
		`<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
		`<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
		`<cellXfs count="3">` +
		`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
		`<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
		`<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
		`</cellXfs>` +
		`<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
		`</styleSheet>`;
	const contentTypes =
		`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
		`<Default Extension="xml" ContentType="application/xml"/>` +
		`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
		`<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
		`<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
		`</Types>`;
	const rootRels =
		`${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
		`<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
		`</Relationships>`;
	return zipStore([
		['[Content_Types].xml', contentTypes],
		['_rels/.rels', rootRels],
		['xl/workbook.xml', workbook],
		['xl/_rels/workbook.xml.rels', workbookRels],
		['xl/styles.xml', styles],
		['xl/worksheets/sheet1.xml', sheet]
	]);
}

// ============================================================================================
// minimal ZIP (STORE only, fixed timestamps) — deterministic
// ============================================================================================

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

export function zipStore(files: [string, string][]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of files) {
		const nameBuf = Buffer.from(name, 'utf8');
		const data = Buffer.from(content, 'utf8');
		const crc = crc32(data) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(0, 8); // STORE
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, nameBuf, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(DOS_TIME, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30); // extra
		central.writeUInt16LE(0, 32); // comment
		central.writeUInt16LE(0, 34); // disk
		central.writeUInt16LE(0, 36); // internal attrs
		central.writeUInt32LE(0, 38); // external attrs
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBuf);
		offset += local.length + nameBuf.length + data.length;
	}
	const centralSize = centrals.reduce((n, b) => n + b.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);
	return Buffer.concat([...locals, ...centrals, end]);
}

/** Reads a STORE-only zip (tests / integrity checks) → { name: text }. */
export function unzipStore(buf: Buffer): Record<string, string> {
	const out: Record<string, string> = {};
	let p = 0;
	while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
		const method = buf.readUInt16LE(p + 8);
		const size = buf.readUInt32LE(p + 18);
		const nameLen = buf.readUInt16LE(p + 26);
		const extraLen = buf.readUInt16LE(p + 28);
		const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
		const start = p + 30 + nameLen + extraLen;
		if (method !== 0) throw new Error('only STORE entries are supported');
		out[name] = buf.toString('utf8', start, start + size);
		p = start + size;
	}
	return out;
}
