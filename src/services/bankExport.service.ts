import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { BankExportProfile, PayrollPaymentItem } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { idCol } from '../lib/sqlIds.js';
import { Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import { moneyString, ZERO } from '../lib/money.js';
import {
	decryptSensitive,
	maskAccountNumber,
	SensitiveDecryptionError
} from '../lib/sensitiveCrypto.js';
import { buildCsv, buildXlsx, type Cell } from '../lib/bankFile.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import {
	EXPORT_FIELDS,
	type ExportField,
	type ExportProfileCreateInput,
	type ExportProfileUpdateInput
} from '../validation/payment.schema.js';

/**
 * BANK EXPORT PROFILES + BANK FILE EXPORT (Phase 14 §24-32, §55-57, §63).
 *
 *  - GENERIC, configurable layouts only (CSV / XLSX); no bank-specific format is hard-coded and a column
 *    can only be one of the predefined safe fields (EXPORT_FIELDS) — never an arbitrary DB field.
 *  - The bank file contains the BANK_TRANSFER items of the batch (CASH items are paid by hand and are
 *    NOT in the file; they still move EXPORTED → PAID / FAILED through manual confirmation).
 *  - ACCOUNT_NUMBER is decrypted ONLY here, only while generating an authorized export
 *    (payroll.payment.export + employees.view_all). Previews show "••••1234".
 *  - NO file content is stored: a PaymentBatchExport row keeps the frozen profile configuration, the
 *    file name, row count and SHA-256; a re-export regenerates the bytes from the immutable items and
 *    must hash identically (otherwise EXPORT_INTEGRITY_MISMATCH — nothing is returned).
 *  - First export of a VALIDATED batch: items READY → EXPORTED, batch → EXPORTED. Exporting never marks
 *    anything PAID. The batch row lock + unique (batch, profile) keep concurrent exports to ONE record.
 */
type Tx = Prisma.TransactionClient;

export const FIELD_LABEL: Record<ExportField, string> = {
	BATCH_NUMBER: 'ເລກທີຊຸດການຈ່າຍ (Batch Number)',
	PAYMENT_DATE: 'ວັນທີຈ່າຍ (Payment Date)',
	EMPLOYEE_CODE: 'ລະຫັດພະນັກງານ (Employee Code)',
	EMPLOYEE_NAME: 'ຊື່ພະນັກງານ (Employee Name)',
	BANK_CODE: 'ລະຫັດທະນາຄານ (Bank Code)',
	BANK_NAME: 'ຊື່ທະນາຄານ (Bank Name)',
	ACCOUNT_NAME: 'ຊື່ບັນຊີ (Account Name)',
	ACCOUNT_NUMBER: 'ເລກບັນຊີ (Account Number) — ຂໍ້ມູນລະອຽດອ່ອນ, ມີສະເພາະໃນໄຟລ໌ທີ່ສົ່ງອອກ',
	AMOUNT: 'ຈຳນວນເງິນ (Amount)',
	CURRENCY: 'ສະກຸນເງິນ (Currency)',
	PAYMENT_REFERENCE: 'ເລກອ້າງອີງການໂອນ (Payment Reference)',
	INSTRUCTION_REFERENCE:
		'ເລກອ້າງອີງຄຳສັ່ງຈ່າຍ (Instruction Reference) — ແນະນຳ: ໃຊ້ຈັບຄູ່ຜົນຈາກທະນາຄານ'
};

