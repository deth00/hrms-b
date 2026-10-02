import type { AccountingEventType, PayComponentType, PayrollItemSource } from '@prisma/client';

/**
 * Phase 16 — the STABLE accounting source types a mapping can name, and how finalized payroll data is
 * classified into them. Accounting never calculates payroll: it only re-groups the immutable finalized
 * result items / statutory results / payment items into these buckets.
 *
 * Natural side of an accrual source:
 *  - DEBIT  — an expense the company recognizes (earnings)
 *  - CREDIT — a liability / recovery (deductions, PIT / SSO withheld, the net payable)
 *  - BOTH   — an employer cost with its own liability (Dr expense / Cr payable, same amount)
 * A NEGATIVE group total (e.g. a PIT / SSO credit in a later cycle) swaps the side; no negative debit or
 * credit is ever stored.
 */
export const ACCRUAL_SOURCES = [
	'BASE_SALARY',
	'RECURRING_EARNING',
	'OVERTIME',
	'OTHER_EARNING',
	'ATTENDANCE_DEDUCTION',
	'UNPAID_LEAVE',
	'LATE_DEDUCTION',
	'EARLY_DEDUCTION',
	'EMPLOYEE_PIT',
	'EMPLOYEE_SSO',
	'OTHER_DEDUCTION',
	'NET_PAYABLE',
	'EMPLOYER_SSO',
	'EMPLOYER_CONTRIBUTION'
] as const;
export type AccrualSource = (typeof ACCRUAL_SOURCES)[number];

/** Payment settlement: Dr PAYROLL_PAYABLE / Cr BANK_CLEARING (bank transfer) or CASH_CLEARING (cash). */
export const PAYMENT_SOURCES = ['PAYROLL_PAYABLE', 'BANK_CLEARING', 'CASH_CLEARING'] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export type NaturalSide = 'DEBIT' | 'CREDIT' | 'BOTH';

export const ACCRUAL_SIDE: Record<AccrualSource, NaturalSide> = {
	BASE_SALARY: 'DEBIT',
	RECURRING_EARNING: 'DEBIT',
	OVERTIME: 'DEBIT',
	OTHER_EARNING: 'DEBIT',
	ATTENDANCE_DEDUCTION: 'CREDIT',
	UNPAID_LEAVE: 'CREDIT',
	LATE_DEDUCTION: 'CREDIT',
	EARLY_DEDUCTION: 'CREDIT',
	EMPLOYEE_PIT: 'CREDIT',
	EMPLOYEE_SSO: 'CREDIT',
	OTHER_DEDUCTION: 'CREDIT',
	NET_PAYABLE: 'CREDIT',
	EMPLOYER_SSO: 'BOTH',
	EMPLOYER_CONTRIBUTION: 'BOTH'
};

/** Which account(s) a mapping of this source must name. */
export const PAYMENT_SIDE: Record<PaymentSource, NaturalSide> = {
	PAYROLL_PAYABLE: 'DEBIT',
	BANK_CLEARING: 'CREDIT',
	CASH_CLEARING: 'CREDIT'
};

export const SOURCE_LABEL: Record<string, { lo: string; en: string }> = {
	BASE_SALARY: { lo: 'ເງິນເດືອນພື້ນຖານ', en: 'Base salary' },
	RECURRING_EARNING: { lo: 'ລາຍຮັບປະຈຳ', en: 'Recurring earning' },
	OVERTIME: { lo: 'ຄ່າລ່ວງເວລາ', en: 'Overtime' },
	OTHER_EARNING: { lo: 'ລາຍຮັບອື່ນ', en: 'Other earning' },
	ATTENDANCE_DEDUCTION: { lo: 'ຫັກຂາດວຽກ', en: 'Attendance deduction' },
	UNPAID_LEAVE: { lo: 'ຫັກລາພັກບໍ່ໄດ້ຮັບເງິນ', en: 'Unpaid leave' },
	LATE_DEDUCTION: { lo: 'ຫັກມາຊ້າ', en: 'Late deduction' },
	EARLY_DEDUCTION: { lo: 'ຫັກອອກກ່ອນເວລາ', en: 'Early leave deduction' },
	EMPLOYEE_PIT: { lo: 'ອາກອນລາຍໄດ້ (ຫັກພະນັກງານ)', en: 'Employee PIT withheld' },
	EMPLOYEE_SSO: { lo: 'ປະກັນສັງຄົມ (ສ່ວນພະນັກງານ)', en: 'Employee social security' },
	OTHER_DEDUCTION: { lo: 'ລາຍການຫັກອື່ນ', en: 'Other deduction' },
	NET_PAYABLE: { lo: 'ເງິນເດືອນຄ້າງຈ່າຍ (ສຸດທິ)', en: 'Net payroll payable' },
	EMPLOYER_SSO: { lo: 'ປະກັນສັງຄົມ (ສ່ວນນາຍຈ້າງ)', en: 'Employer social security' },
	EMPLOYER_CONTRIBUTION: { lo: 'ເງິນສົມທົບອື່ນຂອງນາຍຈ້າງ', en: 'Other employer contribution' },
	PAYROLL_PAYABLE: { lo: 'ເງິນເດືອນຄ້າງຈ່າຍ', en: 'Payroll payable' },
	BANK_CLEARING: { lo: 'ບັນຊີທະນາຄານ (ໂອນ)', en: 'Bank clearing' },
	CASH_CLEARING: { lo: 'ເງິນສົດ', en: 'Cash clearing' }
};

