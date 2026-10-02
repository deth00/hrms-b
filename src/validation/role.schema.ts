import { z } from 'zod';
import { idSchema } from './common.schema.js';

const code = z
	.string()
	.trim()
	.toUpperCase()
	.min(2)
	.max(50)
	.regex(/^[A-Z0-9_]+$/, 'ລະຫັດບົດບາດໃຊ້ໄດ້ສະເພາະໂຕພິມໃຫຍ່, ຕົວເລກ ແລະ _');

const name = z.string().trim().min(1, 'ກະລຸນາປ້ອນຊື່ບົດບາດ').max(120);

export const createRoleSchema = z.object({
	code,
	name,
	description: z.string().trim().max(255).optional(),
	permissionIds: z.array(idSchema).default([])
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
	.object({
		name: name.optional(),
		description: z.string().trim().max(255).nullable().optional(),
		permissionIds: z.array(idSchema).optional()
	})
	.refine((data) => Object.keys(data).length > 0, { message: 'ບໍ່ມີຂໍ້ມູນທີ່ຈະອັບເດດ' });
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
