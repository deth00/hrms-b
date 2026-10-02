import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/password.js';
import { assertNumericIdMode, assertNumericSchemaShapeOf } from '../src/config/numericIdMode.js';

const prisma = new PrismaClient();

interface PermissionDef {
	code: string;
	name: string;
	description: string;
}

const PERMISSIONS: PermissionDef[] = [
	{ code: 'dashboard.view', name: 'ເບິ່ງໜ້າຫຼັກ', description: 'ເຂົ້າເຖິງໜ້າ Dashboard' },
	{ code: 'users.view', name: 'ເບິ່ງຜູ້ໃຊ້ງານ', description: 'ເບິ່ງລາຍຊື່ ແລະ ລາຍລະອຽດຜູ້ໃຊ້ງານ' },
	{ code: 'users.create', name: 'ສ້າງຜູ້ໃຊ້ງານ', description: 'ສ້າງບັນຊີຜູ້ໃຊ້ງານໃໝ່' },
	{
		code: 'users.update',
		name: 'ແກ້ໄຂຜູ້ໃຊ້ງານ',
		description: 'ແກ້ໄຂຂໍ້ມູນ ແລະ ບົດບາດຂອງຜູ້ໃຊ້ງານ'
	},
	{
		code: 'users.disable',
		name: 'ປິດການນຳໃຊ້ຜູ້ໃຊ້ງານ',
		description: 'ເປີດ/ປິດການນຳໃຊ້ບັນຊີຜູ້ໃຊ້ງານ'
	},
	{ code: 'roles.view', name: 'ເບິ່ງບົດບາດ', description: 'ເບິ່ງລາຍຊື່ບົດບາດ ແລະ ສິດອະນຸຍາດ' },
	{ code: 'roles.create', name: 'ສ້າງບົດບາດ', description: 'ສ້າງບົດບາດໃໝ່' },
	{
		code: 'roles.update',
		name: 'ແກ້ໄຂບົດບາດ',
		description: 'ແກ້ໄຂຊື່/ລາຍລະອຽດ/ສິດອະນຸຍາດຂອງບົດບາດ'
	},
	{ code: 'roles.assign', name: 'ມອບໝາຍບົດບາດ', description: 'ມອບໝາຍບົດບາດໃຫ້ຜູ້ໃຊ້ງານ' },
	{
		code: 'organization.view',
		name: 'ເບິ່ງໂຄງສ້າງອົງກອນ',
		description: 'ເບິ່ງຂໍ້ມູນບໍລິສັດ, ສາຂາ, ພະແນກ, ຝ່າຍ ແລະ ໜ່ວຍງານ'
	},
	{
		code: 'organization.create',
		name: 'ສ້າງໂຄງສ້າງອົງກອນ',
		description: 'ສ້າງບໍລິສັດ, ສາຂາ, ພະແນກ, ຝ່າຍ ຫຼື ໜ່ວຍງານໃໝ່'
	},
	{
		code: 'organization.update',
		name: 'ແກ້ໄຂໂຄງສ້າງອົງກອນ',
		description: 'ແກ້ໄຂຂໍ້ມູນບໍລິສັດ, ສາຂາ, ພະແນກ, ຝ່າຍ ຫຼື ໜ່ວຍງານ'
	},
	{
		code: 'organization.disable',
		name: 'ປິດການນຳໃຊ້ໂຄງສ້າງອົງກອນ',
		description: 'ເປີດ/ປິດການນຳໃຊ້ບໍລິສັດ, ສາຂາ, ພະແນກ, ຝ່າຍ ຫຼື ໜ່ວຍງານ'
	},
	{ code: 'positions.view', name: 'ເບິ່ງຕຳແໜ່ງ', description: 'ເບິ່ງລະດັບຕຳແໜ່ງ ແລະ ຕຳແໜ່ງ' },
	{ code: 'positions.create', name: 'ສ້າງຕຳແໜ່ງ', description: 'ສ້າງລະດັບຕຳແໜ່ງ ຫຼື ຕຳແໜ່ງໃໝ່' },
	{ code: 'positions.update', name: 'ແກ້ໄຂຕຳແໜ່ງ', description: 'ແກ້ໄຂລະດັບຕຳແໜ່ງ ຫຼື ຕຳແໜ່ງ' },
	{
		code: 'positions.disable',
		name: 'ປິດການນຳໃຊ້ຕຳແໜ່ງ',
		description: 'ເປີດ/ປິດການນຳໃຊ້ລະດັບຕຳແໜ່ງ ຫຼື ຕຳແໜ່ງ'
	},
	{
		code: 'employees.view',
		name: 'ເບິ່ງພະນັກງານ',
		description: 'ເບິ່ງຂໍ້ມູນພະນັກງານ ແລະ ປະເພດການຈ້າງງານ (ຕາມຂອບເຂດຂໍ້ມູນທີ່ອະນຸຍາດ)'
	},
	{
		code: 'employees.view_all',
		name: 'ເບິ່ງພະນັກງານທັງໝົດ',
		description: 'ຂອບເຂດຂໍ້ມູນ: ເບິ່ງພະນັກງານທຸກຄົນ (ຖ້າບໍ່ມີ ຈະເຫັນສະເພາະຕົນເອງ ແລະ ລູກທີມ)'
	},
	{
		code: 'employees.create',
		name: 'ເພີ່ມພະນັກງານ',
		description: 'ເພີ່ມພະນັກງານ ແລະ ປະເພດການຈ້າງງານໃໝ່'
	},
	{
		code: 'employees.update',
		name: 'ແກ້ໄຂຂໍ້ມູນພະນັກງານ',
		description: 'ແກ້ໄຂຂໍ້ມູນສ່ວນຕົວ ແລະ ຂໍ້ມູນຕິດຕໍ່ຂອງພະນັກງານ'
	},
	{
		code: 'employees.status',
		name: 'ປ່ຽນສະຖານະການຈ້າງງານ',
		description: 'ປ່ຽນສະຖານະການຈ້າງງານ (ລາອອກ, ຢຸດຈ້າງ ແລະ ອື່ນໆ)'
	},
	{
		code: 'employees.transfer',
		name: 'ຍ້າຍ / ປ່ຽນຕຳແໜ່ງພະນັກງານ',
		description: 'ຍ້າຍໂຄງສ້າງອົງກອນ, ປ່ຽນຕຳແໜ່ງ, ຫົວໜ້າ ແລະ ປະເພດການຈ້າງງານ'
	},
	{
		code: 'employees.link_user',
		name: 'ເຊື່ອມບັນຊີເຂົ້າລະບົບ',
		description: 'ເຊື່ອມ ຫຼື ຍົກເລີກການເຊື່ອມບັນຊີຜູ້ໃຊ້ງານກັບພະນັກງານ'
	},
	// Phase 4 — shifts, holidays, employee work schedules
	{ code: 'shifts.view', name: 'ເບິ່ງກະເຮັດວຽກ', description: 'ເບິ່ງລາຍການກະເຮັດວຽກ' },
	{ code: 'shifts.create', name: 'ສ້າງກະເຮັດວຽກ', description: 'ສ້າງກະເຮັດວຽກໃໝ່' },
	{
		code: 'shifts.update',
		name: 'ແກ້ໄຂກະເຮັດວຽກ',
		description: 'ແກ້ໄຂກະເຮັດວຽກ ແລະ ມື້ເຮັດວຽກ'
	},
	{
		code: 'shifts.disable',
		name: 'ປິດການນຳໃຊ້ກະເຮັດວຽກ',
		description: 'ເປີດ/ປິດການນຳໃຊ້ກະເຮັດວຽກ'
	},
	{ code: 'holidays.view', name: 'ເບິ່ງວັນພັກ', description: 'ເບິ່ງລາຍການວັນພັກ' },
	{ code: 'holidays.create', name: 'ສ້າງວັນພັກ', description: 'ສ້າງວັນພັກໃໝ່' },
	{ code: 'holidays.update', name: 'ແກ້ໄຂວັນພັກ', description: 'ແກ້ໄຂວັນພັກ' },
	{
		code: 'holidays.disable',
		name: 'ປິດການນຳໃຊ້ວັນພັກ',
		description: 'ເປີດ/ປິດການນຳໃຊ້ວັນພັກ'
	},
	{
		code: 'schedules.view',
		name: 'ເບິ່ງຕາຕະລາງການເຮັດວຽກ',
		description: 'ເບິ່ງກະເຮັດວຽກທີ່ກຳນົດໃຫ້ພະນັກງານ (ຕາມຂອບເຂດຂໍ້ມູນ)'
	},
	{
		code: 'schedules.assign',
		name: 'ກຳນົດກະໃຫ້ພະນັກງານ',
		description: 'ກຳນົດ ຫຼື ປ່ຽນກະເຮັດວຽກຂອງພະນັກງານ'
	},
	// Phase 5 — attendance punch core + work locations
	{
		code: 'attendance.self',
		name: 'ເຂົ້າ-ອອກວຽກຂອງຕົນເອງ',
		description: 'Check-in / Check-out ແລະ ເບິ່ງປະຫວັດການເຂົ້າ-ອອກວຽກຂອງຕົນເອງ'
	},
	{
		code: 'attendance.view',
		name: 'ເບິ່ງການເຂົ້າ-ອອກວຽກ',
		description: 'ເບິ່ງຂໍ້ມູນການເຂົ້າ-ອອກວຽກຂອງພະນັກງານ (ຕາມຂອບເຂດຂໍ້ມູນ)'
	},
	{
		code: 'work_locations.view',
		name: 'ເບິ່ງສະຖານທີ່ Check-in',
		description: 'ເບິ່ງລາຍການສະຖານທີ່ Check-in'
	},
	{
		code: 'work_locations.create',
		name: 'ສ້າງສະຖານທີ່ Check-in',
		description: 'ສ້າງສະຖານທີ່ Check-in ໃໝ່'
	},
	{
		code: 'work_locations.update',
		name: 'ແກ້ໄຂສະຖານທີ່ Check-in',
		description: 'ແກ້ໄຂຕຳແໜ່ງ, ລັດສະໝີ ແລະ ການບັງຄັບ GPS'
	},
	{
		code: 'work_locations.disable',
		name: 'ປິດການນຳໃຊ້ສະຖານທີ່ Check-in',
		description: 'ເປີດ/ປິດການນຳໃຊ້ສະຖານທີ່ Check-in'
	},
	// Phase 6 — attendance rules + corrections
	{
		code: 'attendance_rules.view',
		name: 'ເບິ່ງກົດລະບຽບ Attendance',
		description: 'ເບິ່ງກົດລະບຽບການຄຳນວນ ແລະ ການຂໍແກ້ໄຂເວລາ'
	},
	{
		code: 'attendance_rules.update',
		name: 'ແກ້ໄຂກົດລະບຽບ Attendance',
		description: 'ແກ້ໄຂກົດລະບຽບການຄຳນວນ ແລະ ການຂໍແກ້ໄຂເວລາ'
	},
	{
		code: 'attendance_corrections.request',
		name: 'ຂໍແກ້ໄຂເວລາເຂົ້າ-ອອກວຽກ',
		description: 'ສົ່ງຄຳຂໍແກ້ໄຂເວລາເຂົ້າ-ອອກວຽກຂອງຕົນເອງ'
	},
	{
		code: 'attendance_corrections.review',
		name: 'ພິຈາລະນາຄຳຂໍແກ້ໄຂເວລາ',
		description: 'ອະນຸມັດ ຫຼື ປະຕິເສດຄຳຂໍແກ້ໄຂເວລາ (ຕາມຂອບເຂດຂໍ້ມູນ)'
	},
	// Phase 7 — leave management
	{
		code: 'leave.self',
		name: 'ຂໍລາຂອງຕົນເອງ',
		description: 'ເບິ່ງຍອດການລາ ແລະ ສົ່ງຄຳຂໍລາຂອງຕົນເອງ'
	},
	{
		code: 'leave.view',
		name: 'ເບິ່ງຄຳຂໍລາ',
		description: 'ເບິ່ງຄຳຂໍລາຂອງພະນັກງານ (ຕາມຂອບເຂດຂໍ້ມູນ)'
	},
	{
		code: 'leave.review',
		name: 'ພິຈາລະນາຄຳຂໍລາ',
		description: 'ອະນຸມັດ ຫຼື ປະຕິເສດຄຳຂໍລາ (ຕາມຂອບເຂດຂໍ້ມູນ)'
	},
	{
		code: 'leave_types.view',
		name: 'ເບິ່ງປະເພດການລາ',
		description: 'ເບິ່ງລາຍການປະເພດການລາ'
	},
	{
		code: 'leave_types.create',
		name: 'ສ້າງປະເພດການລາ',
		description: 'ສ້າງປະເພດການລາໃໝ່'
	},
	{
		code: 'leave_types.update',
		name: 'ແກ້ໄຂປະເພດການລາ',
		description: 'ແກ້ໄຂປະເພດການລາ'
	},
	{
		code: 'leave_types.disable',
		name: 'ປິດການນຳໃຊ້ປະເພດການລາ',
		description: 'ເປີດ/ປິດການນຳໃຊ້ປະເພດການລາ'
	},
	{
		code: 'leave_balances.view',
		name: 'ເບິ່ງສິດການລາ',
		description: 'ເບິ່ງສິດການລາ ແລະ ປະຫວັດການປັບຍອດ (ຕາມຂອບເຂດຂໍ້ມູນ)'
	},
	{
		code: 'leave_balances.manage',
		name: 'ຈັດການສິດການລາ',
		description: 'ກຳນົດສິດການລາປະຈຳປີ ແລະ ປັບຍອດການລາ'
	},
	// Phase 8 — overtime
	{
		code: 'overtime.self',
		name: 'ຂໍ OT ຂອງຕົນເອງ',
		description: 'ເບິ່ງ ແລະ ສົ່ງຄຳຂໍ OT / ເຮັດວຽກມື້ພັກຂອງຕົນເອງ'
	},
	{
		code: 'overtime.view',
		name: 'ເບິ່ງຄຳຂໍ OT',
		description: 'ເບິ່ງຄຳຂໍ OT ຂອງພະນັກງານ (ຕາມຂອບເຂດຂໍ້ມູນ)'
	},
	{
		code: 'overtime.review',
		name: 'ພິຈາລະນາຄຳຂໍ OT',
		description: 'ອະນຸມັດ ຫຼື ປະຕິເສດຄຳຂໍ OT (ຕາມຂອບເຂດຂໍ້ມູນ)'
	},
	{
		code: 'overtime_rules.view',
		name: 'ເບິ່ງກົດລະບຽບ OT',
		description: 'ເບິ່ງກົດລະບຽບ OT ຂອງບໍລິສັດ'
	},
	{
		code: 'overtime_rules.update',
		name: 'ແກ້ໄຂກົດລະບຽບ OT',
		description: 'ແກ້ໄຂກົດລະບຽບ OT ຂອງບໍລິສັດ'
	},
	// Phase 9 — approval workflows
	{
		code: 'approval_workflows.view',
		name: 'ເບິ່ງຂັ້ນຕອນການອະນຸມັດ',
		description: 'ເບິ່ງການຕັ້ງຄ່າຂັ້ນຕອນການອະນຸມັດ ແລະ ຜູ້ອະນຸມັດຂອງແຕ່ລະຂັ້ນ'
	},
	{
		code: 'approval_workflows.manage',
		name: 'ຈັດການຂັ້ນຕອນການອະນຸມັດ',
		description: 'ແກ້ໄຂຂັ້ນຕອນການອະນຸມັດ ແລະ ມອບໝາຍຜູ້ອະນຸມັດຂັ້ນຕອນທີ່ຕິດຂັດ'
	},
	// Phase 10 — audit log (read-only)
	{
		code: 'audit.view',
		name: 'ເບິ່ງປະຫວັດການໃຊ້ງານ',
		description: 'ເບິ່ງບັນທຶກປະຫວັດການໃຊ້ງານລະບົບ (Audit Log) — ອ່ານຢ່າງດຽວ'
	},
	// Phase 11 — payroll foundation (salary data: dedicated permissions, never implied by employees.*)
	{
		code: 'compensation.view',
		name: 'ເບິ່ງຄ່າຕອບແທນ',
		description: 'ເບິ່ງເງິນເດືອນພື້ນຖານ, ປະຫວັດເງິນເດືອນ ແລະ ລາຍຮັບ/ລາຍຈ່າຍປະຈຳຂອງພະນັກງານ'
	},
	{
		code: 'compensation.manage',
		name: 'ຈັດການຄ່າຕອບແທນ',
		description: 'ປັບເງິນເດືອນ ແລະ ກຳນົດ/ສິ້ນສຸດລາຍຮັບ/ລາຍຈ່າຍປະຈຳຂອງພະນັກງານ'
	},
	{
		code: 'pay_components.view',
		name: 'ເບິ່ງລາຍການລາຍຮັບ/ລາຍຈ່າຍ',
		description: 'ເບິ່ງລາຍການລາຍຮັບ ແລະ ລາຍຈ່າຍ (Pay Components)'
	},
	{
		code: 'pay_components.manage',
		name: 'ຈັດການລາຍການລາຍຮັບ/ລາຍຈ່າຍ',
		description: 'ສ້າງ ແລະ ແກ້ໄຂລາຍການລາຍຮັບ/ລາຍຈ່າຍ'
	},
	{
		code: 'payroll.view',
		name: 'ເບິ່ງເງິນເດືອນ',
		description: 'ເບິ່ງການຕັ້ງຄ່າເງິນເດືອນ, ງວດ, ຮອບ ແລະ ຜົນການຄຳນວນເງິນເດືອນ'
	},
	{
		code: 'payroll.manage',
		name: 'ຈັດການເງິນເດືອນ',
		description: 'ຕັ້ງຄ່າເງິນເດືອນ, ສ້າງງວດ/ຮອບ ແລະ ເພີ່ມການປັບປຸງດ້ວຍມື'
	},
	{
		code: 'payroll.calculate',
		name: 'ຄຳນວນເງິນເດືອນ',
		description: 'ຄຳນວນ ແລະ ຄຳນວນໃໝ່ຮອບເງິນເດືອນທີ່ຍັງບໍ່ສຳເລັດ'
	},
	{
		code: 'payroll.finalize',
		name: 'ຢືນຢັນຮອບເງິນເດືອນ',
		description: 'ຢືນຢັນ (Finalize) ຮອບເງິນເດືອນ — ຫຼັງຈາກນັ້ນແກ້ໄຂບໍ່ໄດ້'
	},
	{
		code: 'payroll.approve',
		name: 'ອະນຸມັດຮອບເງິນເດືອນ',
		description:
			'ອະນຸມັດ ຫຼື ປະຕິເສດຮອບເງິນເດືອນທີ່ສົ່ງມາຕາມຂັ້ນຕອນການອະນຸມັດ (ຕ້ອງມີສິດເບິ່ງພະນັກງານທັງໝົດນຳ)'
	},
	{
		code: 'payslip.view_self',
		name: 'ເບິ່ງໃບແຈ້ງເງິນເດືອນຂອງຕົນເອງ',
		description: 'ເບິ່ງ ແລະ ດາວໂຫຼດໃບແຈ້ງເງິນເດືອນຂອງຕົນເອງ (ສະເພາະຮອບທີ່ຢືນຢັນແລ້ວ)'
	},
	{
		code: 'payslip.generate',
		name: 'ອອກໃບແຈ້ງເງິນເດືອນ',
		description: 'ອອກໃບແຈ້ງເງິນເດືອນທີ່ຍັງຂາດ ສຳລັບຮອບເງິນເດືອນເກົ່າທີ່ຢືນຢັນແລ້ວ'
	},
	// Phase 14 — payment preparation (every admin action also needs employees.view_all)
	{
		code: 'employee_bank.view',
		name: 'ເບິ່ງວິທີຮັບເງິນ / ບັນຊີທະນາຄານ',
		description:
			'ເບິ່ງວິທີຮັບເງິນເດືອນ ແລະ ບັນຊີທະນາຄານຂອງພະນັກງານ (ເລກບັນຊີສະແດງແບບປິດບັງເທົ່ານັ້ນ)'
	},
	{
		code: 'employee_bank.manage',
		name: 'ຈັດການວິທີຮັບເງິນ / ບັນຊີທະນາຄານ',
		description: 'ກຳນົດວິທີຮັບເງິນເດືອນ ແລະ ເພີ່ມ/ແກ້ໄຂ/ປິດບັນຊີທະນາຄານຂອງພະນັກງານ'
	},
	{
		code: 'payroll.payment.view',
		name: 'ເບິ່ງຊຸດການຈ່າຍເງິນເດືອນ',
		description: 'ເບິ່ງຊຸດການຈ່າຍເງິນເດືອນ (ເລກບັນຊີສະແດງແບບປິດບັງ)'
	},
	{
		code: 'payroll.payment.manage',
		name: 'ຈັດການຊຸດການຈ່າຍເງິນເດືອນ',
		description: 'ສ້າງ, ກວດສອບ, ສ້າງໃໝ່ ແລະ ຍົກເລີກຊຸດການຈ່າຍ; ຕັ້ງຄ່າຮູບແບບໄຟລ໌ທະນາຄານ'
	},
	{
		code: 'payroll.payment.export',
		name: 'ສົ່ງອອກໄຟລ໌ທະນາຄານ',
		description: 'ດາວໂຫຼດໄຟລ໌ການຈ່າຍເງິນສຳລັບທະນາຄານ (ມີເລກບັນຊີເຕັມ)'
	},
	{
		code: 'payroll.payment.confirm',
		name: 'ຢືນຢັນຜົນການຈ່າຍເງິນ',
		description: 'ບັນທຶກວ່າການຈ່າຍເງິນແຕ່ລະລາຍການ ຈ່າຍແລ້ວ ຫຼື ລົ້ມເຫຼວ'
	},
	// Phase 15 — reconciliation / reversal (every admin action also needs employees.view_all)
	{
		code: 'payroll.payment.reconcile',
		name: 'ກວດສອບຜົນການຈ່າຍຈາກທະນາຄານ',
		description:
			'ນຳເຂົ້າໄຟລ໌ຜົນການຈ່າຍຈາກທະນາຄານ, ຈັບຄູ່, ລະເວັ້ນ ແລະ ນຳໃຊ້ຜົນ (Reconciliation); ຕັ້ງຄ່າຮູບແບບຜົນການຈ່າຍ'
	},
	{
		code: 'payroll.payment.reverse',
		name: 'ຍົກເລີກການຈ່າຍ (Reverse)',
		description:
			'ບັນທຶກວ່າການຈ່າຍທີ່ຈ່າຍແລ້ວຖືກສົ່ງຄືນ / ຍົກເລີກ (ບັນທຶກເພີ່ມເທົ່ານັ້ນ, ບໍ່ລຶບປະຫວັດ)'
	},
	{
		code: 'payroll_payment.view_self',
		name: 'ເບິ່ງປະຫວັດການຮັບເງິນເດືອນຂອງຕົນເອງ',
		description: 'ເບິ່ງສະຖານະການຈ່າຍເງິນເດືອນຂອງຕົນເອງ'
	},
	// Phase 16 — payroll accounting (every action also needs employees.view_all). Internal to LaoHR only.
	{
		code: 'payroll.accounting.view',
		name: 'ເບິ່ງບັນຊີເງິນເດືອນ',
		description: 'ເບິ່ງບັນທຶກບັນຊີ (Journal) ຂອງເງິນເດືອນ ແລະ ການຈ່າຍເງິນ'
	},
	{
		code: 'payroll.accounting.manage',
		name: 'ສ້າງ / ກວດສອບບັນທຶກບັນຊີເງິນເດືອນ',
		description: 'ສ້າງ, ກວດສອບ (Validate) ແລະ ຍົກເລີກບັນທຶກບັນຊີກ່ອນ Post'
	},
	{
		code: 'payroll.accounting.post',
		name: 'Post ບັນທຶກບັນຊີເງິນເດືອນ',
		description: 'Post ບັນທຶກບັນຊີໃນ LaoHR (ລັອກບັນທຶກ; ບໍ່ສົ່ງຂໍ້ມູນໄປລະບົບບັນຊີພາຍນອກ)'
	},
	{
		code: 'payroll.accounting.export',
		name: 'ສົ່ງອອກບັນທຶກບັນຊີເງິນເດືອນ',
		description: 'ສົ່ງອອກໄຟລ໌ບັນທຶກບັນຊີທີ່ Post ແລ້ວ (CSV / XLSX)'
	},
	{
		code: 'payroll.accounting.settings',
		name: 'ຕັ້ງຄ່າບັນຊີເງິນເດືອນ',
		description: 'ຈັດການຜັງບັນຊີ (GL accounts), ກົດການບັນທຶກບັນຊີ ແລະ ຮູບແບບໄຟລ໌ສົ່ງອອກ'
	},
	// Phase 17A — read-only reporting. Never grants data on its own: every report ALSO needs the
	// domain permission (employees.view, attendance.view, payroll.view + employees.view_all, …).
	{
		code: 'reports.view',
		name: 'ເບິ່ງລາຍງານ',
		description: 'ເຂົ້າເຖິງສູນລາຍງານ (ຕ້ອງມີສິດຂອງແຕ່ລະໂມດູນນຳ)'
	},
	// Phase 17B — export of the SAME authorized report rows (never grants data on its own)
	{
		code: 'reports.export',
		name: 'ສົ່ງອອກລາຍງານ',
		description: 'ສົ່ງອອກລາຍງານເປັນ CSV / Excel / PDF (ຕ້ອງມີສິດເບິ່ງລາຍງານ ແລະ ສິດຂອງໂມດູນນຳ)'
	}
];

