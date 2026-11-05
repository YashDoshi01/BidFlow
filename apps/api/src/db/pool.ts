import pg from 'pg';

export type Db = pg.Pool;

export function createPool(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client can error (server restart). Without a handler the process crashes.
  pool.on('error', () => undefined);
  return pool;
}

/**
 * Runs `fn` inside one transaction on one connection. Commits if it resolves,
 * rolls back if it throws. The connection is always released.
 */
export async function withTransaction<T>(
  pool: Db,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is the one worth reporting.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** SQLSTATE of a PostgreSQL error, or undefined for any other error. */
export function pgCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Name of the violated constraint for 23xxx errors. */
export function pgConstraint(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    const constraint = error.constraint;
    return typeof constraint === 'string' ? constraint : undefined;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';

/**
 * Database wall-clock time. This is the ONLY clock used for boundary decisions
 * (plan section 3.4). It must be read AFTER the row lock is held: now() and
 * CURRENT_TIMESTAMP return the transaction START time, which is stale after a
 * lock wait; clock_timestamp() is the actual current time.
 */
export async function databaseClock(client: pg.Pool | pg.PoolClient): Promise<Date> {
  const { rows } = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  return (rows[0] as { now: Date }).now;
}
