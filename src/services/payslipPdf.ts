import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import type { PayslipSnapshot } from './payslip.service.js';

/**
 * PAYSLIP PDF (Phase 13 §42-43) — rendered from `Payslip.snapshotJson` ONLY (never live data).
 *
 * pdfkit + its bundled fontkit do the OpenType layout (GPOS mark positioning), which is what Lao needs:
 * above/below vowels and tone marks are zero-advance marks positioned on their base consonant (Lao is
 * stored in visual order, so no reordering step is involved). Verified visually (stacked marks such as
 * ກີ່ / ກື້ / ກັ້ render correctly) — see PHASE_13 reports.
 *
 * Fonts are SELF-HOSTED in hr-b/assets/fonts (SIL Open Font License, no CDN):
 *   - Noto Sans Lao (Regular/Bold) — Lao script only (no Latin digits / punctuation), so every text is
 *   - split into runs: Lao code points → Noto Sans Lao, everything else → Noto Sans.
 */
const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
export const FONTS = {
	lao: path.join(FONT_DIR, 'NotoSansLao-Regular.ttf'),
	laoBold: path.join(FONT_DIR, 'NotoSansLao-Bold.ttf'),
	latin: path.join(FONT_DIR, 'NotoSans-Regular.ttf'),
	latinBold: path.join(FONT_DIR, 'NotoSans-Bold.ttf')
};

const LAO = /[຀-໿]/;
const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const SOFT = '#f3f4f6';

/** Splits text into runs of Lao / non-Lao (a space joins the run before it). */
export function runs(text: string) {
	const out: { lao: boolean; t: string }[] = [];
	for (const ch of text) {
		const last = out.at(-1);
		const lao = LAO.test(ch) || (ch === ' ' && !!last?.lao);
		if (last && last.lao === lao) last.t += ch;
		else out.push({ lao, t: ch });
	}
	return out;
}

/** "5552250.00" → "5,552,250.00" — string-only (no float conversion). */
export function formatAmount(value: string | null | undefined) {
	if (value === null || value === undefined || value === '') return '—';
	const neg = value.startsWith('-');
	const [int = '0', frac = '00'] = (neg ? value.slice(1) : value).split('.');
	return `${neg ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac.padEnd(2, '0')}`;
}
const dmy = (iso: string | null | undefined) =>
	iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—';
const monthLabel = (ym: string | null | undefined) =>
	ym ? `${ym.slice(5, 7)}/${ym.slice(0, 4)}` : '—';