/** The safe GENERIC template — deliberately NOT labelled as any bank's format. */
export const GENERIC_TEMPLATE = {
	code: 'GENERIC_CSV',
	name: 'ໄຟລ໌ CSV ທົ່ວໄປ (Generic CSV)',
	format: 'CSV' as const,
	delimiter: ',' as const,
	includeHeader: true,
	encoding: 'UTF-8' as const,
	dateFormat: 'YYYY-MM-DD' as const,
	columns: [
		{ field: 'EMPLOYEE_CODE' as const, header: 'Employee Code' },
		{ field: 'EMPLOYEE_NAME' as const, header: 'Employee Name' },
		{ field: 'BANK_CODE' as const, header: 'Bank Code' },
		{ field: 'ACCOUNT_NAME' as const, header: 'Account Name' },
		{ field: 'ACCOUNT_NUMBER' as const, header: 'Account Number' },
		{ field: 'AMOUNT' as const, header: 'Amount' },
		{ field: 'CURRENCY' as const, header: 'Currency' },
		// Phase 15 — the preferred matching key for bank reconciliation (NEW profiles only; existing
		// profiles and their frozen exports are never edited)
		{ field: 'INSTRUCTION_REFERENCE' as const, header: 'Instruction Reference' }
	]
};

export const BANK_FORMAT_WARNING =
	'ກະລຸນາຢືນຢັນຮູບແບບໄຟລ໌ທີ່ທະນາຄານຕ້ອງການ ກ່ອນນຳໄຟລ໌ນີ້ໄປໃຊ້ຈ່າຍເງິນ (Confirm the required file format with your bank before using this file for payment.)';

export function exportFieldCatalog() {
	return {
		fields: EXPORT_FIELDS.map((f) => ({
			field: f,
			label: FIELD_LABEL[f],
			sensitive: f === 'ACCOUNT_NUMBER',
			recommended: f === 'INSTRUCTION_REFERENCE'
		})),
		template: GENERIC_TEMPLATE,
		warning: BANK_FORMAT_WARNING
	};
}

// ---------- profile config (what an export freezes) ----------
export interface ProfileConfig {
	code: string;
	name: string;
	format: 'CSV' | 'XLSX';
	delimiter: string | null;
	includeHeader: boolean;
	encoding: string;
	dateFormat: string;
	columns: { field: ExportField; header: string }[];
}

function configOf(p: BankExportProfile): ProfileConfig {
	return {
		code: p.code,
		name: p.name,
		format: p.format,
		delimiter: p.delimiter,
		includeHeader: p.includeHeader,
		encoding: p.encoding,
		dateFormat: p.dateFormat,
		columns: (p.columnMappingJson as unknown as ProfileConfig['columns']) ?? []
	};
}

function presentProfile(p: BankExportProfile) {
	const c = configOf(p);
	return {
		id: p.id,
		companyId: p.companyId,
		code: c.code,
		name: c.name,
		format: c.format,
		delimiter: c.delimiter,
		includeHeader: c.includeHeader,
		encoding: c.encoding,
		dateFormat: c.dateFormat,
		columns: c.columns,
		status: p.status,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt
	};
}

// ============================================================================================
// profiles CRUD
// ============================================================================================

function normalizeProfile(input: ExportProfileUpdateInput) {
	return {
		name: input.name,
		format: input.format,
		// CSV needs a delimiter (default ","); XLSX has none
		delimiter: input.format === 'CSV' ? (input.delimiter ?? ',') : null,
		includeHeader: input.includeHeader,
		encoding: input.format === 'CSV' ? input.encoding : 'UTF-8',
		dateFormat: input.dateFormat,
		columnMappingJson: input.columns as unknown as Prisma.InputJsonArray,
		...(input.status ? { status: input.status } : {})
	};
}

export async function listProfiles(query: { companyId?: number; status?: 'ACTIVE' | 'INACTIVE' }) {
	const rows = await prisma.bankExportProfile.findMany({
		where: {
			...(query.companyId ? { companyId: query.companyId } : {}),
			...(query.status ? { status: query.status } : {})
		},
		orderBy: [{ status: 'asc' }, { code: 'asc' }]
	});
	return { items: rows.map(presentProfile) };
}

