import { createApp } from './app.ts';
import { EnvValidationError, parseEnv } from './config/env.ts';
import { postgresCheck, redisCheck } from './health/dependencies.ts';

function main(): void {
  const env = parseEnv(process.env);
  const app = createApp({
    checks: [postgresCheck(env.DATABASE_URL), redisCheck(env.REDIS_URL)],
  });

  const server = app.listen(env.API_PORT, () => {
    console.log(`bidflow api listening on port ${String(env.API_PORT)}`);
  });

  // Graceful shutdown: stop accepting connections, let in-flight requests finish.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.log(`${signal} received, shutting down`);
      server.close(() => {
        process.exit(0);
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
