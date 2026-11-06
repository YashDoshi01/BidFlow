// Phase 6: the auction lifecycle (start, anti-sniping, end), notifications, and the database rules
// that back them up. Real PostgreSQL; real WebSockets for the live-event test. Time is controlled
// with setAuctionEnd / setAuctionStart (triggers off for one session), because the database now
// refuses to move these times any other way.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { durableEventSchema } from '../../apps/api/src/events/events.ts';
import { withTransaction } from '../../apps/api/src/db/pool.ts';
import { createLogger } from '../../apps/api/src/logging/logger.ts';
import { createAuctionService } from '../../apps/api/src/modules/auctions/index.ts';
import { createBidService, type BidTestHooks } from '../../apps/api/src/modules/bids/index.ts';
import {
  createLifecycleWorker,
  type LifecycleOptions,
  type LifecycleWorker,
} from '../../apps/api/src/modules/lifecycle/index.ts';
import {
  auctionBody,
  endAuctionRaw,
  inFuture,
  liveAuction,
  makeClient,
  newKey,
  newUser,
  placeBid,
  resetData,
  setAuctionEnd,
  setAuctionStart,
  sleep,
  startApp,
  type Api,
  type TestApp,
} from './helpers.ts';
import { insertNotifications } from '../../apps/api/src/modules/notifications/index.ts';
import { TestSocket } from './realtime-helpers.ts';

interface User {
  token: string;
  id: string;
}

interface AuctionDbRow {
  status: string;
  ends_at: Date;
  original_ends_at: Date;
  extension_count: number;
  bid_sequence: string;
  auction_event_sequence: string;
  highest_bid_id: string | null;
  winning_bid_id: string | null;
  ended_at: Date | null;
  ending_soon_notified_at: Date | null;
}

interface NoteDbRow {
  type: string;
  data: Record<string, unknown>;
}

interface BidResponse {
  bid: { id: string };
  auction: { endsAt: string; eventSequence: string };
}

interface OutboxRow {
  id: string;
  event_type: string;
  auction_event_sequence: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  schema_version: number;
  auction_id: string;
}