export function renderPayslipPdf(s: PayslipSnapshot): Promise<Buffer> {
	const doc = new PDFDocument({
		size: 'A4',
		margins: { top: 42, bottom: 42, left: 44, right: 44 },
		info: { Title: `Payslip ${s.payslipNumber}`, Author: s.company.nameEnglish ?? s.company.code }
	});
	doc.registerFont('lao', FONTS.lao);
	doc.registerFont('laoBold', FONTS.laoBold);
	doc.registerFont('latin', FONTS.latin);
	doc.registerFont('latinBold', FONTS.latinBold);

	const chunks: Buffer[] = [];
	doc.on('data', (c: Buffer) => chunks.push(c));
	const done = new Promise<Buffer>((resolve, reject) => {
		doc.on('end', () => resolve(Buffer.concat(chunks)));
		doc.on('error', reject);
	});

	const left = doc.page.margins.left;
	const width = doc.page.width - left - doc.page.margins.right;

	/** Mixed Lao/Latin text at (x, y) within `w`; returns the height used. */
	function text(
		value: string,
		x: number,
		y: number,
		w: number,
		opts: {
			size?: number;
			bold?: boolean;
			color?: string;
			align?: 'left' | 'right' | 'center';
		} = {}
	) {
		const size = opts.size ?? 9.5;
		doc.fillColor(opts.color ?? INK).fontSize(size);
		const parts = runs(value || '—');
		const fontOf = (lao: boolean) =>
			lao ? (opts.bold ? 'laoBold' : 'lao') : opts.bold ? 'latinBold' : 'latin';
		const align = opts.align ?? 'left';
		if (align !== 'left' && parts.length > 1) {
			// pdfkit mis-places `continued` runs of right / centre aligned text (a later run overlapped an
			// earlier one): measure every run and draw them side by side on ONE line instead
			const widths = parts.map((p) => doc.font(fontOf(p.lao)).widthOfString(p.t));
			const total = widths.reduce((a, b) => a + b, 0);
			let cx = align === 'right' ? x + w - total : x + (w - total) / 2;
			cx = Math.max(x, cx);
			let lineHeight = 0;
			parts.forEach((p, i) => {
				doc.font(fontOf(p.lao));
				doc.text(p.t, cx, y, { lineBreak: false });
				lineHeight = Math.max(lineHeight, doc.currentLineHeight(true));
				cx += widths[i]!;
			});
			return lineHeight;
		}
		doc.x = x;
		doc.y = y;
		parts.forEach((p, i) => {
			doc.font(fontOf(p.lao));
			doc.text(p.t, { width: w, align, continued: i < parts.length - 1 });
		});
		return doc.y - y;
	}
	function ensure(space: number) {
		if (doc.y + space > doc.page.height - doc.page.margins.bottom) {
			doc.addPage();
			doc.y = doc.page.margins.top;
		}
	}
	function rule(y: number, color = LINE) {
		doc
			.moveTo(left, y)
			.lineTo(left + width, y)
			.lineWidth(0.7)
			.strokeColor(color)
			.stroke();
	}

	// ---------- header ----------
	let y = doc.page.margins.top;
	const headW = width * 0.6;
	y += text(s.company.nameLao, left, y, headW, { size: 14, bold: true });
	if (s.company.nameEnglish) y += text(s.company.nameEnglish, left, y, headW, { color: MUTED });
	if (s.company.address) y += text(s.company.address, left, y, headW, { size: 8.5, color: MUTED });
	const contact = [s.company.phone, s.company.email].filter(Boolean).join(' · ');
	if (contact) y += text(contact, left, y, headW, { size: 8.5, color: MUTED });
	let ry = doc.page.margins.top;
	ry += text('ໃບແຈ້ງເງິນເດືອນ', left + headW, ry, width - headW, {
		size: 16,
		bold: true,
		align: 'right'
	});
	ry += text('Payslip', left + headW, ry, width - headW, { color: MUTED, align: 'right' });
	ry += text(`ເລກທີ ${s.payslipNumber}`, left + headW, ry, width - headW, {
		size: 8.5,
		color: MUTED,
		align: 'right'
	});
	y = Math.max(y, ry) + 10;
	rule(y, '#d1d5db');
	y += 12;

	// ---------- employee + period ----------
	const colW = width / 2 - 8;
	const pair = (label: string, value: string | null | undefined, x: number, yy: number) => {
		text(label, x, yy, 110, { size: 8.5, color: MUTED });
		return Math.max(16, text(value ?? '—', x + 112, yy, colW - 112, { size: 9.5 }) + 4);
	};
	let ly = y;
	ly += pair('ລະຫັດພະນັກງານ', s.employee.employeeCode, left, ly);
	ly += pair('ຊື່ ແລະ ນາມສະກຸນ', s.employee.name, left, ly);
	ly += pair('ພະແນກ', s.employee.department, left, ly);
	ly += pair('ຕຳແໜ່ງ', s.employee.position, left, ly);
	if (s.employee.branch) ly += pair('ສາຂາ', s.employee.branch, left, ly);
	const rx = left + width / 2 + 8;
	let py = y;
	py += pair('ງວດ', s.payroll.periodName, rx, py);
	py += pair('ໄລຍະ', `${dmy(s.payroll.periodStart)} – ${dmy(s.payroll.periodEnd)}`, rx, py);
	py += pair('ວັນຈ່າຍ', dmy(s.payroll.payDate), rx, py);
	if (s.payroll.payrollMonth)
		py += pair('ເດືອນເງິນເດືອນ', monthLabel(s.payroll.payrollMonth), rx, py);
	if (s.payroll.cycleNumber)
		py += pair('ຮອບ', `${s.payroll.cycleNumber} / ${s.payroll.cyclesPerMonth ?? 2}`, rx, py);
	py += pair('ສະກຸນເງິນ', s.payroll.currencyCode, rx, py);
	y = Math.max(ly, py) + 6;

	if (s.compensation) {
		const bits = [
			s.compensation.monthlyBaseSalary
				? `ເງິນເດືອນພື້ນຖານລາຍເດືອນ ${formatAmount(s.compensation.monthlyBaseSalary)}`
				: null,
			s.compensation.cycleBaseSalary
				? `ເງິນເດືອນຮອບນີ້ ${formatAmount(s.compensation.cycleBaseSalary)}`
				: null
		].filter((b): b is string => !!b);
		if (bits.length > 0) {
			y += text(bits.join(' · '), left, y, width, { size: 8.5, color: MUTED }) + 6;
		}
	}

	// ---------- tables ----------
	function table(
		title: string,
		rows: { label: string; code?: string; amount: string; note?: string }[],
		empty = 'ບໍ່ມີ'
	) {
		ensure(40 + rows.length * 18);
		y = doc.y > y ? doc.y : y;
		doc.rect(left, y, width, 20).fill(SOFT);
		text(title, left + 8, y + 4, width * 0.6, { size: 9.5, bold: true });
		text('ຈຳນວນເງິນ', left + width * 0.6, y + 4, width * 0.4 - 8, {
			size: 8.5,
			color: MUTED,
			align: 'right'
		});
		y += 22;
		if (rows.length === 0) {
			y += text(empty, left + 8, y, width - 16, { size: 9, color: MUTED }) + 6;
		}
		for (const r of rows) {
			ensure(20);
			const label = r.code ? `${r.label} (${r.code})` : r.label;
			const h = text(label, left + 8, y, width * 0.66, { size: 9.5 });
			text(r.amount, left + width * 0.66, y, width * 0.34 - 8, { size: 9.5, align: 'right' });
			y += Math.max(h, 13) + 3;
			if (r.note) y += text(r.note, left + 8, y - 2, width - 16, { size: 8, color: MUTED }) + 2;
			rule(y - 1);
			y += 3;
		}
		y += 8;
	}

	table(
		'ລາຍຮັບ',
		s.earnings.map((e) => ({ label: e.nameLao, code: e.code, amount: formatAmount(e.amount) }))
	);
	table(
		'ລາຍຈ່າຍ / ລາຍການຫັກ',
		s.deductions.map((d) => ({ label: d.nameLao, code: d.code, amount: formatAmount(d.amount) }))
	);
	if (s.statutory) {
		const rows: { label: string; amount: string; note?: string }[] = [];
		for (const line of [s.statutory.pit, s.statutory.employeeSocialSecurity]) {
			if (!line) continue;
			rows.push(
				line.direction === 'CREDIT'
					? {
							label: `${line.nameLao} — ຄືນເງິນ (ເພີ່ມເຂົ້າ)`,
							amount: `+${formatAmount(line.amount)}`,
							note: 'ເງິນທີ່ຫັກເກີນໃນຮອບກ່ອນ — ບວກຄືນເຂົ້າເງິນສຸດທິ'
						}
					: { label: line.nameLao, amount: formatAmount(line.amount) }
			);
		}
		table('ພາສີ ແລະ ປະກັນສັງຄົມ (ຫັກຈາກພະນັກງານ)', rows);
	}

	// ---------- totals ----------
	ensure(90);
	const tx = left + width * 0.45;
	const tw = width * 0.55;
	const total = (label: string, value: string, bold = false) => {
		text(label, tx, y, tw * 0.55, { size: bold ? 10.5 : 9.5, bold });
		text(value, tx + tw * 0.55, y, tw * 0.45 - 8, {
			size: bold ? 10.5 : 9.5,
			bold,
			align: 'right'
		});
		y += bold ? 18 : 15;
	};
	total('ລາຍຮັບລວມ', formatAmount(s.totals.totalEarnings));
	total('ລາຍຈ່າຍລວມ', formatAmount(s.totals.totalDeductions));
	doc
		.moveTo(tx, y)
		.lineTo(left + width, y)
		.lineWidth(0.8)
		.strokeColor('#9ca3af')
		.stroke();
	y += 5;
	total('ເງິນສຸດທິ', `${formatAmount(s.totals.netPay)} ${s.payroll.currencyCode}`, true);
	y += 6;

	if (s.statutory?.employerSocialSecurity) {
		ensure(40);
		y +=
			text(
				`ຂໍ້ມູນເພີ່ມເຕີມ: ປະກັນສັງຄົມສ່ວນນາຍຈ້າງ ${formatAmount(s.statutory.employerSocialSecurity)} ${s.payroll.currencyCode} — ນາຍຈ້າງເປັນຜູ້ຈ່າຍ, ບໍ່ໄດ້ຫັກຈາກເງິນເດືອນ ແລະ ບໍ່ລວມໃນເງິນສຸດທິ`,
				left,
				y,
				width,
				{ size: 8.5, color: MUTED }
			) + 6;
	}

	// ---------- footer ----------
	ensure(40);
	y += 6;
	rule(y);
	y += 6;
	text(
		`ເລກທີໃບແຈ້ງເງິນເດືອນ ${s.payslipNumber} · ອອກວັນທີ ${dmy(s.issuedAt.slice(0, 10))} · ເອກະສານນີ້ອອກໂດຍລະບົບ LaoHR`,
		left,
		y,
		width,
		{ size: 8, color: MUTED }
	);

	doc.end();
	return done;
}
