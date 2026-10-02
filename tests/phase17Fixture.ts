import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
	agent,
	createTestCompany,
	createTestUser,
	loginAndGetCookie,
	userWithPermissions
} from './helpers.js';
import { prisma } from '../src/config/prisma.js';

/**
 * Phase 17A — a deterministic reporting world (all dates in the PAST, so ABSENT is derivable):
 *
 *   Company C: branches B1 / B2, departments D1 (B1) / D2 (B2), employment types FT / PT,
 *   shift Mon–Fri 08:00–17:00 (no grace), a HOLIDAY on Thu 2025-06-05.
 *
 *   employee  status      branch/dept  type  schedule  notes
 *   MGR       ACTIVE      B1/D1        FT    yes       linked to a MANAGER user; manages A and B
 *   A         ACTIVE      B1/D1        FT    yes       linked to an EMPLOYEE user
 *   B         ACTIVE      B1/D1        PT    yes
 *   Cp        PROBATION   B2/D2        FT    yes
 *   Dd        ACTIVE      B2/D2        FT    yes       approved leave on Wed
 *   E         SUSPENDED   —            —     no        → NO_SCHEDULE
 *   F         RESIGNED    B2/D2        FT    yes       ended 2025-05-01 (before the week)
 *   G         ACTIVE      B1/D1        FT    yes       hired 2025-06-10 (after the week)
 *
 *   Attendance, week Mon 2025-06-02 .. Fri 2025-06-06:
 *     Mon  MGR A B Cp Dd present
 *     Tue  MGR A Cp Dd present, B EARLY_LEAVE 30 min
 *     Wed  MGR A present, B LATE 15 min, Cp ABSENT (no record), Dd LEAVE (approved)
 *     Thu  HOLIDAY (no records)
 *     Fri  MGR A B Cp Dd present
 *   → range Mon..Fri: scheduled 20, present 18, late 1 (15 min), early 1 (30 min), absent 1, leave 1,
 *     holiday 5, noSchedule 5 (E), worked 18×480 − 15 − 30 = 8595 min.
 *
 *   Leave requests (June 2025): Dd APPROVED (Wed, 1 day, LT1) · Cp PENDING (06-10, LT2)
 *                               A REJECTED (06-11, LT2)    · B CANCELLED (06-12, LT2)
 *   OT requests (Wed): A APPROVED eligible 90 · B APPROVED eligible 30 · Cp PENDING planned 120
 *                      Dd REJECTED planned 60
 */
export const uid = () => randomUUID().slice(0, 6).toUpperCase();
export const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
export const get = (path: string, cookie: string) =>
	agent().get(`/api/v1${path}`).set('Cookie', cookie);
export const post = (path: string, cookie: string, body: Record<string, unknown> = {}) =>
	agent().post(`/api/v1${path}`).set('Cookie', cookie).send(body);

export const MON = '2025-06-02';
export const TUE = '2025-06-03';
export const WED = '2025-06-04';
export const THU = '2025-06-05';
export const FRI = '2025-06-06';
export const SAT = '2025-06-07';

export interface World {
	companyId: string;
	b1: string;
	b2: string;
	d1: string;
	d2: string;
	ft: string;
	pt: string;
	lt1: string;
	lt2: string;
	shiftId: string;
	emp: Record<'MGR' | 'A' | 'B' | 'Cp' | 'Dd' | 'E' | 'F' | 'G', { id: string; code: string }>;
	manager: { cookie: string; userId: string };
	employeeUser: { cookie: string; userId: string };
}

const DAYS7 = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

export const recordRow = (
	employeeId: string,
	shiftId: string,
	iso: string,
	o: { result?: 'PRESENT' | 'LATE' | 'EARLY_LEAVE'; late?: number; early?: number } = {}
) => {
	const late = o.late ?? 0;
	const early = o.early ?? 0;
	const inAt = new Date(new Date(`${iso}T01:00:00Z`).getTime() + late * 60_000);
	const outAt = new Date(new Date(`${iso}T10:00:00Z`).getTime() - early * 60_000);
	return {
		employeeId,
		workDate: D(iso),
		shiftId,
		scheduledStartTime: '08:00',
		scheduledEndTime: '17:00',
		scheduledBreakMinutes: 60,
		scheduledLateGraceMinutes: 0,
		scheduledEarlyLeaveGraceMinutes: 0,
		firstCheckInAt: inAt,
		lastCheckOutAt: outAt,
		effectiveCheckInAt: inAt,
		effectiveCheckOutAt: outAt,
		scheduledWorkMinutes: 480,
		workedMinutes: 480 - late - early,
		arrivalDelayMinutes: late,
		lateMinutes: late,
		earlyLeaveMinutes: early,
		calculationStatus: (o.result ?? 'PRESENT') as never,
		calculatedAt: new Date(),
		calculationVersion: 1,
		status: 'COMPLETED' as const,
		isWorkingDay: true
	};
};

