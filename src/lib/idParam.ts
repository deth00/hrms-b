import type { Request } from 'express';
import { parseId } from '../validation/common.schema.js';
import { Errors } from '../utils/AppError.js';

/**
 * The numeric id path parameter `name` (default `id`). Routes validate `:id`-style params with
 * idParamSchema / idParamsSchema, which already replace them with numbers; this parses again (the one
 * strict parseId) so a route that forgot the validator still answers 400 — never a string id.
 */
export function idParam(req: Request, name = 'id'): number {
	const id = parseId((req.params as Record<string, unknown>)[name]);
	if (id === null) throw Errors.badRequest('VALIDATION_ERROR', `${name}: ID ບໍ່ຖືກຕ້ອງ`);
	return id;
}
