import type pg from 'pg';
import {
  SCHEMA_VERSION,
  buildAuctionEndedPayload,
  buildAuctionStartedPayload,
} from '../../events/events.ts';
import { withTransaction, type Db } from '../../db/pool.ts';
import type { Logger } from '../../logging/logger.ts';
import {
  activate,
  finish,
  lockNextDue,
  markEndingSoonNotified,
  type AuctionRow,
  type DueKind,
} from '../auctions/index.ts';
import { distinctBidderIds, findBid } from '../bids/index.ts';
import { insertNotifications, type NewNotification } from '../notifications/index.ts';
import { describeError, insertOutboxEvent } from '../outbox/index.ts';

export interface LifecycleOptions {
  db: Db;
  logger: Logger;
  workerId: string;
  /** Sleep when a pass found nothing to do. */
  pollIntervalMs?: number;
  /** Most auctions handled per kind per pass (the rest wait for the next pass). */
  batchSize?: number;
  /** "Ending soon" notifications are written when ends_at is this close. */
  endingSoonSeconds?: number;
  /** Test-only seam (ADR-052): runs while a candidate auction is locked, before it is changed. */
  faults?: LifecycleFaults;
}

export interface LifecycleFaults {
  afterLock?: (kind: DueKind, auctionId: string) => Promise<void>;
}

export interface PassResult {
  started: number;
  ended: number;
  endingSoon: number;
  /** Auctions whose transaction failed in this pass (they are retried in the next one). */
  errors: number;
}

export interface LifecycleWorker {
  /** One pass over all three kinds of due work. Exposed for tests; `start` calls it in a loop. */
  runOnce: () => Promise<PassResult>;
  start: () => void;
  stop: () => Promise<void>;
}

type StepOutcome = 'done' | 'none' | 'noop' | 'error';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The durable scheduler (ADR-049). Nothing is held in memory between passes: "what is due" is a
 * query over auctions.starts_at / ends_at, so a restart, a crash or a second copy of this worker
 * changes nothing. Each auction is handled in its OWN short transaction:
 *
 *   lock one due auction (FOR UPDATE SKIP LOCKED)   <- another worker or a bid holding it: skipped
 *   conditional UPDATE (status AND time re-checked against the clock read after the lock)
 *   write the outbox event and the notifications    <- same transaction
 *
 * A repeat of any step finds the condition false and does nothing (idempotent).
 */