async function mkEmployee(
	w: { companyId: string },
	code: string,
	o: {
		status?: 'ACTIVE' | 'PROBATION' | 'SUSPENDED' | 'RESIGNED';
		branchId?: string | null;
		departmentId?: string | null;
		typeId?: string | null;
		start?: string;
		end?: string | null;
		managerId?: string | null;
		userId?: string | null;
	}
) {
	return prisma.employee.create({
		data: {
			employeeCode: `${code}_${uid()}`,
			firstNameLao: 'ລາຍງານ',
			lastNameLao: code,
			startDate: D(o.start ?? '2024-01-01'),
			endDate: o.end ? D(o.end) : null,
			employmentStatus: o.status ?? 'ACTIVE',
			companyId: w.companyId,
			branchId: o.branchId ?? null,
			departmentId: o.departmentId ?? null,
			employmentTypeId: o.typeId ?? null,
			managerEmployeeId: o.managerId ?? null,
			userId: o.userId ?? null
		},
		select: { id: true, employeeCode: true }
	});
}

async function linkedUser(roleCode: 'MANAGER' | 'EMPLOYEE') {
	const u = await createTestUser({ roleCode });
	return { cookie: await loginAndGetCookie(u.username, u.password), userId: u.user.id };
}

export async function reportingWorld(): Promise<World> {
	const company = await createTestCompany();
	const companyId = company.id;
	const s = uid();
	const b1 = await prisma.branch.create({
		data: { companyId, code: `B1_${s}`, nameLao: 'ສາຂາ 1' }
	});
	const b2 = await prisma.branch.create({
		data: { companyId, code: `B2_${s}`, nameLao: 'ສາຂາ 2' }
	});
	const d1 = await prisma.department.create({
		data: { companyId, branchId: b1.id, code: `D1_${s}`, nameLao: 'ພະແນກ 1' }
	});
	const d2 = await prisma.department.create({
		data: { companyId, branchId: b2.id, code: `D2_${s}`, nameLao: 'ພະແນກ 2' }
	});
	const ft = await prisma.employmentType.create({
		data: { companyId, code: `FT_${s}`, nameLao: 'ເຕັມເວລາ' }
	});
	const pt = await prisma.employmentType.create({
		data: { companyId, code: `PT_${s}`, nameLao: 'ບາງເວລາ' }
	});
	const lt1 = await prisma.leaveType.create({
		data: { companyId, code: `AL_${s}`, nameLao: 'ລາພັກປະຈຳປີ', requiresBalance: true }
	});
	const lt2 = await prisma.leaveType.create({
		data: { companyId, code: `SL_${s}`, nameLao: 'ລາປ່ວຍ', requiresBalance: false }
	});
	const shift = await prisma.shift.create({
		data: {
			companyId,
			code: `SH_${s}`,
			nameLao: 'ກະລາຍງານ',
			startTime: '08:00',
			endTime: '17:00',
			breakMinutes: 60,
			workDays: {
				create: DAYS7.map((dayOfWeek, i) => ({
					dayOfWeek: dayOfWeek as never,
					isWorkingDay: i < 5
				}))
			}
		}
	});
	await prisma.holiday.create({
		data: { companyId, holidayDate: D(THU), nameLao: `ວັນພັກທົດສອບ ${s}` }
	});

	const manager = await linkedUser('MANAGER');
	const employeeUser = await linkedUser('EMPLOYEE');
	const w = { companyId };
	const MGR = await mkEmployee(w, 'MGR', {
		branchId: b1.id,
		departmentId: d1.id,
		typeId: ft.id,
		userId: manager.userId
	});
	const A = await mkEmployee(w, 'A', {
		branchId: b1.id,
		departmentId: d1.id,
		typeId: ft.id,
		managerId: MGR.id,
		userId: employeeUser.userId
	});
	const B = await mkEmployee(w, 'B', {
		branchId: b1.id,
		departmentId: d1.id,
		typeId: pt.id,
		managerId: MGR.id
	});
	const Cp = await mkEmployee(w, 'CP', {
		status: 'PROBATION',
		branchId: b2.id,
		departmentId: d2.id,
		typeId: ft.id
	});
	const Dd = await mkEmployee(w, 'DD', { branchId: b2.id, departmentId: d2.id, typeId: ft.id });
	const E = await mkEmployee(w, 'E', { status: 'SUSPENDED' });
	const F = await mkEmployee(w, 'F', {
		status: 'RESIGNED',
		branchId: b2.id,
		departmentId: d2.id,
		typeId: ft.id,
		end: '2025-05-01'
	});
	const G = await mkEmployee(w, 'G', {
		branchId: b1.id,
		departmentId: d1.id,
		typeId: ft.id,
		start: '2025-06-10'
	});
	for (const e of [MGR, A, B, Cp, Dd, F]) {
		await prisma.employeeScheduleAssignment.create({
			data: { employeeId: e.id, shiftId: shift.id, effectiveFrom: D('2024-01-01') }
		});
	}
	await prisma.employeeScheduleAssignment.create({
		data: { employeeId: G.id, shiftId: shift.id, effectiveFrom: D('2025-06-10') }
	});

	const all5 = [MGR, A, B, Cp, Dd];
	await prisma.attendanceRecord.createMany({
		data: [
			...all5.map((e) => recordRow(e.id, shift.id, MON)),
			...[MGR, A, Cp, Dd].map((e) => recordRow(e.id, shift.id, TUE)),
			recordRow(B.id, shift.id, TUE, { result: 'EARLY_LEAVE', early: 30 }),
			...[MGR, A].map((e) => recordRow(e.id, shift.id, WED)),
			recordRow(B.id, shift.id, WED, { result: 'LATE', late: 15 }),
			...all5.map((e) => recordRow(e.id, shift.id, FRI))
		]
	});

	// ---- leave (domain rows written directly: reporting only READS them) ----
	const admin = await createTestUser({ roleCode: 'SUPER_ADMIN' });
	const leave = async (
		employeeId: string,
		leaveTypeId: string,
		iso: string,
		status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'CANCELLED'
	) =>
		prisma.leaveRequest.create({
			data: {
				employeeId,
				leaveTypeId,
				startDate: D(iso),
				endDate: D(iso),
				totalDays: 1,
				reason: 'QA reporting',
				status,
				requestedByUserId: admin.user.id,
				days: { create: [{ employeeId, leaveDate: D(iso), dayValue: 1 }] }
			}
		});
	await leave(Dd.id, lt1.id, WED, 'APPROVED');
	await leave(Cp.id, lt2.id, '2025-06-10', 'PENDING');
	await leave(A.id, lt2.id, '2025-06-11', 'REJECTED');
	await leave(B.id, lt2.id, '2025-06-12', 'CANCELLED');
	await prisma.leaveBalance.create({
		data: { employeeId: Dd.id, leaveTypeId: lt1.id, year: 2025, entitlementDays: 10 }
	});

	// ---- overtime (Wed, after shift) ----
	const ot = async (
		employeeId: string,
		status: 'APPROVED' | 'PENDING' | 'REJECTED',
		planned: number,
		eligible: number | null
	) =>
		prisma.overtimeRequest.create({
			data: {
				employeeId,
				workDate: D(WED),
				type: 'AFTER_SHIFT',
				requestedStartAt: new Date(`${WED}T10:00:00Z`),
				requestedEndAt: new Date(new Date(`${WED}T10:00:00Z`).getTime() + planned * 60_000),
				plannedMinutes: planned,
				reason: 'QA reporting OT',
				status,
				requestedByUserId: admin.user.id,
				isWorkingDay: true,
				actualMinutes: eligible,
				eligibleMinutes: eligible,
				calculationStatus: eligible === null ? 'PENDING_ATTENDANCE' : 'CALCULATED',
				calculationVersion: 1
			}
		});
	await ot(A.id, 'APPROVED', 120, 90);
	await ot(B.id, 'APPROVED', 60, 30);
	await ot(Cp.id, 'PENDING', 120, null);
	await ot(Dd.id, 'REJECTED', 60, null);

	const ref = (e: { id: string; employeeCode: string }) => ({ id: e.id, code: e.employeeCode });
	return {
		companyId,
		b1: b1.id,
		b2: b2.id,
		d1: d1.id,
		d2: d2.id,
		ft: ft.id,
		pt: pt.id,
		lt1: lt1.id,
		lt2: lt2.id,
		shiftId: shift.id,
		emp: {
			MGR: ref(MGR),
			A: ref(A),
			B: ref(B),
			Cp: ref(Cp),
			Dd: ref(Dd),
			E: ref(E),
			F: ref(F),
			G: ref(G)
		},
		manager,
		employeeUser
	};
}

/** Role-based sessions used across the Phase 17A suites. */
export async function roleSessions() {
	const mk = async (roleCode: string) => {
		const u = await createTestUser({ roleCode });
		return loginAndGetCookie(u.username, u.password);
	};
	return {
		superAdmin: await mk('SUPER_ADMIN'),
		hrAdmin: await mk('HR_ADMIN')
	};
}

export async function withPerms(codes: string[]) {
	return (await userWithPermissions(codes)).cookie;
}

export function ok<T = Record<string, unknown>>(res: { status: number; body: { data: T } }): T {
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data;
}

export const MONEY = /^-?\d+\.\d{2}$/;
