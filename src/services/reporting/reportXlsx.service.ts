import {
	colName,
	neutralizeFormula,
	numericSafe,
	xmlEscape,
	zipStore
} from '../../lib/bankFile.js';
import type { ColumnDef, DetailRow } from './reportDefinitions.js';
import { fileValue, isNumeric } from './reportFormat.js';

/**
 * Phase 17B XLSX — built on the Phase 14 SpreadsheetML writer primitives (`zipStore`, XML escaping,
 * formula neutralisation, numeric-safety check) rather than a new spreadsheet engine: one worksheet,
 * inline strings, fixed styles, STORE-only zip. Rules:
 *   - every text value (codes included: employee / account / branch codes, periods) is an inline string
 *     with the "@" text format — Excel never turns "00123" into 123; text is formula-neutralised;
 *   - money / decimal → numeric cells "#,##0.00"; minutes / integers → numeric cells "0";
 *   - dates are ISO "YYYY-MM-DD" TEXT and date-times Laos wall-clock "YYYY-MM-DD HH:mm" TEXT (documented:
 *     no serial-date / timezone conversion by the spreadsheet);
 *   - no formulas, no macros (.xlsx, no vbaProject), no hyperlinks, no hidden columns — only the
 *     selected columns are written;
 *   - deterministic column widths from the column TYPE (never by scanning content), capped; long
 *     descriptive columns wrap; the header row is frozen.
 */
const STYLE = { text: 1, money: 2, integer: 3, wrap: 4, header: 5 } as const;

const WIDTH: Record<ColumnDef['type'], number> = {
	text: 22,
	date: 12,
	datetime: 17,
	integer: 10,
	minutes: 12,
	money: 16,
	decimal: 10,
	status: 20
};
const WIDE_TEXT = new Set(['description', 'fullName', 'employeeName', 'accountName']);
const MAX_WIDTH = 48;

const widthOf = (c: ColumnDef) => Math.min(MAX_WIDTH, WIDE_TEXT.has(c.key) ? 34 : WIDTH[c.type]);

function cellXml(ref: string, c: ColumnDef, raw: DetailRow[string]): string {
	const value = fileValue(c, raw ?? null);
	if (value === '') return '';
	if (isNumeric(c) && numericSafe(value)) {
		const style = c.type === 'money' || c.type === 'decimal' ? STYLE.money : STYLE.integer;
		return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
	}
	const style = c.key === 'description' ? STYLE.wrap : STYLE.text;
	return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlEscape(
		neutralizeFormula(value)
	)}</t></is></c>`;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

export function buildReportXlsx(
	columns: ColumnDef[],
	rows: DetailRow[],
	sheetName: string
): Buffer {
	const header = columns
		.map(
			(c, i) =>
				`<c r="${colName(i)}1" t="inlineStr" s="${STYLE.header}"><is><t xml:space="preserve">${xmlEscape(
					neutralizeFormula(c.label)
				)}</t></is></c>`
		)
		.join('');
	const body = rows
		.map((row, r) => {
			const cells = columns
				.map((c, i) => cellXml(`${colName(i)}${r + 2}`, c, row[c.key] ?? null))
				.join('');
			return `<row r="${r + 2}">${cells}</row>`;
		})
		.join('');
	const cols = columns
		.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${widthOf(c)}" customWidth="1"/>`)
		.join('');
	const sheet =
		`${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
		`<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
		`<cols>${cols}</cols>` +
		`<sheetData><row r="1">${header}</row>${body}</sheetData></worksheet>`;
	const workbook =
		`${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
		`<sheets><sheet name="${xmlEscape(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
	const workbookRels =
		`${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
		`<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
		`<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
		`</Relationships>`;
	const styles =
		`${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">` +
		`<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
		`<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>` +
		`<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
		`<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
		`<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
		`<cellXfs count="6">` +
		`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
		`<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
		`<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
		`<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
		`<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>` +
		`<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` +
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