export async function getProfile(id: number) {
	const p = await prisma.bankExportProfile.findUnique({ where: { id } });
	if (!p) throw Errors.notFound('ບໍ່ພົບຮູບແບບໄຟລ໌ທະນາຄານ');
	return presentProfile(p);
}

export async function createProfile(input: ExportProfileCreateInput, actorUserId: number) {
	const company = await prisma.company.findUnique({
		where: { id: input.companyId },
		select: { id: true }
	});
	if (!company) throw Errors.badRequest('COMPANY_NOT_FOUND', 'ບໍ່ພົບບໍລິສັດ');
	try {
		const p = await prisma.$transaction(async (tx) => {
			const row = await tx.bankExportProfile.create({
				data: {
					companyId: input.companyId,
					code: input.code,
					...normalizeProfile(input),
					createdByUserId: actorUserId
				}
			});
			await writeAuditEvent(tx, {
				action: AuditAction.BANK_EXPORT_PROFILE_CREATED,
				entityType: AuditEntity.BANK_EXPORT_PROFILE,
				entityId: row.id,
				companyId: row.companyId,
				actorUserId,
				metadata: {
					exportProfileId: row.id,
					code: row.code,
					format: row.format,
					columns: input.columns.map((c) => c.field)
				}
			});
			return row;
		});
		return presentProfile(p);
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict('EXPORT_PROFILE_CODE_EXISTS', 'ລະຫັດນີ້ມີຢູ່ແລ້ວໃນບໍລິສັດນີ້');
		}
		throw err;
	}
}

/** Editing a profile never changes an existing export (each export froze its own configuration). */
export async function updateProfile(
	id: number,
	input: ExportProfileUpdateInput,
	actorUserId: number
) {
	const p = await prisma.$transaction(async (tx) => {
		const before = await tx.bankExportProfile.findUnique({ where: { id } });
		if (!before) throw Errors.notFound('ບໍ່ພົບຮູບແບບໄຟລ໌ທະນາຄານ');
		const row = await tx.bankExportProfile.update({ where: { id }, data: normalizeProfile(input) });
		await writeAuditEvent(tx, {
			action: AuditAction.BANK_EXPORT_PROFILE_UPDATED,
			entityType: AuditEntity.BANK_EXPORT_PROFILE,
			entityId: id,
			companyId: row.companyId,
			actorUserId,
			metadata: {
				exportProfileId: id,
				code: row.code,
				format: row.format,
				status: row.status,
				columns: input.columns.map((c) => c.field)
			}
		});
		return row;
	});
	return presentProfile(p);
}

// ============================================================================================
// file generation
// ============================================================================================

function formatDate(d: Date, fmt: string) {
	const iso = d.toISOString().slice(0, 10);
	const [y, m, day] = iso.split('-') as [string, string, string];
	switch (fmt) {
		case 'DD/MM/YYYY':
			return `${day}/${m}/${y}`;
		case 'DD-MM-YYYY':
			return `${day}-${m}-${y}`;
		case 'MM/DD/YYYY':
			return `${m}/${day}/${y}`;
		case 'YYYYMMDD':
			return `${y}${m}${day}`;
		default:
			return iso;
	}
}

/** ASCII-safe: PAY-{periodCode}-{YYYYMMDD}.{csv|xlsx} (the batch number is already normalized). */
export function exportFileName(batchNumber: string, paymentDate: Date, format: 'CSV' | 'XLSX') {
	const safe = batchNumber.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'PAY';
	return `${safe}-${formatDate(paymentDate, 'YYYYMMDD')}.${format === 'CSV' ? 'csv' : 'xlsx'}`;
}

interface BatchForFile {
	batchNumber: string;
	paymentDate: Date;
	currencyCode: string;
}

