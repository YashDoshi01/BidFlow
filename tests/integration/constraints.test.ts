// The database must reject invalid data even when the application is bypassed.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createPool, pgCode, pgConstraint, type Db } from '../../apps/api/src/db/pool.ts';
import { resetData, testDatabaseUrl } from './helpers.ts';

describe('database constraints (raw SQL, application bypassed)', () => {
  let db: Db;
  let sellerId: string;

  before(async () => {
    db = createPool(testDatabaseUrl());
    await resetData(db);
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO users (email, password_hash, display_name) VALUES ('c@example.com', 'x', 'C') RETURNING id",
    );
    sellerId = (rows[0] as { id: string }).id;
  });
  after(async () => {
    await db.end();
  });

  async function expectViolation(
    sql: string,
    params: unknown[],
    constraint?: string,
  ): Promise<void> {
    await assert.rejects(db.query(sql, params), (error: unknown) => {
      assert.match(
        pgCode(error) ?? '',
        /^23/,
        `expected an integrity error, got ${String(pgCode(error))}`,
      );
      if (constraint) assert.equal(pgConstraint(error), constraint);
      return true;
    });
  }

  const insertAuction = `INSERT INTO auctions
    (seller_id, title, starting_price, current_price, minimum_increment, currency, status, starts_at, ends_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '1 hour', now() + $8::interval)`;
  const ok = (over: Partial<Record<string, unknown>> = {}): unknown[] => {
    const v = {
      title: 't',
      sp: '10',
      cp: '10',
      inc: '1',
      cur: 'USD',
      status: 'DRAFT',
      dur: '2 hours',
      ...over,
    };
    return [sellerId, v.title, v.sp, v.cp, v.inc, v.cur, v.status, v.dur];
  };

  it('accepts a valid auction (control: the helper itself is not what fails below)', async () => {
    await db.query(insertAuction, ok());
  });

  it('rejects invalid prices, increments, currency, status, title and duration', async () => {
    await expectViolation(
      insertAuction,
      ok({ sp: '0', cp: '0' }),
      'auctions_starting_price_positive',
    );
    await expectViolation(
      insertAuction,
      ok({ sp: '-1', cp: '1' }),
      'auctions_starting_price_positive',
    );
    await expectViolation(insertAuction, ok({ inc: '0' }), 'auctions_increment_positive');
    await expectViolation(insertAuction, ok({ cp: '9' }), 'auctions_current_price_floor');
    await expectViolation(insertAuction, ok({ cur: 'usd' }), 'auctions_currency_format');
    await expectViolation(insertAuction, ok({ status: 'OPEN' }), 'auctions_status_valid');
    await expectViolation(insertAuction, ok({ title: '   ' }), 'auctions_title_length');
    await expectViolation(insertAuction, ok({ dur: '1 hour' }), 'auctions_duration_bounds'); // ends = starts
    await expectViolation(insertAuction, ok({ dur: '32 days' }), 'auctions_duration_bounds');
  });

  it('rejects a missing seller (foreign key) and cannot delete a seller who has auctions', async () => {
    await expectViolation(
      insertAuction,
      ['00000000-0000-4000-8000-000000000000', 't', '10', '10', '1', 'USD', 'DRAFT', '2 hours'],
      'auctions_seller_id_fkey',
    );
    await expectViolation('DELETE FROM users WHERE id = $1', [sellerId], 'auctions_seller_id_fkey');
  });

  it('rejects duplicate or non-normalised emails and expired-at-birth sessions', async () => {
    const ins = "INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'N')";
    await expectViolation(ins, ['c@example.com'], 'users_email_key');
    await expectViolation(ins, ['Upper@example.com'], 'users_email_normalised');
    await expectViolation(ins, ['ab'], 'users_email_length');
    await expectViolation(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, 'h', now() - interval '1 hour')",
      [sellerId],
      'sessions_expiry_after_creation',
    );
  });

  describe('status transition trigger', () => {
    const newAuction = async (status = 'DRAFT'): Promise<string> => {
      const { rows } = await db.query<{ id: string }>(
        `${insertAuction} RETURNING id`,
        ok({ status }),
      );
      return (rows[0] as { id: string }).id;
    };
    const move = (id: string, status: string): Promise<unknown> =>
      db.query('UPDATE auctions SET status = $2 WHERE id = $1', [id, status]);

    it('allows the documented transitions', async () => {
      const a = await newAuction();
      await move(a, 'SCHEDULED');
      await move(a, 'LIVE');
      await move(a, 'ENDED');
    });

    it('rejects skipping states and leaving terminal states', async () => {
      const draft = await newAuction();
      await assert.rejects(move(draft, 'ENDED'), /illegal auction status transition/);
      const ended = await newAuction('DRAFT');
      await move(ended, 'LIVE');
      await move(ended, 'ENDED');
      await assert.rejects(move(ended, 'LIVE'), /illegal auction status transition/);
      await assert.rejects(move(ended, 'CANCELLED'), /illegal auction status transition/);
      const live = await newAuction();
      await move(live, 'LIVE');
      await assert.rejects(move(live, 'DRAFT'), /illegal auction status transition/);
      await assert.rejects(move(live, 'SCHEDULED'), /illegal auction status transition/);
    });

    it('freezes the sale terms after publication but still allows price and end time to move', async () => {
      const id = await newAuction();
      await move(id, 'LIVE');
      for (const set of [
        "title = 'x'",
        "description = 'x'",
        'starting_price = 11, current_price = 11',
        'minimum_increment = 2',
        "currency = 'EUR'",
        "starts_at = starts_at + interval '1 minute'",
        `seller_id = '00000000-0000-4000-8000-000000000000'`,
      ]) {
        await assert.rejects(
          db.query(`UPDATE auctions SET ${set} WHERE id = $1`, [id]),
          /frozen|foreign key/,
          set,
        );
      }
      await db.query(
        "UPDATE auctions SET current_price = 12, ends_at = ends_at + interval '2 minutes' WHERE id = $1",
        [id],
      );
    });
  });
});
