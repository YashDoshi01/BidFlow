// Applies db/migrations/*.sql to DATABASE_URL. Run: npm run db:migrate
import path from 'node:path';
import { EnvValidationError, parseEnv } from '../apps/api/src/config/env.ts';
import { migrate } from '../apps/api/src/db/migrate.ts';

try {
  const env = parseEnv(process.env);
  const result = await migrate(
    env.DATABASE_URL,
    path.resolve(import.meta.dirname, '../db/migrations'),
  );
  console.log(`applied: ${result.applied.join(', ') || '(none)'}`);
  console.log(`already applied: ${String(result.alreadyApplied.length)}`);
} catch (error) {
  if (error instanceof EnvValidationError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    // Print the message chain only (no connection string is included in these errors).
    console.error(error instanceof Error ? error.message : 'migration failed');
    if (error instanceof Error && error.cause instanceof Error) {
      console.error(`cause: ${error.cause.message}`);
    }
    process.exitCode = 1;
  }
}