/** The rows of the bank file: BANK_TRANSFER items (not cancelled), in a stable order. */
function fileItems(items: PayrollPaymentItem[]) {
	return items
		.filter(
			(i) =>
				i.paymentMethod === 'BANK_TRANSFER' && i.status !== 'CANCELLED' && i.status !== 'BLOCKED'
		)
		.sort((a, b) =>
			a.employeeCodeSnapshot === b.employeeCodeSnapshot
				? a.id < b.id
					? -1
					: 1
				: a.employeeCodeSnapshot < b.employeeCodeSnapshot
					? -1
					: 1
		);
}

function accountNumberOf(i: PayrollPaymentItem) {
	if (!i.accountNumberEncryptedSnapshot) {
		throw Errors.conflict('BANK_ACCOUNT_DECRYPTION_FAILED', 'ບໍ່ພົບເລກບັນຊີຂອງລາຍການຈ່າຍ');
	}
	try {
		return decryptSensitive({
			ciphertext: i.accountNumberEncryptedSnapshot,
			iv: i.accountNumberIvSnapshot ?? '',
			authTag: i.accountNumberAuthTagSnapshot ?? '',
			keyVersion: i.encryptionKeyVersion ?? 1
		});
	} catch (err) {
		if (err instanceof SensitiveDecryptionError) {
			throw Errors.conflict(
				'BANK_ACCOUNT_DECRYPTION_FAILED',
				`ຖອດລະຫັດເລກບັນຊີຂອງ ${i.employeeCodeSnapshot} ບໍ່ໄດ້`
			);
		}
		throw err;
	}
}

function cellFor(
	field: ExportField,
	i: PayrollPaymentItem,
	b: BatchForFile,
	cfg: ProfileConfig,
	mode: 'file' | 'preview'
): Cell {
	const text = (value: string | null | undefined): Cell => ({ kind: 'text', value: value ?? '' });
	switch (field) {
		case 'BATCH_NUMBER':
			return text(b.batchNumber);
		case 'PAYMENT_DATE':
			return text(formatDate(b.paymentDate, cfg.dateFormat));
		case 'EMPLOYEE_CODE':
			return text(i.employeeCodeSnapshot);
		case 'EMPLOYEE_NAME':
			return text(i.employeeNameSnapshot);
		case 'BANK_CODE':
			return text(i.bankCodeSnapshot);
		case 'BANK_NAME':
			return text(i.bankNameSnapshot);
		case 'ACCOUNT_NAME':
			return text(i.accountNameSnapshot);
		case 'ACCOUNT_NUMBER':
			return {
				kind: 'account',
				value:
					mode === 'file' ? accountNumberOf(i) : (maskAccountNumber(i.accountNumberLast4) ?? '')
			};
		case 'AMOUNT':
			return { kind: 'amount', value: moneyString(i.amount) };
		case 'CURRENCY':
			return text(i.currencyCode);
		case 'PAYMENT_REFERENCE':
			return text(i.transferReference);
		case 'INSTRUCTION_REFERENCE':
			// Phase 14 (legacy) items have none — an empty cell, never a made-up value
			return text(i.instructionReference);
	}
}

function resolveTable(
	items: PayrollPaymentItem[],
	b: BatchForFile,
	cfg: ProfileConfig,
	mode: 'file' | 'preview'
) {
	const rows = fileItems(items);
	return {
		headers: cfg.columns.map((c) => c.header),
		cells: rows.map((i) => cfg.columns.map((c) => cellFor(c.field, i, b, cfg, mode))),
		rowCount: rows.length,
		totalAmount: rows.reduce((s, i) => s.plus(i.amount), ZERO)
	};
}

export function generateFile(items: PayrollPaymentItem[], b: BatchForFile, cfg: ProfileConfig) {
	const t = resolveTable(items, b, cfg, 'file');
	const bytes =
		cfg.format === 'CSV'
			? buildCsv(t.headers, t.cells, {
					delimiter: cfg.delimiter === 'TAB' ? '\t' : (cfg.delimiter ?? ','),
					includeHeader: cfg.includeHeader,
					bom: cfg.encoding === 'UTF-8-BOM'
				})
			: buildXlsx(t.headers, t.cells, { includeHeader: cfg.includeHeader, sheetName: 'Payments' });
	return {
		bytes,
		hash: createHash('sha256').update(bytes).digest('hex'),
		fileName: exportFileName(b.batchNumber, b.paymentDate, cfg.format),
		contentType:
			cfg.format === 'CSV'
				? 'text/csv; charset=utf-8'
				: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		rowCount: t.rowCount,
		totalAmount: t.totalAmount
	};
}

