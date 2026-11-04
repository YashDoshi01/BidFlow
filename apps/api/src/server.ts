import { createApp } from './app.ts';
import { EnvValidationError, parseEnv } from './config/env.ts';
import { createPool } from './db/pool.ts';
import { postgresCheck, redisCheck } from './health/dependencies.ts';
import { createLogger } from './logging/logger.ts';

function main(): void {
  const env = parseEnv(process.env);
  const logger = createLogger(env.LOG_LEVEL);
  const db = createPool(env.DATABASE_URL);
  const app = createApp({
    db,
    logger,
    sessionTtlSeconds: env.SESSION_TTL_HOURS * 3600,
    checks: [postgresCheck(env.DATABASE_URL), redisCheck(env.REDIS_URL)],
  });

  const server = app.listen(env.API_PORT, () => {
    logger.info('api listening', { port: env.API_PORT });
  });

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // finish, then close the pool.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info('shutting down', { signal });
      server.close(() => {
        db.end().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
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
  throw error;
}
