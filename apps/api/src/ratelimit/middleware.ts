import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../http/errors.ts';
import type { Policy, RateLimiter } from './limiter.ts';

export type SubjectOf = (req: Request, res: Response) => string | undefined;

/**
 * Express middleware: counts this request against `policy` for the subject it names, sets the
 * standard rate-limit headers, and answers 429 with `Retry-After` when the limit is exceeded.
 * A request with no subject (for example no email in the body) is not counted here: validation
 * will reject it anyway.
 */
export function rateLimit(
  limiter: RateLimiter,
  policy: Policy,
  subjectOf: SubjectOf,
): RequestHandler {
  return async (req, res, next) => {
    const subject = subjectOf(req, res);
    if (subject === undefined) {
      next();
      return;
    }
    const d = await limiter.check(policy, subject);
    const resetSeconds = Math.ceil(d.retryAfterMs / 1000);
    // Several limits can apply to one request (an address ceiling, a user limit, an auction limit).
    // The headers describe the TIGHTEST one (least remaining), not whichever ran last: a client reading
    // them wants to know how many more requests it can send.
    const shown: unknown = res.locals['rateLimitShown'];
    const tighter =
      typeof shown !== 'number' || d.remaining < shown || (!d.allowed && d.remaining === 0);
    if (tighter) {
      res.locals['rateLimitShown'] = d.remaining;
      res.setHeader('RateLimit-Limit', String(d.limit));
      res.setHeader('RateLimit-Remaining', String(d.remaining));
      res.setHeader('RateLimit-Reset', String(resetSeconds));
    }
    if (!d.allowed) {
      const wait = Math.max(1, resetSeconds);
      res.setHeader('Retry-After', String(wait));
      throw new AppError(
        429,
        'RATE_LIMITED',
        'Too many requests. Please slow down and try again shortly.',
        undefined,
        { retryAfterSeconds: String(wait), policy: policy.name },
      );
    }
    next();
  };
}

/** Client address as Express resolved it (see `trust proxy` in app.ts). */
export const byIp: SubjectOf = (req) => req.ip ?? 'unknown';

/** The authenticated user. Only valid after requireAuth: the id comes from the session, never from input. */
export const byUser: SubjectOf = (_req, res) => {
  const auth: unknown = res.locals['auth'];
  if (typeof auth === 'object' && auth !== null && 'userId' in auth) {
    return String(auth.userId);
  }
  return undefined;
};

/** The auction id from the path (a validated UUID is checked by the route; here it is just a key). */
export const byAuctionParam: SubjectOf = (req) => {
  const id = req.params['auctionId'];
  return typeof id === 'string' && /^[0-9a-fA-F-]{36}$/.test(id) ? id.toLowerCase() : undefined;
};

/**
 * The email in the login/registration body, hashed. The counter key is stored in Redis and appears
 * in nothing else: hashing keeps a person's address out of Redis keys and dumps (rule 17 in spirit).
 */
export const byBodyEmail: SubjectOf = (req) => {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || !('email' in body)) return undefined;
  const email = body.email;
  if (typeof email !== 'string' || email.length === 0 || email.length > 320) return undefined;
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
};
