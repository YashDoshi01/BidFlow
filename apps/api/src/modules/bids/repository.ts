import type pg from 'pg';
import type { Db } from '../../db/pool.ts';

type Queryable = Db | pg.PoolClient;

export interface BidRow {
  id: string;
  auction_id: string;
  bidder_id: string;
  amount: string;
  bid_sequence: string;
  accepted_at: Date;
  /** The bidder's public display name (ADR-024). Never the email. */
  bidder_display_name: string;
}

// Read-only join of ONE column of users (display_name) so a bid can be shown with
// its bidder's public name. The bids module never reads any other user column.
const SELECT_BID = `b.id, b.auction_id, b.bidder_id, b.amount, b.bid_sequence, b.accepted_at,
  u.display_name AS bidder_display_name`;

export interface BoundaryDecision {
  /** The single timestamp for every time decision in this transaction (full microsecond precision, as text). */
  ts: string;
  /** The same instant in whole milliseconds since the epoch (for the anti-sniping arithmetic). */
  ms: string;
  started: boolean;
  open: boolean;
}

/**
 * The bidding-window decision (plan section 3.4, ADR-018).
 *
 * clock_timestamp() is the real current time. now() / CURRENT_TIMESTAMP would
 * return the START of the transaction, which is stale if this transaction waited
 * for the auction lock. It must therefore run AFTER the lock is held.
 *
 * One statement, one clock reading: the comparisons are done in SQL against the
 * same value (JavaScript Dates would truncate microseconds to milliseconds), and
 * the value is returned so the bid row stores exactly the time it was judged at.
 */
export async function readBoundary(
  client: pg.PoolClient,
  auctionId: string,
): Promise<BoundaryDecision> {
  const { rows } = await client.query<BoundaryDecision>(
    `WITH t AS MATERIALIZED (SELECT clock_timestamp() AS ts)
     SELECT t.ts::text AS ts, floor(extract(epoch from t.ts) * 1000)::bigint::text AS ms,
            t.ts >= a.starts_at AS started, t.ts < a.ends_at AS open
       FROM t, auctions a
      WHERE a.id = $1`,
    [auctionId],
  );
  return rows[0] as BoundaryDecision;
}

export async function insertBid(
  client: pg.PoolClient,
  b: {
    auctionId: string;
    bidderId: string;
    amount: string;
    bidSequence: string;
    acceptedAt: string;
  },
): Promise<BidRow> {
  const { rows } = await client.query<BidRow>(
    `WITH b AS (
       INSERT INTO bids (auction_id, bidder_id, amount, bid_sequence, accepted_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)
       RETURNING *
     )
     SELECT ${SELECT_BID} FROM b JOIN users u ON u.id = b.bidder_id`,
    [b.auctionId, b.bidderId, b.amount, b.bidSequence, b.acceptedAt],
  );
  return rows[0] as BidRow;
}

export async function listBids(
  db: Queryable,
  f: { auctionId: string; beforeSequence: string | undefined; limit: number },
): Promise<BidRow[]> {
  const params: unknown[] = [f.auctionId];
  let cursor = '';
  if (f.beforeSequence !== undefined) {
    params.push(f.beforeSequence);
    cursor = 'AND b.bid_sequence < $2';
  }
  params.push(f.limit);
  const { rows } = await db.query<BidRow>(
    `SELECT ${SELECT_BID} FROM bids b JOIN users u ON u.id = b.bidder_id
      WHERE b.auction_id = $1 ${cursor}
      ORDER BY b.bid_sequence DESC
      LIMIT $${String(params.length)}`,
    params,
  );
  return rows;
}

export async function findBid(db: Queryable, id: string): Promise<BidRow | undefined> {
  const { rows } = await db.query<BidRow>(
    `SELECT ${SELECT_BID} FROM bids b JOIN users u ON u.id = b.bidder_id WHERE b.id = $1`,
    [id],
  );
  return rows[0];
}

/** Everyone who placed at least one bid on the auction, once each (used to notify at the end). */
export async function distinctBidderIds(db: Queryable, auctionId: string): Promise<string[]> {
  const { rows } = await db.query<{ bidder_id: string }>(
    'SELECT DISTINCT bidder_id FROM bids WHERE auction_id = $1 ORDER BY bidder_id',
    [auctionId],
  );
  return rows.map((r) => r.bidder_id);
}
