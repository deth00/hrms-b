import { formatAmount } from '../payslipPdf.js';
import type { ColumnDef, RowValue } from './reportDefinitions.js';

/**
 * Phase 17B — how a catalogue value is written into a file. The API row value is the source; nothing is
 * re-computed, only formatted:
 *
 *   type       API / CSV / XLSX (machine form)          PDF (human form)
 *   money      "5552250.00" (XLSX: numeric #,##0.00)    "5,552,250.00"
 *   decimal    "1.50"       (XLSX: numeric)             "1.5"
 *   minutes    197          (XLSX: numeric)             "197" (as the "(ນາທີ)" label; "1,234")
 *   integer    2            (XLSX: numeric)             "2"
 *   date       "2026-09-25" (ISO text)                  "25/09/2026"
 *   datetime   API: ISO instant (UTC); files: Laos wall-clock "2026-09-25 11:16" (Asia/Vientiane)
 *   status     the code ("LATE")                        the Lao label
 */
const LAOS_MS = 7 * 3_600_000;

export function laosDateTime(iso: string): string {
	const d = new Date(new Date(iso).getTime() + LAOS_MS).toISOString();
	return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
}

export function fileValue(col: ColumnDef, v: RowValue): string {
	if (v === null || v === undefined) return '';
	if (col.type === 'datetime') return laosDateTime(String(v));
	return String(v);
}

/** Whole minutes, grouped ("1,234") — every minutes column is labelled "(ນາທີ)" in all formats. */
export function minutesText(n: number): string {
	return Math.round(n).toLocaleString('en-US');
}

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function displayValue(col: ColumnDef, v: RowValue): string {
	if (v === null || v === undefined || v === '') return '—';
	switch (col.type) {
		case 'money':
			return formatAmount(String(v));
		case 'decimal':
			return String(v).replace(/\.?0+$/, '') || '0';
		case 'minutes':
			return minutesText(Number(v));
		case 'date':
			return dmy(String(v));
		case 'datetime': {
			const t = laosDateTime(String(v));
			return `${dmy(t.slice(0, 10))} ${t.slice(11)}`;
		}
		case 'status':
			return col.labels?.[String(v)] ?? String(v);
		default:
			return String(v);
	}
}

/** Numeric columns (right-aligned in the PDF, numeric cells in XLSX). */
export const isNumeric = (col: ColumnDef) =>
	col.type === 'money' ||
	col.type === 'decimal' ||
	col.type === 'minutes' ||
	col.type === 'integer';
