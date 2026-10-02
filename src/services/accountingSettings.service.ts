import { Prisma } from '@prisma/client';
import type {
	AccountingEventType,
	AccountingExportProfile,
	GLAccount,
	PayrollAccountingMapping,
	PayrollAccountingRuleSet
} from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { idCol } from '../lib/sqlIds.js';
import { Errors } from '../utils/AppError.js';
import { serverNow } from '../lib/clock.js';
import {
	ACCOUNTING_EXPORT_FIELDS,
	ACCOUNTING_FIELD_LABEL,
	ACCRUAL_SOURCES,
	PAYMENT_SOURCES,
	sideOf,
	SOURCE_LABEL,
	sourcesFor,
	type AccountingExportField
} from '../lib/accountingSources.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import type {
	AccountingExportProfileCreateInput,
	AccountingExportProfileUpdateInput,
	GlAccountCreateInput,
	GlAccountUpdateInput,
	MappingUpsertInput,
	RuleSetCreateInput,
	RuleSetUpdateInput
} from '../validation/accounting.schema.js';

/**
 * PAYROLL ACCOUNTING SETTINGS (Phase 16): the company chart of GL accounts used by payroll, the
 * effective-dated accounting rule sets with their mappings, and the accounting export profiles.
 *
 *  - Account codes are configuration (never hard-coded). No delete anywhere: accounts / rule sets are
 *    deactivated; an account on a journal line is protected by a RESTRICT foreign key.
 *  - An INACTIVE account can never be put on a mapping.
 *  - Only ONE ACTIVE rule set may cover any date of a company (activation takes a company-wide lock).
 *  - Journals SNAPSHOT the accounts they used; changing a mapping never rewrites an existing journal.
 */
type Tx = Prisma.TransactionClient;

const dateOf = (s: string) => new Date(`${s}T00:00:00Z`);
const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

async function requireCompany(companyId: number) {
	const c = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
	if (!c) throw Errors.badRequest('COMPANY_NOT_FOUND', 'ບໍ່ພົບບໍລິສັດ');
}

// ============================================================================================
// source catalog
// ============================================================================================

export function sourceCatalog() {
	const entry = (event: AccountingEventType, code: string) => ({
		code,
		label: SOURCE_LABEL[code]?.lo ?? code,
		labelEn: SOURCE_LABEL[code]?.en ?? code,
		side: sideOf(event, code)
	});
	return {
		PAYROLL_ACCRUAL: ACCRUAL_SOURCES.map((s) => entry('PAYROLL_ACCRUAL', s)),
		PAYMENT_SETTLEMENT: PAYMENT_SOURCES.map((s) => entry('PAYMENT_SETTLEMENT', s)),
		PAYMENT_REVERSAL: PAYMENT_SOURCES.map((s) => entry('PAYMENT_REVERSAL', s)),
		/** a reversal journal copies the original POSTED settlement lines exactly (no remapping) */
		reversalNote:
			'ບັນທຶກຍົກເລີກການຈ່າຍ ໃຊ້ບັນຊີຕາມບັນທຶກການຈ່າຍເດີມທີ່ Post ແລ້ວ (ສະລັບໜີ້/ມີ) — ບໍ່ໃຊ້ການຕັ້ງຄ່ານີ້'
	};
}

// ============================================================================================
// GL accounts
// ============================================================================================

function presentAccount(a: GLAccount & { _count?: { journalLines: number } }) {
	return {
		id: a.id,
		companyId: a.companyId,
		code: a.code,
		name: a.name,
		type: a.type,
		status: a.status,
		description: a.description,
		inUse: (a._count?.journalLines ?? 0) > 0,
		createdAt: a.createdAt,
		updatedAt: a.updatedAt
	};
}

export async function listAccounts(query: {
	companyId?: number;
	status?: 'ACTIVE' | 'INACTIVE';
	type?: GLAccount['type'];
	search?: string;
}) {
	const rows = await prisma.gLAccount.findMany({
		where: {
			...(query.companyId ? { companyId: query.companyId } : {}),
			...(query.status ? { status: query.status } : {}),
			...(query.type ? { type: query.type } : {}),
			...(query.search
				? { OR: [{ code: { contains: query.search } }, { name: { contains: query.search } }] }
				: {})
		},
		include: { _count: { select: { journalLines: true } } },
		orderBy: [{ code: 'asc' }]
	});
	return { items: rows.map(presentAccount) };
}

