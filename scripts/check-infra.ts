// Verifies that the Docker Compose PostgreSQL and Redis are reachable with
// the credentials in .env. Run: npm run check:infra
import { EnvValidationError, parseEnv } from '../apps/api/src/config/env.ts';
import { postgresCheck, redisCheck, runChecks } from '../apps/api/src/health/dependencies.ts';

try {
  const env = parseEnv(process.env);
  const results = await runChecks([postgresCheck(env.DATABASE_URL), redisCheck(env.REDIS_URL)]);
  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.error ? ` (${r.error})` : ''}`);
  }
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (error) {
  if (error instanceof EnvValidationError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
