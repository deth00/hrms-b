import { prisma } from '../config/prisma.js';
import { Errors } from '../utils/AppError.js';

/** The organizational placement of an employee — the fields tracked by assignment history. */
export interface AssignmentTarget {
	companyId: number;
	branchId: number | null;
	departmentId: number | null;
	divisionId: number | null;
	unitId: number | null;
	positionId: number | null;
	managerEmployeeId: number | null;
	employmentTypeId: number | null;
}

export const ASSIGNMENT_FIELDS = [
	'companyId',
	'branchId',
	'departmentId',
	'divisionId',
	'unitId',
	'positionId',
	'managerEmployeeId',
	'employmentTypeId'
] as const satisfies readonly (keyof AssignmentTarget)[];

export function pickAssignment(source: AssignmentTarget): AssignmentTarget {
	return {
		companyId: source.companyId,
		branchId: source.branchId,
		departmentId: source.departmentId,
		divisionId: source.divisionId,
		unitId: source.unitId,
		positionId: source.positionId,
		managerEmployeeId: source.managerEmployeeId,
		employmentTypeId: source.employmentTypeId
	};
}

export function assignmentsEqual(a: AssignmentTarget, b: AssignmentTarget): boolean {
	return ASSIGNMENT_FIELDS.every((f) => a[f] === b[f]);
}

interface ValidateOptions {
	/** The employee being changed — enables the manager self/cycle checks. Omit on create. */
	employeeId?: number;
	/** The employee's current assignment. Unchanged references skip the ACTIVE check (history stays valid). */
	current?: AssignmentTarget | null;
	requireEmploymentType?: boolean;
}

const MANAGER_ELIGIBLE_STATUSES = ['ACTIVE', 'PROBATION'];
const MAX_MANAGER_CHAIN = 500;

function invalid(code: string, message: string): never {
	throw Errors.badRequest(code, message);
}

function mustBeActive(status: string, label: string): void {
	if (status !== 'ACTIVE') {
		invalid('INACTIVE_TARGET', `ບໍ່ສາມາດມອບໝາຍໄດ້ ເນື່ອງຈາກ${label}ປິດການນຳໃຊ້ຢູ່`);
	}
}

/**
 * Server-authoritative validation of an employee's organizational placement. Never trusts the
 * frontend's dependent dropdowns: it re-checks that every referenced record exists, belongs to
 * the right company/department/division, and — for references that are NEW in this assignment —
 * is ACTIVE. Levels may be skipped (branch/division/unit/position are all optional).
 */
