import { createHash } from 'node:crypto';
import {
  SCHEMA_VERSION,
  buildAuctionExtendedPayload,
  buildBidAcceptedPayload,
} from '../../events/events.ts';
import { AppError } from '../../http/errors.ts';
import { decodeCursor, encodeCursor } from '../../http/pagination.ts';
import {
  PG_UNIQUE_VIOLATION,
  pgCode,
  pgConstraint,
  withTransaction,
  type Db,
} from '../../db/pool.ts';
import { compareMoney, normalizeMoney } from '../../money.ts';
import {
  applyAcceptedBid,
  extendEnd,
  lockAuction,
  minimumNextBid,
  type AuctionService,
} from '../auctions/index.ts';
import { computeExtension, MAX_EXTENSIONS } from '../../policy/antiSniping.ts';
import { insertNotifications } from '../notifications/index.ts';
import { insertOutboxEvent } from '../outbox/index.ts';
import * as idempotency from './idempotency.ts';
import * as repo from './repository.ts';
import type { BidHistoryQuery, PlaceBidInput } from './schemas.ts';

export const PLACE_BID_OPERATION = 'place_bid';

export interface BidView {
  id: string;
  auctionId: string;
  bidderId: string;
  bidderDisplayName: string;
  amount: string;
  bidSequence: string;
  acceptedAt: string;
}

export interface PlaceBidResponse {
  bid: BidView;
  auction: {
    currentPrice: string;
    bidSequence: string;
    /**
     * The auction's event sequence after this transaction: the position of the LAST event it wrote
     * (the bid.accepted, or the auction.extended that followed it). The state in this response is
     * the state at that position, so a client applies it and ignores live events up to it.
     */
    eventSequence: string;
    endsAt: string;
    minimumNextBid: string | null;
  };
}

export interface PlaceBidResult {
  status: number;
  body: unknown;
  /** True if this is the stored result of an earlier identical request. */
  replayed: boolean;
}

/**
 * Test-only seam (ADR-020). Production code passes nothing. It lets a test run
 * code at one exact point of the transaction to prove the fallback path.
 */
export interface BidTestHooks {
  afterIdempotencyRecheck?: () => Promise<void>;
  /** After the bid, its events and its notifications are written, just before the idempotency record. */
  beforeStore?: () => Promise<void>;
}

function toBidView(r: repo.BidRow): BidView {
  return {
    id: r.id,
    auctionId: r.auction_id,
    bidderId: r.bidder_id,
    bidderDisplayName: r.bidder_display_name,
    amount: r.amount,
    bidSequence: r.bid_sequence,
    acceptedAt: r.accepted_at.toISOString(),
  };
}

/** Identifies "the same request": same auction and the same amount (normalised: "5" == "5.00"). */
export function requestHash(auctionId: string, amount: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ auctionId, amount: normalizeMoney(amount) }))
    .digest('hex');
}

function replay(stored: idempotency.StoredResult, hash: string): PlaceBidResult {
  if (stored.requestHash !== hash) {
    throw new AppError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request',
    );
  }
  return { status: stored.status, body: stored.body, replayed: true };
}

export interface BidService {
  place: (args: {
    auctionId: string;
    userId: string;
    idempotencyKey: string;
    input: PlaceBidInput;
  }) => Promise<PlaceBidResult>;
  history: (
    auctionId: string,
    viewerId: string | undefined,
    query: BidHistoryQuery,
  ) => Promise<{ items: BidView[]; nextCursor: string | null }>;
}

export interface BidServiceOptions {
  hooks?: BidTestHooks;
}

type PlaceArgs = Parameters<BidService['place']>[0];

