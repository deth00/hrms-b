import { prisma } from '../config/prisma.js';
import type { AuthContext } from '../types/express.js';

/**
 * Employee DATA SCOPE (Phase 3 foundation).
 *
 * `employees.view` says a user may call the employee endpoints at all; the scope says WHICH
 * employee rows they may see. It is decided purely by permission + relationships — never by a
 * role name:
 *
 *   - `employees.view_all`  -> ALL: the whole employee directory (HR / admin style access).
 *   - otherwise             -> RESTRICTED to the user's own linked Employee record plus every
 *                              Employee below it in the manager tree (direct AND indirect
 *                              reports). A user with no linked Employee gets an empty scope —
 *                              holding `employees.view` alone never exposes the directory.
 */
export const VIEW_ALL_PERMISSION = 'employees.view_all';

export type EmployeeScope = { all: true } | { all: false; employeeIds: number[] };

/** Bound on manager-tree depth so a corrupted (cyclic) tree can never loop forever. */
const MAX_TREE_DEPTH = 50;

export async function resolveEmployeeScope(auth: AuthContext): Promise<EmployeeScope> {
	if (auth.permissions.includes(VIEW_ALL_PERMISSION)) return { all: true };

	const self = await prisma.employee.findUnique({
		where: { userId: auth.user.id },
		select: { id: true }
	});
	if (!self) return { all: false, employeeIds: [] };

	const visible = new Set<number>([self.id]);
	let frontier = [self.id];
	for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
		const reports = await prisma.employee.findMany({
			where: { managerEmployeeId: { in: frontier } },
			select: { id: true }
		});
		frontier = reports.map((r) => r.id).filter((id) => !visible.has(id));
		frontier.forEach((id) => visible.add(id));
	}
	return { all: false, employeeIds: [...visible] };
}

export function scopeToWhere(scope: EmployeeScope): { id?: { in: number[] } } {
	return scope.all ? {} : { id: { in: scope.employeeIds } };
}

export function isInScope(scope: EmployeeScope, employeeId: number): boolean {
	return scope.all || scope.employeeIds.includes(employeeId);
}
