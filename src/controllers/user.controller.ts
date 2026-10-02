import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import * as userService from '../services/user.service.js';
import type {
	CreateUserInput,
	ListUsersQuery,
	UpdateUserInput
} from '../validation/user.schema.js';

export async function list(req: Request, res: Response): Promise<void> {
	// validateQuery(listUsersQuerySchema) has already parsed/coerced req.query into this shape.
	const query = req.query as unknown as ListUsersQuery;
	const result = await userService.listUsers(query);
	sendSuccess(res, result);
}

export async function getById(req: Request, res: Response): Promise<void> {
	const user = await userService.getUserById(idParam(req));
	sendSuccess(res, user);
}

export async function create(
	req: Request<unknown, unknown, CreateUserInput>,
	res: Response
): Promise<void> {
	const user = await userService.createUser(req.body);
	sendSuccess(res, user, 201);
}

export async function update(
	req: Request<Record<string, string>, unknown, UpdateUserInput>,
	res: Response
): Promise<void> {
	// The PATCH endpoint covers profile + role fields under users.update, but changing `status`
	// (enable/disable) additionally requires the more sensitive users.disable permission.
	if (req.body.status !== undefined && !req.auth?.permissions.includes('users.disable')) {
		throw Errors.forbidden();
	}

	const user = await userService.updateUser(idParam(req), req.body);
	sendSuccess(res, user);
}
