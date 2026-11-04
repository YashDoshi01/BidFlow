import type { RequestHandler, Response } from 'express';
import { AppError } from '../../http/errors.ts';
import type { AuthService } from './service.ts';

export interface AuthContext {
  userId: string;
  sessionId: string;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]{20,128})$/;

/**
 * Resolves the bearer token to a session. The tenant/identity comes only from
 * here (CLAUDE.md rule 18), never from request input. Every failure is the
 * same 401 so a client cannot tell "unknown token" from "expired" or "revoked".
 */
export function requireAuth(auth: AuthService): RequestHandler {
  return async (req, res, next) => {
    const match = BEARER.exec(req.headers.authorization ?? '');
    const principal = match?.[1] ? await auth.authenticate(match[1]) : undefined;
    if (!principal) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    }
    res.locals['auth'] = {
      userId: principal.userId,
      sessionId: principal.sessionId,
    } satisfies AuthContext;
    next();
  };
}

/** Like requireAuth, but a request without credentials continues as anonymous. */
export function optionalAuth(auth: AuthService): RequestHandler {
  const strict = requireAuth(auth);
  return async (req, res, next) => {
    if (req.headers.authorization === undefined) {
      next();
      return;
    }
    await strict(req, res, next);
  };
}

export function getAuth(res: Response): AuthContext | undefined {
  const value: unknown = res.locals['auth'];
  if (typeof value === 'object' && value !== null && 'userId' in value && 'sessionId' in value) {
    return value as AuthContext;
  }
  return undefined;
}

export function mustGetAuth(res: Response): AuthContext {
  const context = getAuth(res);
  if (!context) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  return context;
}