const ALL_PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

interface RoleDef {
	code: string;
	name: string;
	description: string;
	permissionCodes: string[];
}

const ROLES: RoleDef[] = [
	{
		code: 'SUPER_ADMIN',
		name: 'ຜູ້ດູແລລະບົບສູງສຸດ',
		description: 'ສິດເຕັມທຸກຢ່າງໃນລະບົບ',
		permissionCodes: ALL_PERMISSION_CODES
	},
	{
		code: 'HR_ADMIN',
		name: 'ຜູ້ດູແລບຸກຄະລາກອນ',
		description: 'ຈັດການຜູ້ໃຊ້ງານ, ໂຄງສ້າງອົງກອນ, ຕຳແໜ່ງ ແລະ ພະນັກງານ',
		permissionCodes: [
			'dashboard.view',
			'users.view',
			'users.create',
			'users.update',
			'users.disable',
			'roles.view',
			'organization.view',
			'organization.create',
			'organization.update',
			'organization.disable',
			'positions.view',
			'positions.create',
			'positions.update',
			'positions.disable',
			'employees.view',
			'employees.view_all',
			'employees.create',
			'employees.update',
			'employees.status',
			'employees.transfer',
			'employees.link_user',
			'shifts.view',
			'shifts.create',
			'shifts.update',
			'shifts.disable',
			'holidays.view',
			'holidays.create',
			'holidays.update',
			'holidays.disable',
			'schedules.view',
			'schedules.assign',
			'attendance.self',
			'attendance.view',
			'work_locations.view',
			'work_locations.create',
			'work_locations.update',
			'work_locations.disable',
			'attendance_rules.view',
			'attendance_rules.update',
			'attendance_corrections.request',
			'attendance_corrections.review',
			'leave.self',
			'leave.view',
			'leave.review',
			'leave_types.view',
			'leave_types.create',
			'leave_types.update',
			'leave_types.disable',
			'leave_balances.view',
			'leave_balances.manage',
			'overtime.self',
			'overtime.view',
			'overtime.review',
			'overtime_rules.view',
			'overtime_rules.update',
			'approval_workflows.view',
			'approval_workflows.manage',
			'audit.view',
			'compensation.view',
			'compensation.manage',
			'pay_components.view',
			'pay_components.manage',
			'payroll.view',
			'payroll.manage',
			'payroll.calculate',
			'payroll.finalize',
			'payroll.approve',
			'payslip.view_self',
			'payslip.generate',
			'employee_bank.view',
			'employee_bank.manage',
			'payroll.payment.view',
			'payroll.payment.manage',
			'payroll.payment.export',
			'payroll.payment.confirm',
			'payroll.payment.reconcile',
			'payroll.payment.reverse',
			'payroll_payment.view_self',
			// Phase 16 — prepare / export only: POST (locking) and accounting settings stay SUPER_ADMIN
			'payroll.accounting.view',
			'payroll.accounting.manage',
			'payroll.accounting.export',
			// Phase 17A
			'reports.view',
			'reports.export'
		]
	},
	{
		code: 'MANAGER',
		name: 'ຫົວໜ້າງານ',
		description: 'ສິດພື້ນຖານສຳລັບຫົວໜ້າງານ',
		permissionCodes: [
			'dashboard.view',
			'organization.view',
			'positions.view',
			'employees.view',
			'shifts.view',
			'holidays.view',
			'schedules.view',
			'attendance.self',
			'attendance.view',
			'work_locations.view',
			'attendance_rules.view',
			'attendance_corrections.request',
			'attendance_corrections.review',
			'leave.self',
			'leave.view',
			'leave.review',
			'leave_balances.view',
			'overtime.self',
			'overtime.view',
			'overtime.review',
			'overtime_rules.view',
			'approval_workflows.view',
			// Phase 17A — team reports only (manager-tree scope; no payroll / payment / accounting)
			'reports.view',
			'reports.export'
		]
	},
	{
		code: 'EMPLOYEE',
		name: 'ພະນັກງານ',
		description: 'ສິດພື້ນຖານສຳລັບພະນັກງານທົ່ວໄປ',
		permissionCodes: [
			'dashboard.view',
			'attendance.self',
			'attendance_corrections.request',
			'leave.self',
			'overtime.self',
			'payslip.view_self',
			'payroll_payment.view_self'
		]
	}
];

