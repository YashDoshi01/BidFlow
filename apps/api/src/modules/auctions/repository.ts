import type pg from 'pg';
import type { Db } from '../../db/pool.ts';
import type { AuctionStatus } from './stateMachine.ts';

export interface AuctionRow {
  id: string;
  seq: string; // bigint arrives as a string; never converted to a JS number
  seller_id: string;
  title: string;
  description: string;
  starting_price: string; // NUMERIC arrives as a string: exact
  current_price: string;
  minimum_increment: string;
  currency: string;
  status: AuctionStatus;
  starts_at: Date;
  ends_at: Date;
  created_at: Date;
  updated_at: Date;
  bid_sequence: string; // bigint as string
  auction_event_sequence: string; // bigint as string
  highest_bid_id: string | null;
  original_ends_at: Date;
  extension_count: number;
  ended_at: Date | null;
  winning_bid_id: string | null;
  ending_soon_notified_at: Date | null;
}

const COLUMNS = `id, seq, seller_id, title, description, starting_price, current_price,
  minimum_increment, currency, status, starts_at, ends_at, created_at, updated_at,
  bid_sequence, auction_event_sequence, highest_bid_id, original_ends_at, extension_count,
  ended_at, winning_bid_id, ending_soon_notified_at`;

type Queryable = Db | pg.PoolClient;

export async function insertAuction(
  db: Queryable,
  a: {
    sellerId: string;
    title: string;
    description: string;
    startingPrice: string;
    minimumIncrement: string;
    currency: string;
    startsAt: Date;
    endsAt: Date;
  },
): Promise<AuctionRow> {
  const { rows } = await db.query<AuctionRow>(
    `INSERT INTO auctions
       (seller_id, title, description, starting_price, current_price,
        minimum_increment, currency, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [
      a.sellerId,
      a.title,
      a.description,
      a.startingPrice,
      a.minimumIncrement,
      a.currency,
      a.startsAt,
      a.endsAt,
    ],
  );
  return rows[0] as AuctionRow;
}

export async function findAuction(db: Queryable, id: string): Promise<AuctionRow | undefined> {
  const { rows } = await db.query<AuctionRow>(`SELECT ${COLUMNS} FROM auctions WHERE id = $1`, [
    id,
  ]);
  return rows[0];
}

/** Locks the row until the surrounding transaction ends. */
export async function lockAuction(
  client: pg.PoolClient,
  id: string,
): Promise<AuctionRow | undefined> {
  const { rows } = await client.query<AuctionRow>(
    `SELECT ${COLUMNS} FROM auctions WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0];
}

export async function updateDraftFields(
  client: pg.PoolClient,
  id: string,
  f: {
    title: string;
    description: string;
    startingPrice: string;
    minimumIncrement: string;
    currency: string;
    startsAt: Date;
    endsAt: Date;
  },
): Promise<AuctionRow> {
  // While DRAFT there are no bids, so current_price simply follows starting_price.
  const { rows } = await client.query<AuctionRow>(
    `UPDATE auctions
        SET title = $2, description = $3, starting_price = $4, current_price = $4,
            minimum_increment = $5, currency = $6, starts_at = $7, ends_at = $8,
            updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'DRAFT'
      RETURNING ${COLUMNS}`,
    [
      id,
      f.title,
      f.description,
      f.startingPrice,
      f.minimumIncrement,
      f.currency,
      f.startsAt,
      f.endsAt,
    ],
  );
  const row = rows[0];
  if (!row) {
    // Unreachable while the caller holds the row lock and checked the status;
    // fail loudly rather than return undefined disguised as a row.
    throw new Error('updateDraftFields matched no DRAFT row');
  }
  return row;
}

