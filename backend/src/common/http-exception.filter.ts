import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { logger } from './logger';
import * as Sentry from '@sentry/node';

/** Renders every error as `{ error: { code, message, details } }`. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.render(exception);
    const req = host.switchToHttp().getRequest<Request>();
    const where = { method: req?.method, path: req?.originalUrl?.split('?')[0], status };
    if (status >= 500) {
      logger.error({ err: exception, ...where }, 'unhandled error');
      Sentry.captureException(exception);
    } else if (status !== 401 && status !== 404) {
      // Client errors are logged (without bodies) so a failing app flow can be traced in CloudWatch.
      const e = (body as { error?: { code?: string; message?: string } }).error;
      logger.warn({ ...where, code: e?.code, message: e?.message }, 'request rejected');
    }
    res.status(status).json(body);
  }

  private render(exception: unknown): { status: number; body: unknown } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse() as any;
      if (resp && typeof resp === 'object' && resp.error && typeof resp.error === 'object') {
        return { status, body: resp };
      }
      // Nest built-ins (ValidationPipe, ThrottlerException, NotFound route...)
      const message = Array.isArray(resp?.message) ? 'Validation failed' : (resp?.message ?? exception.message);
      const code =
        status === HttpStatus.BAD_REQUEST && Array.isArray(resp?.message)
          ? 'validation_failed'
          : status === HttpStatus.TOO_MANY_REQUESTS
            ? 'rate_limited'
            : status === HttpStatus.NOT_FOUND
              ? 'not_found'
              : status === HttpStatus.UNAUTHORIZED
                ? 'unauthorized'
                : status === HttpStatus.FORBIDDEN
                  ? 'forbidden'
                  : 'http_error';
      return {
        status,
        body: { error: { code, message, details: Array.isArray(resp?.message) ? resp.message : undefined } },
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
      return {
        status: HttpStatus.CONFLICT,
        body: { error: { code: 'duplicate', message: 'A record with these values already exists', details: exception.meta } },
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2025') {
      return { status: HttpStatus.NOT_FOUND, body: { error: { code: 'not_found', message: 'Record not found' } } };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: 'internal_error', message: 'Something went wrong' } },
    };
  }
}