export async function seedPermissions(): Promise<void> {
	for (const permission of PERMISSIONS) {
		await prisma.permission.upsert({
			where: { code: permission.code },
			update: { name: permission.name, description: permission.description },
			create: permission
		});
	}
}

export async function seedRoles(): Promise<void> {
	for (const roleDef of ROLES) {
		const role = await prisma.role.upsert({
			where: { code: roleDef.code },
			update: { name: roleDef.name, description: roleDef.description, isSystem: true },
			create: {
				code: roleDef.code,
				name: roleDef.name,
				description: roleDef.description,
				isSystem: true
			}
		});

		const permissions = await prisma.permission.findMany({
			where: { code: { in: roleDef.permissionCodes } }
		});

		// Idempotent sync: replace this role's permission set with the current definition.
		await prisma.$transaction([
			prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
			prisma.rolePermission.createMany({
				data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id }))
			})
		]);
	}
}

export async function seedAdmin(): Promise<void> {
	const { SEED_ADMIN_USERNAME, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_DISPLAY_NAME } =
		process.env;

	if (!SEED_ADMIN_USERNAME || !SEED_ADMIN_PASSWORD) {
		console.log('SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD not set — skipping admin seed.');
		return;
	}

	if (SEED_ADMIN_PASSWORD.length < 8) {
		console.log('SEED_ADMIN_PASSWORD is shorter than 8 characters — skipping admin seed.');
		return;
	}

	const existing = await prisma.user.findUnique({ where: { username: SEED_ADMIN_USERNAME } });
	if (existing) {
		console.log(`Admin user "${SEED_ADMIN_USERNAME}" already exists — skipping.`);
		return;
	}

	const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
	const passwordHash = await hashPassword(SEED_ADMIN_PASSWORD);

	await prisma.$transaction(async (tx) => {
		const user = await tx.user.create({
			data: {
				username: SEED_ADMIN_USERNAME,
				email: SEED_ADMIN_EMAIL?.toLowerCase(),
				displayName: SEED_ADMIN_DISPLAY_NAME ?? SEED_ADMIN_USERNAME,
				passwordHash,
				status: 'ACTIVE'
			}
		});
		await tx.userRole.create({ data: { userId: user.id, roleId: superAdminRole.id } });
	});

	console.log(`Seeded admin user "${SEED_ADMIN_USERNAME}" with role SUPER_ADMIN.`);
}

