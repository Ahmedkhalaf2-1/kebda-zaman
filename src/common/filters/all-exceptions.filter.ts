import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Canonical error envelope (per BACKEND_IMPLEMENTATION_PLAN.md §1.3):
 *
 * {
 *   "statusCode": 400,
 *   "error": "BadRequest",
 *   "message": "human readable",
 *   "code": "PROMO_EXPIRED",
 *   "details": {...},
 *   "timestamp": "...",
 *   "path": "/api/v1/...",
 *   "requestId": "..."
 * }
 *
 * A stable machine-readable `code` lets the Flutter Result/Failure layer branch
 * without string-matching human messages.
 */
interface ErrorEnvelope {
  statusCode: number;
  error: string;
  message: string;
  code: string;
  details?: unknown;
  timestamp: string;
  path: string;
  requestId?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code = 'INTERNAL_ERROR';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object') {
        const body = res as Record<string, unknown>;
        if (Array.isArray(body.message)) {
          // class-validator style errors
          message = 'Validation failed';
          code = 'VALIDATION_ERROR';
          details = body.message;
        } else if (typeof body.message === 'string') {
          message = body.message;
        }
        if (typeof body.code === 'string') {
          code = body.code;
        }
        if (body.details !== undefined) {
          details = body.details;
        }
      }
      if (code === 'INTERNAL_ERROR') {
        code = this.statusToCode(status);
      }
    } else if (this.isPrismaKnownError(exception)) {
      const mapped = this.mapPrismaError(exception.code);
      status = mapped.status;
      code = mapped.code;
      message = mapped.message;
    } else if (exception instanceof Error) {
      message = exception.message || message;
    }

    const requestId =
      (request as Request & { id?: string }).id ??
      (typeof request.headers['x-request-id'] === 'string'
        ? (request.headers['x-request-id'] as string)
        : undefined);

    const envelope: ErrorEnvelope = {
      statusCode: status,
      error: this.statusToReason(status),
      message,
      code,
      ...(details !== undefined ? { details } : {}),
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(requestId ? { requestId } : {}),
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId ?? '-'}] ${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(envelope);
  }

  private isPrismaKnownError(exception: unknown): exception is { code: string; message: string } {
    return (
      typeof exception === 'object' &&
      exception !== null &&
      'code' in exception &&
      typeof (exception as { code: unknown }).code === 'string' &&
      (exception as { code: string }).code.startsWith('P')
    );
  }

  private mapPrismaError(prismaCode: string): {
    status: number;
    code: string;
    message: string;
  } {
    switch (prismaCode) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          code: 'UNIQUE_CONSTRAINT_VIOLATION',
          message: 'A record with the same unique value already exists',
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: 'RECORD_NOT_FOUND',
          message: 'The requested record was not found',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: 'DATABASE_ERROR',
          message: 'A database error occurred',
        };
    }
  }

  private statusToReason(status: number): string {
    const key = HttpStatus[status];
    if (!key) {
      return 'Error';
    }
    // Convert e.g. "BAD_REQUEST" -> "BadRequest"
    return key
      .toLowerCase()
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }

  private statusToCode(status: number): string {
    const key = HttpStatus[status];
    return key ? key : 'ERROR';
  }
}
