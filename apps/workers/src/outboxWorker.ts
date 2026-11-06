// The outbox worker: publishes committed events to Redis (and so to every API instance's sockets).
// Same Docker image as the API, different entrypoint (plan section 3.6):
//   node apps/workers/src/outboxWorker.ts
// Several copies can run at once: they coordinate through PostgreSQL (leases, FOR UPDATE SKIP
// LOCKED), never through each other. See docs/OPERATIONS.md for what to do when events fail.
import os from 'node:os';
import { EnvValidationError, parseEnv } from '../../api/src/config/env.ts';
import { createPool } from '../../api/src/db/pool.ts';
import { createLogger } from '../../api/src/logging/logger.ts';
import {
  createOutboxPublisher,
  createPublishClient,
  createRedisEmitterSink,
  describeError,
  outboxStats,
  pruneOutbox,
} from '../../api/src/modules/outbox/index.ts';

const STATS_EVERY_MS = 15_000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

function main(): void {
  const env = parseEnv(process.env);
  const workerId = env.INSTANCE_ID ?? `${os.hostname()}-${String(process.pid)}`;
  const logger = createLogger(env.LOG_LEVEL, undefined, {
    instance: workerId,
    role: 'outbox-worker',
  });
  const db = createPool(env.DATABASE_URL, 5);
  const redis = createPublishClient(env.REDIS_URL, logger);

  const publisher = createOutboxPublisher({
    db,
    sink: createRedisEmitterSink(redis),
    logger,
    workerId,
    pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    batchSize: env.OUTBOX_BATCH_SIZE,
    leaseSeconds: env.OUTBOX_LEASE_SECONDS,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
  });
  publisher.start();
  logger.info('outbox worker started', {
    pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    batchSize: env.OUTBOX_BATCH_SIZE,
    leaseSeconds: env.OUTBOX_LEASE_SECONDS,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
  });

  // The alert: failed events block their auction, so they are logged at ERROR level on every tick
  // until someone retries them (docs/OPERATIONS.md). Backlog age is the other number to watch.
  const statsTimer = setInterval(() => {
    outboxStats(db).then(
      (stats) => {
        if (stats.failed > 0) {
          logger.error('outbox has FAILED events: later events of those auctions are blocked', {
            ...stats,
          });
        } else {
          logger.info('outbox stats', { ...stats });
        }
      },
      (error: unknown) => {
        logger.warn('could not read outbox stats', { error: describeError(error) });
      },
    );
  }, STATS_EVERY_MS);

  const pruneTimer = setInterval(() => {
    pruneOutbox(db, env.OUTBOX_RETENTION_HOURS * 3600).then(
      (deleted) => {
        if (deleted > 0) logger.info('pruned published outbox events', { deleted });
      },
      (error: unknown) => {
        logger.warn('outbox prune failed', { error: describeError(error) });
      },
    );
  }, PRUNE_EVERY_MS);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    clearInterval(statsTimer);
    clearInterval(pruneTimer);
    // Finish the batch in progress (its events are marked), then close. Anything not finished keeps
    // its lease and is taken over after it expires: nothing is lost either way.
    publisher
      .stop()
      .then(() => redis.quit())
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
