import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	agent,
	createTestCompany,
	createTestUser,
	loginAndGetCookie,
	superAdminCookie,
	userWithPermissions
} from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import {
	addDays,
	dayOfWeekOf,
	formatDateOnly,
	laosDateOf,
	laosParts,
	shiftCrossesMidnight,
	todayInLaos,
	workDateForInstant
} from '../src/lib/dates.js';

const uid = () => randomUUID().slice(0, 6).toUpperCase();

let admin: string;
beforeAll(async () => {
	admin = await superAdminCookie();
});

const OFFICE = { startTime: '08:00', endTime: '17:00', breakMinutes: 60 };

async function createShift(companyId: string, overrides: Record<string, unknown> = {}) {
	const res = await agent()
		.post('/api/v1/shifts')
		.set('Cookie', admin)
		.send({ companyId, code: `S_${uid()}`, nameLao: 'ກະທົດສອບ', ...OFFICE, ...overrides });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data as {
		id: string;
		code: string;
		workDays: { dayOfWeek: string; isWorkingDay: boolean }[];
	};
}

async function createEmployee(companyId: string, overrides: Record<string, unknown> = {}) {
	return prisma.employee.create({
		data: {
			employeeCode: `E_${uid()}`,
			firstNameLao: 'ທົດສອບ',
			lastNameLao: 'ກະ',
			startDate: new Date('2024-01-01T00:00:00.000Z'),
			companyId,
			...overrides
		}
	});
}

const assign = (employeeId: string, body: Record<string, unknown>, cookie = admin) =>
	agent().post(`/api/v1/employees/${employeeId}/schedules`).set('Cookie', cookie).send(body);
const history = async (employeeId: string) =>
	(await agent().get(`/api/v1/employees/${employeeId}/schedules`).set('Cookie', admin)).body.data
		.items as {
		effectiveFrom: string;
		effectiveTo: string | null;
		state: string;
		shiftId: string;
	}[];
const resolve = (employeeId: string, date: string, cookie = admin) =>
	agent().get(`/api/v1/employees/${employeeId}/schedule?date=${date}`).set('Cookie', cookie);
const day = (d: Date) => formatDateOnly(d);

async function setup() {
	const company = await createTestCompany();
	const shift = await createShift(company.id);
	const employee = await createEmployee(company.id);
	return { company, shift, employee };
}

