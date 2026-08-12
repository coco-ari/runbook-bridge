export class AppError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function toPublicError(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: 'INTERNAL_ERROR', message: '操作失败，请查看本地诊断日志。' };
}
