import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

/**
 * Parses and replaces req.body/query/params with the schema's output
 * (trimmed, normalized, coerced). Zod throws synchronously on failure;
 * Express forwards that to errorHandler, which renders it as a 400.
 */
export function validateBody(schema: ZodType) {
	return (req: Request, _res: Response, next: NextFunction): void => {
		req.body = schema.parse(req.body);
		next();
	};
}

export function validateQuery(schema: ZodType) {
	return (req: Request, _res: Response, next: NextFunction): void => {
		const parsed = schema.parse(req.query) as Request['query'];
		// Express 5 defines req.query as a configurable getter (recomputed from the raw URL on
		// every access, no setter) — redefine the property itself rather than assigning to it.
		Object.defineProperty(req, 'query', {
			value: parsed,
			writable: true,
			configurable: true,
			enumerable: true
		});
		next();
	};
}

export function validateParams(schema: ZodType) {
	return (req: Request, _res: Response, next: NextFunction): void => {
		req.params = schema.parse(req.params) as typeof req.params;
		next();
	};
}
