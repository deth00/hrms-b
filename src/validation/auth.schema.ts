import { z } from 'zod';

export const loginSchema = z.object({
	login: z.string().trim().min(1, 'ກະລຸນາປ້ອນຊື່ຜູ້ໃຊ້ ຫຼື ອີເມວ'),
	password: z.string().min(1, 'ກະລຸນາປ້ອນລະຫັດຜ່ານ')
});
export type LoginInput = z.infer<typeof loginSchema>;

/** At least 8 chars with a letter and a digit — a floor, not a frustrating policy. */
export const passwordSchema = z
	.string()
	.min(8, 'ລະຫັດຜ່ານຕ້ອງມີຢ່າງໜ້ອຍ 8 ຕົວອັກສອນ')
	.regex(/[A-Za-z]/, 'ລະຫັດຜ່ານຕ້ອງມີຕົວອັກສອນຢ່າງໜ້ອຍ 1 ໂຕ')
	.regex(/[0-9]/, 'ລະຫັດຜ່ານຕ້ອງມີຕົວເລກຢ່າງໜ້ອຍ 1 ໂຕ');

export const changePasswordSchema = z
	.object({
		currentPassword: z.string().min(1, 'ກະລຸນາປ້ອນລະຫັດຜ່ານປັດຈຸບັນ'),
		newPassword: passwordSchema,
		confirmPassword: z.string().min(1, 'ກະລຸນາຢືນຢັນລະຫັດຜ່ານໃໝ່')
	})
	.refine((data) => data.newPassword === data.confirmPassword, {
		message: 'ລະຫັດຜ່ານໃໝ່ບໍ່ກົງກັນ',
		path: ['confirmPassword']
	});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
