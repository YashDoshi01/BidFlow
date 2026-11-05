import { createHash } from 'node:crypto';
import { buildBidAcceptedEvent } from '../../events/events.ts';
import { noopPublisher, type EventPublisher } from '../../events/publisher.ts';
import { AppError } from '../../http/errors.ts';
import type { Logger } from '../../logging/logger.ts';
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
  lockAuction,
  minimumNextBid,
  type AuctionService,
} from '../auctions/index.ts';
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

/** Returned internally for a bid that THIS call just committed (never for a replay). */
interface CommittedResult extends PlaceBidResult {
  accepted?: PlaceBidResponse;
}

/**
 * Test-only seam (ADR-020). Production code passes nothing. It lets a test run
 * code at one exact point of the transaction to prove the fallback path.
 */
export interface BidTestHooks {
  afterIdempotencyRecheck?: () => Promise<void>;
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
  /** Receives `bid.accepted` AFTER the transaction has committed. Default: nobody. */
  publisher?: EventPublisher;
  logger?: Logger;
  hooks?: BidTestHooks;
}

type PlaceArgs = Parameters<BidService['place']>[0];

export function createBidService(
  db: Db,
  auctions: AuctionService,
  options: BidServiceOptions = {},
): BidService {
  const hooks = options.hooks ?? {};
  const publisher = options.publisher ?? noopPublisher;

  /** The whole decision. When it returns, the transaction has committed or rolled back. */
  async function placeCommitted({
    auctionId,
    userId,
    idempotencyKey,
    input,
  }: PlaceArgs): Promise<CommittedResult> {
    const amount = normalizeMoney(input.amount);
    const hash = requestHash(auctionId, amount);

    // 1. Fast path: a retry of a request that already succeeded. An optimisation
    //    only; correctness does not depend on it (ADR-017).
    const early = await idempotency.findStored(db, userId, PLACE_BID_OPERATION, idempotencyKey);
    if (early) return replay(early, hash);

    try {
      return await withTransaction(db, async (client): Promise<CommittedResult> => {
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
        await applyAcceptedBid(client, {
          auctionId,
          bidId: bid.id,
          amount,
          bidSequence: sequence,
        });

        const body: PlaceBidResponse = {
          bid: toBidView(bid),
          auction: {
            currentPrice: amount,
            bidSequence: sequence,
            endsAt: auction.ends_at.toISOString(),
            minimumNextBid: minimumNextBid({
              highest_bid_id: bid.id,
              starting_price: auction.starting_price,
              current_price: amount,
              minimum_increment: auction.minimum_increment,
            }),
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
        return { status: 201, body, replayed: false, accepted: body };
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
    async place(args) {
      const { accepted, ...result } = await placeCommitted(args);
      // The transaction has committed. Only now is the bid announced (plan rule:
      // never broadcast uncommitted changes). A failure to announce must not turn a
      // committed bid into an error response: log it; clients recover through the
      // REST snapshot (ADR-026).
      if (accepted) {
        try {
          await publisher.publish(
            buildBidAcceptedEvent({
              auctionId: accepted.bid.auctionId,
              bidId: accepted.bid.id,
              bidderId: accepted.bid.bidderId,
              bidderDisplayName: accepted.bid.bidderDisplayName,
              amount: accepted.bid.amount,
              currentPrice: accepted.auction.currentPrice,
              bidSequence: accepted.bid.bidSequence,
              acceptedAt: accepted.bid.acceptedAt,
              endsAt: accepted.auction.endsAt,
              minimumNextBid: accepted.auction.minimumNextBid,
            }),
          );
        } catch (error) {
          options.logger?.error('failed to publish bid.accepted', {
            auctionId: accepted.bid.auctionId,
            bidSequence: accepted.bid.bidSequence,
            errorName: error instanceof Error ? error.name : 'non-error',
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result;
    },

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
