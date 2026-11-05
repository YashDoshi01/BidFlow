import { createRunningServer } from './createServer.ts';
import { EnvValidationError, parseEnv } from './config/env.ts';
import { createPool } from './db/pool.ts';
import { postgresCheck, redisCheck } from './health/dependencies.ts';
import { createLogger } from './logging/logger.ts';

function main(): void {
  const env = parseEnv(process.env);
  const logger = createLogger(env.LOG_LEVEL);
  const db = createPool(env.DATABASE_URL);
  const { server, realtime } = createRunningServer({
    db,
    logger,
    sessionTtlSeconds: env.SESSION_TTL_HOURS * 3600,
    checks: [postgresCheck(env.DATABASE_URL), redisCheck(env.REDIS_URL)],
  });

  server.listen(env.API_PORT, () => {
    logger.info('api listening', { port: env.API_PORT });
  });

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // finish, then close the pool.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info('shutting down', { signal });
      // Closing Socket.IO also closes the HTTP server and every WebSocket.
      void realtime.close().then(() => {
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
