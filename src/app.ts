import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env, isProduction, isTest } from './config/env.js';
import { v1Router } from './routes/index.js';
import { notFoundHandler } from './middlewares/notFound.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { requestContext } from './middlewares/requestContext.js';

export const app = express();

// Only trust X-Forwarded-For when a reverse proxy is explicitly configured (TRUST_PROXY=1 / hop count
// / "loopback"); otherwise the audit trail records the real socket address, which cannot be spoofed.
if (env.trustProxy !== undefined) app.set('trust proxy', env.trustProxy);

app.use(helmet());
// credentials:true + an explicit origin (never '*') is required for the HttpOnly session cookie to work cross-origin.
app.use(
	cors({
		origin: env.frontendOrigin,
		credentials: true,
		// Phase 14 — downloads: the SPA reads the server's safe filename and the export's SHA-256
		exposedHeaders: [
			'Content-Disposition',
			'X-Export-Hash',
			'X-Export-Id',
			'X-Report-Rows',
			'X-Report-Hash'
		]
	})
);
app.use(express.json());
app.use(cookieParser());
app.use(requestContext);
if (!isTest) app.use(morgan(isProduction ? 'combined' : 'dev'));

app.use('/api/v1', v1Router);

app.use(notFoundHandler);
app.use(errorHandler);
