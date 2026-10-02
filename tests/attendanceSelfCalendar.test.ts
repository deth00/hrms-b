import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	agent,
	createTestCompany,
	createTestUser,
	loginAndGetCookie,
	superAdminCookie,
	userWithPermissions
} from './helpers.js';
import { prisma } from '../src/config/prisma.js';
import { setServerClockForTests } from '../src/lib/clock.js';

/**
 * Employee portal — GET /attendance/me/calendar (read only, attendance.self). Every day comes from the
 * canonical daily resolver; the month totals use the reporting addDay rule.
 */
const uid = () => randomUUID().slice(0, 6).toUpperCase();

// Laos = UTC+7. Monday 2026-09-21.
const MON_0920 = '2026-09-21T02:20:00Z'; // 09:20 Laos (late)
const MON_1712 = '2026-09-21T10:12:00Z'; // 17:12 Laos
const MON_1800 = '2026-09-21T11:00:00Z'; // 18:00 Laos (shift over)

let admin: string;
beforeAll(async () => {
	admin = await superAdminCookie();
});
afterEach(() => setServerClockForTests(null));
const at = (iso: string) => setServerClockForTests(() => new Date(iso));

async function setup(startDate = '2024-01-01') {
	const company = await createTestCompany();
	const shiftRes = await agent()
		.post('/api/v1/shifts')
		.set('Cookie', admin)
		.send({
			companyId: company.id,
			code: `S_${uid()}`,
			nameLao: 'ກະປະຕິທິນ',
			startTime: '08:00',
			endTime: '17:00',
			breakMinutes: 60
		});
	expect(shiftRes.status, JSON.stringify(shiftRes.body)).toBe(201);
	const { user, username, password } = await createTestUser({ roleCode: 'EMPLOYEE' });
	const employee = await prisma.employee.create({
		data: {
			employeeCode: `E_${uid()}`,
			firstNameLao: 'ທົດສອບ',
			lastNameLao: 'ປະຕິທິນ',
			startDate: new Date(`${startDate}T00:00:00.000Z`),
			companyId: company.id,
			userId: user.id,
			employmentStatus: 'ACTIVE'
		}
	});
	await prisma.employeeScheduleAssignment.create({
		data: {
			employeeId: employee.id,
			shiftId: (shiftRes.body.data as { id: string }).id,
			effectiveFrom: new Date('2026-01-01T00:00:00.000Z')
		}
	});
	return { employee, cookie: await loginAndGetCookie(username, password) };
}

const calendar = (cookie: string, query = '') =>
	agent().get(`/api/v1/attendance/me/calendar${query}`).set('Cookie', cookie);

interface Day {
	date: string;
	employed: boolean;
	result?: string;
	shift?: { shiftName: string | null; startTime: string | null } | null;
	checkInAt?: string | null;
	lateMinutes?: number;
}

describe('GET /attendance/me/calendar — access', () => {
	it('requires authentication (401)', async () => {
		expect((await agent().get('/api/v1/attendance/me/calendar')).status).toBe(401);
	});

	it('requires attendance.self (403)', async () => {
		const { cookie } = await userWithPermissions(['dashboard.view']);
		expect((await calendar(cookie)).status).toBe(403);
	});

	it('a user without a linked employee gets NO_LINKED_EMPLOYEE (403)', async () => {
		const { cookie } = await userWithPermissions(['attendance.self']);
		const res = await calendar(cookie);
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe('NO_LINKED_EMPLOYEE');
	});

	it('rejects an invalid month or an unknown query key (400)', async () => {
		const { cookie } = await setup();
		for (const q of ['?month=2026-13', '?month=26-09', '?month=abc', '?employeeId=x']) {
			expect((await calendar(cookie, q)).status, q).toBe(400);
		}
	});
});

describe('GET /attendance/me/calendar — canonical month', () => {
	it('resolves every day of the month with the canonical results and consistent totals', async () => {
		const { cookie } = await setup();
		at(MON_0920);
		expect(
			(await agent().post('/api/v1/attendance/me/check-in').set('Cookie', cookie).send({})).status
		).toBe(201);
		at(MON_1712);
		expect(
			(await agent().post('/api/v1/attendance/me/check-out').set('Cookie', cookie).send({})).status
		).toBe(200);
		at(MON_1800);

		const res = await calendar(cookie, '?month=2026-09');
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const data = res.body.data as {
			month: string;
			today: string;
			totals: Record<string, number> & { attendanceRate: { percent: number | null } };
			days: Day[];
		};
		expect(data.month).toBe('2026-09');
		expect(data.today).toBe('2026-09-21');
		expect(data.days).toHaveLength(30);

		const byDate = new Map(data.days.map((d) => [d.date, d]));
		const mon = byDate.get('2026-09-21')!;
		expect(mon.result).toBe('LATE');
		expect(mon.checkInAt).toBeTruthy();
		expect(mon.lateMinutes).toBe(80);
		expect(mon.shift?.startTime).toBe('08:00');
		// a past working day without a record is ABSENT; a future one is PENDING (never ABSENT)
		expect(byDate.get('2026-09-18')!.result).toBe('ABSENT');
		expect(byDate.get('2026-09-22')!.result).toBe('PENDING');
		expect(data.days.filter((d) => d.date > data.today).every((d) => d.result !== 'ABSENT')).toBe(
			true
		);

		const count = (...results: string[]) =>
			data.days.filter((d) => d.result && results.includes(d.result)).length;
		const t = data.totals;
		expect(t.present).toBe(1);
		expect(t.late).toBe(1);
		expect(t.absent).toBe(count('ABSENT'));
		expect(t.absent).toBeGreaterThan(0);
		expect(t.pending).toBe(count('PENDING'));
		expect(t.offDay).toBe(count('OFF_DAY'));
		expect(t.scheduled).toBe(t.present + t.onLeave + t.absent + t.pending);
		expect(t.present + t.onLeave + t.absent + t.pending + t.offDay + t.holiday + t.noSchedule).toBe(
			30
		);
	});

	it('defaults to the current Laos month and supports another month', async () => {
		const { cookie } = await setup();
		at(MON_1800);
		const cur = await calendar(cookie);
		expect(cur.status).toBe(200);
		expect(cur.body.data.month).toBe('2026-09');
		const aug = await calendar(cookie, '?month=2026-08');
		expect(aug.status).toBe(200);
		expect(aug.body.data.days).toHaveLength(31);
	});

	it('days before the employment start are not employed and never absent', async () => {
		const { cookie } = await setup('2026-09-10');
		at(MON_1800);
		const res = await calendar(cookie, '?month=2026-09');
		const days = res.body.data.days as Day[];
		const before = days.filter((d) => d.date < '2026-09-10');
		expect(before).toHaveLength(9);
		expect(before.every((d) => d.employed === false && d.result === undefined)).toBe(true);
		expect(days.find((d) => d.date === '2026-09-10')!.employed).toBe(true);
	});

	it("only ever returns the caller's own days", async () => {
		const a = await setup();
		const b = await setup();
		at(MON_0920);
		await agent().post('/api/v1/attendance/me/check-in').set('Cookie', b.cookie).send({});
		at(MON_1800);
		const res = await calendar(a.cookie, '?month=2026-09');
		const mon = (res.body.data.days as Day[]).find((d) => d.date === '2026-09-21')!;
		expect(mon.result).toBe('ABSENT');
		expect(mon.checkInAt).toBeNull();
		expect(res.body.data.totals.present).toBe(0);
	});
});