export async function setStatus(
  client: pg.PoolClient,
  id: string,
  status: AuctionStatus,
): Promise<AuctionRow> {
  const { rows } = await client.query<AuctionRow>(
    `UPDATE auctions SET status = $2, updated_at = clock_timestamp()
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, status],
  );
  return rows[0] as AuctionRow;
}

/**
 * Records an accepted bid on the auction: the new price, the highest-bid
 * reference, the bid counter, and the event counter (an accepted bid is an event).
 * The caller holds the row lock and has inserted the bid; the database trigger
 * verifies that all of this agrees. Returns the new auction_event_sequence: the
 * position of the event the caller MUST now write to the outbox, in the same
 * transaction (the database refuses to commit otherwise).
 */
export async function applyAcceptedBid(
  client: pg.PoolClient,
  a: { auctionId: string; bidId: string; amount: string; bidSequence: string },
): Promise<string> {
  const { rows } = await client.query<{ auction_event_sequence: string }>(
    `UPDATE auctions
        SET current_price = $2, highest_bid_id = $3, bid_sequence = $4,
            auction_event_sequence = auction_event_sequence + 1,
            updated_at = clock_timestamp()
      WHERE id = $1
      RETURNING auction_event_sequence`,
    [a.auctionId, a.amount, a.bidId, a.bidSequence],
  );
  return (rows[0] as { auction_event_sequence: string }).auction_event_sequence;
}

/** What a lifecycle step that changes the state AND must write an event needs back. */
export interface TransitionResult {
  row: AuctionRow;
  /** The new auction_event_sequence: the position of the event the caller MUST now write to the outbox. */
  eventSequence: string;
  /** The database clock at the moment of the change (full precision, as text). */
  at: string;
}

/**
 * Anti-sniping (product rule 13): moves ends_at forward. Called by the bid transaction, after the
 * bid.accepted event was written, with the lock held. Advances the event counter, so the caller MUST
 * write the auction.extended event next. The database refuses anything but a counted, forward,
 * capped move of a LIVE auction (migration 0005).
 */
export async function extendEnd(
  client: pg.PoolClient,
  a: { auctionId: string; newEndsAt: Date },
): Promise<TransitionResult> {
  const { rows } = await client.query<AuctionRow & { event_ts: string }>(
    `UPDATE auctions
        SET ends_at = $2, extension_count = extension_count + 1,
            auction_event_sequence = auction_event_sequence + 1,
            updated_at = clock_timestamp()
      WHERE id = $1
      RETURNING ${COLUMNS}, clock_timestamp()::text AS event_ts`,
    [a.auctionId, a.newEndsAt],
  );
  const row = rows[0] as AuctionRow & { event_ts: string };
  return { row, eventSequence: row.auction_event_sequence, at: row.event_ts };
}

export type DueKind = 'start' | 'end' | 'ending_soon';

/**
 * Finds ONE auction whose time has come and locks it, in the caller's (short) transaction:
 *   start        SCHEDULED and starts_at has passed
 *   end          LIVE and ends_at has passed (ends_at <= clock; the exact complement of a bid's clock < ends_at)
 *   ending_soon  LIVE, not yet announced, and ends_at is within `soonSeconds`
 * `FOR UPDATE SKIP LOCKED`: an auction another transaction holds (a bid being decided, another
 * scheduler) is skipped, not waited for; it is picked up on a later tick. All conditions are on the
 * locked table, so PostgreSQL re-evaluates them against the latest committed version once the lock
 * is taken: an auction that a bid just extended no longer matches 'end'. `exclude` holds auctions
 * that already failed in this tick, so one broken auction cannot starve the others.
 */
export async function lockNextDue(
  client: pg.PoolClient,
  kind: DueKind,
  p: { soonSeconds: number; exclude: string[] },
): Promise<AuctionRow | undefined> {
  const condition: Record<DueKind, string> = {
    start: `status = 'SCHEDULED' AND starts_at <= clock_timestamp()`,
    end: `status = 'LIVE' AND ends_at <= clock_timestamp()`,
    ending_soon: `status = 'LIVE' AND ending_soon_notified_at IS NULL
                  AND ends_at > clock_timestamp()
                  AND ends_at <= clock_timestamp() + make_interval(secs => $2)`,
  };
  const order = kind === 'start' ? 'starts_at, seq' : 'ends_at, seq';
  const params: unknown[] = [p.exclude];
  if (kind === 'ending_soon') params.push(p.soonSeconds);
  const { rows } = await client.query<AuctionRow>(
    `SELECT ${COLUMNS} FROM auctions
      WHERE ${condition[kind]} AND id <> ALL($1::uuid[])
      ORDER BY ${order}
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
    params,
  );
  return rows[0];
}

