// Operator tool for the outbox (docs/OPERATIONS.md). Reads DATABASE_URL / REDIS_URL from the
// environment (npm scripts load .env with --env-file-if-exists); prints no secrets.
//
//   node scripts/outbox.ts stats
//   node scripts/outbox.ts failed
//   node scripts/outbox.ts retry <eventId | --all> --reason "why this is safe to retry"
//
// `retry` puts failed events back to `pending` with their attempts reset, and writes an audit row
// (who, why, what failed before) in the same transaction.
import os from 'node:os';
import { EnvValidationError, parseEnv } from '../apps/api/src/config/env.ts';
import { createPool } from '../apps/api/src/db/pool.ts';
import { listFailed, outboxStats, retryFailed } from '../apps/api/src/modules/outbox/index.ts';

const [command, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error(
    'usage: node scripts/outbox.ts stats | failed | retry <eventId|--all> --reason "<why>"',
  );
  process.exit(2);
}

try {
  const env = parseEnv(process.env);
  const db = createPool(env.DATABASE_URL, 2);
  try {
    if (command === 'stats') {
      console.log(JSON.stringify(await outboxStats(db), null, 2));
    } else if (command === 'failed') {
      const failed = await listFailed(db);
      console.log(JSON.stringify(failed, null, 2));
      console.log(`${String(failed.length)} failed event(s)`);
    } else if (command === 'retry') {
      const target = rest[0];
      const reasonAt = rest.indexOf('--reason');
      const reason = reasonAt >= 0 ? rest[reasonAt + 1] : undefined;
      if (!target || !reason || reason.trim().length < 3) usage();
      const all = target === '--all';
      const retried = await retryFailed(db, {
        ...(all ? {} : { eventId: target }),
        actor: os.userInfo().username,
        reason,
      });
      console.log(`retried ${String(retried.length)} event(s)`);
      for (const e of retried) {
        console.log(`  ${e.id} auction ${e.auction_id} seq ${e.auction_event_sequence}`);
      }
    } else {
      usage();
    }
  } finally {
    await db.end();
  }
} catch (error) {
  if (error instanceof EnvValidationError) {
    console.error(error.message);
    process.exit(2);
  }
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'failed');
  process.exit(1);
}