describe('shifts', () => {
	it('requires authentication (401)', async () => {
		expect((await agent().get('/api/v1/shifts')).status).toBe(401);
	});

	it('requires shifts.view (403 for the EMPLOYEE role)', async () => {
		const { username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
		const cookie = await loginAndGetCookie(username, password);
		expect((await agent().get('/api/v1/shifts').set('Cookie', cookie)).status).toBe(403);
	});

	it('creates a shift with the default Monday–Friday pattern', async () => {
		const company = await createTestCompany();
		const shift = await createShift(company.id);
		const working = shift.workDays.filter((d) => d.isWorkingDay).map((d) => d.dayOfWeek);
		expect(shift.workDays.length).toBe(7);
		expect(working).toEqual(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']);
	});

	it('rejects a duplicate code within a company (409)', async () => {
		const company = await createTestCompany();
		const shift = await createShift(company.id);
		const res = await agent()
			.post('/api/v1/shifts')
			.set('Cookie', admin)
			.send({ companyId: company.id, code: shift.code, nameLao: 'ຊ້ຳ', ...OFFICE });
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe('SHIFT_CODE_TAKEN');
	});

	it('creates an overnight shift and derives crossesMidnight (ignoring the client)', async () => {
		const company = await createTestCompany();
		const res = await agent()
			.post('/api/v1/shifts')
			.set('Cookie', admin)
			.send({
				companyId: company.id,
				code: `N_${uid()}`,
				nameLao: 'ກະກາງຄືນ',
				startTime: '22:00',
				endTime: '06:00',
				breakMinutes: 60,
				crossesMidnight: false
			});
		expect(res.status).toBe(201);
		expect(res.body.data.crossesMidnight).toBe(true);
		const normal = await createShift(company.id);
		const fetched = await agent().get(`/api/v1/shifts/${normal.id}`).set('Cookie', admin);
		expect(fetched.body.data.crossesMidnight).toBe(false);
	});

	it('rejects invalid times, zero-length shifts, and a break longer than the shift', async () => {
		const company = await createTestCompany();
		const post = (body: Record<string, unknown>) =>
			agent()
				.post('/api/v1/shifts')
				.set('Cookie', admin)
				.send({ companyId: company.id, code: `X_${uid()}`, nameLao: 'ກະ', ...OFFICE, ...body });
		expect((await post({ startTime: '25:00' })).status).toBe(400);
		expect((await post({ endTime: '8:5' })).status).toBe(400);
		expect((await post({ startTime: '08:00', endTime: '08:00' })).status).toBe(400);
		expect((await post({ breakMinutes: 600 })).status).toBe(400);
		expect((await post({ breakMinutes: -5 })).status).toBe(400);
		expect((await post({ nameLao: '   ' })).status).toBe(400);
		expect((await post({ code: '  ' })).status).toBe(400);
	});

	it('cannot create an ACTIVE shift under an inactive company', async () => {
		const company = await createTestCompany({ status: 'INACTIVE' });
		const res = await agent()
			.post('/api/v1/shifts')
			.set('Cookie', admin)
			.send({ companyId: company.id, code: `X_${uid()}`, nameLao: 'ກະ', ...OFFICE });
		expect(res.body.error.code).toBe('INACTIVE_PARENT');
	});

	it('updates a shift and recomputes crossesMidnight', async () => {
		const company = await createTestCompany();
		const shift = await createShift(company.id);
		const res = await agent()
			.patch(`/api/v1/shifts/${shift.id}`)
			.set('Cookie', admin)
			.send({ nameLao: 'ກະໃໝ່', startTime: '22:00', endTime: '06:00' });
		expect(res.status).toBe(200);
		expect(res.body.data.nameLao).toBe('ກະໃໝ່');
		expect(res.body.data.crossesMidnight).toBe(true);
		// an edit that omits `status` must not touch it
		await agent()
			.patch(`/api/v1/shifts/${shift.id}`)
			.set('Cookie', admin)
			.send({ status: 'INACTIVE' });
		const again = await agent()
			.patch(`/api/v1/shifts/${shift.id}`)
			.set('Cookie', admin)
			.send({ nameLao: 'ຊື່ອື່ນ' });
		expect(again.body.data.status).toBe('INACTIVE');
	});

	it('changing status needs shifts.disable; create needs shifts.create', async () => {
		const company = await createTestCompany();
		const shift = await createShift(company.id);
		const { cookie } = await userWithPermissions(['shifts.view', 'shifts.update']);
		const off = await agent()
			.patch(`/api/v1/shifts/${shift.id}`)
			.set('Cookie', cookie)
			.send({ status: 'INACTIVE' });
		expect(off.status).toBe(403);
		const rename = await agent()
			.patch(`/api/v1/shifts/${shift.id}`)
			.set('Cookie', cookie)
			.send({ nameLao: 'ປ່ຽນຊື່' });
		expect(rename.status).toBe(200);
		const create = await agent()
			.post('/api/v1/shifts')
			.set('Cookie', cookie)
			.send({ companyId: company.id, code: `X_${uid()}`, nameLao: 'ກະ', ...OFFICE });
		expect(create.status).toBe(403);
	});

	it('persists the weekly work pattern, replaces it on update, and leaves omitted days off', async () => {
		const company = await createTestCompany();
		const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
		const shift = await createShift(company.id, {
			workDays: days.map((dayOfWeek) => ({ dayOfWeek, isWorkingDay: true }))
		});
		const got = await agent().get(`/api/v1/shifts/${shift.id}`).set('Cookie', admin);
		const working = (d: { dayOfWeek: string; isWorkingDay: boolean }[]) =>
			d.filter((x) => x.isWorkingDay).map((x) => x.dayOfWeek);
		expect(working(got.body.data.workDays)).toEqual(days);

		const upd = await agent()
			.patch(`/api/v1/shifts/${shift.id}`)
			.set('Cookie', admin)
			.send({
				workDays: [{ dayOfWeek: 'SUNDAY', isWorkingDay: true, startTimeOverride: '09:00' }]
			});
		expect(upd.status).toBe(200);
		expect(working(upd.body.data.workDays)).toEqual(['SUNDAY']);
		expect(upd.body.data.workDays.length).toBe(7);
		expect(await prisma.shiftWorkDay.count({ where: { shiftId: shift.id } })).toBe(7);

		const dup = await agent()
			.patch(`/api/v1/shifts/${shift.id}`)
			.set('Cookie', admin)
			.send({
				workDays: [
					{ dayOfWeek: 'MONDAY', isWorkingDay: true },
					{ dayOfWeek: 'MONDAY', isWorkingDay: false }
				]
			});
		expect(dup.status).toBe(400);
	});

	it('lists with filters and looks up ACTIVE shifts only', async () => {
		const company = await createTestCompany();
		const active = await createShift(company.id);
		const flexible = await createShift(company.id, { shiftType: 'FLEXIBLE' });
		const inactive = await createShift(company.id, { status: 'INACTIVE' });

		const byType = await agent()
			.get(`/api/v1/shifts?companyId=${company.id}&type=FLEXIBLE`)
			.set('Cookie', admin);
		expect(byType.body.data.items.map((s: { id: string }) => s.id)).toEqual([flexible.id]);
		const lookup = await agent()
			.get(`/api/v1/shifts/lookup?companyId=${company.id}`)
			.set('Cookie', admin);
		const ids = lookup.body.data.map((s: { id: string }) => s.id);
		expect(ids).toContain(active.id);
		expect(ids).not.toContain(inactive.id);
	});
});

describe('holidays', () => {
	const post = (companyId: string, body: Record<string, unknown>) =>
		agent()
			.post('/api/v1/holidays')
			.set('Cookie', admin)
			.send({ companyId, holidayDate: '2026-12-02', nameLao: 'ວັນຊາດ', ...body });

	it('creates a public holiday (paid by default) and a company holiday', async () => {
		const company = await createTestCompany();
		const pub = await post(company.id, {});
		expect(pub.status).toBe(201);
		expect(pub.body.data.type).toBe('PUBLIC');
		expect(pub.body.data.isPaid).toBe(true);
		const own = await post(company.id, {
			holidayDate: '2026-11-15',
			nameLao: 'ວັນບໍລິສັດ',
			type: 'COMPANY',
			isPaid: false
		});
		expect(own.status).toBe(201);
		expect(own.body.data.type).toBe('COMPANY');
		expect(own.body.data.isPaid).toBe(false);
	});

	it('rejects a duplicate (same company + date + name) and a fake date', async () => {
		const company = await createTestCompany();
		await post(company.id, {});
		const dup = await post(company.id, {});
		expect(dup.status).toBe(409);
		expect(dup.body.error.code).toBe('HOLIDAY_DUPLICATE');
		expect((await post(company.id, { holidayDate: '2026-02-30' })).status).toBe(400);
		expect((await post(company.id, { nameLao: '  ', holidayDate: '2026-03-01' })).status).toBe(400);
	});

	it('filters by year, month, type and search', async () => {
		const company = await createTestCompany();
		await post(company.id, { holidayDate: '2026-12-02', nameLao: 'ວັນຊາດ' });
		await post(company.id, { holidayDate: '2026-12-25', nameLao: 'ຄຣິສມາດ', type: 'COMPANY' });
		await post(company.id, { holidayDate: '2027-01-01', nameLao: 'ປີໃໝ່' });
		const get = async (qs: string) =>
			(await agent().get(`/api/v1/holidays?companyId=${company.id}&${qs}`).set('Cookie', admin))
				.body.data;

		expect((await get('year=2026')).total).toBe(2);
		expect((await get('year=2026&month=12')).total).toBe(2);
		expect((await get('year=2026&month=11')).total).toBe(0);
		expect((await get('year=2027&month=1')).items[0].nameLao).toBe('ປີໃໝ່');
		expect((await get('type=COMPANY')).total).toBe(1);
		expect((await get('search=ວັນຊາດ')).total).toBe(1);
		expect((await agent().get(`/api/v1/holidays?month=12`).set('Cookie', admin)).status).toBe(400);
	});

	it('cannot create an ACTIVE holiday under an inactive company', async () => {
		const company = await createTestCompany({ status: 'INACTIVE' });
		const res = await post(company.id, {});
		expect(res.body.error.code).toBe('INACTIVE_PARENT');
	});

	it('changing status needs holidays.disable; a plain edit does not reset status', async () => {
		const company = await createTestCompany();
		const created = await post(company.id, { status: 'INACTIVE' });
		const id = created.body.data.id;
		const { cookie } = await userWithPermissions(['holidays.view', 'holidays.update']);
		const off = await agent()
			.patch(`/api/v1/holidays/${id}`)
			.set('Cookie', cookie)
			.send({ status: 'ACTIVE' });
		expect(off.status).toBe(403);
		const edit = await agent()
			.patch(`/api/v1/holidays/${id}`)
			.set('Cookie', cookie)
			.send({ nameEnglish: 'National Day' });
		expect(edit.status).toBe(200);
		expect(edit.body.data.status).toBe('INACTIVE');
	});
});

describe('employee schedule assignment', () => {
	it('assigns a shift and records history', async () => {
		const { shift, employee } = await setup();
		const res = await assign(employee.id, { shiftId: shift.id, effectiveFrom: '2026-01-01' });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const rows = await history(employee.id);
		expect(rows.length).toBe(1);
		expect(rows[0]!.effectiveTo).toBeNull();
		expect(rows[0]!.state).toBe('CURRENT');
	});

	it('rejects a shift from another company', async () => {
		const { employee } = await setup();
		const other = await createTestCompany();
		const foreign = await createShift(other.id);
		const res = await assign(employee.id, { shiftId: foreign.id, effectiveFrom: '2026-01-01' });
		expect(res.body.error.code).toBe('SHIFT_COMPANY_MISMATCH');
	});

	it('rejects an inactive shift', async () => {
		const { company, employee } = await setup();
		const off = await createShift(company.id, { status: 'INACTIVE' });
		const res = await assign(employee.id, { shiftId: off.id, effectiveFrom: '2026-01-01' });
		expect(res.body.error.code).toBe('INACTIVE_SHIFT');
	});

	it('rejects ended and suspended employees but keeps their history', async () => {
		const { company, shift, employee } = await setup();
		await assign(employee.id, { shiftId: shift.id, effectiveFrom: '2026-01-01' });
		for (const status of ['RESIGNED', 'TERMINATED', 'SUSPENDED'] as const) {
			const gone = await createEmployee(company.id, { employmentStatus: status });
			const res = await assign(gone.id, { shiftId: shift.id, effectiveFrom: '2026-01-01' });
			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe('EMPLOYEE_NOT_SCHEDULABLE');
		}
		await prisma.employee.update({
			where: { id: employee.id },
			data: { employmentStatus: 'RESIGNED', endDate: new Date('2026-06-30T00:00:00.000Z') }
		});
		const another = await createShift(company.id);
		expect(
			(await assign(employee.id, { shiftId: another.id, effectiveFrom: '2026-07-01' })).status
		).toBe(400);
		expect((await history(employee.id)).length).toBe(1);
	});

	it('rejects an overlapping range and a reversed range', async () => {
		const { company, shift, employee } = await setup();
		const b = await createShift(company.id);
		await assign(employee.id, {
			shiftId: shift.id,
			effectiveFrom: '2026-01-01',
			effectiveTo: '2026-08-01'
		});
		const overlap = await assign(employee.id, { shiftId: b.id, effectiveFrom: '2026-07-01' });
		expect(overlap.status).toBe(400);
		expect(overlap.body.error.code).toBe('SCHEDULE_OVERLAP');
		const inside = await assign(employee.id, {
			shiftId: b.id,
			effectiveFrom: '2026-03-01',
			effectiveTo: '2026-03-31'
		});
		expect(inside.body.error.code).toBe('SCHEDULE_OVERLAP');
		const reversed = await assign(employee.id, {
			shiftId: b.id,
			effectiveFrom: '2026-09-01',
			effectiveTo: '2026-08-01'
		});
		expect(reversed.status).toBe(400);
		expect((await history(employee.id)).length).toBe(1);
	});

	it('allows back-to-back periods (2026-06-30 then 2026-07-01) and non-overlapping backdating', async () => {
		const { company, shift, employee } = await setup();
		const b = await createShift(company.id);
		const first = await assign(employee.id, {
			shiftId: shift.id,
			effectiveFrom: '2026-01-01',
			effectiveTo: '2026-06-30'
		});
		expect(first.status).toBe(201);
		expect((await assign(employee.id, { shiftId: b.id, effectiveFrom: '2026-07-01' })).status).toBe(
			201
		);
		// backdated, fits before the first period
		const back = await assign(employee.id, {
			shiftId: b.id,
			effectiveFrom: '2025-01-01',
			effectiveTo: '2025-12-31'
		});
		expect(back.status).toBe(201);
		expect((await history(employee.id)).length).toBe(3);
	});

	it('a future assignment closes the open one the day before and keeps the current one current', async () => {
		const { company, shift, employee } = await setup();
		const night = await createShift(company.id, { startTime: '22:00', endTime: '06:00' });
		const today = todayInLaos();
		const nextMonth = addDays(today, 30);
		await assign(employee.id, { shiftId: shift.id, effectiveFrom: day(addDays(today, -60)) });
		const res = await assign(employee.id, { shiftId: night.id, effectiveFrom: day(nextMonth) });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.data.state).toBe('FUTURE');

		const rows = await history(employee.id);
		const current = rows.find((r) => r.state === 'CURRENT');
		const future = rows.find((r) => r.state === 'FUTURE');
		expect(current?.shiftId).toBe(shift.id);
		expect(current?.effectiveTo?.slice(0, 10)).toBe(day(addDays(nextMonth, -1)));
		expect(future?.shiftId).toBe(night.id);

		const list = await agent()
			.get(`/api/v1/employee-schedules?employeeId=${employee.id}`)
			.set('Cookie', admin);
		expect(list.body.data.items[0].current.shiftId).toBe(shift.id);
		expect(list.body.data.items[0].upcoming.shiftId).toBe(night.id);
	});

	it('replacing an open schedule when there is a later period must be explicit (overlap)', async () => {
		const { company, shift, employee } = await setup();
		const b = await createShift(company.id);
		await assign(employee.id, {
			shiftId: shift.id,
			effectiveFrom: '2026-01-01',
			effectiveTo: '2026-03-31'
		});
		await assign(employee.id, { shiftId: b.id, effectiveFrom: '2026-06-01' });
		const res = await assign(employee.id, { shiftId: shift.id, effectiveFrom: '2026-02-01' });
		expect(res.body.error.code).toBe('SCHEDULE_OVERLAP');
	});

	it('an assignment correction re-validates overlap', async () => {
		const { company, shift, employee } = await setup();
		const b = await createShift(company.id);
		const a1 = await assign(employee.id, {
			shiftId: shift.id,
			effectiveFrom: '2026-01-01',
			effectiveTo: '2026-03-31'
		});
		await assign(employee.id, { shiftId: b.id, effectiveFrom: '2026-06-01' });
		const id = a1.body.data.id;
		const bad = await agent()
			.patch(`/api/v1/employee-schedules/${id}`)
			.set('Cookie', admin)
			.send({ effectiveTo: '2026-07-01' });
		expect(bad.body.error.code).toBe('SCHEDULE_OVERLAP');
		const ok = await agent()
			.patch(`/api/v1/employee-schedules/${id}`)
			.set('Cookie', admin)
			.send({ effectiveTo: '2026-04-30', reason: 'ແກ້ໄຂ' });
		expect(ok.status).toBe(200);
		expect(ok.body.data.effectiveTo.slice(0, 10)).toBe('2026-04-30');
	});

	it('schedules.assign is required to assign (view alone cannot)', async () => {
		const { shift, employee } = await setup();
		const { cookie } = await userWithPermissions(['schedules.view', 'employees.view_all']);
		expect(
			(await assign(employee.id, { shiftId: shift.id, effectiveFrom: '2026-01-01' }, cookie)).status
		).toBe(403);
		expect((await history(employee.id)).length).toBe(0);
		const seeHistory = await agent()
			.get(`/api/v1/employees/${employee.id}/schedules`)
			.set('Cookie', cookie);
		expect(seeHistory.status).toBe(200);
	});

	it('respects the Employee data scope for a manager', async () => {
		const { company, shift } = await setup();
		const { user, username, password } = await createTestUser({ roleCode: 'MANAGER' });
		const mgr = await createEmployee(company.id, { userId: user.id });
		const report = await createEmployee(company.id, { managerEmployeeId: mgr.id });
		const outsider = await createEmployee(company.id);
		for (const e of [mgr, report, outsider]) {
			await assign(e.id, { shiftId: shift.id, effectiveFrom: '2026-01-01' });
		}
		const cookie = await loginAndGetCookie(username, password);

		const list = await agent()
			.get(`/api/v1/employee-schedules?companyId=${company.id}&pageSize=100`)
			.set('Cookie', cookie);
		const ids = list.body.data.items.map((i: { employee: { id: string } }) => i.employee.id).sort();
		expect(ids).toEqual([mgr.id, report.id].sort());

		expect(
			(await agent().get(`/api/v1/employees/${report.id}/schedules`).set('Cookie', cookie)).status
		).toBe(200);
		expect((await resolve(report.id, '2026-09-21', cookie)).status).toBe(200);
	});

	it('rejects out-of-scope employees (history, resolve, assign, correction)', async () => {
		const { company, shift } = await setup();
		const { user, username, password } = await createTestUser({ roleCode: 'MANAGER' });
		await createEmployee(company.id, { userId: user.id });
		const outsider = await createEmployee(company.id);
		const a = await assign(outsider.id, { shiftId: shift.id, effectiveFrom: '2026-01-01' });
		const cookie = await loginAndGetCookie(username, password);

		expect(
			(await agent().get(`/api/v1/employees/${outsider.id}/schedules`).set('Cookie', cookie)).status
		).toBe(403);
		expect((await resolve(outsider.id, '2026-09-21', cookie)).status).toBe(403);
		// a scope-limited user who also holds schedules.assign is still bounded by scope
		const { cookie: assigner } = await userWithPermissions(['schedules.assign']);
		expect(
			(await assign(outsider.id, { shiftId: shift.id, effectiveFrom: '2027-01-01' }, assigner))
				.status
		).toBe(403);
		const fix = await agent()
			.patch(`/api/v1/employee-schedules/${a.body.data.id}`)
			.set('Cookie', assigner)
			.send({ reason: 'x' });
		expect(fix.status).toBe(403);
	});

	it('flags (but never rewrites) a schedule whose company no longer matches the employee', async () => {
		const { company, shift, employee } = await setup();
		await assign(employee.id, { shiftId: shift.id, effectiveFrom: '2026-01-01' });
		const other = await createTestCompany();
		await prisma.employee.update({ where: { id: employee.id }, data: { companyId: other.id } });
		const res = await resolve(employee.id, '2026-09-21');
		expect(res.body.data.companyMismatch).toBe(true);
		expect((await history(employee.id))[0]!.shiftId).toBe(shift.id);
		expect(company.id).not.toBe(other.id);
	});
});

describe('schedule resolution', () => {
	// 2026-09-21 is a Monday, 2026-09-19 a Saturday, 2026-12-02 a Wednesday.
	it('resolves a normal Monday to the working shift', async () => {
		const { shift, employee } = await setup();
		await assign(employee.id, { shiftId: shift.id, effectiveFrom: '2026-01-01' });
		const res = await resolve(employee.id, '2026-09-21');
		const d = res.body.data;
		expect(res.status).toBe(200);
		expect(d.dayOfWeek).toBe('MONDAY');
		expect(d.hasSchedule).toBe(true);
		expect(d.isWorkingDay).toBe(true);
		expect(d.isHoliday).toBe(false);
		expect(d.shift.code).toBe(shift.code);
		expect(d.expected).toMatchObject({ startTime: '08:00', endTime: '17:00', breakMinutes: 60 });
		// this endpoint only resolves context — it never invents attendance data
		for (const key of ['attendanceStatus', 'isLate', 'isAbsent', 'workedMinutes'])
			expect(d).not.toHaveProperty(key);
	});

	it('resolves a Saturday as a non-working day', async () => {
		const { shift, employee } = await setup();
		await assign(employee.id, { shiftId: shift.id, effectiveFrom: '2026-01-01' });
		const d = (await resolve(employee.id, '2026-09-19')).body.data;
		expect(d.dayOfWeek).toBe('SATURDAY');
		expect(d.isWorkingDay).toBe(false);
		expect(d.expected).toBeNull();
	});

	it('resolves a holiday as isHoliday without deciding attendance', async () => {
		const { company, shift, employee } = await setup();
		await assign(employee.id, { shiftId: shift.id, effectiveFrom: '2026-01-01' });
		await agent()
			.post('/api/v1/holidays')
			.set('Cookie', admin)
			.send({ companyId: company.id, holidayDate: '2026-12-02', nameLao: 'ວັນຊາດ' });
		const d = (await resolve(employee.id, '2026-12-02')).body.data;
		expect(d.isHoliday).toBe(true);
		expect(d.holiday.nameLao).toBe('ວັນຊາດ');
		expect(d.isWorkingDay).toBe(true); // the weekly pattern alone; policy is for Attendance
		const normal = (await resolve(employee.id, '2026-12-03')).body.data;
		expect(normal.isHoliday).toBe(false);
	});

	it("ignores inactive holidays and other companies' holidays", async () => {
		const { company, shift, employee } = await setup();
		const other = await createTestCompany();
		await assign(employee.id, { shiftId: shift.id, effectiveFrom: '2026-01-01' });
		await prisma.holiday.create({
			data: {
				companyId: company.id,
				holidayDate: new Date('2026-10-01T00:00:00.000Z'),
				nameLao: 'ປິດ',
				status: 'INACTIVE'
			}
		});
		await prisma.holiday.create({
			data: {
				companyId: other.id,
				holidayDate: new Date('2026-10-02T00:00:00.000Z'),
				nameLao: 'ບໍລິສັດອື່ນ'
			}
		});
		expect((await resolve(employee.id, '2026-10-01')).body.data.isHoliday).toBe(false);
		expect((await resolve(employee.id, '2026-10-02')).body.data.isHoliday).toBe(false);
	});

	it('resolves an overnight shift with the end on the next calendar day', async () => {
		const company = await createTestCompany();
		const night = await createShift(company.id, { startTime: '22:00', endTime: '06:00' });
		const employee = await createEmployee(company.id);
		await assign(employee.id, { shiftId: night.id, effectiveFrom: '2026-01-01' });
		const d = (await resolve(employee.id, '2026-09-21')).body.data;
		expect(d.shift.crossesMidnight).toBe(true);
		expect(d.expected).toMatchObject({
			startTime: '22:00',
			endTime: '06:00',
			crossesMidnight: true
		});
		expect(d.expected.endsOnDate.slice(0, 10)).toBe('2026-09-22');
	});

	it('uses per-day overrides and picks the schedule effective on the requested date', async () => {
		const company = await createTestCompany();
		const a = await createShift(company.id, {
			workDays: [
				{
					dayOfWeek: 'MONDAY',
					isWorkingDay: true,
					startTimeOverride: '09:00',
					breakMinutesOverride: 30
				}
			]
		});
		const b = await createShift(company.id, { startTime: '10:00', endTime: '19:00' });
		const employee = await createEmployee(company.id);
		await assign(employee.id, {
			shiftId: a.id,
			effectiveFrom: '2026-01-01',
			effectiveTo: '2026-09-30'
		});
		await assign(employee.id, { shiftId: b.id, effectiveFrom: '2026-10-01' });

		const early = (await resolve(employee.id, '2026-09-21')).body.data;
		expect(early.expected).toMatchObject({
			startTime: '09:00',
			endTime: '17:00',
			breakMinutes: 30
		});
		expect(early.shift.id).toBe(a.id);
		const later = (await resolve(employee.id, '2026-10-05')).body.data; // a Monday
		expect(later.shift.id).toBe(b.id);
		const before = (await resolve(employee.id, '2025-12-31')).body.data;
		expect(before.hasSchedule).toBe(false);
		expect(before.expected).toBeNull();
	});

	it('the date defaults to today in Laos when omitted', async () => {
		const { shift, employee } = await setup();
		await assign(employee.id, { shiftId: shift.id, effectiveFrom: '2020-01-01' });
		const res = await agent().get(`/api/v1/employees/${employee.id}/schedule`).set('Cookie', admin);
		expect(res.body.data.date.slice(0, 10)).toBe(day(todayInLaos()));
		expect((await resolve(employee.id, 'not-a-date')).status).toBe(400);
	});
});

describe('Laos timezone helpers', () => {
	it('converts an instant to the Laos calendar date around the UTC boundary', () => {
		// 16:59Z = 23:59 Laos (same day); 17:00Z = 00:00 Laos (next day)
		expect(day(laosDateOf(new Date('2026-09-19T16:59:00Z')))).toBe('2026-09-19');
		expect(day(laosDateOf(new Date('2026-09-19T17:00:00Z')))).toBe('2026-09-20');
		expect(day(laosDateOf(new Date('2026-12-31T20:00:00Z')))).toBe('2027-01-01');
		expect(laosParts(new Date('2026-09-19T17:30:00Z')).minutesOfDay).toBe(30);
		expect(day(todayInLaos(new Date('2026-09-19T17:00:00Z')))).toBe('2026-09-20');
		expect(day(todayInLaos(new Date('2026-09-19T16:59:59Z')))).toBe('2026-09-19');
	});

	it('computes the weekday of a calendar date', () => {
		expect(dayOfWeekOf(new Date('2026-09-19T00:00:00Z'))).toBe('SATURDAY');
		expect(dayOfWeekOf(new Date('2026-09-21T00:00:00Z'))).toBe('MONDAY');
		expect(shiftCrossesMidnight('22:00', '06:00')).toBe(true);
		expect(shiftCrossesMidnight('08:00', '17:00')).toBe(false);
	});

	it('keeps the intended work date for an overnight shift', () => {
		const night = { startTime: '22:00', endTime: '06:00' };
		// 22:30 Laos on 09-19 -> starts that day
		expect(day(workDateForInstant(new Date('2026-09-19T15:30:00Z'), night))).toBe('2026-09-19');
		// 03:00 Laos on 09-20 (= 20:00Z on 09-19) still belongs to the 09-19 shift
		expect(day(workDateForInstant(new Date('2026-09-19T20:00:00Z'), night))).toBe('2026-09-19');
		// 06:30 Laos on 09-20 is after the shift end
		expect(day(workDateForInstant(new Date('2026-09-19T23:30:00Z'), night))).toBe('2026-09-20');
		// a normal day shift is unaffected by the midnight rule
		const office = { startTime: '08:00', endTime: '17:00' };
		expect(day(workDateForInstant(new Date('2026-09-19T20:00:00Z'), office))).toBe('2026-09-20');
	});
});
