import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { createPool, withTransaction } from '../../apps/api/src/db/pool.ts';
import { testDatabaseUrl } from './helpers.ts';

// Found by the Phase 9 load test: PostgreSQL stopped while requests held a transaction, and both API
// processes EXITED, because the pg Client of a checked-out connection emitted 'error' with no listener
// (the pool's own handler covers idle clients only). Terminating the backend is the same event.
describe('a database connection that dies inside a transaction', () => {
  const admin = new pg.Client({ connectionString: testDatabaseUrl() });
  before(async () => {
    await admin.connect();
  });
  after(async () => {
    await admin.end();
  });

  it('fails that call but not the process, and the pool keeps working', async () => {
    const uncaught: unknown[] = [];
    const record = (e: unknown): void => {
      uncaught.push(e);
    };
    process.on('uncaughtException', record);
    const pool = createPool(testDatabaseUrl(), 2);
    try {
      let pid = 0;
      await assert.rejects(
        withTransaction(pool, async (client) => {
          pid = Number(
            (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
          );
          // another session kills this one's backend while the transaction is open
          await admin.query('SELECT pg_terminate_backend($1)', [pid]);
          await new Promise((r) => setTimeout(r, 300));
          await client.query('SELECT 1');
        }),
      );
      await new Promise((r) => setTimeout(r, 300)); // an unhandled 'error' event would surface here
      assert.deepEqual(uncaught, [], 'the dead connection must not become an uncaught exception');
      const ok = await pool.query<{ one: number }>('SELECT 1 AS one');
      assert.equal(ok.rows[0]?.one, 1, 'the pool hands out a fresh working connection afterwards');
    } finally {
      process.off('uncaughtException', record);
      await pool.end();
    }
  });
});