export async function createAccount(input: GlAccountCreateInput, actorUserId: number) {
	await requireCompany(input.companyId);
	try {
		const row = await prisma.$transaction(async (tx) => {
			const a = await tx.gLAccount.create({
				data: {
					companyId: input.companyId,
					code: input.code,
					name: input.name,
					type: input.type,
					description: input.description ?? null,
					createdByUserId: actorUserId,
					updatedByUserId: actorUserId
				}
			});
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_ACCOUNTING_GL_ACCOUNT_CREATED,
				entityType: AuditEntity.GL_ACCOUNT,
				entityId: a.id,
				companyId: a.companyId,
				actorUserId,
				metadata: { glAccountId: a.id, code: a.code, type: a.type, status: a.status }
			});
			return a;
		});
		return presentAccount(row);
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict('GL_ACCOUNT_CODE_EXISTS', 'ລະຫັດບັນຊີນີ້ມີຢູ່ແລ້ວໃນບໍລິສັດນີ້');
		}
		throw err;
	}
}

export async function updateAccount(id: number, input: GlAccountUpdateInput, actorUserId: number) {
	const row = await prisma.$transaction(async (tx) => {
		const before = await tx.gLAccount.findUnique({
			where: { id },
			include: { _count: { select: { journalLines: true } } }
		});
		if (!before) throw Errors.notFound('ບໍ່ພົບບັນຊີ');
		if (input.type && input.type !== before.type && before._count.journalLines > 0) {
			throw Errors.conflict(
				'GL_ACCOUNT_IN_USE',
				'ບັນຊີນີ້ຖືກໃຊ້ໃນບັນທຶກບັນຊີແລ້ວ — ບໍ່ສາມາດປ່ຽນປະເພດບັນຊີໄດ້'
			);
		}
		const a = await tx.gLAccount.update({
			where: { id },
			data: {
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.type !== undefined ? { type: input.type } : {}),
				...(input.description !== undefined ? { description: input.description } : {}),
				...(input.status !== undefined ? { status: input.status } : {}),
				updatedByUserId: actorUserId
			},
			include: { _count: { select: { journalLines: true } } }
		});
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_ACCOUNTING_GL_ACCOUNT_UPDATED,
			entityType: AuditEntity.GL_ACCOUNT,
			entityId: id,
			companyId: a.companyId,
			actorUserId,
			metadata: {
				glAccountId: id,
				code: a.code,
				type: a.type,
				status: a.status,
				changedFields: Object.keys(input)
			}
		});
		return a;
	});
	return presentAccount(row);
}

// ============================================================================================
// rule sets + mappings
// ============================================================================================

type MappingWithAccounts = PayrollAccountingMapping & {
	debitAccount: GLAccount | null;
	creditAccount: GLAccount | null;
};

const accountRef = (a: GLAccount | null) =>
	a ? { id: a.id, code: a.code, name: a.name, type: a.type, status: a.status } : null;

function presentMapping(m: MappingWithAccounts) {
	return {
		id: m.id,
		eventType: m.eventType,
		sourceType: m.sourceType,
		sourceLabel: SOURCE_LABEL[m.sourceType]?.lo ?? m.sourceType,
		side: sideOf(m.eventType, m.sourceType),
		debitAccount: accountRef(m.debitAccount),
		creditAccount: accountRef(m.creditAccount),
		groupingDimension: m.groupingDimension,
		descriptionTemplate: m.descriptionTemplate,
		status: m.status,
		updatedAt: m.updatedAt
	};
}

function presentRuleSet(
	r: PayrollAccountingRuleSet & {
		mappings?: MappingWithAccounts[];
		_count?: { journals: number; mappings?: number };
	}
) {
	return {
		id: r.id,
		companyId: r.companyId,
		name: r.name,
		version: r.version,
		effectiveFrom: isoDate(r.effectiveFrom),
		effectiveTo: isoDate(r.effectiveTo),
		status: r.status,
		activatedAt: r.activatedAt,
		journalCount: r._count?.journals ?? 0,
		mappingCount: r.mappings?.length ?? r._count?.mappings ?? 0,
		...(r.mappings ? { mappings: r.mappings.map(presentMapping) } : {}),
		createdAt: r.createdAt,
		updatedAt: r.updatedAt
	};
}

