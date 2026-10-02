import type { OrgStatus } from '@prisma/client';
import { Errors } from '../utils/AppError.js';

/**
 * Enforces "do not allow creating/activating a child as ACTIVE under an
 * INACTIVE parent." Only ever called when the child's resulting status
 * is ACTIVE — an INACTIVE child may always be created/kept under any
 * parent, and an already-ACTIVE child is never forced INACTIVE just
 * because its parent later becomes INACTIVE (no cascade, per spec).
 */
export function assertParentActive(parentStatus: OrgStatus, parentLabel: string): void {
	if (parentStatus !== 'ACTIVE') {
		throw Errors.badRequest(
			'INACTIVE_PARENT',
			`ບໍ່ສາມາດສ້າງ ຫຼື ເປີດນຳໃຊ້ລາຍການນີ້ໄດ້ ເນື່ອງຈາກ${parentLabel}ປິດການນຳໃຊ້ຢູ່`
		);
	}
}
