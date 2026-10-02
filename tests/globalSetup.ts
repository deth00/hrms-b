import { execSync } from 'node:child_process';
import 'dotenv/config';

/**
 * Runs once before the whole test suite. Requires an explicit,
 * isolated TEST_DATABASE_URL — tests never run against the primary
 * dev database, and never invent credentials if none are configured.
 */
export default async function globalSetup(): Promise<void> {
	const testDatabaseUrl = process.env.TEST_DATABASE_URL;

	if (!testDatabaseUrl) {
		throw new Error(
			'TEST_DATABASE_URL is not set. Set it in hr-b/.env to an isolated MySQL database ' +
				'(e.g. mysql://user:pass@127.0.0.1:3306/hr_test) before running `npm test`.'
		);
	}

	// numeric-ID migration safety: globalSetup db-pushes and WIPES tables — never the live database or the
	// M6 rehearsal copy, whatever the .env says
	const testDb = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//, ''));
	const forbidden = ['hr_db', 'hr_db_idmig_rehearsal'];
	const liveDb = process.env.DATABASE_URL
		? decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.replace(/^\//, ''))
		: undefined;
	if (forbidden.includes(testDb) || testDb === liveDb) {
		throw new Error(
			`TEST_DATABASE_URL names "${testDb}" — refusing to push/wipe a non-test database.`
		);
	}
	execSync('npx prisma db push --skip-generate --accept-data-loss', {
		env: { ...process.env, DATABASE_URL: testDatabaseUrl },
		stdio: 'inherit'
	});

	// prisma/seed.ts constructs a module-level PrismaClient from process.env.DATABASE_URL at
	// import time — point it at the test database before importing it below.
	process.env.DATABASE_URL = testDatabaseUrl;

	const { PrismaClient } = await import('@prisma/client');
	const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });

	// Start every run from a clean slate: wipe sessions/users and organization/position data
	// (children before parents, for MySQL FK ordering), keep the freshly-pushed schema.
	// Phase 3 rows reference users/org master data, so they go first.
	await prisma.notification.deleteMany();
	await prisma.auditEvent.deleteMany();
	// Phase 16 — payroll accounting (children first; reversal journals reference their original)
	await prisma.payrollJournalExport.deleteMany();
	await prisma.payrollJournalSource.deleteMany();
	await prisma.payrollJournalLine.deleteMany();
	await prisma.payrollJournal.updateMany({ data: { reversedJournalId: null } });
	await prisma.payrollJournal.deleteMany();
	await prisma.accountingExportProfile.deleteMany();
	await prisma.payrollAccountingMapping.deleteMany();
	await prisma.payrollAccountingRuleSet.deleteMany();
	await prisma.gLAccount.deleteMany();
	// Phase 15 — reconciliation / reversal (children first)
	await prisma.paymentReconciliationRow.deleteMany();
	await prisma.payrollPaymentReversal.deleteMany();
	// Phase 14 — payment preparation (children first)
	await prisma.paymentBatchExport.deleteMany();
	// retry items point at their source item (self-FK): clear the lineage links first
	await prisma.payrollPaymentItem.updateMany({
		data: { sourcePaymentItemId: null, retrySourceLockId: null }
	});
	await prisma.payrollPaymentItem.deleteMany();
	await prisma.paymentReconciliationImport.deleteMany();
	await prisma.paymentReconciliationProfile.deleteMany();
	await prisma.payrollPaymentBatch.updateMany({ data: { parentBatchId: null } });
	await prisma.payrollPaymentBatch.deleteMany();
	await prisma.bankExportProfile.deleteMany();
	await prisma.employeePaymentProfile.deleteMany();
	await prisma.employeeBankAccount.deleteMany();
	await prisma.payslip.deleteMany();
	await prisma.payrollStatutoryItem.deleteMany();
	await prisma.payrollStatutoryResult.deleteMany();
	await prisma.payrollResultSegment.deleteMany();
	await prisma.payrollResultItem.deleteMany();
	await prisma.payrollEmployeeResult.deleteMany();
	await prisma.payrollManualAdjustment.deleteMany();
	await prisma.payrollRun.deleteMany();
	await prisma.overtimeCompensationRule.deleteMany();
	await prisma.payrollRuleSet.deleteMany();
	await prisma.payrollPeriod.deleteMany();
	await prisma.payrollScheduleEmployee.deleteMany();
	await prisma.payrollSchedule.deleteMany();
	await prisma.employeeRecurringPayComponent.deleteMany();
	await prisma.employeeCompensation.deleteMany();
	await prisma.payComponent.deleteMany();
	await prisma.payrollSettings.deleteMany();
	await prisma.payrollPitBracket.deleteMany();
	await prisma.payrollSocialSecurityRule.deleteMany();
	await prisma.payrollStatutoryRuleSet.deleteMany();
	await prisma.approvalStepCandidate.deleteMany();
	await prisma.approvalStepInstance.deleteMany();
	await prisma.approvalInstance.deleteMany();
	await prisma.approvalWorkflowStep.deleteMany();
	await prisma.approvalWorkflow.deleteMany();
	await prisma.overtimeRequest.deleteMany();
	await prisma.overtimePolicy.deleteMany();
	await prisma.leaveBalanceAdjustment.deleteMany();
	await prisma.leaveBalance.deleteMany();
	await prisma.leaveRequestDay.deleteMany();
	await prisma.leaveRequest.deleteMany();
	await prisma.leaveType.deleteMany();
	await prisma.attendanceCorrectionApplication.deleteMany();
	await prisma.attendanceCorrectionRequest.deleteMany();
	await prisma.attendancePunch.deleteMany();
	await prisma.attendanceRecord.deleteMany();
	await prisma.employeeScheduleAssignment.deleteMany();
	await prisma.shift.deleteMany();
	await prisma.holiday.deleteMany();
	await prisma.workLocation.deleteMany();
	await prisma.attendancePolicy.deleteMany();
	await prisma.employeeAssignmentHistory.deleteMany();
	await prisma.employeeStatutoryProfile.deleteMany();
	await prisma.employee.deleteMany();
	await prisma.employmentType.deleteMany();
	await prisma.session.deleteMany();
	await prisma.userRole.deleteMany();
	await prisma.user.deleteMany();
	await prisma.position.deleteMany();
	await prisma.positionLevel.deleteMany();
	await prisma.unit.deleteMany();
	await prisma.division.deleteMany();
	await prisma.department.deleteMany();
	await prisma.branch.deleteMany();
	await prisma.company.deleteMany();

	const seed = await import('../prisma/seed.js');
	await seed.seedPermissions();
	await seed.seedRoles();

	await prisma.$disconnect();
}
