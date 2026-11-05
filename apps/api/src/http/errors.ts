import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from '../logging/logger.ts';
import { getRequestId } from './requestContext.ts';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_JSON'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'EMAIL_TAKEN'
  | 'INVALID_STATE'
  | 'AUCTION_NOT_LIVE'
  | 'AUCTION_ENDED'
  | 'BID_TOO_LOW'
  | 'BIDDER_IS_SELLER'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  path: string;
  message: string;
}

/** An error the client is allowed to see. Everything else becomes a 500. */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: ErrorDetail[] | undefined;
  /** Extra public, non-secret fields for the client (e.g. the minimum acceptable bid). */
  readonly data: Record<string, string> | undefined;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: ErrorDetail[],
    data?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.data = data;
  }
}

export const notFoundHandler: RequestHandler = () => {
  throw new AppError(404, 'NOT_FOUND', 'Resource not found');
};

function bodyParserError(error: unknown): AppError | undefined {
  if (typeof error !== 'object' || error === null || !('type' in error)) return undefined;
  const type = error.type;
  if (type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  if (type === 'entity.parse.failed' || type === 'encoding.unsupported') {
    return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  return undefined;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifies an error handler by its four parameters; `next` must stay.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (error: unknown, _req, res, _next) => {
    const requestId = getRequestId(res);
    const known = error instanceof AppError ? error : bodyParserError(error);
    if (known) {
      res.status(known.status).json({
        error: {
          code: known.code,
          message: known.message,
          requestId,
          ...(known.details ? { details: known.details } : {}),
          ...(known.data ? { data: known.data } : {}),
        },
      });
      return;
    }
    // Unknown failure: log the real error server-side, show nothing internal to the client.
    logger.error('unhandled error', {
      requestId,
      errorName: error instanceof Error ? error.name : 'non-error',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId },
    });
  };
}