/**
 * OPTIONAL Phase 2 demo organization data — never runs unless
 * SEED_DEMO_ORG=true is explicitly set. Clearly-labelled development
 * data only; never seeded automatically for a fresh/production database.
 */
export async function seedOrganizationDemo(): Promise<void> {
	if (process.env.SEED_DEMO_ORG !== 'true') {
		console.log('SEED_DEMO_ORG is not "true" — skipping optional demo organization data.');
		return;
	}

	const company = await prisma.company.upsert({
		where: { code: 'LAOHR' },
		update: {},
		create: { code: 'LAOHR', nameLao: 'ບໍລິສັດ LaoHR ທົດລອງ (DEMO)', status: 'ACTIVE' }
	});

	const branch = await prisma.branch.upsert({
		where: { companyId_code: { companyId: company.id, code: 'HO' } },
		update: {},
		create: { companyId: company.id, code: 'HO', nameLao: 'ສຳນັກງານໃຫຍ່', status: 'ACTIVE' }
	});

	const departmentDefs = [
		{ code: 'HR', nameLao: 'ພະແນກບຸກຄະລາກອນ', branchId: branch.id },
		{ code: 'IT', nameLao: 'ພະແນກເຕັກໂນໂລຊີສາລະສົນເທດ', branchId: branch.id },
		{ code: 'FIN', nameLao: 'ພະແນກການເງິນ', branchId: branch.id }
	];
	const departments: Record<string, Awaited<ReturnType<typeof prisma.department.upsert>>> = {};
	for (const def of departmentDefs) {
		departments[def.code] = await prisma.department.upsert({
			where: { companyId_code: { companyId: company.id, code: def.code } },
			update: {},
			create: {
				companyId: company.id,
				branchId: def.branchId,
				code: def.code,
				nameLao: def.nameLao,
				status: 'ACTIVE'
			}
		});
	}
	const itDepartment = departments.IT!;

	const divisionDefs = [
		{ code: 'DEV', nameLao: 'ຝ່າຍພັດທະນາລະບົບ' },
		{ code: 'INFRA', nameLao: 'ຝ່າຍ Infrastructure' }
	];
	const divisions: Record<string, Awaited<ReturnType<typeof prisma.division.upsert>>> = {};
	for (const def of divisionDefs) {
		divisions[def.code] = await prisma.division.upsert({
			where: { departmentId_code: { departmentId: itDepartment.id, code: def.code } },
			update: {},
			create: {
				departmentId: itDepartment.id,
				code: def.code,
				nameLao: def.nameLao,
				status: 'ACTIVE'
			}
		});
	}
	const devDivision = divisions.DEV!;

	const unitDefs = [
		{ code: 'APP', nameLao: 'ໜ່ວຍພັດທະນາ Application', divisionId: devDivision.id },
		{ code: 'QA', nameLao: 'ໜ່ວຍ QA', divisionId: devDivision.id },
		{ code: 'NET', nameLao: 'ໜ່ວຍ Network & Server', divisionId: null }
	];
	for (const def of unitDefs) {
		await prisma.unit.upsert({
			where: { departmentId_code: { departmentId: itDepartment.id, code: def.code } },
			update: {},
			create: {
				departmentId: itDepartment.id,
				divisionId: def.divisionId,
				code: def.code,
				nameLao: def.nameLao,
				status: 'ACTIVE'
			}
		});
	}

	const levelDefs = [
		{ code: '01', nameLao: 'ຄະນະບໍລິຫານ', rank: 1 },
		{ code: '02', nameLao: 'ຜູ້ຈັດການ', rank: 2 },
		{ code: '03', nameLao: 'ຫົວໜ້າ', rank: 3 },
		{ code: '04', nameLao: 'ພະນັກງານ', rank: 4 }
	];
	const levels: Record<string, Awaited<ReturnType<typeof prisma.positionLevel.upsert>>> = {};
	for (const def of levelDefs) {
		levels[def.code] = await prisma.positionLevel.upsert({
			where: { companyId_code: { companyId: company.id, code: def.code } },
			update: {},
			create: {
				companyId: company.id,
				code: def.code,
				nameLao: def.nameLao,
				rank: def.rank,
				status: 'ACTIVE'
			}
		});
	}

	const positionDefs = [
		{ code: 'HR_MGR', nameLao: 'HR Manager', levelCode: '02' },
		{ code: 'HR_OFC', nameLao: 'HR Officer', levelCode: '04' },
		{ code: 'IT_MGR', nameLao: 'IT Manager', levelCode: '02' },
		{ code: 'DEV', nameLao: 'Software Developer', levelCode: '04' },
		{ code: 'SYSADMIN', nameLao: 'System Administrator', levelCode: '04' },
		{ code: 'ACCT', nameLao: 'Accountant', levelCode: '04' }
	];
	for (const def of positionDefs) {
		await prisma.position.upsert({
			where: { companyId_code: { companyId: company.id, code: def.code } },
			update: {},
			create: {
				companyId: company.id,
				positionLevelId: levels[def.levelCode]!.id,
				code: def.code,
				nameLao: def.nameLao,
				status: 'ACTIVE'
			}
		});
	}

	console.log('Seeded DEMO organization structure (company "LAOHR") and position master data.');
}