export function createLifecycleWorker(options: LifecycleOptions): LifecycleWorker {
  const { db, logger, workerId } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const batchSize = options.batchSize ?? 50;
  const endingSoonSeconds = options.endingSoonSeconds ?? 300;
  const faults = options.faults ?? {};

  let stopping = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  /** SCHEDULED -> LIVE, with its auction.started event. */
  async function startOne(row: AuctionRow, client: pg.PoolClient) {
    const moved = await activate(client, row.id);
    if (!moved) return false;
    await insertOutboxEvent(client, {
      auctionId: row.id,
      eventType: 'auction.started',
      schemaVersion: SCHEMA_VERSION,
      sequence: moved.eventSequence,
      payload: buildAuctionStartedPayload({
        startedAt: new Date(moved.at).toISOString(),
        startsAt: moved.row.starts_at.toISOString(),
        endsAt: moved.row.ends_at.toISOString(),
      }),
      occurredAt: new Date(moved.at).toISOString(),
    });
    return true;
  }

  /** LIVE -> ENDED: winner, auction.ended event, notifications; all or nothing. */
  async function endOne(row: AuctionRow, client: pg.PoolClient) {
    const moved = await finish(client, row.id);
    if (!moved) return false;
    const ended = moved.row;
    const winningBid = ended.winning_bid_id
      ? await findBid(client, ended.winning_bid_id)
      : undefined;
    const endedAt = ended.ended_at
      ? ended.ended_at.toISOString()
      : new Date(moved.at).toISOString();
    await insertOutboxEvent(client, {
      auctionId: row.id,
      eventType: 'auction.ended',
      schemaVersion: SCHEMA_VERSION,
      sequence: moved.eventSequence,
      payload: buildAuctionEndedPayload({
        endedAt,
        endsAt: ended.ends_at.toISOString(),
        winningBidId: winningBid?.id ?? null,
        winnerId: winningBid?.bidder_id ?? null,
        winnerDisplayName: winningBid?.bidder_display_name ?? null,
        finalPrice: ended.current_price,
        bidCount: Number(ended.bid_sequence),
      }),
      occurredAt: endedAt,
    });

    // Notifications, in the same transaction: the winner, every other bidder, and the seller.
    const base = {
      auctionTitle: ended.title,
      finalPrice: ended.current_price,
      currency: ended.currency,
    };
    const notes: NewNotification[] = [];
    for (const bidderId of await distinctBidderIds(client, row.id)) {
      const won = bidderId === winningBid?.bidder_id;
      notes.push({
        userId: bidderId,
        auctionId: row.id,
        type: won ? 'auction_won' : 'auction_lost',
        dedupeKey: `${won ? 'won' : 'lost'}:${row.id}`,
        data: { ...base, endedAt },
      });
    }
    notes.push({
      userId: ended.seller_id,
      auctionId: row.id,
      type: 'auction_ended',
      dedupeKey: `ended:${row.id}`,
      data: {
        ...base,
        endedAt,
        sold: winningBid !== undefined,
        winnerDisplayName: winningBid?.bidder_display_name ?? null,
        bidCount: Number(ended.bid_sequence),
      },
    });
    await insertNotifications(client, notes);
    return true;
  }

  /** "Ending soon" for everyone who bid; once per auction (the column and the dedupe key). */
  async function endingSoonOne(row: AuctionRow, client: pg.PoolClient) {
    const marked = await markEndingSoonNotified(client, row.id);
    if (!marked) return false;
    const bidders = await distinctBidderIds(client, row.id);
    await insertNotifications(
      client,
      bidders.map((userId) => ({
        userId,
        auctionId: row.id,
        type: 'ending_soon' as const,
        dedupeKey: `ending_soon:${row.id}`,
        data: {
          auctionTitle: marked.title,
          endsAt: marked.ends_at.toISOString(),
          currentPrice: marked.current_price,
        },
      })),
    );
    return true;
  }

  async function step(kind: DueKind, exclude: string[], failed: Set<string>): Promise<StepOutcome> {
    let candidate: string | undefined;
    try {
      return await withTransaction(db, async (client): Promise<StepOutcome> => {
        const row = await lockNextDue(client, kind, { soonSeconds: endingSoonSeconds, exclude });
        if (!row) return 'none';
        candidate = row.id;
        await faults.afterLock?.(kind, row.id);
        const changed =
          kind === 'start'
            ? await startOne(row, client)
            : kind === 'end'
              ? await endOne(row, client)
              : await endingSoonOne(row, client);
        return changed ? 'done' : 'noop';
      });
    } catch (error) {
      // This auction's transaction rolled back as a whole. Remember it so the rest of this pass
      // moves on; the next pass tries it again.
      if (candidate) failed.add(candidate);
      logger.error('lifecycle step failed', {
        kind,
        auctionId: candidate,
        error: describeError(error),
      });
      return 'error';
    }
  }

  async function runOnce(): Promise<PassResult> {
    const result: PassResult = { started: 0, ended: 0, endingSoon: 0, errors: 0 };
    const failed = new Set<string>();
    // Order matters a little: an auction that is both due to start and (after a long outage) due to
    // end is started first, then ended in the same pass, each as its own event.
    for (const [kind, key] of [
      ['start', 'started'],
      ['end', 'ended'],
      ['ending_soon', 'endingSoon'],
    ] as const) {
      for (let i = 0; i < batchSize && !stopping; i += 1) {
        const outcome = await step(kind, [...failed], failed);
        if (outcome === 'error') continue; // that auction is now excluded: carry on with the others
        if (outcome !== 'done') break;
        result[key] += 1;
        logger.info('auction lifecycle step', { kind, workerId });
      }
    }
    result.errors = failed.size;
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
      let result: PassResult | undefined;
      try {
        result = await runOnce();
      } catch (error) {
        logger.error('lifecycle pass failed', { error: describeError(error) });
        await sleep(Math.max(pollIntervalMs, 1000));
        continue;
      }
      if (result.started + result.ended + result.endingSoon === 0) await idle();
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
