import type pg from 'pg';
import type { Db } from '../../db/pool.ts';

type Queryable = Db | pg.PoolClient;

export interface StoredResult {
  requestHash: string;
  status: number;
  body: unknown;
}

/**
 * Retention: 24 hours (product rule 15). Records past that are removed by
 * purgeExpired(); nothing schedules it until the worker phase, so for now
 * expired records stay and still count as the original result.
 */
export const RETENTION_SECONDS = 24 * 3600;

export async function findStored(
  db: Queryable,
  userId: string,
  operation: string,
  key: string,
): Promise<StoredResult | undefined> {
  const { rows } = await db.query<{
    request_hash: string;
    response_status: number;
    response_body: unknown;
  }>(
    `SELECT request_hash, response_status, response_body
       FROM idempotency_records
      WHERE user_id = $1 AND operation = $2 AND idempotency_key = $3`,
    [userId, operation, key],
  );
  const row = rows[0];
  return row
    ? { requestHash: row.request_hash, status: row.response_status, body: row.response_body }
    : undefined;
}

export async function store(
  client: pg.PoolClient,
  r: {
    userId: string;
    operation: string;
    key: string;
    requestHash: string;
    status: number;
    body: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_records
       (user_id, operation, idempotency_key, request_hash, response_status, response_body, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now() + make_interval(secs => $7))`,
    [
      r.userId,
      r.operation,
      r.key,
      r.requestHash,
      r.status,
      JSON.stringify(r.body),
      RETENTION_SECONDS,
    ],
  );
}

export async function purgeExpired(db: Db): Promise<number> {
  const result = await db.query(
    'DELETE FROM idempotency_records WHERE expires_at < clock_timestamp()',
  );
  return result.rowCount ?? 0;
}