export function createBidService(
  db: Db,
  auctions: AuctionService,
  options: BidServiceOptions = {},
): BidService {
  const hooks = options.hooks ?? {};

  /** The whole decision. When it returns, the transaction has committed or rolled back. */
  async function place({
    auctionId,
    userId,
    idempotencyKey,
    input,
  }: PlaceArgs): Promise<PlaceBidResult> {
    const amount = normalizeMoney(input.amount);
    const hash = requestHash(auctionId, amount);

    // 1. Fast path: a retry of a request that already succeeded. An optimisation
    //    only; correctness does not depend on it (ADR-017).
    const early = await idempotency.findStored(db, userId, PLACE_BID_OPERATION, idempotencyKey);
    if (early) return replay(early, hash);

    try {
      return await withTransaction(db, async (client): Promise<PlaceBidResult> => {
        // 2. The serialisation point: one transaction at a time per auction.
        const auction = await lockAuction(client, auctionId);
        if (!auction || (auction.status === 'DRAFT' && auction.seller_id !== userId)) {
          throw new AppError(404, 'NOT_FOUND', 'Auction not found');
        }

        // 3. Recheck AFTER the lock. An identical request that was queued behind
        //    the same lock must see the first one's committed result, not judge
        //    the bid again against the new, higher price.
        const again = await idempotency.findStored(
          client,
          userId,
          PLACE_BID_OPERATION,
          idempotencyKey,
        );
        if (again) return replay(again, hash);
        await hooks.afterIdempotencyRecheck?.();

        // 4. One clock reading, after the lock, for every time decision.
        const boundary = await repo.readBoundary(client, auctionId);

        if (auction.status === 'ENDED' || (auction.status === 'LIVE' && !boundary.open)) {
          throw new AppError(409, 'AUCTION_ENDED', 'The auction has ended');
        }
        if (auction.status !== 'LIVE' || !boundary.started) {
          throw new AppError(409, 'AUCTION_NOT_LIVE', 'The auction is not accepting bids');
        }
        if (auction.seller_id === userId) {
          throw new AppError(403, 'BIDDER_IS_SELLER', 'A seller cannot bid on their own auction');
        }

        // 5. Price check against the price read AFTER the lock. Exact decimal math.
        const minimum = minimumNextBid(auction);
        if (minimum === null || compareMoney(amount, minimum) < 0) {
          throw new AppError(
            409,
            'BID_TOO_LOW',
            'The bid is below the minimum acceptable amount',
            undefined,
            {
              currentPrice: auction.current_price,
              ...(minimum === null ? {} : { minimumAcceptableBid: minimum }),
            },
          );
        }

        // 6. Accept: next position, the bid, the new price. Same transaction.
        const sequence = (BigInt(auction.bid_sequence) + 1n).toString();
        const bid = await repo.insertBid(client, {
          auctionId,
          bidderId: userId,
          amount,
          bidSequence: sequence,
          acceptedAt: boundary.ts,
        });
        // The event counter advances with the bid: this is the position of the event we must write.
        const eventSequence = await applyAcceptedBid(client, {
          auctionId,
          bidId: bid.id,
          amount,
          bidSequence: sequence,
        });

        const nextMinimum = minimumNextBid({
          highest_bid_id: bid.id,
          starting_price: auction.starting_price,
          current_price: amount,
          minimum_increment: auction.minimum_increment,
        });

        // 6b. THE OUTBOX: the announcement of this bid is written in the SAME transaction as the
        //     bid. If anything below fails, the bid and the event roll back together; if it
        //     commits, the event is durable and a worker will publish it, even if this process
        //     dies right after COMMIT. (The database also refuses to commit an advanced
        //     auction_event_sequence without this row.)
        await insertOutboxEvent(client, {
          auctionId,
          eventType: 'bid.accepted',
          schemaVersion: SCHEMA_VERSION,
          sequence: eventSequence,
          payload: buildBidAcceptedPayload({
            bidId: bid.id,
            bidderId: userId,
            bidderDisplayName: bid.bidder_display_name,
            amount,
            currentPrice: amount,
            bidSequence: sequence,
            acceptedAt: bid.accepted_at.toISOString(),
            endsAt: auction.ends_at.toISOString(),
            minimumNextBid: nextMinimum,
          }),
          occurredAt: bid.accepted_at.toISOString(),
        });

        // 6c. ANTI-SNIPING (product rule 13), inside the same locked transaction as the bid, with
        //     the same clock reading. A bid in the last 2 minutes moves ends_at to bid time + 2
        //     minutes (capped). This is a second event: it advances the event sequence again and
        //     writes its own outbox row, after the bid.accepted it follows. The auction row is
        //     still locked, so no other bid and no scheduler can see a half-done state.
        const decision = computeExtension({
          nowMs: Number(boundary.ms),
          endsAtMs: auction.ends_at.getTime(),
          originalEndsAtMs: auction.original_ends_at.getTime(),
          extensionCount: auction.extension_count,
        });
        let endsAt = auction.ends_at;
        const extensionsUsed = decision.extend ? decision.extensionCount : auction.extension_count;
        let finalEventSequence = eventSequence;
        if (decision.extend) {
          const extended = await extendEnd(client, {
            auctionId,
            newEndsAt: new Date(decision.newEndsAtMs),
          });
          endsAt = extended.row.ends_at;
          finalEventSequence = extended.eventSequence;
          await insertOutboxEvent(client, {
            auctionId,
            eventType: 'auction.extended',
            schemaVersion: SCHEMA_VERSION,
            sequence: extended.eventSequence,
            payload: buildAuctionExtendedPayload({
              previousEndsAt: auction.ends_at.toISOString(),
              endsAt: endsAt.toISOString(),
              extensionCount: extended.row.extension_count,
              triggeringBidId: bid.id,
            }),
            occurredAt: bid.accepted_at.toISOString(),
          });
        }

        // 6d. OUTBID notification for the bidder who just lost the lead (never for oneself). Same
        //     transaction; the dedupe key makes a repeat harmless.
        if (auction.highest_bid_id !== null) {
          const previous = await repo.findBid(client, auction.highest_bid_id);
          if (previous && previous.bidder_id !== userId) {
            await insertNotifications(client, [
              {
                userId: previous.bidder_id,
                auctionId,
                type: 'outbid',
                dedupeKey: `outbid:${bid.id}`,
                data: {
                  auctionTitle: auction.title,
                  yourAmount: previous.amount,
                  currentPrice: amount,
                  minimumNextBid: nextMinimum,
                  endsAt: endsAt.toISOString(),
                  extensionsLeft: MAX_EXTENSIONS - extensionsUsed,
                },
              },
            ]);
          }
        }
        await hooks.beforeStore?.();

        const body: PlaceBidResponse = {
          bid: toBidView(bid),
          auction: {
            currentPrice: amount,
            bidSequence: sequence,
            eventSequence: finalEventSequence,
            endsAt: endsAt.toISOString(),
            minimumNextBid: nextMinimum,
          },
        };

        // 7. The idempotent result, committed atomically with the bid.
        await idempotency.store(client, {
          userId,
          operation: PLACE_BID_OPERATION,
          key: idempotencyKey,
          requestHash: hash,
          status: 201,
          body,
        });
        return { status: 201, body, replayed: false };
      });
    } catch (error) {
      // Final guard: a concurrent request with the same key won the UNIQUE
      // constraint. The bid transaction has rolled back (no second bid);
      // return the original result instead of an unexplained database error.
      if (
        pgCode(error) === PG_UNIQUE_VIOLATION &&
        pgConstraint(error) === 'idempotency_records_scope_key'
      ) {
        const stored = await idempotency.findStored(
          db,
          userId,
          PLACE_BID_OPERATION,
          idempotencyKey,
        );
        if (stored) return replay(stored, hash);
      }
      throw error;
    }
  }

  return {
    place,

    async history(auctionId, viewerId, query) {
      await auctions.get(auctionId, viewerId); // 404 for a missing auction or someone else's draft
      const rows = await repo.listBids(db, {
        auctionId,
        beforeSequence: query.cursor ? decodeCursor(query.cursor) : undefined,
        limit: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toBidView),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.bid_sequence) : null,
      };
    },
  };
}
