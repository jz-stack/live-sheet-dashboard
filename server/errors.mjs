export class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', status = 500, stage = 'unknown', retryable = false } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.stage = stage;
    this.retryable = retryable;
  }
}

export function normalizeError(error) {
  return {
    code: error?.code || 'UNKNOWN',
    stage: error?.stage || 'unknown',
    message: error?.message || String(error),
  };
}
