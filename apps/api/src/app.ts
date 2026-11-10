import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Db } from './db/pool.ts';
import { AppError, errorHandler, notFoundHandler } from './http/errors.ts';
import { requestContext } from './http/requestContext.ts';
import { apiSecurityHeaders } from './http/security.ts';
import { runChecks, type DependencyCheck } from './health/dependencies.ts';
import type { Logger } from './logging/logger.ts';
import type { AppMetrics } from './metrics/appMetrics.ts';
import { auctionRoutes } from './modules/auctions/index.ts';
import { authRoutes } from './modules/auth/index.ts';
import { bidRoutes } from './modules/bids/index.ts';
import { notificationRoutes } from './modules/notifications/index.ts';
import type { RateLimiter } from './ratelimit/limiter.ts';
import { byAuctionParam, byBodyEmail, byIp, byUser, rateLimit } from './ratelimit/middleware.ts';
import { buildPolicies, DEFAULT_RATE_LIMITS, type RateLimitConfig } from './ratelimit/policies.ts';
import { createServices, type Services } from './services.ts';

export interface AppDeps {
  db: Db;
  checks: DependencyCheck[];
  logger: Logger;
  sessionTtlSeconds: number;
  /** Shared with the WebSocket gateway. Built here if not given (HTTP-only tests). */
  services?: Services;
  /** Returned in the X-Instance-Id header so a request can be traced to the instance that served it. */
  instanceId?: string;
  /** Without metrics there is no /metrics route and nothing is counted. */
  metrics?: AppMetrics;
  /** Without a limiter nothing is rate limited. */
  limiter?: RateLimiter;
  rateLimits?: RateLimitConfig;
  /** Reverse proxies in front of this process (see TRUST_PROXY_HOPS in config/env.ts). */
  trustProxyHops?: number;
  /** If set, GET /metrics needs this bearer token. */
  metricsToken?: string;
  /** True once shutdown has started: readiness answers 503 and keep-alive connections are closed. */
  isDraining?: () => boolean;
}

/** Constant-time comparison of two secrets of any length (hash first, so lengths do not leak). */
function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function createApp({
  db,
  checks,
  logger,
  sessionTtlSeconds,
  services,
  instanceId,
  metrics,
  limiter,
  rateLimits = DEFAULT_RATE_LIMITS,
  trustProxyHops = 0,
  metricsToken,
  isDraining = () => false,
}: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // How `req.ip` is derived. With 0 the socket address is the client. Behind NGINX it must be 1:
  // NGINX appends the real client to X-Forwarded-For, and Express then takes the entry that the
  // trusted proxy added, ignoring anything the client put in the header itself.
  app.set('trust proxy', trustProxyHops === 0 ? false : trustProxyHops);

  app.use(requestContext(logger, metrics));
  app.use(apiSecurityHeaders());
  app.use((_req, res, next) => {
    if (instanceId) res.setHeader('X-Instance-Id', instanceId);
    // While draining, tell keep-alive clients to open their next connection somewhere else.
    if (isDraining()) res.setHeader('Connection', 'close');
    next();
  });
  // A small limit: every JSON body in this API is a few hundred bytes.
  app.use(express.json({ limit: '16kb' }));

  // Liveness: is the process up and able to answer? No dependencies are
  // touched, so a Postgres outage does not make an orchestrator restart us.
  // It stays 200 while draining: the process is healthy, it is just leaving.
  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness: can this instance do its core job? Only a CRITICAL dependency failing (PostgreSQL)
  // makes it 503 and takes the instance out of the load balancer. Redis down is `degraded` but
  // still 200: bids are committed to PostgreSQL and must keep working; only live fan-out suffers.
  // (If Redis outages removed instances from rotation, a Redis outage would stop all bidding.)
  // While draining it is 503 too: "do not send me new work".
  app.get('/health/ready', async (_req, res) => {
    if (isDraining()) {
      res.status(503).json({ status: 'draining', ...(instanceId ? { instance: instanceId } : {}) });
      return;
    }
    const results = await runChecks(checks);
    const criticalDown = results.some((r) => r.critical && !r.ok);
    const anyDown = results.some((r) => !r.ok);
    res.status(criticalDown ? 503 : 200).json({
      status: criticalDown ? 'unavailable' : anyDown ? 'degraded' : 'ready',
      ...(instanceId ? { instance: instanceId } : {}),
      checks: results,
    });
  });

  // Prometheus scrape endpoint. It exposes counts and timings, never user data, but it describes
  // the system (route names, load), so it is not published through NGINX and can be protected
  // with a bearer token. Defined BEFORE the general rate limit: a scraper must not be limited.
  if (metrics) {
    app.get('/metrics', async (req, res) => {
      if (metricsToken !== undefined) {
        const header = req.get('Authorization') ?? '';
        const given = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!sameSecret(given, metricsToken)) {
          throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
        }
      }
      res
        .status(200)
        .type('text/plain; version=0.0.4; charset=utf-8')
        .send(await metrics.registry.render());
    });
  }

  const policies = buildPolicies(rateLimits);
  const guard = limiter && rateLimits.enabled ? limiter : undefined;
  if (guard) {
    // Everything below shares one per-address ceiling (reads included).
    app.use(rateLimit(guard, policies.readIp, byIp));
  }

  const { auth, auctions, bids, notifications } =
    services ?? createServices(db, { sessionTtlSeconds, logger });
  app.use(
    authRoutes(
      auth,
      guard
        ? {
            register: [rateLimit(guard, policies.registerIp, byIp)],
            // Two independent limits: one address trying many accounts, and many addresses
            // trying one account.
            login: [
              rateLimit(guard, policies.loginIp, byIp),
              rateLimit(guard, policies.loginEmail, byBodyEmail),
            ],
          }
        : {},
    ),
  );
  app.use(auctionRoutes(auctions, auth));
  app.use(
    bidRoutes(
      bids,
      auth,
      // Order matters: the user limit first, so a user who is already limited does not also use
      // up the shared budget of the auction.
      guard
        ? [
            rateLimit(guard, policies.bidUser, byUser),
            rateLimit(guard, policies.bidAuction, byAuctionParam),
          ]
        : [],
    ),
  );
  app.use(notificationRoutes(notifications, auth));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
