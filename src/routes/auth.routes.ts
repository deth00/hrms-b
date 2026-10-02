import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { loginRateLimiter } from '../middlewares/rateLimit.js';
import { validateBody } from '../middlewares/validate.js';
import { loginSchema, changePasswordSchema } from '../validation/auth.schema.js';

export const authRouter = Router();

authRouter.post('/auth/login', loginRateLimiter, validateBody(loginSchema), authController.login);
authRouter.get('/auth/me', requireAuth, authController.me);
authRouter.post('/auth/logout', requireAuth, authController.logout);
authRouter.post(
	'/auth/change-password',
	requireAuth,
	validateBody(changePasswordSchema),
	authController.changePassword
);