async function loadProfileFor(db: Tx | typeof prisma, profileId: number, companyId: number) {
	const profile = await db.bankExportProfile.findUnique({ where: { id: profileId } });
	// another company's profile is indistinguishable from a missing one
	if (!profile || profile.companyId !== companyId) {
		throw Errors.notFound('ບໍ່ພົບຮູບແບບໄຟລ໌ທະນາຄານ');
	}
	return profile;
}

const EXPORTABLE = [
	'VALIDATED',
	'EXPORTED',
	'PARTIALLY_PAID',
	'PAID',
	'PARTIALLY_REVERSED',
	'REVERSED'
];

/** GET /payroll/payment-batches/:id/export-preview — account numbers MASKED; no plaintext ever. */
export async function exportPreview(batchId: number, profileId: number) {
	const batch = await prisma.payrollPaymentBatch.findUnique({
		where: { id: batchId },
		include: { items: true, exports: { where: { bankExportProfileId: profileId } } }
	});
	if (!batch) throw Errors.notFound('ບໍ່ພົບຊຸດການຈ່າຍ');
	const profile = await loadProfileFor(prisma, profileId, batch.companyId);
	const existing = batch.exports[0] ?? null;
	const cfg = existing
		? (existing.profileSnapshotJson as unknown as ProfileConfig)
		: configOf(profile);
	const t = resolveTable(batch.items, batch, cfg, 'preview');
	return {
		format: cfg.format,
		fileName: exportFileName(batch.batchNumber, batch.paymentDate, cfg.format),
		headers: cfg.includeHeader ? t.headers : [],
		columns: cfg.columns,
		rows: t.cells.map((r) => r.map((c) => c.value)),
		rowCount: t.rowCount,
		totalAmount: moneyString(t.totalAmount),
		cashItemsExcluded: batch.items.filter(
			(i) => i.paymentMethod === 'CASH' && i.status !== 'CANCELLED'
		).length,
		exportable: EXPORTABLE.includes(batch.status),
		existingExport: existing
			? {
					id: existing.id,
					exportNumber: existing.exportNumber,
					fileHash: existing.fileHash,
					createdAt: existing.createdAt
				}
			: null,
		warning: BANK_FORMAT_WARNING
	};
}

/**
 * POST /payroll/payment-batches/:id/export — returns the file bytes. VALIDATED (first export) or an
 * already exported batch (re-export). Same profile again → the SAME bytes/hash (no new record, no
 * status change, logged as EXPORT_DOWNLOADED); another profile → a new export record.
 */
