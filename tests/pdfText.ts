import { inflateSync } from 'node:zlib';

/**
 * TEST-ONLY PDF text extractor for the pdfkit output (no OCR): inflates FlateDecode streams, reads each
 * font's ToUnicode CMap and decodes the hex glyph strings of the page content streams (Tj / TJ).
 * Returns, per page, the decoded text fragments in drawing order and the font BaseFont names in use.
 */
interface PdfObject {
	dict: string;
	stream: Buffer | null;
}

function parseObjects(buf: Buffer): Map<number, PdfObject> {
	const s = buf.toString('latin1');
	const out = new Map<number, PdfObject>();
	const re = /(\d+) 0 obj/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s))) {
		const start = m.index + m[0].length;
		const end = s.indexOf('endobj', start);
		const body = s.slice(start, end);
		const si = body.indexOf('stream');
		let dict = body;
		let stream: Buffer | null = null;
		if (si >= 0 && /\/Length/.test(body.slice(0, si))) {
			dict = body.slice(0, si);
			let dataStart = si + 'stream'.length;
			if (body[dataStart] === '\r') dataStart++;
			if (body[dataStart] === '\n') dataStart++;
			const dataEnd = body.lastIndexOf('endstream');
			let raw = Buffer.from(body.slice(dataStart, dataEnd), 'latin1');
			if (/\/FlateDecode/.test(dict)) {
				try {
					raw = inflateSync(raw);
				} catch {
					/* binary font data etc. */
				}
			}
			stream = raw;
		}
		out.set(Number(m[1]), { dict, stream });
		re.lastIndex = end;
	}
	return out;
}

function parseCMap(text: string): Map<string, string> {
	const map = new Map<string, string>();
	// a destination may hold several code points separated by spaces: <0066 0069> ("fi"), <0ecd 0ec9>
	const hexToStr = (raw: string) => {
		const h = raw.replace(/\s+/g, '');
		let r = '';
		for (let i = 0; i < h.length; i += 4) r += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
		return r;
	};
	for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
		for (const e of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
			map.set(e[1]!.toLowerCase().padStart(4, '0'), hexToStr(e[2]!));
		}
	}
	for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
		for (const e of block[1]!.matchAll(
			/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g
		)) {
			const lo = parseInt(e[1]!, 16);
			const hi = parseInt(e[2]!, 16);
			if (e[4]) {
				const base = parseInt(e[4], 16);
				for (let g = lo; g <= hi; g++) {
					map.set(g.toString(16).padStart(4, '0'), String.fromCharCode(base + (g - lo)));
				}
			} else if (e[5]) {
				const items = [...e[5].matchAll(/<([0-9a-fA-F\s]+)>/g)].map((x) => hexToStr(x[1]!));
				for (let g = lo; g <= hi; g++) {
					map.set(g.toString(16).padStart(4, '0'), items[g - lo] ?? '');
				}
			}
		}
	}
	return map;
}

export interface PdfPage {
	text: string[];
	fonts: string[];
}

export function pdfPages(buf: Buffer): PdfPage[] {
	const objs = parseObjects(buf);
	const ref = (d: string, key: string) => {
		const m = d.match(new RegExp(`/${key}\\s+(\\d+) 0 R`));
		return m ? Number(m[1]) : null;
	};
	const pages: PdfPage[] = [];
	for (const [, o] of objs) {
		if (!/\/Type\s*\/Page\b/.test(o.dict) || /\/Type\s*\/Pages/.test(o.dict)) continue;
		// resources: inline or referenced
		let res = o.dict;
		const resRef = ref(o.dict, 'Resources');
		if (resRef !== null) res = objs.get(resRef)?.dict ?? '';
		const fontDict = res.match(/\/Font\s*<<([\s\S]*?)>>/)?.[1] ?? '';
		const fonts = new Map<string, { cmap: Map<string, string>; name: string }>();
		for (const f of fontDict.matchAll(/\/(\w+)\s+(\d+) 0 R/g)) {
			const fo = objs.get(Number(f[2]))!;
			const tu = ref(fo.dict, 'ToUnicode');
			const cmap =
				tu !== null ? parseCMap(objs.get(tu)?.stream?.toString('latin1') ?? '') : new Map();
			fonts.set(f[1]!, { cmap, name: fo.dict.match(/\/BaseFont\s*\/([^\s/>]+)/)?.[1] ?? '' });
		}
		const contentRef = ref(o.dict, 'Contents');
		const content =
			contentRef !== null ? (objs.get(contentRef)?.stream?.toString('latin1') ?? '') : '';
		const text: string[] = [];
		let font: { cmap: Map<string, string> } | undefined;
		const decode = (hex: string) => {
			let r = '';
			for (let i = 0; i < hex.length; i += 4) {
				r += font?.cmap.get(hex.slice(i, i + 4).toLowerCase()) ?? '';
			}
			return r;
		};
		for (const t of content.matchAll(
			/\/(\w+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g
		)) {
			if (t[1]) font = fonts.get(t[1]);
			else if (t[2] !== undefined) {
				text.push([...t[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => decode(x[1]!)).join(''));
			} else if (t[3] !== undefined) text.push(decode(t[3]));
		}
		pages.push({ text, fonts: [...fonts.values()].map((f) => f.name) });
	}
	return pages;
}

export const pdfAllText = (buf: Buffer) =>
	pdfPages(buf)
		.map((p) => p.text.join(''))
		.join('\n');
