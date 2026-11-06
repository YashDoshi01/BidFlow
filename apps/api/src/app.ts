import express from 'express';
import type { Db } from './db/pool.ts';
import { errorHandler, notFoundHandler } from './http/errors.ts';
import { requestContext } from './http/requestContext.ts';
import { runChecks, type DependencyCheck } from './health/dependencies.ts';
import type { Logger } from './logging/logger.ts';
import { auctionRoutes } from './modules/auctions/index.ts';
import { authRoutes } from './modules/auth/index.ts';
import { bidRoutes } from './modules/bids/index.ts';
import { notificationRoutes } from './modules/notifications/index.ts';
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
}

export function createApp({
  db,
  checks,
  logger,
  sessionTtlSeconds,
  services,
  instanceId,
}: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext(logger));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (instanceId) res.setHeader('X-Instance-Id', instanceId);
    next();
  });
  // A small limit: every JSON body in this API is a few hundred bytes.
  app.use(express.json({ limit: '16kb' }));

  // Liveness: is the process up and able to answer? No dependencies are
  // touched, so a Postgres outage does not make an orchestrator restart us.
  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness: can this instance do its core job? Only a CRITICAL dependency failing (PostgreSQL)
  // makes it 503 and takes the instance out of the load balancer. Redis down is `degraded` but
  // still 200: bids are committed to PostgreSQL and must keep working; only live fan-out suffers.
  // (If Redis outages removed instances from rotation, a Redis outage would stop all bidding.)
  app.get('/health/ready', async (_req, res) => {
    const results = await runChecks(checks);
    const criticalDown = results.some((r) => r.critical && !r.ok);
    const anyDown = results.some((r) => !r.ok);
    res.status(criticalDown ? 503 : 200).json({
      status: criticalDown ? 'unavailable' : anyDown ? 'degraded' : 'ready',
      ...(instanceId ? { instance: instanceId } : {}),
      checks: results,
    });
  });

  const { auth, auctions, bids, notifications } =
    services ?? createServices(db, { sessionTtlSeconds });
  app.use(authRoutes(auth));
  app.use(auctionRoutes(auctions, auth));
  app.use(bidRoutes(bids, auth));
  app.use(notificationRoutes(notifications, auth));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
