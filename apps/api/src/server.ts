import { createRunningServer } from './createServer.ts';
import { EnvValidationError, parseEnv } from './config/env.ts';
import { createPool } from './db/pool.ts';
import { postgresPoolCheck, redisStatusCheck } from './health/dependencies.ts';
import { createLogger } from './logging/logger.ts';
import { createRedisPair } from './modules/realtime/index.ts';
import os from 'node:os';

function main(): void {
  const env = parseEnv(process.env);
  const instanceId = env.INSTANCE_ID ?? `${os.hostname()}-${String(process.pid)}`;
  // Every log line carries the instance id, so a request or a socket can be followed to the
  // process that handled it.
  const logger = createLogger(env.LOG_LEVEL, undefined, { instance: instanceId });
  const db = createPool(env.DATABASE_URL);
  const redis = createRedisPair(env.REDIS_URL, logger);
  const { server, realtime } = createRunningServer({
    db,
    logger,
    redis,
    instanceId,
    sessionTtlSeconds: env.SESSION_TTL_HOURS * 3600,
    checks: [postgresPoolCheck(db), redisStatusCheck(() => redis.isUp())],
  });

  server.listen(env.API_PORT, env.API_HOST, () => {
    logger.info('api listening', { host: env.API_HOST, port: env.API_PORT });
  });

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // finish, then close the pool.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info('shutting down', { signal });
      // Closing Socket.IO also closes the HTTP server and every WebSocket.
      void realtime
        .close()
        .then(() => redis.close())
        .then(() => db.end())
        .then(
          () => process.exit(0),
          () => process.exit(1),
        );
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
