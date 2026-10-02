import type { UserStatus } from '@prisma/client';

export interface AuthUser {
	id: number;
	username: string;
	email: string | null;
	displayName: string;
	status: UserStatus;
}

export interface AuthRole {
	id: number;
	code: string;
	name: string;
}

export interface AuthContext {
	sessionId: number;
	user: AuthUser;
	roles: AuthRole[];
	permissions: string[];
}

declare global {
	namespace Express {
		interface Request {
			auth?: AuthContext;
			/** server-generated correlation id (see middlewares/requestContext) */
			requestId?: string;
		}
	}
}

export {};