export async function exportBatch(batchId: number, profileId: number, actorUserId: number) {
	const run = async () =>
		prisma.$transaction(
			async (tx) => {
				await tx.$queryRaw`SELECT ${idCol()} AS id FROM payroll_payment_batches WHERE ${idCol()} = ${batchId} FOR UPDATE`;
				const batch = await tx.payrollPaymentBatch.findUnique({
					where: { id: batchId },
					include: { items: true }
				});
				if (!batch) throw Errors.notFound('ບໍ່ພົບຊຸດການຈ່າຍ');
				if (!EXPORTABLE.includes(batch.status)) {
					throw Errors.conflict(
						'PAYMENT_BATCH_NOT_VALIDATED',
						'ສົ່ງອອກໄຟລ໌ໄດ້ຫຼັງຈາກກວດສອບຊຸດການຈ່າຍແລ້ວ (VALIDATED) ເທົ່ານັ້ນ'
					);
				}
				const profile = await loadProfileFor(tx, profileId, batch.companyId);
				const existing = await tx.paymentBatchExport.findUnique({
					where: {
						paymentBatchId_bankExportProfileId: {
							paymentBatchId: batchId,
							bankExportProfileId: profileId
						}
					}
				});

				if (existing) {
					// RE-EXPORT: regenerate from the frozen configuration + immutable items; must be identical
					const cfg = existing.profileSnapshotJson as unknown as ProfileConfig;
					const file = generateFile(batch.items, batch, cfg);
					if (file.hash !== existing.fileHash) {
						throw Errors.conflict(
							'EXPORT_INTEGRITY_MISMATCH',
							'ໄຟລ໌ທີ່ສ້າງໃໝ່ບໍ່ກົງກັບໄຟລ໌ທີ່ສົ່ງອອກຄັ້ງທຳອິດ — ກະລຸນາຕິດຕໍ່ຜູ້ດູແລລະບົບ'
						);
					}
					await writeAuditEvent(tx, {
						action: AuditAction.PAYROLL_PAYMENT_EXPORT_DOWNLOADED,
						entityType: AuditEntity.PAYROLL_PAYMENT_BATCH,
						entityId: batchId,
						companyId: batch.companyId,
						actorUserId,
						metadata: {
							batchId,
							runId: batch.payrollRunId,
							exportId: existing.id,
							exportProfileId: profileId,
							rowCount: existing.rowCount,
							fileHash: existing.fileHash
						}
					});
					return { ...file, exportId: existing.id, firstExport: false };
				}

				if (profile.status !== 'ACTIVE') {
					throw Errors.conflict('EXPORT_PROFILE_INACTIVE', 'ຮູບແບບໄຟລ໌ນີ້ຖືກປິດການໃຊ້ງານແລ້ວ');
				}
				const cfg = configOf(profile);
				const file = generateFile(batch.items, batch, cfg);
				const count = await tx.paymentBatchExport.count({ where: { paymentBatchId: batchId } });
				const record = await tx.paymentBatchExport.create({
					data: {
						paymentBatchId: batchId,
						bankExportProfileId: profileId,
						exportNumber: `${batch.batchNumber}-E${count + 1}`,
						format: cfg.format,
						fileName: file.fileName,
						fileHash: file.hash,
						rowCount: file.rowCount,
						totalAmount: file.totalAmount,
						profileSnapshotJson: cfg as unknown as Prisma.InputJsonObject,
						createdByUserId: actorUserId
					}
				});
				const firstExport = batch.status === 'VALIDATED';
				if (firstExport) {
					await tx.payrollPaymentItem.updateMany({
						where: { paymentBatchId: batchId, status: 'READY' },
						data: { status: 'EXPORTED' }
					});
					await tx.payrollPaymentBatch.update({
						where: { id: batchId },
						data: { status: 'EXPORTED', exportedAt: serverNow(), exportedByUserId: actorUserId }
					});
				}
				await writeAuditEvent(tx, {
					action: AuditAction.PAYROLL_PAYMENT_EXPORTED,
					entityType: AuditEntity.PAYROLL_PAYMENT_BATCH,
					entityId: batchId,
					companyId: batch.companyId,
					actorUserId,
					metadata: {
						batchId,
						runId: batch.payrollRunId,
						exportId: record.id,
						exportProfileId: profileId,
						format: cfg.format,
						rowCount: file.rowCount,
						fileHash: file.hash,
						status: firstExport ? 'EXPORTED' : batch.status
					}
				});
				return { ...file, exportId: record.id, firstExport };
			},
			{ timeout: 60_000, maxWait: 15_000 }
		);
	try {
		return await run();
	} catch (err) {
		// a concurrent request created this (batch, profile) export first → serve it as a re-export
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return run();
		throw err;
	}
}
