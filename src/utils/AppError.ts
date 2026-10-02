/** A known, expected failure that should map directly to an HTTP status + API error code. */
export class AppError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
		/** Optional machine-readable context for the client (never sensitive data). */
		public readonly details?: Record<string, unknown>
	) {
		super(message);
		this.name = 'AppError';
	}
}

export const Errors = {
	unauthenticated: (message = 'ກະລຸນາເຂົ້າສູ່ລະບົບ') =>
		new AppError(401, 'UNAUTHENTICATED', message),
	invalidCredentials: () =>
		new AppError(401, 'INVALID_CREDENTIALS', 'ຊື່ຜູ້ໃຊ້/ອີເມວ ຫຼື ລະຫັດຜ່ານ ບໍ່ຖືກຕ້ອງ'),
	forbidden: (message = 'ທ່ານບໍ່ມີສິດເຂົ້າເຖິງລາຍການນີ້') =>
		new AppError(403, 'FORBIDDEN', message),
	notFound: (message = 'ບໍ່ພົບຂໍ້ມູນ') => new AppError(404, 'NOT_FOUND', message),
	badRequest: (code: string, message: string, details?: Record<string, unknown>) =>
		new AppError(400, code, message, details),
	conflict: (code: string, message: string, details?: Record<string, unknown>) =>
		new AppError(409, code, message, details),
	forbiddenWith: (code: string, message: string) => new AppError(403, code, message)
};
