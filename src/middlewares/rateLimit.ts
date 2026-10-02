import rateLimit from 'express-rate-limit';
import { isTest } from '../config/env.js';
import { sendError } from '../utils/response.js';

/** 20 attempts / 15 min per IP — generous enough for real users, tight enough to slow brute force. */
export const loginRateLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 20,
	standardHeaders: true,
	legacyHeaders: false,
	skip: () => isTest,
	handler: (_req, res) => {
		sendError(res, 429, 'TOO_MANY_REQUESTS', 'ພະຍາຍາມເຂົ້າສູ່ລະບົບຫຼາຍເກີນໄປ, ກະລຸນາລອງໃໝ່ພາຍຫຼັງ');
	}
});

/**
 * Self punch endpoints: 30 requests / minute per signed-in user. Real double-taps and retries
 * after a flaky network stay far below this; the primary protection against duplicates is the
 * idempotent service behaviour (unique record + compare-and-set), not this limiter.
 */
export const punchRateLimiter = rateLimit({
	windowMs: 60 * 1000,
	limit: 30,
	standardHeaders: true,
	legacyHeaders: false,
	skip: () => isTest,
	keyGenerator: (req) => (req.auth ? `user:${req.auth.user.id}` : 'anonymous'),
	validate: { keyGeneratorIpFallback: false },
	handler: (_req, res) => {
		sendError(res, 429, 'TOO_MANY_REQUESTS', 'ສົ່ງຄຳຂໍຫຼາຍເກີນໄປ, ກະລຸນາລໍຖ້າສັກຄູ່ແລ້ວລອງໃໝ່');
	}
});
