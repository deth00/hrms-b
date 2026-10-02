/**
 * ONE centralized description of what each approval target type is. Adding a future module (expense,
 * documents, …) means adding an entry here plus an adapter — the engine itself never changes.
 *
 * The REVIEW PERMISSION is what the acting user must hold no matter how the step is configured
 * (MANAGER, ROLE, USER or PERMISSION). Authorization is by permission, never by role name.
 */
export const APPROVAL_TARGET_TYPES = [
	'LEAVE',
	'OVERTIME',
	'ATTENDANCE_CORRECTION',
	'PAYROLL_RUN'
] as const;
export type ApprovalTargetKind = (typeof APPROVAL_TARGET_TYPES)[number];

export const REVIEW_PERMISSION: Record<ApprovalTargetKind, string> = {
	LEAVE: 'leave.review',
	OVERTIME: 'overtime.review',
	ATTENDANCE_CORRECTION: 'attendance_corrections.review',
	PAYROLL_RUN: 'payroll.approve'
};

/**
 * Phase 13 — permissions an approver must hold ON TOP of the review permission, both when the
 * candidates are snapshotted and when they act. Payroll is company-wide salary data: the approver needs
 * the broad employee scope (`employees.view_all`), exactly like every other payroll endpoint. There is
 * no manager-tree fallback for payroll.
 */
export const REQUIRED_SCOPE_PERMISSIONS: Record<ApprovalTargetKind, string[]> = {
	LEAVE: [],
	OVERTIME: [],
	ATTENDANCE_CORRECTION: [],
	PAYROLL_RUN: ['employees.view_all']
};

/**
 * Targets that are about ONE employee (manager chain, employee data scope, the employee can never
 * approve their own request). PAYROLL_RUN is company-wide: no employee on the instance, no MANAGER steps.
 */
export const EMPLOYEE_TARGETS: readonly ApprovalTargetKind[] = [
	'LEAVE',
	'OVERTIME',
	'ATTENDANCE_CORRECTION'
];
export const isEmployeeTarget = (t: ApprovalTargetKind) => EMPLOYEE_TARGETS.includes(t);

/** Permissions that let a user SEE (but not necessarily act on) requests of a target type. */
export const VIEW_PERMISSIONS: Record<ApprovalTargetKind, string[]> = {
	LEAVE: ['leave.view', 'leave.review'],
	OVERTIME: ['overtime.view', 'overtime.review'],
	ATTENDANCE_CORRECTION: ['attendance_corrections.review'],
	PAYROLL_RUN: ['payroll.view', 'payroll.approve']
};

/** Permission codes a PERMISSION step may reference for a target type (no nonsense like dashboard.view). */
export const ALLOWED_STEP_PERMISSIONS: Record<ApprovalTargetKind, string[]> = {
	LEAVE: [REVIEW_PERMISSION.LEAVE],
	OVERTIME: [REVIEW_PERMISSION.OVERTIME],
	ATTENDANCE_CORRECTION: [REVIEW_PERMISSION.ATTENDANCE_CORRECTION],
	PAYROLL_RUN: [REVIEW_PERMISSION.PAYROLL_RUN]
};

export interface DefaultWorkflowDef {
	code: string;
	nameLao: string;
	nameEnglish: string;
	stepNameLao: string;
	stepNameEnglish: string;
}

/**
 * Default one-step workflows that `ensureDefaultWorkflows` creates automatically. PAYROLL_RUN is
 * deliberately NOT here: a company that switches payroll to WORKFLOW approval must configure the payroll
 * workflow explicitly (until then submission is refused with APPROVAL_WORKFLOW_NOT_FOUND).
 */
export const DEFAULT_WORKFLOW: Partial<Record<ApprovalTargetKind, DefaultWorkflowDef>> = {
	LEAVE: {
		code: 'DEFAULT_LEAVE',
		nameLao: 'ຂັ້ນຕອນອະນຸມັດການລາ',
		nameEnglish: 'Leave approval',
		stepNameLao: 'ພິຈາລະນາອະນຸມັດ',
		stepNameEnglish: 'Review'
	},
	OVERTIME: {
		code: 'DEFAULT_OVERTIME',
		nameLao: 'ຂັ້ນຕອນອະນຸມັດ OT',
		nameEnglish: 'Overtime approval',
		stepNameLao: 'ພິຈາລະນາອະນຸມັດ',
		stepNameEnglish: 'Review'
	},
	ATTENDANCE_CORRECTION: {
		code: 'DEFAULT_ATTENDANCE_CORRECTION',
		nameLao: 'ຂັ້ນຕອນອະນຸມັດແກ້ໄຂ Attendance',
		nameEnglish: 'Attendance correction approval',
		stepNameLao: 'ພິຈາລະນາອະນຸມັດ',
		stepNameEnglish: 'Review'
	}
};

/** The recommended payroll workflow (one PERMISSION payroll.approve step) — offered by the settings UI. */
export const RECOMMENDED_PAYROLL_WORKFLOW: DefaultWorkflowDef = {
	code: 'PAYROLL_RUN_APPROVAL',
	nameLao: 'ຂັ້ນຕອນອະນຸມັດຮອບເງິນເດືອນ',
	nameEnglish: 'Payroll run approval',
	stepNameLao: 'ອະນຸມັດເງິນເດືອນ',
	stepNameEnglish: 'Payroll approval'
};

export const MAX_MANAGER_LEVEL = 5;
