import type pg from 'pg';
import { withTransaction, type Db } from '../../db/pool.ts';

export type OutboxStatus = 'pending' | 'processing' | 'published' | 'failed';

/** A row as the publisher sees it right after claiming it. */
export interface ClaimedEvent {
  id: string;
  auction_id: string;
  event_type: string;
  schema_version: number;
  auction_event_sequence: string; // bigint as string
  payload: unknown;
  occurred_at: Date;
  attempt_count: number;
}

/**
 * Writes an event to the outbox. It MUST be called inside the transaction that makes the change
 * the event describes, after that transaction advanced the auction's auction_event_sequence to
 * `sequence`: the database refuses the row otherwise (outbox_guard_insert), and refuses to COMMIT a
 * transaction that advanced the sequence without writing the row.
 */
export async function insertOutboxEvent(
  client: pg.PoolClient,
  e: {
    auctionId: string;
    eventType: string;
    schemaVersion: number;
    sequence: string;
    payload: unknown;
    occurredAt: string;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO outbox_events
       (auction_id, event_type, schema_version, auction_event_sequence, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
     RETURNING id`,
    [
      e.auctionId,
      e.eventType,
      e.schemaVersion,
      e.sequence,
      JSON.stringify(e.payload),
      e.occurredAt,
    ],
  );
  return (rows[0] as { id: string }).id;
}

/**
 * Claims up to `batchSize` events in ONE statement, i.e. one short transaction that commits
 * before anything is published. Why not just `SELECT ... FOR UPDATE SKIP LOCKED` and publish
 * inside that transaction? SKIP LOCKED only protects a row while the transaction that locked it is
 * open; keeping a transaction open during network calls would hold a connection and locks for as
 * long as Redis takes. So the claim is recorded IN the row (status + lease) and committed.
 *
 * Which rows are claimable (all conditions are on the row being locked, so PostgreSQL re-checks
 * them after waiting for a concurrent claimer; a join to a precomputed list would not be):
 *  - ORDER: no earlier (lower auction_event_sequence) event of the same auction is still
 *    unpublished (pending, processing or failed). Hence at most ONE event per auction is
 *    claimable at a time, the lowest one, and a later event can never overtake it. Cost: a stuck
 *    or failed event blocks the later events of that auction (head-of-line blocking), by design.
 *  - READY: pending and due, or processing with an EXPIRED lease (its worker crashed or hung).
 *
 * `owner` must be unique per claim (worker id + a fresh random part): marking a row later is
 * conditional on it, so a worker whose lease expired cannot overwrite the new owner's state.
 */
export async function claimBatch(
  db: Db,
  p: { owner: string; batchSize: number; leaseSeconds: number },
): Promise<ClaimedEvent[]> {
  const { rows } = await db.query<ClaimedEvent>(
    `WITH candidates AS (
       SELECT o.id
         FROM outbox_events o
        WHERE o.status <> 'published'
          AND NOT EXISTS (
                SELECT 1 FROM outbox_events earlier
                 WHERE earlier.auction_id = o.auction_id
                   AND earlier.auction_event_sequence < o.auction_event_sequence
                   AND earlier.status <> 'published')
          AND (   (o.status = 'pending'    AND o.next_attempt_at <= clock_timestamp())
               OR (o.status = 'processing' AND o.lease_until      <  clock_timestamp()))
        ORDER BY o.created_at, o.id
        LIMIT $1
        FOR UPDATE OF o SKIP LOCKED
     )
     UPDATE outbox_events e
        SET status = 'processing',
            lease_owner = $2,
            lease_until = clock_timestamp() + make_interval(secs => $3),
            attempt_count = e.attempt_count + 1
       FROM candidates c
      WHERE e.id = c.id
      RETURNING e.id, e.auction_id, e.event_type, e.schema_version,
                e.auction_event_sequence, e.payload, e.occurred_at, e.attempt_count`,
    [p.batchSize, p.owner, p.leaseSeconds],
  );
  return rows;
}

/**
 * Marks an event published, but only if this claim still owns it. Zero rows means the lease was
 * lost (it expired and someone else took the row): the event may be delivered twice, which clients
 * tolerate.
 */
export async function markPublished(db: Db, id: string, owner: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE outbox_events
        SET status = 'published', published_at = clock_timestamp(),
            lease_owner = NULL, lease_until = NULL, last_error = NULL
      WHERE id = $1 AND status = 'processing' AND lease_owner = $2`,
    [id, owner],
  );
  return result.rowCount === 1;
}

/**
 * A publish attempt failed. Under the attempt limit the row goes back to `pending`, due again after
 * the backoff; at the limit it becomes `failed` (terminal until someone retries it by hand).
 * Conditional on the claim, like markPublished. Returns the new status, or undefined if the lease
 * was lost.
 */
export async function markAttemptFailed(
  db: Db,
  p: { id: string; owner: string; maxAttempts: number; delaySeconds: number; error: string },
): Promise<OutboxStatus | undefined> {
  const { rows } = await db.query<{ status: OutboxStatus }>(
    `UPDATE outbox_events
        SET status = CASE WHEN attempt_count >= $3 THEN 'failed' ELSE 'pending' END,
            lease_owner = NULL, lease_until = NULL,
            last_error = $4,
            next_attempt_at = clock_timestamp() + make_interval(secs => $5)
      WHERE id = $1 AND status = 'processing' AND lease_owner = $2
      RETURNING status`,
    [p.id, p.owner, p.maxAttempts, p.error, p.delaySeconds],
  );
  return rows[0]?.status;
}

export interface OutboxStats {
  pending: number;
  processing: number;
  failed: number;
  /** Age of the oldest event that has not been published, in seconds (0 if none). */
  oldestUnpublishedSeconds: number;
}

export async function outboxStats(db: Db): Promise<OutboxStats> {
  const { rows } = await db.query<{
    pending: string;
    processing: string;
    failed: string;
    oldest: string;
  }>(
    `SELECT count(*) FILTER (WHERE status = 'pending')    AS pending,
            count(*) FILTER (WHERE status = 'processing') AS processing,
            count(*) FILTER (WHERE status = 'failed')     AS failed,
            coalesce(extract(epoch FROM clock_timestamp() - min(created_at)), 0) AS oldest
       FROM outbox_events
      WHERE status <> 'published'`,
  );
  const r = rows[0] as { pending: string; processing: string; failed: string; oldest: string };
  return {
    pending: Number(r.pending),
    processing: Number(r.processing),
    failed: Number(r.failed),
    oldestUnpublishedSeconds: Math.round(Number(r.oldest)),
  };
}

export interface FailedEvent {
  id: string;
  auction_id: string;
  event_type: string;
  auction_event_sequence: string;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
}

export async function listFailed(db: Db, limit = 100): Promise<FailedEvent[]> {
  const { rows } = await db.query<FailedEvent>(
    `SELECT id, auction_id, event_type, auction_event_sequence, attempt_count, last_error, created_at
       FROM outbox_events WHERE status = 'failed'
      ORDER BY created_at, id LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Manual retry of terminally failed events: each goes back to `pending` with its attempts reset,
 * and an audit row records who did it, why, and what failed before. All in one transaction, so
 * an event is never retried without a trace. With `eventId` only that event; without, all failed.
 */
export async function retryFailed(
  db: Db,
  p: { eventId?: string; actor: string; reason: string },
): Promise<FailedEvent[]> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<FailedEvent>(
      `SELECT id, auction_id, event_type, auction_event_sequence, attempt_count, last_error, created_at
         FROM outbox_events
        WHERE status = 'failed' AND ($1::uuid IS NULL OR id = $1::uuid)
        ORDER BY created_at, id
        FOR UPDATE`,
      [p.eventId ?? null],
    );
    for (const e of rows) {
      await client.query(
        `INSERT INTO outbox_retry_audit
           (outbox_event_id, auction_id, auction_event_sequence, actor, reason,
            previous_attempt_count, previous_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          e.id,
          e.auction_id,
          e.auction_event_sequence,
          p.actor,
          p.reason,
          e.attempt_count,
          e.last_error,
        ],
      );
      await client.query(
        `UPDATE outbox_events
            SET status = 'pending', attempt_count = 0, next_attempt_at = clock_timestamp()
          WHERE id = $1 AND status = 'failed'`,
        [e.id],
      );
    }
    return rows;
  });
}

/** Deletes published events older than the retention. Unpublished events are never touched. */
export async function pruneOutbox(db: Db, retentionSeconds: number): Promise<number> {
  const result = await db.query(
    `DELETE FROM outbox_events
      WHERE status = 'published'
        AND published_at < clock_timestamp() - make_interval(secs => $1)`,
    [retentionSeconds],
  );
  return result.rowCount ?? 0;
}