/**
 * OPTIONAL Phase 3 demo employees — only with SEED_DEMO_ORG=true AND only if the Phase 2 demo
 * master data (company LAOHR, departments, positions) already exists. Idempotent by employeeCode.
 */
export async function seedEmployeeDemo(): Promise<void> {
	if (process.env.SEED_DEMO_ORG !== 'true') {
		console.log('SEED_DEMO_ORG is not "true" — skipping optional demo employees.');
		return;
	}

	const company = await prisma.company.findUnique({ where: { code: 'LAOHR' } });
	if (!company) {
		console.log('Demo company "LAOHR" not found — skipping demo employees.');
		return;
	}

	const [branch, departments, positions] = await Promise.all([
		prisma.branch.findFirst({ where: { companyId: company.id, code: 'HO' } }),
		prisma.department.findMany({ where: { companyId: company.id, code: { in: ['HR', 'IT'] } } }),
		prisma.position.findMany({
			where: { companyId: company.id, code: { in: ['DEV', 'HR_OFC', 'IT_MGR'] } }
		})
	]);
	const dept = (code: string) => departments.find((d) => d.code === code);
	const pos = (code: string) => positions.find((p) => p.code === code);
	if (!dept('IT') || !dept('HR') || !pos('DEV') || !pos('HR_OFC') || !pos('IT_MGR')) {
		console.log('Demo departments/positions missing — skipping demo employees.');
		return;
	}

	const fullTime = await prisma.employmentType.upsert({
		where: { companyId_code: { companyId: company.id, code: 'FULL_TIME' } },
		update: {},
		create: { companyId: company.id, code: 'FULL_TIME', nameLao: 'ພະນັກງານປະຈຳ', status: 'ACTIVE' }
	});
	await prisma.employmentType.upsert({
		where: { companyId_code: { companyId: company.id, code: 'CONTRACT' } },
		update: {},
		create: { companyId: company.id, code: 'CONTRACT', nameLao: 'ພະນັກງານສັນຍາ', status: 'ACTIVE' }
	});

	const startDate = new Date('2024-01-01T00:00:00.000Z');
	const defs = [
		// IT Manager first, so the others can reference them as manager.
		{
			code: 'EMP0003',
			first: 'ວິໄລ',
			last: 'ແກ້ວມະນີ',
			department: 'IT',
			position: 'IT_MGR',
			manager: null
		},
		{
			code: 'EMP0001',
			first: 'ສົມຊາຍ',
			last: 'ພົມມະວົງ',
			department: 'IT',
			position: 'DEV',
			manager: 'EMP0003'
		},
		{
			code: 'EMP0002',
			first: 'ດາວວອນ',
			last: 'ສີວົງ',
			department: 'HR',
			position: 'HR_OFC',
			manager: null
		}
	] as const;

	for (const def of defs) {
		if (await prisma.employee.findUnique({ where: { employeeCode: def.code } })) continue;
		const manager = def.manager
			? await prisma.employee.findUnique({ where: { employeeCode: def.manager } })
			: null;
		const placement = {
			companyId: company.id,
			branchId: branch?.id ?? null,
			departmentId: dept(def.department)!.id,
			divisionId: null,
			unitId: null,
			positionId: pos(def.position)!.id,
			managerEmployeeId: manager?.id ?? null,
			employmentTypeId: fullTime.id
		};
		await prisma.$transaction(async (tx) => {
			const employee = await tx.employee.create({
				data: {
					employeeCode: def.code,
					firstNameLao: def.first,
					lastNameLao: def.last,
					startDate,
					employmentStatus: 'ACTIVE',
					...placement
				}
			});
			await tx.employeeAssignmentHistory.create({
				data: {
					employeeId: employee.id,
					...placement,
					effectiveFrom: startDate,
					reason: 'ເລີ່ມຕົ້ນການຈ້າງງານ (DEMO)'
				}
			});
		});
	}
	console.log('Seeded DEMO employment types and employees (EMP0001-EMP0003).');
}

