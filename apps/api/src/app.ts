import express from 'express';
import type { Db } from './db/pool.ts';
import { errorHandler, notFoundHandler } from './http/errors.ts';
import { requestContext } from './http/requestContext.ts';
import { runChecks, type DependencyCheck } from './health/dependencies.ts';
import type { Logger } from './logging/logger.ts';
import { auctionRoutes, createAuctionService } from './modules/auctions/index.ts';
import { authRoutes, createAuthService } from './modules/auth/index.ts';
import { bidRoutes, createBidService } from './modules/bids/index.ts';

export interface AppDeps {
  db: Db;
  checks: DependencyCheck[];
  logger: Logger;
  sessionTtlSeconds: number;
}

export function createApp({ db, checks, logger, sessionTtlSeconds }: AppDeps): express.Express {
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

  const auth = createAuthService(db, { sessionTtlSeconds });
  const auctions = createAuctionService(db);
  app.use(authRoutes(auth));
  app.use(auctionRoutes(auctions, auth));
  app.use(bidRoutes(createBidService(db, auctions), auth));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