const MAPPING_INCLUDE = {
	mappings: {
		include: { debitAccount: true, creditAccount: true },
		orderBy: [{ eventType: 'asc' as const }, { sourceType: 'asc' as const }]
	},
	_count: { select: { journals: true } }
};

export async function listRuleSets(query: {
	companyId?: number;
	status?: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
}) {
	const rows = await prisma.payrollAccountingRuleSet.findMany({
		where: {
			...(query.companyId ? { companyId: query.companyId } : {}),
			...(query.status ? { status: query.status } : {})
		},
		include: { _count: { select: { journals: true, mappings: true } } },
		orderBy: [{ companyId: 'asc' }, { version: 'desc' }]
	});
	return { items: rows.map(presentRuleSet) };
}

export async function getRuleSet(id: number) {
	const r = await prisma.payrollAccountingRuleSet.findUnique({
		where: { id },
		include: MAPPING_INCLUDE
	});
	if (!r) throw Errors.notFound('ບໍ່ພົບກົດການບັນທຶກບັນຊີ');
	return presentRuleSet(r);
}

/** serializes rule-set writes of ONE company (versions, activation overlap) */
async function lockCompanyRuleSets(tx: Tx, companyId: number) {
	await tx.$queryRaw`SELECT ${idCol()} AS id FROM companies WHERE ${idCol()} = ${companyId} FOR UPDATE`;
}

export async function createRuleSet(input: RuleSetCreateInput, actorUserId: number) {
	await requireCompany(input.companyId);
	const id = await prisma.$transaction(async (tx) => {
		await lockCompanyRuleSets(tx, input.companyId);
		let copyFrom: PayrollAccountingMapping[] = [];
		if (input.copyFromRuleSetId) {
			const src = await tx.payrollAccountingRuleSet.findUnique({
				where: { id: input.copyFromRuleSetId },
				include: { mappings: true }
			});
			if (!src || src.companyId !== input.companyId) {
				throw Errors.notFound('ບໍ່ພົບກົດການບັນທຶກບັນຊີທີ່ຈະສຳເນົາ');
			}
			copyFrom = src.mappings;
		}
		const last = await tx.payrollAccountingRuleSet.aggregate({
			where: { companyId: input.companyId },
			_max: { version: true }
		});
		const r = await tx.payrollAccountingRuleSet.create({
			data: {
				companyId: input.companyId,
				name: input.name,
				version: (last._max.version ?? 0) + 1,
				effectiveFrom: dateOf(input.effectiveFrom),
				effectiveTo: input.effectiveTo ? dateOf(input.effectiveTo) : null,
				status: 'DRAFT',
				createdByUserId: actorUserId
			}
		});
		if (copyFrom.length > 0) {
			await tx.payrollAccountingMapping.createMany({
				data: copyFrom.map((m) => ({
					ruleSetId: r.id,
					eventType: m.eventType,
					sourceType: m.sourceType,
					debitAccountId: m.debitAccountId,
					creditAccountId: m.creditAccountId,
					groupingDimension: m.groupingDimension,
					descriptionTemplate: m.descriptionTemplate,
					status: m.status
				}))
			});
		}
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_ACCOUNTING_RULESET_CREATED,
			entityType: AuditEntity.PAYROLL_ACCOUNTING_RULE_SET,
			entityId: r.id,
			companyId: r.companyId,
			actorUserId,
			metadata: {
				ruleSetId: r.id,
				version: r.version,
				status: r.status,
				copiedFromRuleSetId: input.copyFromRuleSetId ?? null,
				mappingCount: copyFrom.length
			}
		});
		return r.id;
	});
	return getRuleSet(id);
}

