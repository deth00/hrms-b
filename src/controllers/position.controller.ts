import type { Request, Response } from 'express';
import { idParam } from '../lib/idParam.js';
import { sendSuccess } from '../utils/response.js';
import { Errors } from '../utils/AppError.js';
import * as positionLevelService from '../services/positionLevel.service.js';
import * as positionService from '../services/position.service.js';

/** Status changes (ACTIVE <-> INACTIVE) require the more sensitive `positions.disable` permission. */
function assertCanChangeStatus(req: Request): void {
	if (req.body.status !== undefined && !req.auth?.permissions.includes('positions.disable')) {
		throw Errors.forbidden();
	}
}

// ---------- Position Level ----------

export async function listPositionLevels(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await positionLevelService.listPositionLevels(req.query as never));
}
export async function getPositionLevel(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await positionLevelService.getPositionLevelById(idParam(req)));
}
export async function createPositionLevel(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await positionLevelService.createPositionLevel(req.body), 201);
}
export async function updatePositionLevel(req: Request, res: Response): Promise<void> {
	assertCanChangeStatus(req);
	sendSuccess(res, await positionLevelService.updatePositionLevel(idParam(req), req.body));
}
export async function lookupPositionLevels(req: Request, res: Response): Promise<void> {
	const { companyId, status } = req.query as unknown as {
		companyId: number;
		status?: 'ACTIVE' | 'INACTIVE';
	};
	sendSuccess(res, await positionLevelService.listPositionLevelLookup(companyId, status));
}

// ---------- Position ----------

export async function listPositions(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await positionService.listPositions(req.query as never));
}
export async function getPosition(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await positionService.getPositionById(idParam(req)));
}
export async function createPosition(req: Request, res: Response): Promise<void> {
	sendSuccess(res, await positionService.createPosition(req.body), 201);
}
export async function updatePosition(req: Request, res: Response): Promise<void> {
	assertCanChangeStatus(req);
	sendSuccess(res, await positionService.updatePosition(idParam(req), req.body));
}
