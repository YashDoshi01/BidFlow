import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createAuctionService } from '../../apps/api/src/modules/auctions/index.ts';
import { createBidService } from '../../apps/api/src/modules/bids/index.ts';
import { requestHash } from '../../apps/api/src/modules/bids/service.ts';
import { toMinorUnits } from '../../apps/api/src/money.ts';
import {
  auctionBody,
  liveAuction,
  makeClient,
  newKey,
  newUser,
  placeBid,
  resetData,
  sleep,
  startApp,
  type Api,
  type ApiResponse,
  type TestApp,
} from './helpers.ts';

interface User {
  token: string;
  id: string;
}

describe('bid engine (real PostgreSQL)', () => {
  let app: TestApp;
  let api: Api;
  let seller: User;
  let buyers: User[];

  before(async () => {
    app = await startApp();
    api = makeClient(app.base);
    await resetData(app.db);
    seller = await newUser(api, 'seller');
    buyers = [];
    for (let i = 0; i < 12; i += 1) buyers.push(await newUser(api, `buyer${String(i)}`));
  });
  after(async () => {
    await app.close();
  });

  const buyer = (i = 0): User => buyers[i] as User;

  async function counts(auctionId: string): Promise<{ bids: number; records: number }> {
    const b = await app.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM bids WHERE auction_id = $1',
      [auctionId],
    );
    const r = await app.db.query<{ n: string }>('SELECT count(*) AS n FROM idempotency_records');
    return { bids: Number(b.rows[0]?.n), records: Number(r.rows[0]?.n) };
  }

  /** Every invariant the plan requires of an auction's accepted bids. */
  async function assertInvariants(auctionId: string, expectedBids?: number): Promise<number> {
    const { rows: bids } = await app.db.query<{ id: string; amount: string; bid_sequence: string }>(
      'SELECT id, amount, bid_sequence FROM bids WHERE auction_id = $1 ORDER BY bid_sequence',
      [auctionId],
    );
    const { rows } = await app.db.query<{
      current_price: string;
      starting_price: string;
      minimum_increment: string;
      highest_bid_id: string | null;
      bid_sequence: string;
    }>('SELECT * FROM auctions WHERE id = $1', [auctionId]);
    const a = rows[0];
    assert.ok(a);
    // contiguous 1..n (a deterministic order, no gaps, no duplicates)
    bids.forEach((b, i) => {
      assert.equal(b.bid_sequence, String(i + 1));
    });
    // each accepted bid beat the previous price by at least the increment
    const inc = toMinorUnits(a.minimum_increment);
    bids.forEach((b, i) => {
      const prev = bids[i - 1];
      if (prev) {
        assert.ok(
          toMinorUnits(b.amount) >= toMinorUnits(prev.amount) + inc,
          `bid ${b.bid_sequence} (${b.amount}) did not beat ${prev.amount} + increment`,
        );
      } else {
        assert.ok(toMinorUnits(b.amount) >= toMinorUnits(a.starting_price));
      }
    });
    // the auction row agrees with its bids
    assert.equal(a.bid_sequence, String(bids.length));
    const last = bids[bids.length - 1];
    if (last) {
      assert.equal(a.highest_bid_id, last.id);
      assert.equal(a.current_price, last.amount);
    } else {
      assert.equal(a.highest_bid_id, null);
      assert.equal(a.current_price, a.starting_price);
    }
    if (expectedBids !== undefined) assert.equal(bids.length, expectedBids);
    return bids.length;
  }

  describe('accepting and rejecting', () => {
    it('accepts the first bid at the starting price and returns the authoritative state', async () => {
      const id = await liveAuction(api, seller.token);
      const res = await placeBid(api, buyer().token, id, '10.00');
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.bid.amount, '10.00');
      assert.equal(res.body.bid.bidSequence, '1');
      assert.equal(res.body.bid.bidderId, buyer().id);
      assert.equal(res.body.bid.bidderDisplayName, 'buyer0'); // public name, set at registration
      assert.equal(res.body.auction.currentPrice, '10.00');
      assert.equal(res.body.auction.minimumNextBid, '11.00');
      const view = await api('GET', `/auctions/${id}`);
      assert.equal(view.body.auction.currentPrice, '10.00');
      assert.equal(view.body.auction.bidSequence, '1');
      assert.equal(view.body.auction.highestBidId, res.body.bid.id);
      assert.equal(view.body.auction.minimumNextBid, '11.00');
      await assertInvariants(id, 1);
    });

    it('rejects below the start, below price + increment, and equal bids, telling the client the minimum', async () => {
      const id = await liveAuction(api, seller.token);
      const low = await placeBid(api, buyer().token, id, '9.99');
      assert.equal(low.status, 409);
      assert.equal(low.body.error.code, 'BID_TOO_LOW');
      assert.equal(low.body.error.data.minimumAcceptableBid, '10.00');
      await placeBid(api, buyer().token, id, '10.00');
      for (const amount of ['10.00', '10.99']) {
        const r = await placeBid(api, buyer(1).token, id, amount);
        assert.equal(r.status, 409, amount);
        assert.equal(r.body.error.data.minimumAcceptableBid, '11.00');
      }
      assert.equal((await placeBid(api, buyer(1).token, id, '11.00')).status, 201);
      await assertInvariants(id, 2);
    });

    it('does exact decimal arithmetic (0.10 + 0.20 is 0.30)', async () => {
      const id = await liveAuction(api, seller.token, {
        startingPrice: '0.10',
        minimumIncrement: '0.20',
      });
      assert.equal((await placeBid(api, buyer().token, id, '0.10')).status, 201);
      assert.equal((await placeBid(api, buyer(1).token, id, '0.29')).status, 409);
      assert.equal((await placeBid(api, buyer(1).token, id, '0.30')).status, 201);
      await assertInvariants(id, 2);
    });

    it('a seller cannot bid on their own auction', async () => {
      const id = await liveAuction(api, seller.token);
      const res = await placeBid(api, seller.token, id, '50.00');
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'BIDDER_IS_SELLER');
      assert.deepEqual(await counts(id), { bids: 0, records: (await counts(id)).records });
    });

    it('validates input: auth, amount shape, unknown fields, the idempotency header', async () => {
      const id = await liveAuction(api, seller.token);
      assert.equal((await placeBid(api, undefined, id, '10.00')).status, 401);
      for (const amount of [15, '0', '0.00', '-1', '1.234', 'abc', null, '1e3']) {
        const r = await placeBid(api, buyer().token, id, amount);
        assert.equal(r.status, 400, JSON.stringify(amount));
      }
      const extra = await api('POST', `/auctions/${id}/bids`, {
        token: buyer().token,
        body: { amount: '10.00', bidderId: seller.id },
        headers: { 'Idempotency-Key': newKey() },
      });
      assert.equal(extra.status, 400);
      const noKey = await placeBid(api, buyer().token, id, '10.00', null);
      assert.equal(noKey.status, 400);
      assert.equal(noKey.body.error.details[0].path, 'Idempotency-Key');
      for (const key of ['short', 'has spaces in it', 'x'.repeat(129)]) {
        assert.equal((await placeBid(api, buyer().token, id, '10.00', key)).status, 400, key);
      }
      assert.equal((await placeBid(api, buyer().token, 'not-a-uuid', '10.00')).status, 400);
      assert.equal((await counts(id)).bids, 0);
    });

    it('reports closed, not-yet-live, draft and unknown auctions', async () => {
      const scheduled = await api('POST', '/auctions', {
        token: seller.token,
        body: auctionBody(),
      });
      const sid = scheduled.body.auction.id as string;
      const draftBid = await placeBid(api, buyer().token, sid, '10.00');
      assert.equal(draftBid.status, 404); // someone else's draft is invisible
      await api('POST', `/auctions/${sid}/publish`, { token: seller.token });
      const notLive = await placeBid(api, buyer().token, sid, '10.00');
      assert.equal(notLive.status, 409);
      assert.equal(notLive.body.error.code, 'AUCTION_NOT_LIVE');

      const id = await liveAuction(api, seller.token);
      await app.db.query(
        "UPDATE auctions SET ends_at = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      const late = await placeBid(api, buyer().token, id, '10.00');
      assert.equal(late.status, 409);
      assert.equal(late.body.error.code, 'AUCTION_ENDED');

      await app.db.query("UPDATE auctions SET status = 'ENDED' WHERE id = $1", [id]);
      assert.equal(
        (await placeBid(api, buyer().token, id, '10.00')).body.error.code,
        'AUCTION_ENDED',
      );

      const unknown = await placeBid(
        api,
        buyer().token,
        '00000000-0000-4000-8000-000000000000',
        '10.00',
      );
      assert.equal(unknown.status, 404);
      assert.equal((await counts(id)).bids, 0);
    });

    it('rejected bids change nothing', async () => {
      const id = await liveAuction(api, seller.token);
      await placeBid(api, buyer().token, id, '20.00');
      const before = await app.db.query(
        'SELECT current_price, bid_sequence, highest_bid_id, updated_at FROM auctions WHERE id = $1',
        [id],
      );
      const recordsBefore = (await counts(id)).records;
      await placeBid(api, buyer(1).token, id, '5.00');
      await placeBid(api, seller.token, id, '99.00');
      const after = await app.db.query(
        'SELECT current_price, bid_sequence, highest_bid_id, updated_at FROM auctions WHERE id = $1',
        [id],
      );
      assert.deepEqual(after.rows, before.rows);
      assert.equal((await counts(id)).records, recordsBefore); // rejections are not stored
      await assertInvariants(id, 1);
    });

    it('at the maximum price nobody can outbid, and the answer is a clean 409 (not a 500)', async () => {
      const id = await liveAuction(api, seller.token, { startingPrice: '9999999999.99' });
      assert.equal((await placeBid(api, buyer().token, id, '9999999999.99')).status, 201);
      const res = await placeBid(api, buyer(1).token, id, '9999999999.99');
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'BID_TOO_LOW');
      const view = await api('GET', `/auctions/${id}`);
      assert.equal(view.body.auction.minimumNextBid, null);
    });
  });

  describe('idempotency', () => {
    it('a retry with the same key and request returns the original result and adds no bid', async () => {
      const id = await liveAuction(api, seller.token);
      const key = newKey();
      const first = await placeBid(api, buyer().token, id, '10.00', key);
      const retry = await placeBid(api, buyer().token, id, '10.00', key);
      assert.equal(first.status, 201);
      assert.equal(retry.status, 201);
      assert.deepEqual(retry.body, first.body);
      assert.equal(first.headers.get('idempotent-replay'), null);
      assert.equal(retry.headers.get('idempotent-replay'), 'true');
      // "10" and "10.00" are the same request
      const sameValue = await placeBid(api, buyer().token, id, '10', key);
      assert.deepEqual(sameValue.body, first.body);
      assert.equal((await counts(id)).bids, 1);
    });

    // The fast path: a retry of a finished request is answered without touching the
    // hot auction row, so it is not delayed by contention. Found by mutation testing
    // (removing the fast path survived until this test existed).
    it('a retry of a finished request is answered even while the auction row is locked', async () => {
      const id = await liveAuction(api, seller.token);
      const key = newKey();
      const first = await placeBid(api, buyer().token, id, '10.00', key);
      const holder = await app.db.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [id]);
        const outcome = await Promise.race([
          placeBid(api, buyer().token, id, '10.00', key),
          sleep(1500).then(() => 'blocked' as const),
        ]);
        assert.notEqual(outcome, 'blocked', 'the replay must not wait for the auction lock');
        assert.deepEqual((outcome as ApiResponse).body, first.body);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it('the replay still works after the price moved on (it is the original answer, not a re-judgement)', async () => {
      const id = await liveAuction(api, seller.token);
      const key = newKey();
      const first = await placeBid(api, buyer().token, id, '10.00', key);
      await placeBid(api, buyer(1).token, id, '50.00');
      const retry = await placeBid(api, buyer().token, id, '10.00', key);
      assert.equal(retry.status, 201);
      assert.deepEqual(retry.body, first.body);
      await assertInvariants(id, 2);
    });

    it('reusing a key for a different request is rejected and changes nothing', async () => {
      const id = await liveAuction(api, seller.token);
      const other = await liveAuction(api, seller.token);
      const key = newKey();
      await placeBid(api, buyer().token, id, '10.00', key);
      const diffAmount = await placeBid(api, buyer().token, id, '20.00', key);
      assert.equal(diffAmount.status, 422);
      assert.equal(diffAmount.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
      const diffAuction = await placeBid(api, buyer().token, other, '10.00', key);
      assert.equal(diffAuction.status, 422);
      assert.equal((await counts(id)).bids, 1);
      assert.equal((await counts(other)).bids, 0);
    });

    it('keys are scoped per user: two users may use the same key', async () => {
      const id = await liveAuction(api, seller.token);
      const key = newKey();
      assert.equal((await placeBid(api, buyer().token, id, '10.00', key)).status, 201);
      assert.equal((await placeBid(api, buyer(1).token, id, '11.00', key)).status, 201);
      await assertInvariants(id, 2);
    });

    it('rejections are not stored: the same key can succeed once the bid is acceptable', async () => {
      const id = await liveAuction(api, seller.token);
      const key = newKey();
      assert.equal((await placeBid(api, buyer().token, id, '5.00', key)).status, 409);
      const { rows } = await app.db.query(
        'SELECT 1 FROM idempotency_records WHERE idempotency_key = $1',
        [key],
      );
      assert.equal(rows.length, 0);
    });

    // Deterministic: the auction lock is held by another connection while two
    // identical requests queue behind it, so both pass the fast-path lookup
    // before either has committed. Found necessary by mutation testing.
    it('two identical requests queued on the lock: one bid, both get the same answer', async () => {
      const id = await liveAuction(api, seller.token);
      const key = newKey();
      const holder = await app.db.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [id]);
        let settled = 0;
        const track = (p: Promise<ApiResponse>): Promise<ApiResponse> =>
          p.then((r) => {
            settled += 1;
            return r;
          });
        const a = track(placeBid(api, buyer().token, id, '10.00', key));
        const b = track(placeBid(api, buyer().token, id, '10.00', key));
        await sleep(400);
        assert.equal(settled, 0, 'both requests must be waiting for the auction lock');
        await holder.query('COMMIT');
        const [ra, rb] = await Promise.all([a, b]);
        assert.equal(ra.status, 201, JSON.stringify(ra.body));
        assert.equal(rb.status, 201, JSON.stringify(rb.body));
        assert.deepEqual(ra.body, rb.body);
        const replays = [ra, rb].filter((r) => r.headers.get('idempotent-replay') === 'true');
        assert.equal(replays.length, 1);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      await assertInvariants(id, 1);
    });

    it('ten identical requests fired together: one bid, ten identical 201s', async () => {
      for (let round = 0; round < 3; round += 1) {
        const id = await liveAuction(api, seller.token);
        const key = newKey();
        const results = await Promise.all(
          Array.from({ length: 10 }, () => placeBid(api, buyer().token, id, '10.00', key)),
        );
        for (const r of results) {
          assert.equal(r.status, 201, JSON.stringify(r.body));
          assert.deepEqual(r.body, results[0]?.body);
        }
        await assertInvariants(id, 1);
      }
    });

    it('a unique-key conflict at insert time returns the stored result, never a raw error or a second bid', async () => {
      const id = await liveAuction(api, seller.token);
      const key = newKey();
      const auctions = createAuctionService(app.db);
      const canned = { canned: true };
      const service = createBidService(app.db, auctions, {
        // Runs after the recheck, inside the bid transaction: a concurrent writer
        // "wins" the key at exactly the moment the recheck can no longer see it.
        afterIdempotencyRecheck: async () => {
          await app.db.query(
            `INSERT INTO idempotency_records
               (user_id, operation, idempotency_key, request_hash, response_status, response_body, expires_at)
             VALUES ($1, 'place_bid', $2, $3, 201, $4::jsonb, now() + interval '1 day')`,
            [buyer().id, key, requestHash(id, '10.00'), JSON.stringify(canned)],
          );
        },
      });
      const result = await service.place({
        auctionId: id,
        userId: buyer().id,
        idempotencyKey: key,
        input: { amount: '10.00' },
      });
      assert.equal(result.replayed, true);
      assert.deepEqual(result.body, canned);
      assert.equal((await counts(id)).bids, 0); // the losing transaction rolled back
      await assertInvariants(id, 0);
    });
  });

  describe('concurrency', () => {
    it('many different buyers, one auction, increasing amounts in random order: invariants hold', async () => {
      for (let round = 0; round < 4; round += 1) {
        const id = await liveAuction(api, seller.token);
        const amounts = Array.from({ length: 36 }, (_, i) => `${String(11 + i)}.00`).sort(
          () => Math.random() - 0.5,
        );
        const results = await Promise.all(
          amounts.map((amount, i) => placeBid(api, buyer(i % buyers.length).token, id, amount)),
        );
        const accepted = results.filter((r) => r.status === 201);
        const rejected = results.filter((r) => r.status !== 201);
        assert.ok(rejected.every((r) => r.status === 409 && r.body.error.code === 'BID_TOO_LOW'));
        assert.ok(accepted.length >= 1);
        // every 201 is a distinct sequence number
        assert.equal(new Set(accepted.map((r) => r.body.bid.bidSequence)).size, accepted.length);
        await assertInvariants(id, accepted.length);
      }
    });

    it('fifteen bids for the same amount: exactly one wins', async () => {
      const id = await liveAuction(api, seller.token);
      const results = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          placeBid(api, buyer(i % buyers.length).token, id, '50.00'),
        ),
      );
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      assert.equal(results.filter((r) => r.status === 409).length, 14);
      await assertInvariants(id, 1);
    });

    it('two bids that are each valid against the same stale price are never both accepted', async () => {
      for (let i = 0; i < 10; i += 1) {
        const id = await liveAuction(api, seller.token);
        await placeBid(api, buyer().token, id, '10.00');
        // both are >= 11.00 (valid against the price they both saw); only one can be first,
        // and the second must beat the first by the increment.
        const [x, y] = await Promise.all([
          placeBid(api, buyer(1).token, id, '11.00'),
          placeBid(api, buyer(2).token, id, '11.50'),
        ]);
        const ok = [x, y].filter((r) => r.status === 201).length;
        // 11.00 first makes 11.50 too low (needs 12.00); 11.50 first makes 11.00 too low.
        assert.equal(ok, 1, 'exactly one of the two stale-price bids may win');
        await assertInvariants(id);
      }
    });

    // Deterministic: another connection holds the lock and commits a higher bid.
    // The queued request must wait and then judge against the NEW price.
    it('the price is read after the lock: a bid valid before the wait is rejected after it', async () => {
      const id = await liveAuction(api, seller.token);
      const holder = await app.db.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [id]);
        let settled = false;
        const pending = placeBid(api, buyer().token, id, '15.00').then((r) => {
          settled = true;
          return r;
        });
        await sleep(400);
        assert.equal(settled, false, 'the bid must wait for the auction lock');
        const bid = await holder.query<{ id: string }>(
          `INSERT INTO bids (auction_id, bidder_id, amount, bid_sequence, accepted_at)
           VALUES ($1, $2, 20.00, 1, clock_timestamp()) RETURNING id`,
          [id, buyer(1).id],
        );
        await holder.query(
          `UPDATE auctions SET current_price = 20.00, highest_bid_id = $2, bid_sequence = 1 WHERE id = $1`,
          [id, bid.rows[0]?.id],
        );
        await holder.query('COMMIT');
        const res = await pending;
        assert.equal(res.status, 409, JSON.stringify(res.body));
        assert.equal(res.body.error.code, 'BID_TOO_LOW');
        assert.equal(res.body.error.data.minimumAcceptableBid, '21.00');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      await assertInvariants(id, 1);
    });

    // The NOW() trap (plan section 3.4). The request starts its transaction while
    // the auction is open, then waits for the lock past ends_at. now() would still
    // say "open" (transaction start); clock_timestamp() says "ended".
    it('a request that waited for the lock past the end time is rejected as ended', async () => {
      const id = await liveAuction(api, seller.token);
      await app.db.query(
        "UPDATE auctions SET ends_at = clock_timestamp() + interval '1500 milliseconds' WHERE id = $1",
        [id],
      );
      const holder = await app.db.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [id]);
        const pending = placeBid(api, buyer().token, id, '10.00');
        await sleep(2200); // now well past ends_at; the request is still queued
        await holder.query('COMMIT');
        const res = await pending;
        assert.equal(res.status, 409, JSON.stringify(res.body));
        assert.equal(res.body.error.code, 'AUCTION_ENDED');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      await assertInvariants(id, 0);
    });

    it('a bid just inside the window is accepted and records the judged time', async () => {
      const id = await liveAuction(api, seller.token);
      const res = await placeBid(api, buyer().token, id, '10.00');
      assert.equal(res.status, 201);
      const { rows } = await app.db.query<{ ok: boolean }>(
        'SELECT b.accepted_at < a.ends_at AND b.accepted_at >= a.starts_at AS ok FROM bids b JOIN auctions a ON a.id = b.auction_id WHERE a.id = $1',
        [id],
      );
      assert.equal(rows[0]?.ok, true);
    });
  });

  describe('bid history', () => {
    it('lists bids newest first, public, with bounded pages', async () => {
      const id = await liveAuction(api, seller.token);
      for (let i = 0; i < 5; i += 1) {
        await placeBid(api, buyer(i).token, id, `${String(10 + i)}.00`);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q: string = `/auctions/${id}/bids?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await api('GET', q);
        assert.equal(res.status, 200);
        assert.ok(res.body.items.length <= 2);
        seen.push(...res.body.items.map((b: { bidSequence: string }) => b.bidSequence));
        cursor = res.body.nextCursor as string | null;
        pages += 1;
      } while (cursor && pages < 10);
      assert.deepEqual(seen, ['5', '4', '3', '2', '1']);
      // Names are shown (ADR-024); emails and other user fields never are.
      const all = await api('GET', `/auctions/${id}/bids?limit=50`);
      assert.deepEqual(
        all.body.items.map((b: { bidderDisplayName: string }) => b.bidderDisplayName),
        ['buyer4', 'buyer3', 'buyer2', 'buyer1', 'buyer0'],
      );
      const text = JSON.stringify(all.body);
      for (let i = 0; i < 5; i += 1) assert.ok(!text.includes('@example.com'));
      assert.ok(!text.includes('password'));
      assert.equal((await api('GET', `/auctions/${id}/bids?limit=51`)).status, 400);
      assert.equal((await api('GET', `/auctions/${id}/bids?cursor=%25`)).status, 400);
    });

    it('does not reveal bids of a draft to other users', async () => {
      const created = await api('POST', '/auctions', { token: seller.token, body: auctionBody() });
      const id = created.body.auction.id as string;
      assert.equal((await api('GET', `/auctions/${id}/bids`)).status, 404);
      assert.equal((await api('GET', `/auctions/${id}/bids`, { token: seller.token })).status, 200);
    });
  });

  it('the service connection pool is not leaked by failing bids', async () => {
    const id = await liveAuction(api, seller.token);
    for (let i = 0; i < 60; i += 1) await placeBid(api, buyer().token, id, '1.00');
    await sleep(50);
    const pool = app.db;
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.totalCount - pool.idleCount, 0);
  });
});