/** Header (name / dates) is editable while DRAFT only — an ACTIVE set's coverage never moves. */
export async function updateRuleSet(id: number, input: RuleSetUpdateInput, actorUserId: number) {
	await prisma.$transaction(async (tx) => {
		const r = await tx.payrollAccountingRuleSet.findUnique({ where: { id } });
		if (!r) throw Errors.notFound('ບໍ່ພົບກົດການບັນທຶກບັນຊີ');
		if (r.status !== 'DRAFT') {
			throw Errors.conflict(
				'ACCOUNTING_RULESET_NOT_DRAFT',
				'ແກ້ໄຂຂໍ້ມູນຫົວຂອງກົດໄດ້ສະເພາະສະຖານະ DRAFT — ສ້າງເວີຊັນໃໝ່ແທນ'
			);
		}
		const from = input.effectiveFrom ? dateOf(input.effectiveFrom) : r.effectiveFrom;
		const to =
			input.effectiveTo === undefined
				? r.effectiveTo
				: input.effectiveTo
					? dateOf(input.effectiveTo)
					: null;
		if (to && to < from) {
			throw Errors.badRequest('VALIDATION_ERROR', 'ວັນທີສິ້ນສຸດຕ້ອງບໍ່ກ່ອນວັນທີເລີ່ມ');
		}
		await tx.payrollAccountingRuleSet.update({
			where: { id },
			data: { name: input.name ?? r.name, effectiveFrom: from, effectiveTo: to }
		});
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_ACCOUNTING_RULESET_UPDATED,
			entityType: AuditEntity.PAYROLL_ACCOUNTING_RULE_SET,
			entityId: id,
			companyId: r.companyId,
			actorUserId,
			metadata: { ruleSetId: id, version: r.version, changedFields: Object.keys(input) }
		});
	});
	return getRuleSet(id);
}

/** the minimum an ACTIVE rule set must map before it can account a payroll */
export const REQUIRED_ACCRUAL_SOURCES = ['BASE_SALARY', 'NET_PAYABLE'] as const;

const overlaps = (
	a: { effectiveFrom: Date; effectiveTo: Date | null },
	b: { effectiveFrom: Date; effectiveTo: Date | null }
) =>
	a.effectiveFrom <= (b.effectiveTo ?? new Date('9999-12-31')) &&
	b.effectiveFrom <= (a.effectiveTo ?? new Date('9999-12-31'));

export async function activateRuleSet(id: number, actorUserId: number) {
	await prisma.$transaction(async (tx) => {
		// LOCKING reads first: a plain read would pin the REPEATABLE READ snapshot before the lock and
		// hide a concurrent activation from the overlap check below
		const head = await tx.$queryRaw<{ company_id: number }[]>`
			SELECT ${idCol('company_id')} AS company_id FROM payroll_accounting_rule_sets WHERE ${idCol()} = ${id} FOR UPDATE`;
		if (head.length === 0) throw Errors.notFound('ບໍ່ພົບກົດການບັນທຶກບັນຊີ');
		await lockCompanyRuleSets(tx, head[0]!.company_id);
		const r = await tx.payrollAccountingRuleSet.findUnique({
			where: { id },
			include: { mappings: { include: { debitAccount: true, creditAccount: true } } }
		});
		if (!r) throw Errors.notFound('ບໍ່ພົບກົດການບັນທຶກບັນຊີ');
		if (r.status === 'ACTIVE') {
			throw Errors.conflict('ACCOUNTING_RULESET_ALREADY_ACTIVE', 'ກົດນີ້ເປີດໃຊ້ງານຢູ່ແລ້ວ');
		}
		const active = r.mappings.filter((m) => m.status === 'ACTIVE');
		const missing = REQUIRED_ACCRUAL_SOURCES.filter(
			(s) => !active.some((m) => m.eventType === 'PAYROLL_ACCRUAL' && m.sourceType === s)
		);
		const inactiveAccounts = active.filter(
			(m) =>
				(m.debitAccount && m.debitAccount.status !== 'ACTIVE') ||
				(m.creditAccount && m.creditAccount.status !== 'ACTIVE')
		);
		if (missing.length > 0 || inactiveAccounts.length > 0) {
			throw Errors.conflict(
				'ACCOUNTING_RULESET_INCOMPLETE',
				missing.length > 0
					? `ກົດນີ້ຍັງບໍ່ຄົບ — ຕ້ອງຕັ້ງຄ່າບັນຊີສຳລັບ: ${missing
							.map((s) => SOURCE_LABEL[s]?.lo ?? s)
							.join(', ')}`
					: 'ກົດນີ້ມີການຕັ້ງຄ່າທີ່ໃຊ້ບັນຊີທີ່ປິດການໃຊ້ງານແລ້ວ',
				{
					missingSourceTypes: [...missing],
					inactiveAccountMappings: inactiveAccounts.map((m) => m.sourceType)
				}
			);
		}
		const others = await tx.payrollAccountingRuleSet.findMany({
			where: { companyId: r.companyId, status: 'ACTIVE', id: { not: id } }
		});
		const clash = others.find((o) => overlaps(o, r));
		if (clash) {
			throw Errors.conflict(
				'ACCOUNTING_RULESET_OVERLAP',
				`ຊ່ວງວັນທີທັບຊ້ອນກັບກົດທີ່ເປີດໃຊ້ງານຢູ່ (ເວີຊັນ ${clash.version}) — ປິດ ຫຼື ປັບວັນທີກ່ອນ`,
				{ conflictingRuleSetId: clash.id, conflictingVersion: clash.version }
			);
		}
		await tx.payrollAccountingRuleSet.update({
			where: { id },
			data: { status: 'ACTIVE', activatedAt: serverNow(), activatedByUserId: actorUserId }
		});
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_ACCOUNTING_RULESET_ACTIVATED,
			entityType: AuditEntity.PAYROLL_ACCOUNTING_RULE_SET,
			entityId: id,
			companyId: r.companyId,
			actorUserId,
			metadata: { ruleSetId: id, version: r.version, status: 'ACTIVE', mappingCount: active.length }
		});
	});
	return getRuleSet(id);
}