/**
 * SCHEDULED -> LIVE. Conditional: it changes nothing (returns undefined) unless the auction is still
 * SCHEDULED and its start time has passed, so a repeat, or a worker that lost a race, does nothing.
 */
export async function activate(
  client: pg.PoolClient,
  id: string,
): Promise<TransitionResult | undefined> {
  const { rows } = await client.query<AuctionRow & { event_ts: string }>(
    `UPDATE auctions
        SET status = 'LIVE', auction_event_sequence = auction_event_sequence + 1,
            updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'SCHEDULED' AND starts_at <= clock_timestamp()
      RETURNING ${COLUMNS}, clock_timestamp()::text AS event_ts`,
    [id],
  );
  const row = rows[0];
  return row && { row, eventSequence: row.auction_event_sequence, at: row.event_ts };
}

/**
 * LIVE -> ENDED, recording the winner (the highest accepted bid) and the time. Conditional on the
 * auction still being LIVE and ends_at <= the database clock read now, with the lock held: the same
 * clock source and the exact complement of the bid rule, so a bid and the end can never both win.
 */
export async function finish(
  client: pg.PoolClient,
  id: string,
): Promise<TransitionResult | undefined> {
  const { rows } = await client.query<AuctionRow & { event_ts: string }>(
    `UPDATE auctions
        SET status = 'ENDED', ended_at = clock_timestamp(), winning_bid_id = highest_bid_id,
            auction_event_sequence = auction_event_sequence + 1,
            updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'LIVE' AND ends_at <= clock_timestamp()
      RETURNING ${COLUMNS}, ended_at::text AS event_ts`,
    [id],
  );
  const row = rows[0];
  return row && { row, eventSequence: row.auction_event_sequence, at: row.event_ts };
}

/** Records that the "ending soon" notifications were written. Conditional: once only, and only while LIVE and not over. */
export async function markEndingSoonNotified(
  client: pg.PoolClient,
  id: string,
): Promise<AuctionRow | undefined> {
  const { rows } = await client.query<AuctionRow>(
    `UPDATE auctions SET ending_soon_notified_at = clock_timestamp()
      WHERE id = $1 AND status = 'LIVE' AND ending_soon_notified_at IS NULL
        AND ends_at > clock_timestamp()
      RETURNING ${COLUMNS}`,
    [id],
  );
  return rows[0];
}

export interface ListFilter {
  /** Visible to everyone: all statuses except DRAFT. */
  publicOnly: boolean;
  sellerId?: string | undefined;
  status?: AuctionStatus | undefined;
  beforeSeq?: string | undefined;
  /** Case-insensitive "title contains" text. Taken literally: % _ and \ are escaped. */
  titleContains?: string | undefined;
  limit: number;
}

/** Escapes LIKE wildcards so user text is matched literally (a typed `%` must not match everything). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listAuctions(db: Db, f: ListFilter): Promise<AuctionRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    where.push(sql.replace('?', `$${String(params.length)}`));
  };
  if (f.publicOnly) where.push("status <> 'DRAFT'");
  if (f.sellerId) add('seller_id = ?', f.sellerId);
  if (f.status) add('status = ?', f.status);
  if (f.beforeSeq) add('seq < ?', f.beforeSeq);
  // A value parameter, never concatenated into the SQL. ESCAPE makes `\` the escape character.
  if (f.titleContains) add("title ILIKE ? ESCAPE '\\'", `%${escapeLike(f.titleContains)}%`);
  params.push(f.limit);
  const { rows } = await db.query<AuctionRow>(
    `SELECT ${COLUMNS} FROM auctions
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY seq DESC
      LIMIT $${String(params.length)}`,
    params,
  );
  return rows;
}
