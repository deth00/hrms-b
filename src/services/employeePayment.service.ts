import type { EmployeeBankAccount, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';
import { encryptSensitive, maskAccountNumber } from '../lib/sensitiveCrypto.js';
import { AuditAction, AuditEntity, writeAuditEvent } from './audit.service.js';
import { lockEmployee } from './leaveBalance.service.js';
import type {
	BankAccountCreateInput,
	BankAccountUpdateInput,
	PaymentProfileUpdateInput
} from '../validation/payment.schema.js';

/**
 * EMPLOYEE PAYMENT PROFILE + BANK ACCOUNTS (Phase 14 §6-12).
 *
 *  - The account number is encrypted (AES-256-GCM, lib/sensitiveCrypto) before it reaches the database
 *    and is NEVER returned: every response carries `accountNumberMasked` ("••••1234") only. An edit with
 *    a blank number keeps the stored ciphertext; a new number replaces it (fresh IV).
 *  - Invariant: an employee has at most ONE account that is ACTIVE + isPrimary, and the payment profile
 *    points at it. Every write runs in a transaction holding the employee row lock, so two concurrent
 *    "make primary" requests serialize instead of producing two primaries.
 *  - Audit metadata: bankCode / currency / last4 / changed flags — never the number, IV, tag or blob.
 *  - Access (routes): employee_bank.view / employee_bank.manage + employees.view_all. No self-service.
 */
type Tx = Prisma.TransactionClient;

async function loadEmployee(db: Tx | typeof prisma, employeeId: number) {
	const employee = await db.employee.findUnique({
		where: { id: employeeId },
		select: { id: true, companyId: true }
	});
	if (!employee) throw Errors.notFound('ບໍ່ພົບພະນັກງານ');
	return employee;
}

/** The ONLY shape of a bank account the API returns — no ciphertext, IV, tag or plaintext. */
export function presentAccount(a: EmployeeBankAccount) {
	return {
		id: a.id,
		bankCode: a.bankCode,
		bankName: a.bankName,
		branchName: a.branchName,
		accountName: a.accountName,
		accountNumberMasked: maskAccountNumber(a.accountNumberLast4),
		accountNumberLast4: a.accountNumberLast4,
		currencyCode: a.currencyCode,
		isPrimary: a.isPrimary,
		status: a.status,
		createdAt: a.createdAt,
		updatedAt: a.updatedAt
	};
}

const last4Of = (accountNumber: string) => accountNumber.slice(-4);

function encryptedFields(accountNumber: string) {
	const enc = encryptSensitive(accountNumber);
	return {
		accountNumberEncrypted: enc.ciphertext,
		accountNumberIv: enc.iv,
		accountNumberAuthTag: enc.authTag,
		accountNumberLast4: last4Of(accountNumber),
		encryptionKeyVersion: enc.keyVersion
	};
}

/** Audit-safe description of an account (never the number). */
const safeAccountMeta = (a: EmployeeBankAccount) => ({
	bankAccountId: a.id,
	bankCode: a.bankCode,
	currency: a.currencyCode,
	last4: a.accountNumberLast4,
	isPrimary: a.isPrimary,
	status: a.status
});

/** Flags of what changed (values only for non-sensitive fields). */
function changedFlags(before: EmployeeBankAccount, after: EmployeeBankAccount) {
	const flags: Record<string, unknown> = {};
	for (const f of ['bankCode', 'bankName', 'branchName', 'accountName', 'currencyCode'] as const) {
		if (before[f] !== after[f]) flags[`${f}Changed`] = true;
	}
	if (before.accountNumberEncrypted !== after.accountNumberEncrypted) {
		flags.accountNumberChanged = true;
		flags.previousLast4 = before.accountNumberLast4;
	}
	return flags;
}

/** Makes `accountId` the ONE active primary account (caller holds the employee lock). */
async function makePrimary(tx: Tx, employeeId: number, accountId: number, actorUserId: number) {
	await tx.employeeBankAccount.updateMany({
		where: { employeeId, id: { not: accountId }, isPrimary: true },
		data: { isPrimary: false, updatedByUserId: actorUserId }
	});
	const account = await tx.employeeBankAccount.update({
		where: { id: accountId },
		data: { isPrimary: true, status: 'ACTIVE', updatedByUserId: actorUserId }
	});
	const profile = await tx.employeePaymentProfile.findUnique({ where: { employeeId } });
	if (profile) {
		if (profile.bankAccountId !== accountId) {
			await tx.employeePaymentProfile.update({
				where: { employeeId },
				data: { bankAccountId: accountId, updatedByUserId: actorUserId }
			});
		}
	} else {
		// an account made primary with no profile yet → the employee is paid by bank transfer
		await tx.employeePaymentProfile.create({
			data: {
				employeeId,
				paymentMethod: 'BANK_TRANSFER',
				bankAccountId: accountId,
				createdByUserId: actorUserId
			}
		});
	}
	return account;
}

async function loadAccount(tx: Tx, employeeId: number, accountId: number) {
	const account = await tx.employeeBankAccount.findFirst({ where: { id: accountId, employeeId } });
	if (!account) throw Errors.notFound('ບໍ່ພົບບັນຊີທະນາຄານ');
	return account;
}

// ============================================================================================
// read
// ============================================================================================

export async function getPaymentProfile(employeeId: number) {
	const employee = await loadEmployee(prisma, employeeId);
	const [profile, accounts, settings] = await Promise.all([
		prisma.employeePaymentProfile.findUnique({ where: { employeeId } }),
		prisma.employeeBankAccount.findMany({
			where: { employeeId },
			orderBy: [{ isPrimary: 'desc' }, { status: 'asc' }, { createdAt: 'desc' }]
		}),
		prisma.payrollSettings.findUnique({
			where: { companyId: employee.companyId },
			select: { currencyCode: true }
		})
	]);
	const primary = profile?.bankAccountId
		? (accounts.find((a) => a.id === profile.bankAccountId) ?? null)
		: null;
	return {
		employeeId,
		companyId: employee.companyId,
		/** the company payroll currency — a bank account in another currency is BLOCKED at payment */
		payrollCurrencyCode: settings?.currencyCode ?? null,
		exists: profile !== null,
		paymentMethod: profile?.paymentMethod ?? null,
		status: profile?.status ?? null,
		primaryAccount: primary ? presentAccount(primary) : null,
		accounts: accounts.map(presentAccount),
		updatedAt: profile?.updatedAt ?? null
	};
}

// ============================================================================================
// write
// ============================================================================================

/**
 * PUT /employees/:id/payment-profile — the method, and for BANK_TRANSFER optionally the primary
 * account's details (edit in place; blank number = keep). Without a primary account a number is required.
 */
export async function updatePaymentProfile(
	employeeId: number,
	input: PaymentProfileUpdateInput,
	actorUserId: number
) {
	const employee = await loadEmployee(prisma, employeeId);
	await prisma.$transaction(async (tx) => {
		await lockEmployee(tx, employeeId);
		const before = await tx.employeePaymentProfile.findUnique({ where: { employeeId } });
		let bankAccountId = before?.bankAccountId ?? null;

		if (input.paymentMethod === 'BANK_TRANSFER' && input.bankAccount) {
			const b = input.bankAccount;
			const current = bankAccountId
				? await tx.employeeBankAccount.findFirst({
						where: { id: bankAccountId, employeeId, status: 'ACTIVE' }
					})
				: null;
			if (current) {
				const updated = await tx.employeeBankAccount.update({
					where: { id: current.id },
					data: {
						bankCode: b.bankCode,
						bankName: b.bankName,
						branchName: b.branchName ?? null,
						accountName: b.accountName,
						currencyCode: b.currencyCode,
						...(b.accountNumber ? encryptedFields(b.accountNumber) : {}),
						updatedByUserId: actorUserId
					}
				});
				const flags = changedFlags(current, updated);
				if (Object.keys(flags).length > 0) {
					await writeAuditEvent(tx, {
						action: AuditAction.EMPLOYEE_BANK_ACCOUNT_UPDATED,
						entityType: AuditEntity.EMPLOYEE_BANK_ACCOUNT,
						entityId: updated.id,
						companyId: employee.companyId,
						employeeId,
						actorUserId,
						metadata: { employeeId, ...safeAccountMeta(updated), ...flags }
					});
				}
			} else {
				if (!b.accountNumber) {
					throw Errors.badRequest('ACCOUNT_NUMBER_REQUIRED', 'ກະລຸນາປ້ອນເລກບັນຊີ');
				}
				const created = await tx.employeeBankAccount.create({
					data: {
						employeeId,
						companyId: employee.companyId,
						bankCode: b.bankCode,
						bankName: b.bankName,
						branchName: b.branchName ?? null,
						accountName: b.accountName,
						currencyCode: b.currencyCode,
						...encryptedFields(b.accountNumber),
						isPrimary: false,
						status: 'ACTIVE',
						createdByUserId: actorUserId
					}
				});
				const primary = await makePrimary(tx, employeeId, created.id, actorUserId);
				bankAccountId = created.id;
				await writeAuditEvent(tx, {
					action: AuditAction.EMPLOYEE_BANK_ACCOUNT_CREATED,
					entityType: AuditEntity.EMPLOYEE_BANK_ACCOUNT,
					entityId: created.id,
					companyId: employee.companyId,
					employeeId,
					actorUserId,
					metadata: { employeeId, ...safeAccountMeta(primary) }
				});
			}
		}

		const after = await tx.employeePaymentProfile.upsert({
			where: { employeeId },
			create: {
				employeeId,
				paymentMethod: input.paymentMethod,
				bankAccountId,
				status: 'ACTIVE',
				createdByUserId: actorUserId
			},
			update: {
				paymentMethod: input.paymentMethod,
				bankAccountId,
				status: 'ACTIVE',
				updatedByUserId: actorUserId
			}
		});
		if (!before || before.paymentMethod !== after.paymentMethod || before.status !== after.status) {
			await writeAuditEvent(tx, {
				action: AuditAction.EMPLOYEE_PAYMENT_PROFILE_UPDATED,
				entityType: AuditEntity.EMPLOYEE_PAYMENT_PROFILE,
				entityId: after.id,
				companyId: employee.companyId,
				employeeId,
				actorUserId,
				changes: {
					paymentMethod: {
						before: before?.paymentMethod ?? null,
						after: after.paymentMethod
					}
				},
				metadata: { employeeId, created: !before }
			});
		}
	});
	return getPaymentProfile(employeeId);
}

/** POST /employees/:id/bank-accounts — a new account (number required); primary by default. */
export async function createBankAccount(
	employeeId: number,
	input: BankAccountCreateInput,
	actorUserId: number
) {
	const employee = await loadEmployee(prisma, employeeId);
	await prisma.$transaction(async (tx) => {
		await lockEmployee(tx, employeeId);
		const created = await tx.employeeBankAccount.create({
			data: {
				employeeId,
				companyId: employee.companyId,
				bankCode: input.bankCode,
				bankName: input.bankName,
				branchName: input.branchName ?? null,
				accountName: input.accountName,
				currencyCode: input.currencyCode,
				...encryptedFields(input.accountNumber),
				isPrimary: false,
				status: 'ACTIVE',
				createdByUserId: actorUserId
			}
		});
		const row = input.makePrimary
			? await makePrimary(tx, employeeId, created.id, actorUserId)
			: created;
		await writeAuditEvent(tx, {
			action: AuditAction.EMPLOYEE_BANK_ACCOUNT_CREATED,
			entityType: AuditEntity.EMPLOYEE_BANK_ACCOUNT,
			entityId: created.id,
			companyId: employee.companyId,
			employeeId,
			actorUserId,
			metadata: { employeeId, ...safeAccountMeta(row) }
		});
	});
	return getPaymentProfile(employeeId);
}

/** PATCH /employees/:id/bank-accounts/:accountId — edit; a blank number keeps the stored ciphertext. */
export async function updateBankAccount(
	employeeId: number,
	accountId: number,
	input: BankAccountUpdateInput,
	actorUserId: number
) {
	const employee = await loadEmployee(prisma, employeeId);
	await prisma.$transaction(async (tx) => {
		await lockEmployee(tx, employeeId);
		const before = await loadAccount(tx, employeeId, accountId);
		const after = await tx.employeeBankAccount.update({
			where: { id: accountId },
			data: {
				bankCode: input.bankCode,
				bankName: input.bankName,
				branchName: input.branchName ?? null,
				accountName: input.accountName,
				currencyCode: input.currencyCode,
				...(input.accountNumber ? encryptedFields(input.accountNumber) : {}),
				updatedByUserId: actorUserId
			}
		});
		const flags = changedFlags(before, after);
		if (Object.keys(flags).length > 0) {
			await writeAuditEvent(tx, {
				action: AuditAction.EMPLOYEE_BANK_ACCOUNT_UPDATED,
				entityType: AuditEntity.EMPLOYEE_BANK_ACCOUNT,
				entityId: accountId,
				companyId: employee.companyId,
				employeeId,
				actorUserId,
				metadata: { employeeId, ...safeAccountMeta(after), ...flags }
			});
		}
	});
	return getPaymentProfile(employeeId);
}

/** POST …/activate — ACTIVE + the one primary account (the profile points at it). */
export async function activateBankAccount(
	employeeId: number,
	accountId: number,
	actorUserId: number
) {
	const employee = await loadEmployee(prisma, employeeId);
	await prisma.$transaction(async (tx) => {
		await lockEmployee(tx, employeeId);
		await loadAccount(tx, employeeId, accountId);
		const row = await makePrimary(tx, employeeId, accountId, actorUserId);
		await writeAuditEvent(tx, {
			action: AuditAction.EMPLOYEE_BANK_ACCOUNT_ACTIVATED,
			entityType: AuditEntity.EMPLOYEE_BANK_ACCOUNT,
			entityId: accountId,
			companyId: employee.companyId,
			employeeId,
			actorUserId,
			metadata: { employeeId, ...safeAccountMeta(row) }
		});
	});
	return getPaymentProfile(employeeId);
}

/**
 * POST …/deactivate — INACTIVE, no longer primary. The profile keeps pointing at it on purpose, so a
 * payment snapshot reports INACTIVE_BANK_ACCOUNT (a clear reason) until HR activates / adds an account.
 */
export async function deactivateBankAccount(
	employeeId: number,
	accountId: number,
	actorUserId: number
) {
	const employee = await loadEmployee(prisma, employeeId);
	await prisma.$transaction(async (tx) => {
		await lockEmployee(tx, employeeId);
		const before = await loadAccount(tx, employeeId, accountId);
		if (before.status === 'INACTIVE') return;
		const row = await tx.employeeBankAccount.update({
			where: { id: accountId },
			data: { status: 'INACTIVE', isPrimary: false, updatedByUserId: actorUserId }
		});
		await writeAuditEvent(tx, {
			action: AuditAction.EMPLOYEE_BANK_ACCOUNT_DEACTIVATED,
			entityType: AuditEntity.EMPLOYEE_BANK_ACCOUNT,
			entityId: accountId,
			companyId: employee.companyId,
			employeeId,
			actorUserId,
			metadata: { employeeId, ...safeAccountMeta(row) }
		});
	});
	return getPaymentProfile(employeeId);
}