export async function deactivateRuleSet(id: number, actorUserId: number) {
	await prisma.$transaction(async (tx) => {
		const r = await tx.payrollAccountingRuleSet.findUnique({ where: { id } });
		if (!r) throw Errors.notFound('ບໍ່ພົບກົດການບັນທຶກບັນຊີ');
		if (r.status === 'INACTIVE') return;
		await tx.payrollAccountingRuleSet.update({ where: { id }, data: { status: 'INACTIVE' } });
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_ACCOUNTING_RULESET_DEACTIVATED,
			entityType: AuditEntity.PAYROLL_ACCOUNTING_RULE_SET,
			entityId: id,
			companyId: r.companyId,
			actorUserId,
			metadata: { ruleSetId: id, version: r.version, status: 'INACTIVE' }
		});
	});
	return getRuleSet(id);
}

async function mappableAccount(tx: Tx, id: number | null | undefined, companyId: number) {
	if (!id) return null;
	const a = await tx.gLAccount.findUnique({ where: { id } });
	if (!a || a.companyId !== companyId) {
		throw Errors.badRequest('GL_ACCOUNT_NOT_FOUND', 'ບໍ່ພົບບັນຊີໃນບໍລິສັດນີ້');
	}
	if (a.status !== 'ACTIVE') {
		throw Errors.badRequest(
			'GL_ACCOUNT_INACTIVE',
			`ບັນຊີ ${a.code} ຖືກປິດການໃຊ້ງານແລ້ວ — ບໍ່ສາມາດໃຊ້ໃນການຕັ້ງຄ່າໃໝ່ໄດ້`
		);
	}
	return a;
}

/**
 * Creates or replaces the mapping of (event, source) in a rule set. Allowed on any status — journals
 * already created keep their snapshotted accounts — and audited as MAPPING_UPDATED.
 */
