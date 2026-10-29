import { HttpException, HttpStatus } from '@nestjs/common';

/** Application error rendered as `{ error: { code, message, details } }` (§11). */
export class AppError extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super({ error: { code, message, details } }, status);
  }
}

export const Errors = {
  notFound: (entity: string) => new AppError('not_found', `${entity} not found`, HttpStatus.NOT_FOUND),
  forbidden: (message = 'You do not have permission to do this') =>
    new AppError('forbidden', message, HttpStatus.FORBIDDEN),
  unauthorized: (message = 'Authentication required') =>
    new AppError('unauthorized', message, HttpStatus.UNAUTHORIZED),
  conflict: (code: string, message: string, details?: unknown) =>
    new AppError(code, message, HttpStatus.CONFLICT, details),
  invalid: (code: string, message: string, details?: unknown) =>
    new AppError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details),
  badRequest: (code: string, message: string, details?: unknown) =>
    new AppError(code, message, HttpStatus.BAD_REQUEST, details),
  unavailable: (code: string, message: string) => new AppError(code, message, HttpStatus.SERVICE_UNAVAILABLE),
  tooMany: (message = 'Too many requests, try again later') =>
    new AppError('rate_limited', message, HttpStatus.TOO_MANY_REQUESTS),
};
