import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import { agent, createTestCompany, superAdminCookie } from './helpers.js';

/**
 * Numeric-ID migration M8 — the retained M9 legacy columns (audit §10.2 M8/M9).
 * After the cutover every re-keyed reference keeps its old CUID in `<col>_legacy` and every table keeps
 * `legacy_id`; `legacy_id_map` is kept permanently. The schema declares the `*_legacy` columns with
 * `@ignore` and the map with `@@ignore` so that `prisma migrate diff` against the cut-over database is
 * empty, while Prisma Client never reads, writes or returns them.
 */
const LEGACY_REF_COLUMNS = 234; // = the 199 FK + 31 soft + 4 polymorphic references swapped by M8

describe('M8 legacy retention', () => {
	it('L1 the physical schema carries the retained legacy columns and legacy_id_map', async () => {
		const [cols] = await prisma.$queryRaw<{ n: bigint }[]>`
			SELECT COUNT(*) AS n FROM information_schema.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME LIKE '%\\_legacy' AND COLUMN_TYPE = 'varchar(191)' AND IS_NULLABLE = 'YES'`;
		expect(Number(cols.n)).toBe(LEGACY_REF_COLUMNS);
		const [map] = await prisma.$queryRaw<{ n: bigint }[]>`
			SELECT COUNT(*) AS n FROM information_schema.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'legacy_id_map' AND COLUMN_NAME IN ('legacy_id', 'table_name', 'new_id')`;
		expect(Number(map.n)).toBe(3);
	});

	it('L2 Prisma Client exposes no *Legacy reference field and no LegacyIdMap model', () => {
		const models = Prisma.dmmf.datamodel.models;
		expect(models.some((m) => m.name === 'LegacyIdMap')).toBe(false);
		const leaked = models.flatMap((m) =>
			m.fields.filter((f) => /Legacy$/.test(f.name)).map((f) => `${m.name}.${f.name}`)
		);
		expect(leaked).toEqual([]);
		expect('legacyIdMap' in prisma).toBe(false);
		// legacyId (the row's own old CUID) stays readable on purpose: the audit dual lookup uses it
		expect(Prisma.EmployeeScalarFieldEnum.legacyId).toBe('legacyId');
	});

	it('L3 rows created after the cutover leave every legacy column NULL', async () => {
		const company = await createTestCompany();
		const cookie = await superAdminCookie();
		const res = await agent()
			.post('/api/v1/organization/branches')
			.set('Cookie', cookie)
			.send({ companyId: company.id, code: `BR_M8_${company.id}`, nameLao: 'ສາຂາ M8' });
		expect(res.status).toBe(201);
		const [row] = await prisma.$queryRaw<
			{ legacy_id: string | null; company_id_legacy: string | null; company_id: number }[]
		>`
			SELECT legacy_id, company_id_legacy, company_id FROM branches WHERE id = ${res.body.data.id}`;
		expect(row).toEqual({ legacy_id: null, company_id_legacy: null, company_id: company.id });
	});

	it('L4 API responses never carry a *Legacy field', async () => {
		const cookie = await superAdminCookie();
		const walk = (v: unknown, out: string[] = []): string[] => {
			if (Array.isArray(v)) v.forEach((x) => walk(x, out));
			else if (v && typeof v === 'object')
				for (const [k, x] of Object.entries(v)) {
					if (/Legacy$/.test(k)) out.push(k);
					walk(x, out);
				}
			return out;
		};
		for (const path of [
			'/employees',
			'/organization/branches',
			'/users',
			'/notifications',
			'/audit-events'
		]) {
			const res = await agent().get(`/api/v1${path}`).set('Cookie', cookie);
			expect(res.status, path).toBe(200);
			expect(walk(res.body), path).toEqual([]);
		}
	});
});