export async function upsertMapping(
	ruleSetId: number,
	input: MappingUpsertInput,
	actorUserId: number
) {
	await prisma.$transaction(async (tx) => {
		const r = await tx.payrollAccountingRuleSet.findUnique({ where: { id: ruleSetId } });
		if (!r) throw Errors.notFound('ບໍ່ພົບກົດການບັນທຶກບັນຊີ');
		if (!sourcesFor(input.eventType).includes(input.sourceType)) {
			throw Errors.badRequest(
				'ACCOUNTING_SOURCE_TYPE_INVALID',
				'ປະເພດແຫຼ່ງຂໍ້ມູນນີ້ບໍ່ຖືກຕ້ອງສຳລັບເຫດການນີ້'
			);
		}
		const side = sideOf(input.eventType, input.sourceType);
		const debit = await mappableAccount(tx, input.debitAccountId, r.companyId);
		const credit = await mappableAccount(tx, input.creditAccountId, r.companyId);
		const needDebit = side === 'DEBIT' || side === 'BOTH';
		const needCredit = side === 'CREDIT' || side === 'BOTH';
		if ((needDebit && !debit) || (needCredit && !credit)) {
			throw Errors.badRequest(
				'MAPPING_ACCOUNT_REQUIRED',
				side === 'BOTH'
					? 'ກະລຸນາເລືອກທັງບັນຊີໜີ້ (Debit) ແລະ ບັນຊີມີ (Credit)'
					: side === 'DEBIT'
						? 'ກະລຸນາເລືອກບັນຊີໜີ້ (Debit)'
						: 'ກະລຸນາເລືອກບັນຊີມີ (Credit)'
			);
		}
		if ((!needDebit && debit) || (!needCredit && credit)) {
			throw Errors.badRequest(
				'MAPPING_ACCOUNT_SIDE_INVALID',
				side === 'DEBIT'
					? 'ແຫຼ່ງຂໍ້ມູນນີ້ໃຊ້ສະເພາະບັນຊີໜີ້ (Debit) — ຍອດຕິດລົບຈະບັນທຶກໃນບັນຊີດຽວກັນຝັ່ງກົງກັນຂ້າມ'
					: 'ແຫຼ່ງຂໍ້ມູນນີ້ໃຊ້ສະເພາະບັນຊີມີ (Credit) — ຍອດຕິດລົບຈະບັນທຶກໃນບັນຊີດຽວກັນຝັ່ງກົງກັນຂ້າມ'
			);
		}
		if (side === 'BOTH' && debit && credit && debit.id === credit.id) {
			throw Errors.badRequest(
				'MAPPING_ACCOUNT_SAME',
				'ບັນຊີໜີ້ ແລະ ບັນຊີມີ ຕ້ອງບໍ່ແມ່ນບັນຊີດຽວກັນ'
			);
		}
		const data = {
			debitAccountId: debit?.id ?? null,
			creditAccountId: credit?.id ?? null,
			groupingDimension: input.groupingDimension,
			descriptionTemplate: input.descriptionTemplate ?? null,
			status: input.status
		};
		const m = await tx.payrollAccountingMapping.upsert({
			where: {
				ruleSetId_eventType_sourceType: {
					ruleSetId,
					eventType: input.eventType,
					sourceType: input.sourceType
				}
			},
			create: { ruleSetId, eventType: input.eventType, sourceType: input.sourceType, ...data },
			update: data
		});
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_ACCOUNTING_MAPPING_UPDATED,
			entityType: AuditEntity.PAYROLL_ACCOUNTING_RULE_SET,
			entityId: ruleSetId,
			companyId: r.companyId,
			actorUserId,
			metadata: {
				ruleSetId,
				mappingId: m.id,
				eventType: m.eventType,
				sourceType: m.sourceType,
				debitAccountId: m.debitAccountId,
				creditAccountId: m.creditAccountId,
				groupingDimension: m.groupingDimension,
				status: m.status
			}
		});
	});
	return getRuleSet(ruleSetId);
}

/** The ONE ACTIVE rule set covering a date for a company (null when none). */
export async function applicableRuleSet(db: Tx | typeof prisma, companyId: number, date: Date) {
	const rows = await db.payrollAccountingRuleSet.findMany({
		where: {
			companyId,
			status: 'ACTIVE',
			effectiveFrom: { lte: date },
			OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }]
		},
		include: { mappings: { include: { debitAccount: true, creditAccount: true } } },
		orderBy: { version: 'desc' }
	});
	return rows[0] ?? null;
}

// ============================================================================================
// accounting export profiles
// ============================================================================================

export interface AccountingProfileConfig {
	code: string;
	name: string;
	format: 'CSV' | 'XLSX';
	delimiter: string | null;
	includeHeader: boolean;
	encoding: string;
	dateFormat: string;
	columns: { field: AccountingExportField; header: string }[];
}

export function profileConfigOf(p: AccountingExportProfile): AccountingProfileConfig {
	return {
		code: p.code,
		name: p.name,
		format: p.format,
		delimiter: p.delimiter,
		includeHeader: p.includeHeader,
		encoding: p.encoding,
		dateFormat: p.dateFormat,
		columns: (p.columnMappingJson as unknown as AccountingProfileConfig['columns']) ?? []
	};
}

