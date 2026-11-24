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
  const db = createPool(env.DATABASE_URL, env.DB_POOL_MAX);
  const redis = createRedisPair(env.REDIS_URL, logger);
  const { server, shutdown } = createRunningServer({
    db,
    logger,
    redis,
    instanceId,
    sessionTtlSeconds: env.SESSION_TTL_HOURS * 3600,
    rateLimits: {
      enabled: env.RATE_LIMIT_ENABLED,
      bidUserMax: env.RATE_LIMIT_BID_USER_MAX,
      bidAuctionMax: env.RATE_LIMIT_BID_AUCTION_MAX,
      loginIpMax: env.RATE_LIMIT_LOGIN_IP_MAX,
      loginEmailMax: env.RATE_LIMIT_LOGIN_EMAIL_MAX,
      registerIpMax: env.RATE_LIMIT_REGISTER_IP_MAX,
      readIpMax: env.RATE_LIMIT_READ_IP_MAX,
    },
    trustProxyHops: env.TRUST_PROXY_HOPS,
    allowedOrigins: env.ALLOWED_ORIGINS,
    ...(env.METRICS_TOKEN === undefined ? {} : { metricsToken: env.METRICS_TOKEN }),
    checks: [postgresPoolCheck(db), redisStatusCheck(() => redis.isUp())],
  });

  server.listen(env.API_PORT, env.API_HOST, () => {
    logger.info('api listening', { host: env.API_HOST, port: env.API_PORT });
  });

  // Graceful shutdown: report "draining", stop accepting connections, let in-flight requests
  // finish, close the WebSockets, then Redis and the pool. A hard deadline guarantees the process
  // exits even if something refuses to close.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info('shutting down', { signal });
      const hardStop = setTimeout(
        () => {
          logger.error('shutdown took too long: exiting');
          process.exit(1);
        },
        env.SHUTDOWN_DRAIN_MS + env.SHUTDOWN_GRACE_MS + 5000,
      );
      hardStop.unref();
      void shutdown({ drainMs: env.SHUTDOWN_DRAIN_MS, graceMs: env.SHUTDOWN_GRACE_MS })
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