describe('auction lifecycle (real PostgreSQL)', () => {
  let app: TestApp;
  let api: Api;
  let seller: User;
  let alice: User;
  let bob: User;
  let carol: User;
  let workerCount = 0;

  before(async () => {
    app = await startApp();
    api = makeClient(app.base);
  });
  beforeEach(async () => {
    await resetData(app.db);
    seller = await newUser(api, 'seller');
    alice = await newUser(api, 'alice');
    bob = await newUser(api, 'bob');
    carol = await newUser(api, 'carol');
  });
  after(async () => {
    await app.close();
  });

  const quiet = createLogger('error', () => undefined);
  function worker(over: Partial<LifecycleOptions> = {}): LifecycleWorker {
    workerCount += 1;
    return createLifecycleWorker({
      db: app.db,
      logger: quiet,
      workerId: `test-worker-${String(workerCount)}`,
      pollIntervalMs: 20,
      ...over,
    });
  }

  async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await app.db.query(sql, params)).rows as T[];
  }
  const outboxOf = (id: string): Promise<OutboxRow[]> =>
    rows<OutboxRow>(
      'SELECT * FROM outbox_events WHERE auction_id = $1 ORDER BY auction_event_sequence',
      [id],
    );
  async function auctionRow(id: string): Promise<AuctionDbRow> {
    return (
      await rows<AuctionDbRow>('SELECT * FROM auctions WHERE id = $1', [id])
    )[0] as AuctionDbRow;
  }
  const notesOf = (userId: string): Promise<NoteDbRow[]> =>
    rows<NoteDbRow>('SELECT * FROM notifications WHERE user_id = $1 ORDER BY seq', [userId]);

  /** The event as a client receives it, validated against the contract. */
  function asEvent(row: OutboxRow): ReturnType<typeof durableEventSchema.parse> {
    return durableEventSchema.parse({
      eventId: row.id,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      auctionId: row.auction_id,
      sequence: Number(row.auction_event_sequence),
      occurredAt: row.occurred_at.toISOString(),
      data: row.payload,
    });
  }

  async function bid(user: User, id: string, amount: string): Promise<BidResponse> {
    const res = await placeBid(api, user.token, id, amount);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body as BidResponse;
  }

  /** A LIVE auction with bids from alice (10.00) and bob (11.00), already past its end time. */
  async function overdueWithBids(): Promise<string> {
    const id = await liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
    await bid(alice, id, '10.00');
    await bid(bob, id, '11.00');
    await setAuctionEnd(app.db, id, "now() - interval '1 second'");
    return id;
  }

  /** A SCHEDULED auction whose start time has now passed. */
  async function dueToStart(): Promise<string> {
    const created = await api('POST', '/auctions', {
      token: seller.token,
      body: auctionBody({ startsAt: inFuture(3_600_000), endsAt: inFuture(7_200_000) }),
    });
    const id = created.body.auction.id as string;
    const published = await api('POST', `/auctions/${id}/publish`, { token: seller.token });
    assert.equal(published.body.auction.status, 'SCHEDULED');
    await setAuctionStart(app.db, id, "now() - interval '1 second'");
    return id;
  }

  describe('activation (SCHEDULED -> LIVE) without any browser', () => {
    it('starts a due auction once, with an auction.started event; repeats and early auctions do nothing', async () => {
      const due = await dueToStart();
      const later = await api('POST', '/auctions', {
        token: seller.token,
        body: auctionBody({ startsAt: inFuture(3_600_000), endsAt: inFuture(7_200_000) }),
      });
      await api('POST', `/auctions/${later.body.auction.id as string}/publish`, {
        token: seller.token,
      });

      const w = worker();
      const first = await w.runOnce();
      assert.deepEqual(
        { started: first.started, ended: first.ended, errors: first.errors },
        { started: 1, ended: 0, errors: 0 },
      );
      const a = await auctionRow(due);
      assert.equal(a['status'], 'LIVE');
      assert.equal(a['auction_event_sequence'], '1');
      const events = await outboxOf(due);
      assert.equal(events.length, 1);
      const started = asEvent(events[0] as OutboxRow);
      assert.equal(started.eventType, 'auction.started');
      assert.equal(started.sequence, 1);

      // Idempotent: a second pass, and a second worker, change nothing.
      assert.equal((await w.runOnce()).started, 0);
      assert.equal((await worker().runOnce()).started, 0);
      assert.equal((await outboxOf(due)).length, 1);
      assert.equal((await auctionRow(later.body.auction.id))['status'], 'SCHEDULED');
    });

    it('once LIVE the auction accepts bids, and its next event follows the started event', async () => {
      const id = await dueToStart();
      assert.equal((await placeBid(api, alice.token, id, '10.00')).status, 409); // not live yet
      await worker().runOnce();
      const res = await bid(alice, id, '10.00');
      assert.equal(res.auction.eventSequence, '2');
      assert.deepEqual(
        (await outboxOf(id)).map((r) => r.event_type),
        ['auction.started', 'bid.accepted'],
      );
    });
  });

  describe('ending (LIVE -> ENDED)', () => {
    it('ends a due auction: winner = highest bid, one auction.ended event, notifications, no more bids', async () => {
      const id = await overdueWithBids();
      const pass = await worker().runOnce();
      assert.equal(pass.ended, 1);

      const a = await auctionRow(id);
      assert.equal(a['status'], 'ENDED');
      assert.ok(a['ended_at'] instanceof Date);
      const winning = await rows<{ bidder_id: string; amount: string }>(
        'SELECT bidder_id, amount FROM bids WHERE id = $1',
        [a['winning_bid_id']],
      );
      assert.deepEqual(winning, [{ bidder_id: bob.id, amount: '11.00' }]);
      assert.equal(a['winning_bid_id'], a['highest_bid_id']);

      const events = await outboxOf(id);
      assert.deepEqual(
        events.map((e) => [e.event_type, e.auction_event_sequence]),
        [
          ['bid.accepted', '1'],
          ['bid.accepted', '2'],
          ['auction.ended', '3'],
        ],
      );
      const ended = asEvent(events[2] as OutboxRow);
      assert.equal(ended.eventType, 'auction.ended');
      if (ended.eventType === 'auction.ended') {
        assert.equal(ended.data.winnerId, bob.id);
        assert.equal(ended.data.winnerDisplayName, 'bob');
        assert.equal(ended.data.finalPrice, '11.00');
        assert.equal(ended.data.bidCount, 2);
        assert.equal(ended.data.winningBidId, a['winning_bid_id']);
      }

      assert.deepEqual(
        (await notesOf(bob.id)).map((n) => n['type']),
        ['auction_won'],
      );
      // alice was outbid by bob (written when bob bid) and then lost the auction.
      assert.deepEqual(
        (await notesOf(alice.id)).map((n) => n['type']),
        ['outbid', 'auction_lost'],
      );
      const sellerNotes = await notesOf(seller.id);
      assert.deepEqual(
        sellerNotes.map((n) => n['type']),
        ['auction_ended'],
      );
      assert.equal(sellerNotes[0]?.['data'].sold, true);
      assert.deepEqual(await notesOf(carol.id), []); // never bid: nothing

      const late = await placeBid(api, carol.token, id, '50.00');
      assert.equal(late.status, 409);
      assert.equal(late.body.error.code, 'AUCTION_ENDED');
    });

    it('an auction nobody bid on ends without a winner and tells the seller', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
      await setAuctionEnd(app.db, id, "now() - interval '1 second'");
      await worker().runOnce();
      const a = await auctionRow(id);
      assert.equal(a['status'], 'ENDED');
      assert.equal(a['winning_bid_id'], null);
      const ended = asEvent((await outboxOf(id))[0] as OutboxRow);
      if (ended.eventType !== 'auction.ended') throw new Error('expected auction.ended');
      assert.equal(ended.data.winnerId, null);
      assert.equal(ended.data.bidCount, 0);
      assert.equal(ended.data.finalPrice, '10.00');
      const notes = await notesOf(seller.id);
      assert.equal(notes[0]?.['data'].sold, false);
      assert.equal((await rows('SELECT 1 FROM notifications')).length, 1);
    });

    it('never ends an auction before ends_at', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
      const pass = await worker().runOnce();
      assert.equal(pass.ended, 0);
      assert.equal((await auctionRow(id))['status'], 'LIVE');
      // Not even one second early.
      await setAuctionEnd(app.db, id, "clock_timestamp() + interval '2 seconds'");
      assert.equal((await worker().runOnce()).ended, 0);
      assert.equal((await auctionRow(id))['status'], 'LIVE');
    });

    it('after an outage that covered both times, one pass starts and then ends the auction, in order', async () => {
      const id = await dueToStart();
      await setAuctionStart(app.db, id, "now() - interval '10 minutes'");
      await setAuctionEnd(app.db, id, "now() - interval '1 second'");
      const pass = await worker().runOnce();
      assert.deepEqual({ started: pass.started, ended: pass.ended }, { started: 1, ended: 1 });
      assert.deepEqual(
        (await outboxOf(id)).map((e) => [e.event_type, e.auction_event_sequence]),
        [
          ['auction.started', '1'],
          ['auction.ended', '2'],
        ],
      );
    });
  });

  describe('duplicate schedulers and restarts', () => {
    it('four workers racing over many overdue auctions: each ends exactly once, with exactly one event', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const id = await liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
        await bid(alice, id, '10.00');
        await bid(bob, id, '12.00');
        await setAuctionEnd(app.db, id, "now() - interval '1 second'");
        ids.push(id);
      }
      const results = await Promise.all([1, 2, 3, 4].map(() => worker().runOnce()));
      assert.equal(
        results.reduce((n, r) => n + r.ended, 0),
        6,
        JSON.stringify(results),
      );
      assert.equal(
        results.reduce((n, r) => n + r.errors, 0),
        0,
      );
      for (const id of ids) {
        const ended = (await outboxOf(id)).filter((e) => e.event_type === 'auction.ended');
        assert.equal(ended.length, 1, id);
        assert.equal((await auctionRow(id))['status'], 'ENDED');
      }
      // One won + one lost notification per auction, no duplicates.
      assert.equal(
        (await rows('SELECT 1 FROM notifications WHERE type = $1', ['auction_won'])).length,
        6,
      );
      assert.equal(
        (await rows('SELECT 1 FROM notifications WHERE type = $1', ['auction_lost'])).length,
        6,
      );
    });

    it('many workers and ONE overdue auction: exactly one of them ends it', async () => {
      const id = await overdueWithBids();
      const results = await Promise.all(Array.from({ length: 6 }, () => worker().runOnce()));
      assert.equal(
        results.reduce((n, r) => n + r.ended, 0),
        1,
      );
      assert.equal((await outboxOf(id)).filter((e) => e.event_type === 'auction.ended').length, 1);
    });

    it('a worker that dies after locking leaves nothing behind; the next one does the whole job', async () => {
      const id = await overdueWithBids();
      const crashing = worker({
        faults: {
          afterLock: () => Promise.reject(new Error('simulated crash after the lock')),
        },
      });
      const pass = await crashing.runOnce();
      assert.equal(pass.ended, 0);
      assert.equal(pass.errors, 1);
      // The transaction rolled back as a whole: still LIVE, no event, no notification of the end.
      assert.equal((await auctionRow(id))['status'], 'LIVE');
      assert.equal((await outboxOf(id)).length, 2);
      assert.equal(
        (await rows("SELECT 1 FROM notifications WHERE type IN ('auction_won','auction_lost')"))
          .length,
        0,
      );
      assert.equal((await worker().runOnce()).ended, 1);
      assert.equal((await auctionRow(id))['status'], 'ENDED');
    });

    it('one broken auction does not starve the others in the same pass', async () => {
      const first = await overdueWithBids();
      const second = await overdueWithBids();
      const w = worker({
        faults: {
          afterLock: (_kind, auctionId) =>
            auctionId === first ? Promise.reject(new Error('boom')) : Promise.resolve(),
        },
      });
      const pass = await w.runOnce();
      assert.deepEqual({ ended: pass.ended, errors: pass.errors }, { ended: 1, errors: 1 });
      assert.equal((await auctionRow(second))['status'], 'ENDED');
      assert.equal((await auctionRow(first))['status'], 'LIVE');
    });

    it('the polling loop ends an auction that becomes due, and stops cleanly', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
      const w = worker();
      w.start();
      try {
        await setAuctionEnd(app.db, id, "now() - interval '1 second'");
        const deadline = Date.now() + 5000;
        while ((await auctionRow(id))['status'] !== 'ENDED') {
          assert.ok(Date.now() < deadline, 'the loop did not end the auction in 5 s');
          await sleep(25);
        }
      } finally {
        await w.stop();
      }
    });
  });

  describe('the boundary: a bid and the end can never both win', () => {
    const service = (hooks: BidTestHooks): ReturnType<typeof createBidService> =>
      createBidService(app.db, createAuctionService(app.db), { hooks });
    const place = (
      svc: ReturnType<typeof createBidService>,
      user: User,
      auctionId: string,
      amount: string,
    ): Promise<{ status: number }> =>
      svc.place({ auctionId, userId: user.id, idempotencyKey: newKey(), input: { amount } });

    it('the worker holds the lock: the waiting bid is then rejected as ended', async () => {
      const id = await overdueWithBids();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => undefined;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const w = worker({
        faults: {
          afterLock: async () => {
            entered();
            await gate;
          },
        },
      });
      const pass = w.runOnce();
      await inside; // the worker now holds the auction's row lock

      const bidding = place(service({}), carol, id, '20.00');
      const settled = bidding.then(
        () => 'accepted',
        (error: unknown) => (error as { code?: string }).code,
      );
      await sleep(250); // the bid is queued behind the lock
      release();
      assert.equal((await pass).ended, 1);
      assert.equal(await settled, 'AUCTION_ENDED');
      assert.equal((await rows('SELECT 1 FROM bids WHERE auction_id = $1', [id])).length, 2);
    });

    it('a bid holds the lock past ends_at: the worker skips the auction, the bid is rejected as ended, the next pass ends it', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
      await bid(alice, id, '10.00');
      await setAuctionEnd(app.db, id, "clock_timestamp() + interval '1500 milliseconds'");

      // The bid takes the lock while the auction is still open, then dawdles past ends_at; its
      // decision is made AFTER the pause with a fresh clock, so it must be refused.
      const svc = service({ afterIdempotencyRecheck: () => sleep(2200) });
      const bidding = place(svc, bob, id, '11.00').then(
        () => 'accepted',
        (error: unknown) => (error as { code?: string }).code,
      );
      await sleep(1900); // past ends_at, and the bid still holds the lock
      const during = await worker().runOnce();
      assert.equal(during.ended, 0, 'the locked auction must be skipped, not waited for');
      assert.equal(await bidding, 'AUCTION_ENDED');
      assert.equal((await worker().runOnce()).ended, 1);
      assert.equal((await rows('SELECT 1 FROM bids WHERE auction_id = $1', [id])).length, 1);
      assert.equal((await auctionRow(id))['status'], 'ENDED');
    });

    it('a bid decided before ends_at but committed after it extends the auction; the worker must not end it', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
      await setAuctionEnd(app.db, id, "clock_timestamp() + interval '1500 milliseconds'");
      const before = await auctionRow(id);

      // Decided at ~0 s (open, inside the window: extends), committed at ~1.8 s (after the old end).
      const svc = service({ beforeStore: () => sleep(1800) });
      const bidding = place(svc, alice, id, '10.00');
      await sleep(1700); // the OLD ends_at has passed; the bid's transaction is still open
      const during = await worker().runOnce();
      assert.equal(during.ended, 0, 'the auction is locked by the bid: skipped');
      assert.equal((await bidding).status, 201);
      const after = await auctionRow(id);
      assert.ok(after['ends_at'].getTime() > before['ends_at'].getTime() + 60_000);
      assert.equal((await worker().runOnce()).ended, 0, 'the extended auction is not due');
      assert.equal(after['status'], 'LIVE');
    });
  });

  describe('anti-sniping (product rule 13)', () => {
    it('a bid outside the last 2 minutes does not extend the auction', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
      const before = await auctionRow(id);
      const res = await bid(alice, id, '10.00');
      assert.equal(res.auction.endsAt, before['ends_at'].toISOString());
      assert.equal(res.auction.eventSequence, '1');
      assert.deepEqual(
        (await outboxOf(id)).map((e) => e.event_type),
        ['bid.accepted'],
      );
      assert.equal((await auctionRow(id))['extension_count'], 0);
    });

    it('a bid inside the last 2 minutes moves the end to bid time + 2 minutes, as a second event', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(90_000) });
      const before = await auctionRow(id);
      const sent = Date.now();
      const res = await bid(alice, id, '10.00');
      const newEnd = new Date(res.auction.endsAt).getTime();
      assert.ok(newEnd > before['ends_at'].getTime());
      assert.ok(Math.abs(newEnd - (sent + 120_000)) < 5000, 'about bid time + 2 minutes');
      assert.equal(res.auction.eventSequence, '2'); // the LAST event of this transaction

      const events = await outboxOf(id);
      assert.deepEqual(
        events.map((e) => [e.event_type, e.auction_event_sequence]),
        [
          ['bid.accepted', '1'],
          ['auction.extended', '2'],
        ],
      );
      const extended = asEvent(events[1] as OutboxRow);
      if (extended.eventType !== 'auction.extended') throw new Error('expected auction.extended');
      assert.equal(extended.data.previousEndsAt, before['ends_at'].toISOString());
      assert.equal(extended.data.endsAt, res.auction.endsAt);
      assert.equal(extended.data.extensionCount, 1);
      assert.equal(extended.data.triggeringBidId, res.bid.id);

      const a = await api('GET', `/auctions/${id}`);
      assert.equal(a.body.auction.endsAt, res.auction.endsAt);
      assert.equal(a.body.auction.extensionCount, 1);
      assert.equal(a.body.auction.eventSequence, '2');
    });

    it('allows at most 10 extensions; later bids are still accepted, without further extensions', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(90_000) });
      for (let i = 0; i < 12; i += 1) {
        await bid(i % 2 === 0 ? alice : bob, id, `${String(10 + i)}.00`);
      }
      const a = await auctionRow(id);
      assert.equal(a['extension_count'], 10);
      assert.equal(a['bid_sequence'], '12');
      const events = await outboxOf(id);
      assert.equal(events.filter((e) => e.event_type === 'auction.extended').length, 10);
      assert.equal(events.filter((e) => e.event_type === 'bid.accepted').length, 12);
      // One total order with no gaps: 1..22.
      assert.deepEqual(
        events.map((e) => Number(e.auction_event_sequence)),
        Array.from({ length: 22 }, (_, i) => i + 1),
      );
      // Each extension directly follows the bid that caused it.
      for (const [i, e] of events.entries()) {
        if (e.event_type === 'auction.extended') {
          assert.equal(events[i - 1]?.event_type, 'bid.accepted');
          assert.equal(e.payload['triggeringBidId'], events[i - 1]?.payload['bidId']);
        }
      }
    });

    it("never moves the end beyond the seller's end time + 1 hour", async () => {
      // The seller's end time was 59 minutes ago in "their" calendar: the cap is now + 1 minute.
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
      await setAuctionEnd(
        app.db,
        id,
        "clock_timestamp() + interval '30 seconds'",
        "clock_timestamp() - interval '59 minutes'",
      );
      const res = await bid(alice, id, '10.00');
      const cap = (await auctionRow(id))['original_ends_at'].getTime() + 3_600_000;
      assert.equal(new Date(res.auction.endsAt).getTime(), cap, 'clamped to the cap');
      assert.equal((await auctionRow(id))['extension_count'], 1);

      // At the cap exactly: the bid is accepted, nothing can move, no event.
      const again = await bid(bob, id, '11.00');
      assert.equal(new Date(again.auction.endsAt).getTime(), cap);
      assert.equal((await auctionRow(id))['extension_count'], 1);
      assert.deepEqual(
        (await outboxOf(id)).map((e) => e.event_type),
        ['bid.accepted', 'auction.extended', 'bid.accepted'],
      );
    });

    it('is atomic with the bid: a failure before COMMIT leaves no bid, no extension, no event, no notification', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(90_000) });
      await bid(alice, id, '10.00'); // alice leads (and extended once)
      const before = await auctionRow(id);
      const eventsBefore = (await outboxOf(id)).length;
      const notesBefore = (await rows('SELECT 1 FROM notifications')).length;

      const svc = createBidService(app.db, createAuctionService(app.db), {
        hooks: { beforeStore: () => Promise.reject(new Error('simulated failure before commit')) },
      });
      await assert.rejects(
        svc.place({
          auctionId: id,
          userId: bob.id,
          idempotencyKey: newKey(),
          input: { amount: '11.00' },
        }),
        /simulated failure/,
      );
      const after = await auctionRow(id);
      assert.equal(after['bid_sequence'], before['bid_sequence']);
      assert.equal(after['extension_count'], before['extension_count']);
      assert.equal(after['ends_at'].getTime(), before['ends_at'].getTime());
      assert.equal(after['auction_event_sequence'], before['auction_event_sequence']);
      assert.equal((await outboxOf(id)).length, eventsBefore);
      assert.equal((await rows('SELECT 1 FROM notifications')).length, notesBefore);
    });

    it('a replayed request (same Idempotency-Key) does not extend again', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(90_000) });
      const key = newKey();
      const first = await placeBid(api, alice.token, id, '10.00', key);
      const second = await placeBid(api, alice.token, id, '10.00', key);
      assert.equal(second.headers.get('Idempotent-Replay'), 'true');
      assert.deepEqual(second.body, first.body);
      assert.equal((await auctionRow(id))['extension_count'], 1);
      assert.equal((await outboxOf(id)).length, 2);
    });
  });

  describe('events reach the sockets', () => {
    it('a client in the room receives bid.accepted, auction.extended and auction.ended in order', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(90_000) });
      const socket = await TestSocket.connect(app.base, alice.token);
      try {
        assert.deepEqual(await socket.join(id), { ok: true });
        await socket.next('auction.snapshot');
        await bid(alice, id, '10.00');
        await setAuctionEnd(app.db, id, "now() - interval '1 second'");
        await worker().runOnce();

        const accepted = await socket.next('bid.accepted');
        const extended = await socket.next('auction.extended');
        const ended = await socket.next('auction.ended');
        assert.deepEqual([accepted.sequence, extended.sequence, ended.sequence], [1, 2, 3]);
        assert.equal(ended.data.winnerDisplayName, 'alice');
        // The contract: what the client receives validates against the schema.
        durableEventSchema.parse(accepted);
        durableEventSchema.parse(extended);
        durableEventSchema.parse(ended);
      } finally {
        socket.close();
      }
    });
  });

  describe('notifications', () => {
    it('outbid: the previous leader is told, never the new leader, never oneself', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
      await bid(alice, id, '10.00');
      assert.deepEqual(await notesOf(alice.id), []);
      await bid(bob, id, '11.00');
      const notes = await notesOf(alice.id);
      assert.equal(notes.length, 1);
      assert.equal(notes[0]?.['type'], 'outbid');
      assert.equal(notes[0]?.['data'].yourAmount, '10.00');
      assert.equal(notes[0]?.['data'].currentPrice, '11.00');
      assert.deepEqual(await notesOf(bob.id), []);
      await bid(bob, id, '12.00'); // bob outbids himself: nobody is told
      assert.equal((await notesOf(alice.id)).length, 1);
      assert.deepEqual(await notesOf(bob.id), []);
      await bid(alice, id, '13.00');
      assert.equal((await notesOf(bob.id)).length, 1);
      assert.deepEqual(await notesOf(seller.id), []);
    });

    it('ending soon: once, only for bidders, only inside the window', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
      await bid(alice, id, '10.00');
      await bid(bob, id, '11.00');
      // Window 60 s, auction ends in an hour: nothing.
      assert.equal((await worker({ endingSoonSeconds: 60 }).runOnce()).endingSoon, 0);
      // Window 2 hours: both bidders, once.
      const w = worker({ endingSoonSeconds: 7200 });
      assert.equal((await w.runOnce()).endingSoon, 1);
      assert.equal((await w.runOnce()).endingSoon, 0);
      assert.equal((await worker({ endingSoonSeconds: 7200 }).runOnce()).endingSoon, 0);
      for (const user of [alice, bob]) {
        const soon = (await notesOf(user.id)).filter((n) => n['type'] === 'ending_soon');
        assert.equal(soon.length, 1);
      }
      assert.equal((await notesOf(seller.id)).length, 0);
      assert.equal((await notesOf(carol.id)).length, 0);
      assert.equal((await auctionRow(id))['ending_soon_notified_at'] instanceof Date, true);
    });

    it('writing the same notification twice stores it once (the dedupe key)', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
      await bid(alice, id, '10.00');
      const note = {
        userId: alice.id,
        auctionId: id,
        type: 'ending_soon' as const,
        dedupeKey: 'ending_soon:test',
        data: {},
      };
      const written = await withTransaction(app.db, async (client) => [
        await insertNotifications(client, [note]),
        await insertNotifications(client, [note]),
        await insertNotifications(client, []),
      ]);
      assert.deepEqual(written, [1, 0, 0]);
      assert.equal(
        (await rows('SELECT 1 FROM notifications WHERE dedupe_key = $1', ['ending_soon:test']))
          .length,
        1,
      );
    });

    describe('the API', () => {
      it("requires a session and never reveals another user's notifications", async () => {
        assert.equal((await api('GET', '/notifications')).status, 401);
        assert.equal((await api('POST', '/notifications/read-all')).status, 401);
        const id = await overdueWithBids();
        await worker().runOnce();
        const mine = await api('GET', '/notifications', { token: alice.token });
        assert.equal(mine.status, 200);
        assert.deepEqual(
          mine.body.items.map((n: { type: string }) => n.type),
          ['auction_lost', 'outbid'], // newest first
        );
        assert.equal(mine.body.unreadCount, 2);
        assert.ok(
          mine.body.items.every(
            (n: { auctionId: string; readAt: string | null }) =>
              n.auctionId === id && n.readAt === null,
          ),
        );
        assert.equal(
          (await api('GET', '/notifications', { token: carol.token })).body.items.length,
          0,
        );
        // No field names another user, the body has no way to choose the owner.
        assert.equal(JSON.stringify(mine.body).includes(bob.id), false);
      });

      it('pages with a cursor and filters unread', async () => {
        await overdueWithBids();
        await worker().runOnce();
        const p1 = await api('GET', '/notifications?limit=1', { token: alice.token });
        assert.equal(p1.body.items.length, 1);
        assert.ok(p1.body.nextCursor);
        const p2 = await api(
          'GET',
          `/notifications?limit=1&cursor=${p1.body.nextCursor as string}`,
          {
            token: alice.token,
          },
        );
        assert.equal(p2.body.items.length, 1);
        assert.equal(p2.body.nextCursor, null);
        assert.notEqual(p1.body.items[0].id, p2.body.items[0].id);
        await api('POST', `/notifications/${p1.body.items[0].id as string}/read`, {
          token: alice.token,
        });
        const unread = await api('GET', '/notifications?unread=true', { token: alice.token });
        assert.deepEqual(
          unread.body.items.map((n: { id: string }) => n.id),
          [p2.body.items[0].id],
        );
        assert.equal(
          (await api('GET', '/notifications?limit=0', { token: alice.token })).status,
          400,
        );
        assert.equal(
          (await api('GET', '/notifications?cursor=!!', { token: alice.token })).status,
          400,
        );
      });

      it('marks one notification read (idempotently, keeping the first time), only your own', async () => {
        await overdueWithBids();
        await worker().runOnce();
        const list = await api('GET', '/notifications', { token: alice.token });
        const id = list.body.items[0].id as string;
        const first = await api('POST', `/notifications/${id}/read`, { token: alice.token });
        assert.equal(first.status, 200);
        assert.ok(first.body.notification.readAt);
        await sleep(20);
        const second = await api('POST', `/notifications/${id}/read`, { token: alice.token });
        assert.equal(second.body.notification.readAt, first.body.notification.readAt);
        assert.equal(
          (await api('GET', '/notifications', { token: alice.token })).body.unreadCount,
          1,
        );

        // bob cannot read or change alice's notification: indistinguishable from a missing one.
        const bobTry = await api('POST', `/notifications/${list.body.items[1].id as string}/read`, {
          token: bob.token,
        });
        assert.equal(bobTry.status, 404);
        assert.equal(
          (await api('GET', '/notifications', { token: alice.token })).body.unreadCount,
          1,
        );
        assert.equal(
          (await api('POST', '/notifications/not-a-uuid/read', { token: alice.token })).status,
          400,
        );
        assert.equal(
          (await api('POST', `/notifications/${crypto.randomUUID()}/read`, { token: alice.token }))
            .status,
          404,
        );
      });

      it('marks all of your own read, and only yours', async () => {
        await overdueWithBids();
        await worker().runOnce();
        const res = await api('POST', '/notifications/read-all', { token: alice.token });
        assert.deepEqual(res.body, { updated: 2 });
        assert.equal(
          (await api('GET', '/notifications', { token: alice.token })).body.unreadCount,
          0,
        );
        assert.equal(
          (await api('GET', '/notifications', { token: bob.token })).body.unreadCount,
          1,
        );
        assert.deepEqual(
          (await api('POST', '/notifications/read-all', { token: alice.token })).body,
          {
            updated: 0,
          },
        );
      });
    });
  });

  describe('database backstops (the application is bypassed)', () => {
    const expectRejected = (sql: string, params: unknown[], pattern: RegExp): Promise<void> =>
      assert.rejects(app.db.query(sql, params), pattern);

    async function liveRow(): Promise<string> {
      return liveAuction(api, seller.token, { endsAt: inFuture(3_600_000) });
    }

    it('notifications: only for a published auction the user sells or bid on; immutable except read_at (once)', async () => {
      const id = await liveRow();
      await bid(alice, id, '10.00');
      const insert = `INSERT INTO notifications (user_id, auction_id, type, dedupe_key, data)
                      VALUES ($1, $2, 'outbid', $3, '{}'::jsonb)`;
      await expectRejected(insert, [bob.id, id, 'k1'], /user sells or bid on/); // never bid
      await expectRejected(insert, [carol.id, id, 'k2'], /user sells or bid on/);
      const draft = await api('POST', '/auctions', { token: seller.token, body: auctionBody() });
      await expectRejected(
        insert,
        [seller.id, draft.body.auction.id, 'k3'],
        /user sells or bid on/,
      );
      await app.db.query(insert, [alice.id, id, 'k4']); // control: a bidder is fine
      await app.db.query(insert, [seller.id, id, 'k5']); // control: the seller is fine
      await expectRejected(insert, [alice.id, id, 'k4'], /notifications_dedupe_key/);
      await expectRejected(
        "INSERT INTO notifications (user_id, auction_id, type, dedupe_key, data, read_at) VALUES ($1, $2, 'outbid', 'k6', '{}', now())",
        [alice.id, id],
        /new notification is unread/,
      );
      await expectRejected(
        "INSERT INTO notifications (user_id, auction_id, type, dedupe_key, data) VALUES ($1, $2, 'spam', 'k7', '{}')",
        [alice.id, id],
        /notifications_type_valid/,
      );
      await expectRejected(
        "UPDATE notifications SET type = 'auction_won' WHERE dedupe_key = 'k4'",
        [],
        /immutable except for read_at/,
      );
      await expectRejected(
        "UPDATE notifications SET user_id = $1 WHERE dedupe_key = 'k4'",
        [bob.id],
        /immutable except for read_at/,
      );
      await app.db.query("UPDATE notifications SET read_at = now() WHERE dedupe_key = 'k4'");
      await expectRejected(
        "UPDATE notifications SET read_at = now() + interval '1 hour' WHERE dedupe_key = 'k4'",
        [],
        /read_at is set once/,
      );
    });

    it('an auction cannot go LIVE before starts_at, nor end before ends_at', async () => {
      const scheduled = await dueToStart();
      await setAuctionStart(app.db, scheduled, "now() + interval '1 hour'");
      await expectRejected(
        "UPDATE auctions SET status = 'LIVE' WHERE id = $1",
        [scheduled],
        /cannot become LIVE before starts_at/,
      );
      const live = await liveRow();
      await expectRejected(
        `UPDATE auctions SET status = 'ENDED', ended_at = now(), auction_event_sequence = auction_event_sequence + 1 WHERE id = $1`,
        [live],
        /cannot end before ends_at/,
      );
    });

    it('ending must be an event, must record the highest bid as the winner, and the outcome is final', async () => {
      const id = await overdueWithBids();
      const end = (set: string): Promise<unknown> =>
        app.db.query(
          `UPDATE auctions SET status = 'ENDED', ended_at = clock_timestamp(), ${set} WHERE id = $1`,
          [id],
        );
      await expectRejected(
        `UPDATE auctions SET status = 'ENDED', ended_at = clock_timestamp(), winning_bid_id = highest_bid_id WHERE id = $1`,
        [id],
        /ending an auction is an event/,
      );
      await assert.rejects(
        end('winning_bid_id = NULL, auction_event_sequence = auction_event_sequence + 1'),
        /winner must be the highest accepted bid/,
      );
      await assert.rejects(
        app.db.query(
          `UPDATE auctions SET status = 'ENDED', winning_bid_id = highest_bid_id, auction_event_sequence = auction_event_sequence + 1 WHERE id = $1`,
          [id],
        ),
        /auctions_ended_has_time/, // an ENDED auction needs its time
      );
      // Without its outbox row the transaction cannot even commit.
      await assert.rejects(
        end('winning_bid_id = highest_bid_id, auction_event_sequence = auction_event_sequence + 1'),
        /has no outbox event/,
      );
      await endAuctionRaw(app.db, id); // the proper way: control
      await expectRejected(
        'UPDATE auctions SET winning_bid_id = NULL WHERE id = $1',
        [id],
        /outcome of an ended auction never changes/,
      );
      await expectRejected(
        'UPDATE auctions SET ended_at = now() WHERE id = $1',
        [id],
        /outcome of an ended auction never changes/,
      );
    });

    it('ends_at moves only as a counted, forward, capped extension of a LIVE auction, as an event', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(90_000) });
      const ext = (set: string): Promise<unknown> =>
        app.db.query(`UPDATE auctions SET ${set} WHERE id = $1`, [id]);
      await assert.rejects(
        ext("ends_at = ends_at + interval '1 minute'"),
        /every extension must be counted/,
      );
      await assert.rejects(
        ext(
          "ends_at = ends_at - interval '1 minute', extension_count = 1, auction_event_sequence = auction_event_sequence + 1",
        ),
        /only move forward/,
      );
      await assert.rejects(
        ext("ends_at = ends_at + interval '1 minute', extension_count = 1"),
        /extension is an event/,
      );
      await assert.rejects(
        ext('extension_count = 1'),
        /extension_count cannot change without an extension/,
      );
      await assert.rejects(
        ext(
          "ends_at = ends_at + interval '2 hours', extension_count = 1, auction_event_sequence = auction_event_sequence + 1",
        ),
        /auctions_extension_cap/,
      );
      await assert.rejects(
        ext("original_ends_at = original_ends_at + interval '1 hour'"),
        /original_ends_at is frozen/,
      );
      // An extension without its outbox row cannot commit.
      await assert.rejects(
        ext(
          "ends_at = ends_at + interval '1 minute', extension_count = 1, auction_event_sequence = auction_event_sequence + 1",
        ),
        /has no outbox event/,
      );
      // A finished auction is never extended.
      await setAuctionEnd(app.db, id, "now() - interval '1 second'");
      await assert.rejects(
        ext(
          "ends_at = now() + interval '1 minute', extension_count = 1, auction_event_sequence = auction_event_sequence + 1",
        ),
        /finished auction cannot be extended|has no outbox event|auctions_extension_cap/,
      );
    });

    it('the extension limit is a table CHECK (at most 10)', async () => {
      const id = await liveAuction(api, seller.token, { endsAt: inFuture(90_000) });
      await assert.rejects(
        app.db.query('UPDATE auctions SET extension_count = 11 WHERE id = $1', [id]),
        /extension_count cannot change without an extension|auctions_extension_count_range/,
      );
    });

    it('original_ends_at follows ends_at while DRAFT and is frozen from publication', async () => {
      const created = await api('POST', '/auctions', {
        token: seller.token,
        body: auctionBody({ startsAt: inFuture(3_600_000), endsAt: inFuture(7_200_000) }),
      });
      const id = created.body.auction.id as string;
      const edited = await api('PATCH', `/auctions/${id}`, {
        token: seller.token,
        body: { endsAt: inFuture(10_800_000) },
      });
      assert.equal(edited.status, 200);
      const row = await auctionRow(id);
      assert.equal(row['original_ends_at'].getTime(), row['ends_at'].getTime());
      await api('POST', `/auctions/${id}/publish`, { token: seller.token });
      assert.equal((await auctionRow(id))['original_ends_at'].getTime(), row['ends_at'].getTime());
    });
  });
});
