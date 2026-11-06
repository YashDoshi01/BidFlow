import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/pool.ts';
import type { Logger } from '../../logging/logger.ts';
import { describeError, retryDelaySeconds, toEnvelope } from './envelope.ts';
import { claimBatch, markAttemptFailed, markPublished, type ClaimedEvent } from './repository.ts';
import type { EventSink } from './sink.ts';

export interface OutboxPublisherOptions {
  db: Db;
  sink: EventSink;
  logger: Logger;
  /** Names this worker in logs; every claim also gets a random part, so claims are unique. */
  workerId: string;
  /** How long to sleep when there was nothing to do. A busy worker does not sleep between batches. */
  pollIntervalMs?: number;
  batchSize?: number;
  /** A claimed event not finished by then is considered abandoned and can be taken over. */
  leaseSeconds?: number;
  /** After this many failed attempts an event becomes `failed` and needs a manual retry. */
  maxAttempts?: number;
  /** Test-only fault injection (ADR-042): stop at an exact point as a crash would. */
  faults?: OutboxFaults;
}

export interface OutboxFaults {
  /** Return right after claiming: the rows stay `processing`, as if the worker died. */
  crashAfterClaim?: boolean;
  /** Return right after publishing, before marking: the event was delivered but not recorded. */
  crashAfterPublish?: boolean;
  /** Called with each claimed event just before it is published. */
  beforePublish?: (event: ClaimedEvent) => Promise<void>;
}

export interface BatchResult {
  claimed: number;
  published: number;
  failed: number;
  /** Events whose lease was lost before they could be marked (possible duplicate delivery). */
  leaseLost: number;
}

export interface OutboxPublisher {
  /** One claim-publish-mark cycle. Exposed for tests; `start` calls it in a loop. */
  runOnce: () => Promise<BatchResult>;
  start: () => void;
  /** Stops claiming and waits for the batch in progress to finish. */
  stop: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createOutboxPublisher(options: OutboxPublisherOptions): OutboxPublisher {
  const { db, sink, logger, workerId } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const batchSize = options.batchSize ?? 50;
  const leaseSeconds = options.leaseSeconds ?? 30;
  const maxAttempts = options.maxAttempts ?? 10;
  const faults = options.faults ?? {};

  let stopping = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  async function runOnce(): Promise<BatchResult> {
    // 1. CLAIM: one short transaction (a single statement) that commits before any network call.
    const owner = `${workerId}/${randomUUID()}`;
    const claimed = await claimBatch(db, { owner, batchSize, leaseSeconds });
    const result: BatchResult = { claimed: claimed.length, published: 0, failed: 0, leaseLost: 0 };
    if (claimed.length === 0 || faults.crashAfterClaim) return result;

    // 2. PUBLISH + 3. MARK, outside any database transaction. The claimed events belong to
    //    different auctions (at most one per auction), so they are independent.
    await Promise.all(
      claimed.map(async (row) => {
        try {
          await faults.beforePublish?.(row);
          await sink.publish(toEnvelope(row));
        } catch (error) {
          result.failed += 1;
          const status = await markAttemptFailed(db, {
            id: row.id,
            owner,
            maxAttempts,
            delaySeconds: retryDelaySeconds(row.attempt_count),
            error: describeError(error),
          }).catch(() => undefined);
          const detail = {
            eventId: row.id,
            auctionId: row.auction_id,
            sequence: row.auction_event_sequence,
            attempt: row.attempt_count,
            nextStatus: status ?? 'lease-lost',
            error: describeError(error),
          };
          if (status === 'failed') {
            // Terminal: later events of this auction are blocked until someone retries it.
            logger.error('outbox event FAILED (gave up; manual retry needed)', detail);
          } else {
            logger.warn('outbox event not published (will retry)', detail);
          }
          return;
        }
        if (faults.crashAfterPublish) return;
        let marked: boolean;
        try {
          marked = await markPublished(db, row.id, owner);
        } catch (error) {
          // The event WAS delivered but we could not record it: the lease will expire and the event
          // will be delivered again. Duplicate delivery is part of the contract.
          logger.warn('outbox event delivered but could not be marked', {
            eventId: row.id,
            error: describeError(error),
          });
          return;
        }
        if (marked) {
          result.published += 1;
        } else {
          result.leaseLost += 1;
          logger.warn('outbox lease lost before marking: the event may be delivered twice', {
            eventId: row.id,
            auctionId: row.auction_id,
            sequence: row.auction_event_sequence,
          });
        }
      }),
    );
    return result;
  }

  async function idle(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = undefined;
  }

  async function run(): Promise<void> {
    while (!stopping) {
      let result: BatchResult | undefined;
      try {
        result = await runOnce();
      } catch (error) {
        // The database is unreachable or similar: back off briefly and try again. Nothing is lost,
        // the events are rows.
        logger.error('outbox cycle failed', { error: describeError(error) });
        await sleep(Math.max(pollIntervalMs, 1000));
        continue;
      }
      // Work found: go straight back (a hot auction publishes its next event right after the
      // previous one). Nothing found: sleep.
      if (result.claimed === 0) await idle();
    }
  }

  return {
    runOnce,
    start() {
      if (loop) return;
      stopping = false;
      loop = run();
    },
    async stop() {
      stopping = true;
      wake?.();
      await loop;
      loop = undefined;
    },
  };
}
