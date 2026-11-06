import type pg from 'pg';
import type { Db } from '../../db/pool.ts';

export const NOTIFICATION_TYPES = [
  'outbid',
  'ending_soon',
  'auction_won',
  'auction_lost',
  'auction_ended',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationRow {
  id: string;
  seq: string; // bigint as string
  user_id: string;
  auction_id: string;
  type: NotificationType;
  data: Record<string, unknown>;
  created_at: Date;
  read_at: Date | null;
}

const COLUMNS = 'id, seq, user_id, auction_id, type, data, created_at, read_at';

type Queryable = Db | pg.PoolClient;

export interface NewNotification {
  userId: string;
  auctionId: string;
  type: NotificationType;
  /** The same (user, dedupeKey) is stored once: writing it again is a no-op. */
  dedupeKey: string;
  data: Record<string, unknown>;
}

/**
 * Writes notifications in ONE statement, inside the caller's transaction (the transaction of the
 * change that caused them). Set-based, so ending an auction with thousands of bidders is a single
 * round trip. `ON CONFLICT DO NOTHING` makes a repeated write harmless. The database refuses a
 * notification for a user who neither sells nor bid on a published auction (migration 0005).
 * Returns how many rows were actually inserted.
 */
export async function insertNotifications(
  client: pg.PoolClient,
  rows: NewNotification[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO notifications (user_id, auction_id, type, dedupe_key, data)
     SELECT (r->>'userId')::uuid, (r->>'auctionId')::uuid, r->>'type', r->>'dedupeKey', r->'data'
       FROM jsonb_array_elements($1::jsonb) AS r
     ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
    [JSON.stringify(rows)],
  );
  return rowCount ?? 0;
}

export async function listNotifications(
  db: Queryable,
  f: { userId: string; unreadOnly: boolean; beforeSeq: string | undefined; limit: number },
): Promise<NotificationRow[]> {
  const params: unknown[] = [f.userId];
  const where = ['user_id = $1'];
  if (f.unreadOnly) where.push('read_at IS NULL');
  if (f.beforeSeq !== undefined) {
    params.push(f.beforeSeq);
    where.push(`seq < $${String(params.length)}`);
  }
  params.push(f.limit);
  const { rows } = await db.query<NotificationRow>(
    `SELECT ${COLUMNS} FROM notifications
      WHERE ${where.join(' AND ')}
      ORDER BY seq DESC
      LIMIT $${String(params.length)}`,
    params,
  );
  return rows;
}

export async function countUnread(db: Queryable, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return Number((rows[0] as { n: string }).n);
}

/**
 * Marks ONE of the user's own notifications read. The owner is part of the WHERE clause, so another
 * user's id matches nothing (indistinguishable from a missing one). Idempotent: an already-read
 * notification keeps its first read time. Returns undefined if the user has no such notification.
 */
export async function markRead(
  db: Queryable,
  userId: string,
  id: string,
): Promise<NotificationRow | undefined> {
  const { rows } = await db.query<NotificationRow>(
    `UPDATE notifications SET read_at = COALESCE(read_at, clock_timestamp())
      WHERE id = $1 AND user_id = $2
      RETURNING ${COLUMNS}`,
    [id, userId],
  );
  return rows[0];
}

export async function markAllRead(db: Queryable, userId: string): Promise<number> {
  const { rowCount } = await db.query(
    'UPDATE notifications SET read_at = clock_timestamp() WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return rowCount ?? 0;
}
