import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import * as roleService from '../services/role.service.js';
import type { CreateRoleInput, UpdateRoleInput } from '../validation/role.schema.js';

export async function list(_req: Request, res: Response): Promise<void> {
	const roles = await roleService.listRoles();
	sendSuccess(res, roles);
}

export async function getById(req: Request, res: Response): Promise<void> {
	const role = await roleService.getRoleById(idParam(req));
	sendSuccess(res, role);
}

export async function create(
	req: Request<unknown, unknown, CreateRoleInput>,
	res: Response
): Promise<void> {
	const role = await roleService.createRole(req.body);
	sendSuccess(res, role, 201);
}

export async function update(
	req: Request<Record<string, string>, unknown, UpdateRoleInput>,
	res: Response
): Promise<void> {
	const role = await roleService.updateRole(idParam(req), req.body);
	sendSuccess(res, role);
}

export async function listPermissions(_req: Request, res: Response): Promise<void> {
	const permissions = await roleService.listPermissions();
	sendSuccess(res, permissions);
}