/**
 * OPTIONAL Phase 7 DEMO leave types (only with SEED_DEMO_ORG=true, after the demo company exists).
 * These are illustrative sample values — NOT Lao legal defaults, and no business logic reads them.
 */
export async function seedLeaveDemo(): Promise<void> {
	if (process.env.SEED_DEMO_ORG !== 'true') return;
	const company = await prisma.company.findUnique({ where: { code: 'LAOHR' } });
	if (!company) return;
	const defs = [
		{
			code: 'ANNUAL',
			nameLao: 'ລາພັກປະຈຳປີ',
			nameEnglish: 'Annual Leave (DEMO)',
			requiresBalance: true,
			isPaid: true,
			days: '15.00'
		},
		{
			code: 'SICK',
			nameLao: 'ລາປ່ວຍ',
			nameEnglish: 'Sick Leave (DEMO)',
			requiresBalance: true,
			isPaid: true,
			days: '30.00'
		},
		{
			code: 'PERSONAL',
			nameLao: 'ລາກິດ',
			nameEnglish: 'Personal Leave (DEMO)',
			requiresBalance: true,
			isPaid: true,
			days: '5.00'
		},
		{
			code: 'UNPAID',
			nameLao: 'ລາບໍ່ຮັບເງິນເດືອນ',
			nameEnglish: 'Unpaid Leave (DEMO)',
			requiresBalance: false,
			isPaid: false,
			days: null
		}
	];
	for (const d of defs) {
		await prisma.leaveType.upsert({
			where: { companyId_code: { companyId: company.id, code: d.code } },
			update: {},
			create: {
				companyId: company.id,
				code: d.code,
				nameLao: d.nameLao,
				nameEnglish: d.nameEnglish,
				requiresBalance: d.requiresBalance,
				isPaid: d.isPaid,
				defaultEntitlementDays: d.days,
				description: 'DEMO — sample value, not a legal default'
			}
		});
	}
	console.log('Seeded DEMO leave types (ANNUAL, SICK, PERSONAL, UNPAID).');
}

/** Idempotent: every company gets its default one-step approval workflows (Leave / OT / Correction). */
export async function seedApprovalWorkflows(): Promise<void> {
	const { ensureDefaultWorkflows } = await import('../src/services/approvalInstance.service.js');
	const companies = await prisma.company.findMany({ select: { id: true } });
	let created = 0;
	for (const c of companies) created += (await ensureDefaultWorkflows(c.id)).length;
	console.log(
		`Approval workflows: ${created} default workflow(s) created for ${companies.length} company(ies).`
	);
}

async function main(): Promise<void> {
	// numeric-ID migration: the seed upserts (UPDATE on existing rows) — never run it against VARCHAR-keyed hr_db
	assertNumericIdMode();
	await assertNumericSchemaShapeOf(prisma);
	await seedPermissions();
	await seedRoles();
	await seedAdmin();
	await seedOrganizationDemo();
	await seedEmployeeDemo();
	await seedLeaveDemo();
	await seedApprovalWorkflows();
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
	main()
		.catch((err: unknown) => {
			console.error(err);
			process.exitCode = 1;
		})
		.finally(() => void prisma.$disconnect());
}