function presentExportProfile(p: AccountingExportProfile) {
	return {
		id: p.id,
		companyId: p.companyId,
		...profileConfigOf(p),
		status: p.status,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt
	};
}

export const ACCOUNTING_GENERIC_TEMPLATE = {
	name: 'Generic GL journal (CSV)',
	format: 'CSV' as const,
	delimiter: ',',
	includeHeader: true,
	encoding: 'UTF-8-BOM',
	dateFormat: 'YYYY-MM-DD',
	columns: ACCOUNTING_EXPORT_FIELDS.map((f) => ({ field: f, header: f }))
};

export function exportFieldCatalog() {
	return {
		fields: ACCOUNTING_EXPORT_FIELDS.map((f) => ({ field: f, label: ACCOUNTING_FIELD_LABEL[f] })),
		template: ACCOUNTING_GENERIC_TEMPLATE,
		warning:
			'ຮູບແບບໄຟລ໌ເປັນແບບທົ່ວໄປ — ກະລຸນາກວດສອບກັບລະບົບບັນຊີຂອງທ່ານກ່ອນນຳເຂົ້າ. LaoHR ບໍ່ສົ່ງຂໍ້ມູນໄປລະບົບບັນຊີພາຍນອກ.'
	};
}

function normalizeExportProfile(input: AccountingExportProfileUpdateInput) {
	return {
		name: input.name,
		format: input.format,
		delimiter: input.format === 'CSV' ? (input.delimiter ?? ',') : null,
		includeHeader: input.includeHeader,
		encoding: input.format === 'CSV' ? input.encoding : 'UTF-8',
		dateFormat: input.dateFormat,
		columnMappingJson: input.columns as unknown as Prisma.InputJsonArray,
		...(input.status ? { status: input.status } : {})
	};
}

export async function listExportProfiles(query: {
	companyId?: number;
	status?: 'ACTIVE' | 'INACTIVE';
}) {
	const rows = await prisma.accountingExportProfile.findMany({
		where: {
			...(query.companyId ? { companyId: query.companyId } : {}),
			...(query.status ? { status: query.status } : {})
		},
		orderBy: [{ status: 'asc' }, { code: 'asc' }]
	});
	return { items: rows.map(presentExportProfile) };
}

export async function getExportProfile(id: number) {
	const p = await prisma.accountingExportProfile.findUnique({ where: { id } });
	if (!p) throw Errors.notFound('ບໍ່ພົບຮູບແບບໄຟລ໌ບັນຊີ');
	return presentExportProfile(p);
}

export async function createExportProfile(
	input: AccountingExportProfileCreateInput,
	actorUserId: number
) {
	await requireCompany(input.companyId);
	try {
		const p = await prisma.$transaction(async (tx) => {
			const row = await tx.accountingExportProfile.create({
				data: {
					companyId: input.companyId,
					code: input.code,
					...normalizeExportProfile(input),
					createdByUserId: actorUserId
				}
			});
			await writeAuditEvent(tx, {
				action: AuditAction.PAYROLL_ACCOUNTING_EXPORT_PROFILE_CREATED,
				entityType: AuditEntity.ACCOUNTING_EXPORT_PROFILE,
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
		return presentExportProfile(p);
	} catch (err) {
		if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
			throw Errors.conflict('EXPORT_PROFILE_CODE_EXISTS', 'ລະຫັດນີ້ມີຢູ່ແລ້ວໃນບໍລິສັດນີ້');
		}
		throw err;
	}
}

/** Editing a profile never changes an existing export (each export froze its configuration). */
export async function updateExportProfile(
	id: number,
	input: AccountingExportProfileUpdateInput,
	actorUserId: number
) {
	const p = await prisma.$transaction(async (tx) => {
		const before = await tx.accountingExportProfile.findUnique({ where: { id } });
		if (!before) throw Errors.notFound('ບໍ່ພົບຮູບແບບໄຟລ໌ບັນຊີ');
		const row = await tx.accountingExportProfile.update({
			where: { id },
			data: normalizeExportProfile(input)
		});
		await writeAuditEvent(tx, {
			action: AuditAction.PAYROLL_ACCOUNTING_EXPORT_PROFILE_UPDATED,
			entityType: AuditEntity.ACCOUNTING_EXPORT_PROFILE,
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
	return presentExportProfile(p);
}
