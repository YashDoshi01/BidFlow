import { durableEventSchema, type DurableEvent } from '../../events/events.ts';
import type { ClaimedEvent } from './repository.ts';

/**
 * Rebuilds the envelope from a claimed row. Every field comes from the row, so a re-publication of the
 * same event is byte-for-byte the same message with the same eventId. The result is validated: a row
 * that does not match the contract (a "poison" event) throws, is retried, and eventually fails.
 */
export function toEnvelope(row: ClaimedEvent): DurableEvent {
  return durableEventSchema.parse({
    eventId: row.id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    auctionId: row.auction_id,
    sequence: Number(row.auction_event_sequence),
    occurredAt: row.occurred_at.toISOString(),
    data: row.payload,
  });
}

/**
 * A short, secret-free description of an error for `last_error` and logs: the error name and message
 * with anything that looks like a URL (connection strings) removed, truncated.
 */
export function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${message}`.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').slice(0, 300);
}

/** Exponential backoff for retries: 1 s, 2 s, 4 s ... capped at 60 s. `attempt` is the attempt that just failed (1-based). */
export function retryDelaySeconds(attempt: number): number {
  return Math.min(60, 2 ** Math.max(0, attempt - 1));
}
