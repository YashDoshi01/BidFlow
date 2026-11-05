import express from 'express';
import type { Db } from './db/pool.ts';
import { errorHandler, notFoundHandler } from './http/errors.ts';
import { requestContext } from './http/requestContext.ts';
import { runChecks, type DependencyCheck } from './health/dependencies.ts';
import type { Logger } from './logging/logger.ts';
import { noopPublisher, type EventPublisher } from './events/publisher.ts';
import { auctionRoutes } from './modules/auctions/index.ts';
import { authRoutes } from './modules/auth/index.ts';
import { bidRoutes } from './modules/bids/index.ts';
import { createServices, type Services } from './services.ts';

export interface AppDeps {
  db: Db;
  checks: DependencyCheck[];
  logger: Logger;
  sessionTtlSeconds: number;
  /** Shared with the WebSocket gateway. Built here if not given (HTTP-only tests). */
  services?: Services;
  /** Used only when `services` is not given. */
  publisher?: EventPublisher;
}

export function createApp({
  db,
  checks,
  logger,
  sessionTtlSeconds,
  services,
  publisher,
}: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext(logger));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  // A small limit: every JSON body in this API is a few hundred bytes.
  app.use(express.json({ limit: '16kb' }));

  // Liveness: is the process up and able to answer? No dependencies are
  // touched, so a Postgres outage does not make an orchestrator restart us.
  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness: can this instance do useful work? 503 if a dependency is down.
  app.get('/health/ready', async (_req, res) => {
    const results = await runChecks(checks);
    const ready = results.every((r) => r.ok);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', checks: results });
  });

  const { auth, auctions, bids } =
    services ??
    createServices(db, { sessionTtlSeconds, logger, publisher: publisher ?? noopPublisher });
  app.use(authRoutes(auth));
  app.use(auctionRoutes(auctions, auth));
  app.use(bidRoutes(bids, auth));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
