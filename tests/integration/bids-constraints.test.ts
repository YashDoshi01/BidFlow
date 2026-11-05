// The database must refuse an invalid bid even when the application is bypassed.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createPool, pgCode, pgConstraint, type Db } from '../../apps/api/src/db/pool.ts';
import { purgeExpiredIdempotencyRecords } from '../../apps/api/src/modules/bids/index.ts';
import { resetData, testDatabaseUrl } from './helpers.ts';

describe('bid constraints (raw SQL, application bypassed)', () => {
  let db: Db;
  let sellerId: string;
  let buyerId: string;

  before(async () => {
    db = createPool(testDatabaseUrl());
    await resetData(db);
    const mk = async (email: string): Promise<string> =>
      (
        await db.query<{ id: string }>(
          "INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'U') RETURNING id",
          [email],
        )
      ).rows[0]?.id as string;
    sellerId = await mk('seller@example.com');
    buyerId = await mk('buyer@example.com');
  });
  after(async () => {
    await db.end();
  });

  /** A LIVE auction: start 10 min ago, end in 2 hours, price 10.00, increment 1.00. */
  async function live(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO auctions (seller_id, title, starting_price, current_price, minimum_increment,
                             status, starts_at, ends_at)
       VALUES ($1, 't', 10, 10, 1, 'LIVE', now() - interval '10 minutes', now() + interval '2 hours')
       RETURNING id`,
      [sellerId],
    );
    return (rows[0] as { id: string }).id;
  }
  const insertBid = (
    auctionId: string,
    over: { bidder?: string; amount?: string; seq?: number; at?: string } = {},
  ): Promise<unknown> =>
    db.query(
      `INSERT INTO bids (auction_id, bidder_id, amount, bid_sequence, accepted_at)
       VALUES ($1, $2, $3, $4, ${over.at ?? 'clock_timestamp()'})`,
      [auctionId, over.bidder ?? buyerId, over.amount ?? '10.00', over.seq ?? 1],
    );

  it('accepts a valid first bid (control)', async () => {
    await insertBid(await live());
  });

  it('rejects: seller as bidder, wrong sequence, below start, below price + increment', async () => {
    const a = await live();
    await assert.rejects(insertBid(a, { bidder: sellerId }), /seller cannot bid/);
    await assert.rejects(insertBid(a, { seq: 2 }), /next number/);
    // (The BEFORE INSERT trigger fires before the CHECK constraints, so these
    // are reported by the trigger; the CHECKs remain as a second layer.)
    await assert.rejects(insertBid(a, { seq: 0 }), /next number/);
    await assert.rejects(insertBid(a, { amount: '9.99' }), /below the starting price/);
    await assert.rejects(insertBid(a, { amount: '0' }), /below the starting price/);
    // after a real first bid, the increment applies (the trigger reads the auction row)
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const b = await client.query<{ id: string }>(
        `INSERT INTO bids (auction_id, bidder_id, amount, bid_sequence, accepted_at)
         VALUES ($1, $2, 10, 1, clock_timestamp()) RETURNING id`,
        [a, buyerId],
      );
      await client.query(
        'UPDATE auctions SET current_price = 10, highest_bid_id = $2, bid_sequence = 1 WHERE id = $1',
        [a, b.rows[0]?.id],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await assert.rejects(insertBid(a, { amount: '10.99', seq: 2 }), /below the minimum acceptable/);
    await insertBid(a, { amount: '11.00', seq: 2 });
  });

  it('rejects bids on auctions that are not LIVE or are outside the window', async () => {
    for (const [status, sql] of [
      ['DRAFT', "now() - interval '10 minutes', now() + interval '2 hours'"],
      ['SCHEDULED', "now() - interval '10 minutes', now() + interval '2 hours'"],
      ['ENDED', "now() - interval '10 minutes', now() + interval '2 hours'"],
    ] as const) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO auctions (seller_id, title, starting_price, current_price, status, starts_at, ends_at)
         VALUES ($1, 't', 10, 10, $2, ${sql}) RETURNING id`,
        [sellerId, status],
      );
      await assert.rejects(insertBid((rows[0] as { id: string }).id), /not LIVE/, status);
    }
    const ended = await db.query<{ id: string }>(
      `INSERT INTO auctions (seller_id, title, starting_price, current_price, status, starts_at, ends_at)
       VALUES ($1, 't', 10, 10, 'LIVE', now() - interval '2 hours', now() - interval '1 hour') RETURNING id`,
      [sellerId],
    );
    await assert.rejects(
      insertBid((ended.rows[0] as { id: string }).id),
      /outside the auction window/,
    );
  });

  it('rejects a back-dated or future-dated accepted_at', async () => {
    const a = await live();
    await assert.rejects(
      insertBid(a, { at: "now() - interval '1 hour'" }),
      /inside the bid transaction/,
    );
    await assert.rejects(
      insertBid(a, { at: "clock_timestamp() + interval '1 hour'" }),
      /inside the bid transaction/,
    );
  });

  it('bids are immutable', async () => {
    const a = await live();
    await insertBid(a);
    await assert.rejects(
      db.query('UPDATE bids SET amount = 99 WHERE auction_id = $1', [a]),
      /immutable/,
    );
    await assert.rejects(db.query('DELETE FROM bids WHERE auction_id = $1', [a]), /immutable/);
  });

  it('the auction row cannot disagree with its bids', async () => {
    const a = await live();
    await insertBid(a);
    const bidId = (await db.query<{ id: string }>('SELECT id FROM bids WHERE auction_id = $1', [a]))
      .rows[0]?.id;
    // wrong price for the bid
    await assert.rejects(
      db.query(
        'UPDATE auctions SET current_price = 12, highest_bid_id = $2, bid_sequence = 1 WHERE id = $1',
        [a, bidId],
      ),
      /must reference the latest bid/,
    );
    // sequence jumps by two
    await assert.rejects(
      db.query(
        'UPDATE auctions SET current_price = 10, highest_bid_id = $2, bid_sequence = 2 WHERE id = $1',
        [a, bidId],
      ),
      /increase by one/,
    );
    // sequence moves without a new highest bid
    await assert.rejects(
      db.query('UPDATE auctions SET bid_sequence = 1 WHERE id = $1', [a]),
      /without a new highest bid/,
    );
    // a bid belonging to another auction
    const other = await live();
    await assert.rejects(
      db.query(
        'UPDATE auctions SET current_price = 10, highest_bid_id = $2, bid_sequence = 1 WHERE id = $1',
        [other, bidId],
      ),
      /must reference the latest bid/,
    );
    // the legitimate update works
    await db.query(
      'UPDATE auctions SET current_price = 10, highest_bid_id = $2, bid_sequence = 1 WHERE id = $1',
      [a, bidId],
    );
  });

  it('two inserts for the same position cannot both commit, even without the row lock', async () => {
    const a = await live();
    const c1 = await db.connect();
    const c2 = await db.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      const sql = `INSERT INTO bids (auction_id, bidder_id, amount, bid_sequence, accepted_at)
                   VALUES ($1, $2, 10, 1, clock_timestamp())`;
      await c1.query(sql, [a, buyerId]);
      const second = c2.query(sql, [a, buyerId]); // waits on the unique index entry of c1
      await new Promise((resolve) => setTimeout(resolve, 200));
      await c1.query('COMMIT');
      await assert.rejects(second, (e: unknown) => {
        assert.equal(pgCode(e), '23505');
        assert.equal(pgConstraint(e), 'bids_auction_sequence_key');
        return true;
      });
    } finally {
      await c2.query('ROLLBACK').catch(() => undefined);
      await c1.query('ROLLBACK').catch(() => undefined);
      c1.release();
      c2.release();
    }
  });

  describe('idempotency_records', () => {
    const insert = (
      key: string,
      over: {
        status?: number;
        hash?: string;
        user?: string;
        created?: string;
        expires?: string;
      } = {},
    ): Promise<unknown> =>
      db.query(
        `INSERT INTO idempotency_records
           (user_id, operation, idempotency_key, request_hash, response_status, response_body, created_at, expires_at)
         VALUES ($1, 'place_bid', $2, $3, $4, '{}'::jsonb, ${over.created ?? 'now()'}, ${over.expires ?? "now() + interval '1 day'"})`,
        [over.user ?? buyerId, key, over.hash ?? 'a'.repeat(64), over.status ?? 201],
      );

    it('enforces the unique scope, success-only results, key and hash format', async () => {
      await insert('key-unique-0001');
      await assert.rejects(
        insert('key-unique-0001'),
        (e: unknown) => pgConstraint(e) === 'idempotency_records_scope_key',
      );
      await insert('key-unique-0001', { user: sellerId }); // another user: allowed
      await assert.rejects(
        insert('key-status-0001', { status: 409 }),
        (e: unknown) => pgConstraint(e) === 'idempotency_success_only',
      );
      await assert.rejects(
        insert('key-status-0002', { status: 500 }),
        (e: unknown) => pgConstraint(e) === 'idempotency_success_only',
      );
      await assert.rejects(
        insert('bad key'),
        (e: unknown) => pgConstraint(e) === 'idempotency_key_format',
      );
      await assert.rejects(
        insert('key-hash-0001', { hash: 'xyz' }),
        (e: unknown) => pgConstraint(e) === 'idempotency_hash_format',
      );
    });

    it('purgeExpired removes only expired records', async () => {
      await insert('key-old-000001', {
        created: "now() - interval '3 days'",
        expires: "now() - interval '2 days'",
      });
      await insert('key-new-000001');
      const removed = await purgeExpiredIdempotencyRecords(db);
      assert.equal(removed, 1);
      const { rows } = await db.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM idempotency_records WHERE idempotency_key LIKE 'key-%-000001'",
      );
      assert.deepEqual(
        rows.map((r) => r.idempotency_key),
        ['key-new-000001'],
      );
    });
  });
});