export async function validateAssignment(
	target: AssignmentTarget,
	options: ValidateOptions = {}
): Promise<void> {
	const { current = null } = options;
	// A reference needs the ACTIVE check only if it differs from what the employee already has.
	const isNew = (field: keyof AssignmentTarget) => !current || current[field] !== target[field];

	if (options.requireEmploymentType && !target.employmentTypeId) {
		invalid('EMPLOYMENT_TYPE_REQUIRED', 'ກະລຸນາເລືອກປະເພດການຈ້າງງານ');
	}

	const company = await prisma.company.findUnique({ where: { id: target.companyId } });
	if (!company) invalid('INVALID_COMPANY', 'ບໍ່ພົບບໍລິສັດ');
	if (isNew('companyId')) mustBeActive(company.status, 'ບໍລິສັດ');

	if (target.branchId) {
		const branch = await prisma.branch.findUnique({ where: { id: target.branchId } });
		if (!branch) invalid('INVALID_BRANCH', 'ບໍ່ພົບສາຂາ');
		if (branch.companyId !== target.companyId) {
			invalid('BRANCH_COMPANY_MISMATCH', 'ສາຂາທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ບໍລິສັດດຽວກັນ');
		}
		if (isNew('branchId')) mustBeActive(branch.status, 'ສາຂາ');
	}

	if (target.departmentId) {
		const department = await prisma.department.findUnique({ where: { id: target.departmentId } });
		if (!department) invalid('INVALID_DEPARTMENT', 'ບໍ່ພົບພະແນກ');
		if (department.companyId !== target.companyId) {
			invalid('DEPARTMENT_COMPANY_MISMATCH', 'ພະແນກທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ບໍລິສັດດຽວກັນ');
		}
		if (target.branchId && department.branchId && department.branchId !== target.branchId) {
			invalid('DEPARTMENT_BRANCH_MISMATCH', 'ພະແນກທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ສາຂາດຽວກັນ');
		}
		if (isNew('departmentId')) mustBeActive(department.status, 'ພະແນກ');
	}

	if (target.divisionId) {
		if (!target.departmentId) {
			invalid('DIVISION_DEPARTMENT_MISMATCH', 'ຕ້ອງເລືອກພະແນກກ່ອນຈຶ່ງຈະເລືອກຝ່າຍໄດ້');
		}
		const division = await prisma.division.findUnique({ where: { id: target.divisionId } });
		if (!division) invalid('INVALID_DIVISION', 'ບໍ່ພົບຝ່າຍ');
		if (division.departmentId !== target.departmentId) {
			invalid('DIVISION_DEPARTMENT_MISMATCH', 'ຝ່າຍທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ພະແນກດຽວກັນ');
		}
		if (isNew('divisionId')) mustBeActive(division.status, 'ຝ່າຍ');
	}

	if (target.unitId) {
		if (!target.departmentId) {
			invalid('UNIT_DEPARTMENT_MISMATCH', 'ຕ້ອງເລືອກພະແນກກ່ອນຈຶ່ງຈະເລືອກໜ່ວຍງານໄດ້');
		}
		const unit = await prisma.unit.findUnique({ where: { id: target.unitId } });
		if (!unit) invalid('INVALID_UNIT', 'ບໍ່ພົບໜ່ວຍງານ');
		if (unit.departmentId !== target.departmentId) {
			invalid('UNIT_DEPARTMENT_MISMATCH', 'ໜ່ວຍງານທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ພະແນກດຽວກັນ');
		}
		if (unit.divisionId && target.divisionId && unit.divisionId !== target.divisionId) {
			invalid('UNIT_DIVISION_MISMATCH', 'ໜ່ວຍງານທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ຝ່າຍດຽວກັນ');
		}
		if (isNew('unitId')) mustBeActive(unit.status, 'ໜ່ວຍງານ');
	}

	if (target.positionId) {
		const position = await prisma.position.findUnique({ where: { id: target.positionId } });
		if (!position) invalid('INVALID_POSITION', 'ບໍ່ພົບຕຳແໜ່ງ');
		if (position.companyId !== target.companyId) {
			invalid('POSITION_COMPANY_MISMATCH', 'ຕຳແໜ່ງທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ບໍລິສັດດຽວກັນ');
		}
		if (isNew('positionId')) mustBeActive(position.status, 'ຕຳແໜ່ງ');
	}

	if (target.employmentTypeId) {
		const type = await prisma.employmentType.findUnique({ where: { id: target.employmentTypeId } });
		if (!type) invalid('INVALID_EMPLOYMENT_TYPE', 'ບໍ່ພົບປະເພດການຈ້າງງານ');
		if (type.companyId !== target.companyId) {
			invalid(
				'EMPLOYMENT_TYPE_COMPANY_MISMATCH',
				'ປະເພດການຈ້າງງານທີ່ເລືອກບໍ່ໄດ້ຢູ່ພາຍໃຕ້ບໍລິສັດດຽວກັນ'
			);
		}
		if (isNew('employmentTypeId')) mustBeActive(type.status, 'ປະເພດການຈ້າງງານ');
	}

	if (target.managerEmployeeId) {
		await validateManager(target.managerEmployeeId, options.employeeId, isNew('managerEmployeeId'));
	}
}

/**
 * Manager rules: must exist, cannot be the employee themself, must not create a management
 * cycle of ANY length, and (when newly assigned) must be ACTIVE/PROBATION. Managers may belong
 * to any department/company branch — cross-department and matrix reporting is allowed.
 */
async function validateManager(
	managerId: number,
	employeeId: number | undefined,
	isNewManager: boolean
): Promise<void> {
	if (employeeId && managerId === employeeId) {
		invalid('MANAGER_SELF', 'ພະນັກງານບໍ່ສາມາດເປັນຫົວໜ້າຂອງຕົນເອງ');
	}

	const manager = await prisma.employee.findUnique({
		where: { id: managerId },
		select: { id: true, employmentStatus: true, managerEmployeeId: true }
	});
	if (!manager) invalid('INVALID_MANAGER', 'ບໍ່ພົບຫົວໜ້າທີ່ເລືອກ');

	if (isNewManager && !MANAGER_ELIGIBLE_STATUSES.includes(manager.employmentStatus)) {
		invalid('MANAGER_NOT_ACTIVE', 'ຫົວໜ້າທີ່ເລືອກຕ້ອງມີສະຖານະເຮັດວຽກ ຫຼື ທົດລອງງານ');
	}

	if (!employeeId) return; // a brand-new employee cannot yet be anyone's manager

	// Walk UP the chain from the proposed manager. Reaching `employeeId` means the proposed
	// assignment would close a loop (A->B->...->A), at any depth.
	const seen = new Set<number>([manager.id]);
	let nextId = manager.managerEmployeeId;
	for (let i = 0; nextId && i < MAX_MANAGER_CHAIN; i++) {
		if (nextId === employeeId) {
			invalid('MANAGER_CYCLE', 'ບໍ່ສາມາດກຳນົດຫົວໜ້າໄດ້ ເພາະຈະເກີດການອ້າງອີງວົນກັນ (manager cycle)');
		}
		if (seen.has(nextId)) break; // pre-existing loop elsewhere in the chain — stop, don't spin
		seen.add(nextId);
		const parent = await prisma.employee.findUnique({
			where: { id: nextId },
			select: { managerEmployeeId: true }
		});
		nextId = parent?.managerEmployeeId ?? null;
	}
}
