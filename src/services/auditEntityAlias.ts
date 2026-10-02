import { prisma } from '../config/prisma.js';
import { parseId } from '../validation/common.schema.js';

/**
 * Numeric-ID migration (M9 compatibility): audit `entityId` is frozen history. Events written before the
 * migration hold the entity's CUID; events written after hold String(numeric id). To show ONE entity's
 * full history, a lookup by either form also matches the other, via the entity's `legacyId`.
 *
 * Which table an audit entityType points to was verified against every historical row (Stage 1
 * legacy_id_map, idmig/out/audit_entity_tables.tsv). ORGANIZATION / POLICY / POSITION span several tables:
 * a numeric id there is ambiguous and is matched literally only, while a CUID (globally unique) still
 * resolves to its one row. REPORT entity ids are report keys (e.g. "attendance"), never ids.
 */
type Delegate = {
	findUnique(args: {
		where: { id: number };
		select: { legacyId: true };
	}): Promise<{ legacyId: string | null } | null>;
	findUnique(args: {
		where: { legacyId: string };
		select: { id: true };
	}): Promise<{ id: number } | null>;
};
const d = (name: keyof typeof prisma) => prisma[name] as unknown as Delegate;

const TABLES: Record<string, (keyof typeof prisma)[]> = {
	USER: ['user'],
	ROLE: ['role'],
	EMPLOYEE: ['employee'],
	SHIFT: ['shift'],
	HOLIDAY: ['holiday'],
	WORK_LOCATION: ['workLocation'],
	SCHEDULE_ASSIGNMENT: ['employeeScheduleAssignment'],
	POLICY: ['attendancePolicy', 'overtimePolicy'],
	ORGANIZATION: ['company', 'branch', 'department', 'division', 'unit', 'employmentType'],
	POSITION: ['position', 'positionLevel'],
	ATTENDANCE: ['attendanceRecord'],
	ATTENDANCE_CORRECTION: ['attendanceCorrectionRequest'],
	LEAVE_REQUEST: ['leaveRequest'],
	PAYSLIP: ['payslip'],
	OVERTIME_REQUEST: ['overtimeRequest'],
	APPROVAL_WORKFLOW: ['approvalWorkflow'],
	APPROVAL_INSTANCE: ['approvalInstance'],
	LEAVE_BALANCE: ['leaveBalance'],
	LEAVE_TYPE: ['leaveType'],
	PAYROLL_SETTINGS: ['payrollSettings'],
	PAY_COMPONENT: ['payComponent'],
	EMPLOYEE_COMPENSATION: ['employeeCompensation'],
	RECURRING_PAY_COMPONENT: ['employeeRecurringPayComponent'],
	PAYROLL_PERIOD: ['payrollPeriod'],
	PAYROLL_RUN: ['payrollRun'],
	PAYROLL_ADJUSTMENT: ['payrollManualAdjustment'],
	PAYROLL_SCHEDULE: ['payrollSchedule'],
	PAYROLL_RULE: ['payrollRuleSet'],
	STATUTORY_RULE: ['payrollStatutoryRuleSet'],
	EMPLOYEE_STATUTORY_PROFILE: ['employeeStatutoryProfile'],
	EMPLOYEE_PAYMENT_PROFILE: ['employeePaymentProfile'],
	EMPLOYEE_BANK_ACCOUNT: ['employeeBankAccount'],
	PAYROLL_PAYMENT_BATCH: ['payrollPaymentBatch'],
	PAYROLL_PAYMENT_ITEM: ['payrollPaymentItem'],
	BANK_EXPORT_PROFILE: ['bankExportProfile'],
	PAYMENT_RECONCILIATION_IMPORT: ['paymentReconciliationImport'],
	PAYMENT_RECONCILIATION_PROFILE: ['paymentReconciliationProfile'],
	GL_ACCOUNT: ['gLAccount'],
	PAYROLL_ACCOUNTING_RULE_SET: ['payrollAccountingRuleSet'],
	PAYROLL_JOURNAL: ['payrollJournal'],
	ACCOUNTING_EXPORT_PROFILE: ['accountingExportProfile']
};
const ALL_TABLES = [...new Set(Object.values(TABLES).flat())];
const CUID = /^c[a-z0-9]{24}$/;

/**
 * Every audit entityId that denotes the same entity as `entityId`: itself, plus its legacy CUID (for a
 * numeric id of an unambiguous entity type) or its String(numeric id) (for a legacy CUID).
 */
export async function auditEntityIdAliases(
	entityId: string,
	entityType?: string
): Promise<string[]> {
	const aliases = new Set([entityId]);
	const tables = entityType ? (TABLES[entityType] ?? []) : ALL_TABLES;
	const numeric = parseId(entityId);
	if (numeric !== null && tables.length === 1) {
		const row = await d(tables[0]!).findUnique({
			where: { id: numeric },
			select: { legacyId: true }
		});
		if (row?.legacyId) aliases.add(row.legacyId);
	} else if (CUID.test(entityId)) {
		const found = (
			await Promise.all(
				tables.map((t) => d(t).findUnique({ where: { legacyId: entityId }, select: { id: true } }))
			)
		).filter((r): r is { id: number } => r !== null);
		if (found.length === 1) aliases.add(String(found[0]!.id));
	}
	return [...aliases];
}
