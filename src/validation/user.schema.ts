import { z } from 'zod';
import { idSchema } from './common.schema.js';
import { passwordSchema } from './auth.schema.js';

const username = z
	.string()
	.trim()
	.min(3, 'ຊື່ຜູ້ໃຊ້ຕ້ອງມີຢ່າງໜ້ອຍ 3 ຕົວອັກສອນ')
	.max(50)
	.regex(/^[a-zA-Z0-9._-]+$/, 'ຊື່ຜູ້ໃຊ້ໃຊ້ໄດ້ສະເພາະ a-z, 0-9, . _ -');

const email = z.string().trim().toLowerCase().email('ອີເມວບໍ່ຖືກຕ້ອງ');

const displayName = z.string().trim().min(1, 'ກະລຸນາປ້ອນຊື່ສະແດງ').max(120);

export const listUsersQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
	search: z.string().trim().max(120).optional(),
	status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
	roleId: idSchema.optional()
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const createUserSchema = z.object({
	username,
	email: email.optional(),
	displayName,
	password: passwordSchema,
	roleIds: z.array(idSchema).default([])
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
	.object({
		displayName: displayName.optional(),
		email: email.nullable().optional(),
		status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
		roleIds: z.array(idSchema).optional()
	})
	.refine((data) => Object.keys(data).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
