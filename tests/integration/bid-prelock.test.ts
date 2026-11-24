// ADR-073: a bid that is already too low is refused WITHOUT taking the auction row lock.
// The tests hold the row lock from a separate connection to tell the two paths apart.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  auctionBody,
  endAuctionRaw,
  HOUR,
  inFuture,
  liveAuction,
  makeClient,
  newKey,
  newUser,
  placeBid,
  resetData,
  setAuctionEnd,
  sleep,
  startApp,
  type Api,
  type ApiResponse,
  type TestApp,
} from './helpers.ts';

describe('bid pre-check without the row lock (real PostgreSQL)', () => {
  let app: TestApp;
  let api: Api;
  let seller: { token: string; id: string };
  let bidder: { token: string; id: string };
  let other: { token: string; id: string };

  before(async () => {
    app = await startApp({ outbox: false });
    api = makeClient(app.base);
    await resetData(app.db);
    seller = await newUser(api, 'seller');
    bidder = await newUser(api, 'bidder');
    other = await newUser(api, 'other');
  });
  after(async () => {
    await app.close();
  });

  /** Holds FOR UPDATE on the auction row from another connection until `release` is called. */
  async function holdRowLock(auctionId: string): Promise<() => Promise<void>> {
    const client = await app.db.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM auctions WHERE id = $1 FOR UPDATE', [auctionId]);
    return async () => {
      await client.query('ROLLBACK');
      client.release();
    };
  }

  const bidsIn = async (auctionId: string): Promise<number> =>
    Number(
      (
        await app.db.query<{ n: string }>('SELECT count(*) AS n FROM bids WHERE auction_id = $1', [
          auctionId,
        ])
      ).rows[0]?.n,
    );

  const settled = <T>(p: Promise<T>): { done: () => boolean; value: Promise<T> } => {
    let done = false;
    const value = p.finally(() => {
      done = true;
    });
    return { done: () => done, value };
  };

  it('a bid below the minimum is answered 409 BID_TOO_LOW while the row lock is held by someone else', async () => {
    const id = await liveAuction(api, seller.token, { startingPrice: '100.00' });
    assert.equal((await placeBid(api, bidder.token, id, '110.00')).status, 201);
    const release = await holdRowLock(id);
    try {
      const started = Date.now();
      const low = await placeBid(api, other.token, id, '105.00');
      assert.equal(low.status, 409);
      assert.equal(low.body.error.code, 'BID_TOO_LOW');
      assert.equal(low.body.error.data.currentPrice, '110.00');
      assert.equal(low.body.error.data.minimumAcceptableBid, '111.00');
      assert.ok(Date.now() - started < 1500, 'it waited for the lock');
    } finally {
      await release();
    }
    assert.equal(await bidsIn(id), 1);
  });

  it('control: a bid that WOULD be accepted still waits for the lock, then succeeds', async () => {
    const id = await liveAuction(api, seller.token, { startingPrice: '100.00' });
    const release = await holdRowLock(id);
    const pending = settled(placeBid(api, bidder.token, id, '120.00'));
    await sleep(500);
    assert.equal(pending.done(), false, 'a valid bid must queue on the row lock');
    await release();
    const res: ApiResponse = await pending.value;
    assert.equal(res.status, 201);
    assert.equal(await bidsIn(id), 1);
  });

  it('the checks that come before the price check keep their error codes (seller, ended)', async () => {
    const id = await liveAuction(api, seller.token, { startingPrice: '100.00' });
    assert.equal((await placeBid(api, bidder.token, id, '110.00')).status, 201);
    const sellerLow = await placeBid(api, seller.token, id, '101.00');
    assert.equal(sellerLow.status, 403);
    assert.equal(sellerLow.body.error.code, 'BIDDER_IS_SELLER');

    // Time is up but the status is still LIVE (the worker has not ended it yet).
    await setAuctionEnd(app.db, id, "now() - interval '1 second'");
    const timeUpLow = await placeBid(api, other.token, id, '101.00');
    assert.equal(timeUpLow.status, 409);
    assert.equal(timeUpLow.body.error.code, 'AUCTION_ENDED');

    // Then the worker ends it: status ENDED.
    await endAuctionRaw(app.db, id);
    const endedLow = await placeBid(api, other.token, id, '101.00');
    assert.equal(endedLow.status, 409);
    assert.equal(endedLow.body.error.code, 'AUCTION_ENDED');
  });

  it('an unpublished (DRAFT) auction is still 404 for a bidder, even for a bid below the starting price', async () => {
    const created = await api('POST', '/auctions', {
      token: seller.token,
      body: auctionBody({
        startingPrice: '100.00',
        startsAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        endsAt: inFuture(2 * HOUR),
      }),
    });
    assert.equal(created.status, 201);
    const draftId = created.body.auction.id as string;
    const low = await placeBid(api, other.token, draftId, '1.00');
    assert.equal(low.status, 404);
    assert.equal(low.body.error.code, 'NOT_FOUND');
  });

  it('a retry with the same key after the win still gets the stored 201, not a 409', async () => {
    const id = await liveAuction(api, seller.token, { startingPrice: '100.00' });
    const key = newKey();
    const first = await placeBid(api, bidder.token, id, '110.00', key);
    assert.equal(first.status, 201);
    const again = await placeBid(api, bidder.token, id, '110.00', key);
    assert.equal(again.status, 201);
    assert.equal(again.body.bid.id, first.body.bid.id);
    assert.equal(await bidsIn(id), 1);
  });

  it('many stale bids racing one valid bid: exactly one wins, the rest are 409, the sequence is gapless', async () => {
    const id = await liveAuction(api, seller.token, { startingPrice: '100.00' });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        placeBid(api, i % 2 === 0 ? bidder.token : other.token, id, '150.00'),
      ),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.ok(
      results.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'BID_TOO_LOW'),
    );
    assert.equal(await bidsIn(id), 1);
  });
});
