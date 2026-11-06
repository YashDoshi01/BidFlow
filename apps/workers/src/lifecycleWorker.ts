// The lifecycle worker: starts auctions at starts_at and ends them at ends_at with no browser or API
// process involved, writes their outbox events and notifications. Same Docker image as the API:
//   node apps/workers/src/lifecycleWorker.ts
// Several copies can run at once; they coordinate through PostgreSQL only (FOR UPDATE SKIP LOCKED,
// conditional updates), never through each other. Nothing is scheduled in memory: "what is due" is
// a query, so a restart loses nothing but time.
import os from 'node:os';
import { EnvValidationError, parseEnv } from '../../api/src/config/env.ts';
import { createPool } from '../../api/src/db/pool.ts';
import { createLogger } from '../../api/src/logging/logger.ts';
import { createLifecycleWorker } from '../../api/src/modules/lifecycle/index.ts';
import { describeError } from '../../api/src/modules/outbox/index.ts';

function main(): void {
  const env = parseEnv(process.env);
  const workerId = env.INSTANCE_ID ?? `${os.hostname()}-${String(process.pid)}`;
  const logger = createLogger(env.LOG_LEVEL, undefined, {
    instance: workerId,
    role: 'lifecycle-worker',
  });
  const db = createPool(env.DATABASE_URL, 5);

  const worker = createLifecycleWorker({
    db,
    logger,
    workerId,
    pollIntervalMs: env.LIFECYCLE_POLL_INTERVAL_MS,
    batchSize: env.LIFECYCLE_BATCH_SIZE,
    endingSoonSeconds: env.ENDING_SOON_SECONDS,
  });
  worker.start();
  logger.info('lifecycle worker started', {
    pollIntervalMs: env.LIFECYCLE_POLL_INTERVAL_MS,
    batchSize: env.LIFECYCLE_BATCH_SIZE,
    endingSoonSeconds: env.ENDING_SOON_SECONDS,
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    // Finish the auction in progress (its transaction commits or rolls back whole), then close.
    worker
      .stop()
      .then(() => db.end())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      shutdown(signal);
    });
  }
}

try {
  main();
} catch (error) {
  if (error instanceof EnvValidationError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(describeError(error));
  process.exit(1);
}
