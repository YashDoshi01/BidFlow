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
  highest_bid_id: string | null;
}

const COLUMNS = `id, seq, seller_id, title, description, starting_price, current_price,
  minimum_increment, currency, status, starts_at, ends_at, created_at, updated_at,
  bid_sequence, highest_bid_id`;

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
 * reference and the counter. The caller holds the row lock and has inserted the
 * bid; the database trigger verifies that all of this agrees.
 */
export async function applyAcceptedBid(
  client: pg.PoolClient,
  a: { auctionId: string; bidId: string; amount: string; bidSequence: string },
): Promise<void> {
  await client.query(
    `UPDATE auctions
        SET current_price = $2, highest_bid_id = $3, bid_sequence = $4,
            updated_at = clock_timestamp()
      WHERE id = $1`,
    [a.auctionId, a.amount, a.bidId, a.bidSequence],
  );
}

export interface ListFilter {
  /** Visible to everyone: all statuses except DRAFT. */
  publicOnly: boolean;
  sellerId?: string | undefined;
  status?: AuctionStatus | undefined;
  beforeSeq?: string | undefined;
  limit: number;
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
