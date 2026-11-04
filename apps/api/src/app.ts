import express from 'express';
import { runChecks, type DependencyCheck } from './health/dependencies.ts';

export interface AppDeps {
  checks: DependencyCheck[];
}

export function createApp({ checks }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // Liveness: is the process up and able to answer? No dependencies are
  // touched, so a Postgres outage does not make an orchestrator restart us.
  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness: can this instance do useful work? 503 if a dependency is down.
  app.get('/health/ready', (_req, res, next) => {
    runChecks(checks).then((results) => {
      const ready = results.every((r) => r.ok);
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', checks: results });
    }, next);
  });

  return app;
}