export function sourcesFor(event: AccountingEventType): readonly string[] {
	if (event === 'PAYROLL_ACCRUAL') return ACCRUAL_SOURCES;
	// the reversal journal copies the ORIGINAL posted settlement lines — its mappings are informational
	return PAYMENT_SOURCES;
}

export function sideOf(event: AccountingEventType, source: string): NaturalSide | null {
	if (event === 'PAYROLL_ACCRUAL') return ACCRUAL_SIDE[source as AccrualSource] ?? null;
	return PAYMENT_SIDE[source as PaymentSource] ?? null;
}

/**
 * Classifies one finalized result item. PIT / SSO CREDITS (a negative current cycle) are stored by the
 * payroll engine as EARNING items of the same source — the sign handling below turns them into a
 * negative EMPLOYEE_PIT / EMPLOYEE_SSO, i.e. the debit side.
 */
export function accrualSourceOfItem(
	source: PayrollItemSource,
	type: PayComponentType
): AccrualSource {
	switch (source) {
		case 'BASE_SALARY':
		case 'PRORATED_BASE_SALARY':
			return 'BASE_SALARY';
		case 'RECURRING':
		case 'PRORATED_RECURRING':
			return type === 'EARNING' ? 'RECURRING_EARNING' : 'OTHER_DEDUCTION';
		case 'OVERTIME':
			return 'OVERTIME';
		case 'ATTENDANCE_DEDUCTION':
			return 'ATTENDANCE_DEDUCTION';
		case 'UNPAID_LEAVE':
			return 'UNPAID_LEAVE';
		case 'LATE_DEDUCTION':
			return 'LATE_DEDUCTION';
		case 'EARLY_LEAVE_DEDUCTION':
			return 'EARLY_DEDUCTION';
		case 'PIT':
			return 'EMPLOYEE_PIT';
		case 'SOCIAL_SECURITY_EMPLOYEE':
			return 'EMPLOYEE_SSO';
		case 'MANUAL':
		default:
			return type === 'EARNING' ? 'OTHER_EARNING' : 'OTHER_DEDUCTION';
	}
}

/**
 * +1 when the item increases its source on the source's natural side, −1 otherwise. An EARNING item is
 * a debit movement, a DEDUCTION item a credit movement (exactly how net pay is derived).
 */
export function itemSign(source: AccrualSource, type: PayComponentType): 1 | -1 {
	const side = ACCRUAL_SIDE[source];
	const movement = type === 'EARNING' ? 'DEBIT' : 'CREDIT';
	return side === movement ? 1 : -1;
}

// ---------- accounting export ----------
export const ACCOUNTING_EXPORT_FIELDS = [
	'JOURNAL_NUMBER',
	'ACCOUNTING_DATE',
	'JOURNAL_TYPE',
	'LINE_NUMBER',
	'ACCOUNT_CODE',
	'ACCOUNT_NAME',
	'DESCRIPTION',
	'EMPLOYEE_CODE',
	'BRANCH_CODE',
	'DEPARTMENT_CODE',
	'DEBIT',
	'CREDIT',
	'CURRENCY',
	'SOURCE_REFERENCE'
] as const;
export type AccountingExportField = (typeof ACCOUNTING_EXPORT_FIELDS)[number];

export const ACCOUNTING_FIELD_LABEL: Record<AccountingExportField, string> = {
	JOURNAL_NUMBER: 'ເລກບັນທຶກບັນຊີ (Journal number)',
	ACCOUNTING_DATE: 'ວັນທີບັນຊີ (Accounting date)',
	JOURNAL_TYPE: 'ປະເພດບັນທຶກ (Journal type)',
	LINE_NUMBER: 'ລຳດັບແຖວ (Line number)',
	ACCOUNT_CODE: 'ລະຫັດບັນຊີ (Account code)',
	ACCOUNT_NAME: 'ຊື່ບັນຊີ (Account name)',
	DESCRIPTION: 'ຄຳອະທິບາຍ (Description)',
	EMPLOYEE_CODE: 'ລະຫັດພະນັກງານ (Employee code)',
	BRANCH_CODE: 'ລະຫັດສາຂາ (Branch code)',
	DEPARTMENT_CODE: 'ລະຫັດພະແນກ (Department code)',
	DEBIT: 'ໜີ້ (Debit)',
	CREDIT: 'ມີ (Credit)',
	CURRENCY: 'ສະກຸນເງິນ (Currency)',
	SOURCE_REFERENCE: 'ເອກະສານອ້າງອີງ (Source reference)'
};

/** Codes that must stay TEXT in XLSX (leading zeros, "00123"), never become numbers. */
export const ACCOUNTING_TEXT_CODE_FIELDS: readonly AccountingExportField[] = [
	'ACCOUNT_CODE',
	'EMPLOYEE_CODE',
	'BRANCH_CODE',
	'DEPARTMENT_CODE',
	'JOURNAL_NUMBER',
	'SOURCE_REFERENCE'
];
