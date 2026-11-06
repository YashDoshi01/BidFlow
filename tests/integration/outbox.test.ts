// The transactional outbox against a real PostgreSQL (and real sockets where delivery matters).
// The API runs WITHOUT its embedded publisher here: each test drives the publishers explicitly so it
// controls exactly when events are claimed, published, crashed or failed.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { bidAcceptedDataSchema, type DurableEvent } from '../../apps/api/src/events/events.ts';
import { createLogger } from '../../apps/api/src/logging/logger.ts';
import { createAuctionService } from '../../apps/api/src/modules/auctions/index.ts';
import { createBidService } from '../../apps/api/src/modules/bids/index.ts';
import {
  claimBatch,
  createOutboxPublisher,
  createSocketIoSink,
  listFailed,
  markPublished,
  outboxStats,
  pruneOutbox,
  retryFailed,
  type EventSink,
  type OutboxFaults,
  type OutboxPublisher,
} from '../../apps/api/src/modules/outbox/index.ts';
import { parseBidAccepted, parseSnapshot } from '../../apps/web/src/room/parseEvents.ts';
import { initialRoomState, needsResync, roomReducer } from '../../apps/web/src/room/roomState.ts';
import {
  acceptBidRaw,
  liveAuction,
  makeClient,
  newKey,
  newUser,
  placeBid,
  resetData,
  sleep,
  startApp,
  testDatabaseUrl,
  type Api,
  type TestApp,
} from './helpers.ts';
import { TestSocket } from './realtime-helpers.ts';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const silent = createLogger('error', () => undefined);

interface User {
  token: string;
  id: string;
}

interface Delivery {
  event: DurableEvent;
  start: number;
  end: number;
}

/** A sink that records every delivery (with timing) and can be slowed down or made to fail. */
function recordingSink(
  options: {
    delayMs?: () => number;
    failWhen?: (event: DurableEvent) => Error | undefined;
  } = {},
): EventSink & { deliveries: Delivery[] } {
  const deliveries: Delivery[] = [];
  return {
    deliveries,
    async publish(event) {
      const start = performance.now();
      const failure = options.failWhen?.(event);
      if (options.delayMs) await sleep(options.delayMs());
      if (failure) throw failure;
      deliveries.push({ event, start, end: performance.now() });
    },
  };
}

describe('transactional outbox (real PostgreSQL)', () => {
  let app: TestApp;
  let api: Api;
  let seller: User;
  let buyers: User[];

  before(async () => {
    app = await startApp({ outbox: false });
    api = makeClient(app.base);
  });
  beforeEach(async () => {
    await resetData(app.db);
    seller = await newUser(api, 'seller');
    buyers = [await newUser(api, 'b0'), await newUser(api, 'b1'), await newUser(api, 'b2')];
  });
  after(async () => {
    await app.close();
  });

  const buyer = (i = 0): User => buyers[i] as User;
  const publisher = (
    sink: EventSink,
    o: { id?: string; leaseSeconds?: number; maxAttempts?: number; faults?: OutboxFaults } = {},
  ): OutboxPublisher =>
    createOutboxPublisher({
      db: app.db,
      sink,
      logger: silent,
      workerId: o.id ?? 'test-worker',
      pollIntervalMs: 10,
      ...(o.leaseSeconds === undefined ? {} : { leaseSeconds: o.leaseSeconds }),
      ...(o.maxAttempts === undefined ? {} : { maxAttempts: o.maxAttempts }),
      ...(o.faults === undefined ? {} : { faults: o.faults }),
    });
  const rows = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => (await app.db.query<T>(sql, params)).rows;
  const untilDrained = async (ms = 20_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const left = await rows("SELECT 1 FROM outbox_events WHERE status <> 'published'");
      if (left.length === 0) return;
      await sleep(25);
    }
    throw new Error('the outbox did not drain');
  };
  /** n sequential accepted bids on a fresh LIVE auction. */
  const auctionWithBids = async (n: number): Promise<string> => {
    const id = await liveAuction(api, seller.token);
    for (let i = 0; i < n; i += 1) {
      const r = await placeBid(api, buyer(i % 3).token, id, `${String(10 + i)}.00`);
      assert.equal(r.status, 201);
    }
    return id;
  };

  describe('atomicity: the event is part of the bid transaction', () => {
    it("an accepted bid writes exactly one outbox row with the auction's next event sequence and a valid payload", async () => {
      const id = await liveAuction(api, seller.token);
      const first = await placeBid(api, buyer(0).token, id, '10.00');
      const second = await placeBid(api, buyer(1).token, id, '12.00');
      assert.equal(first.body.auction.eventSequence, '1');
      assert.equal(second.body.auction.eventSequence, '2');

      const events = await rows<{
        id: string;
        event_type: string;
        schema_version: number;
        auction_event_sequence: string;
        status: string;
        attempt_count: number;
        payload: unknown;
      }>(
        'SELECT id, event_type, schema_version, auction_event_sequence, status, attempt_count, payload FROM outbox_events WHERE auction_id = $1 ORDER BY auction_event_sequence',
        [id],
      );
      assert.equal(events.length, 2);
      events.forEach((e, i) => {
        assert.equal(e.event_type, 'bid.accepted');
        assert.equal(e.schema_version, 2);
        assert.equal(e.auction_event_sequence, (i + 1).toString());
        assert.equal(e.status, 'pending');
        assert.equal(e.attempt_count, 0);
        const data = bidAcceptedDataSchema.parse(e.payload);
        assert.equal(data.bidSequence, i + 1);
        assert.equal(data.bidId, [first, second][i]?.body.bid.id);
      });
      const [auction] = await rows<{ auction_event_sequence: string; bid_sequence: string }>(
        'SELECT auction_event_sequence, bid_sequence FROM auctions WHERE id = $1',
        [id],
      );
      assert.deepEqual(auction, { auction_event_sequence: '2', bid_sequence: '2' });
    });

    it('rejected bids and idempotent replays write nothing to the outbox', async () => {
      const id = await liveAuction(api, seller.token);
      const key = newKey();
      assert.equal((await placeBid(api, buyer(0).token, id, '10.00', key)).status, 201);
      const before = await rows('SELECT 1 FROM outbox_events');
      assert.equal(
        (await placeBid(api, buyer(0).token, id, '10.00', key)).headers.get('idempotent-replay'),
        'true',
      );
      assert.equal((await placeBid(api, buyer(1).token, id, '5.00')).status, 409); // too low
      assert.equal((await placeBid(api, seller.token, id, '99.00')).status, 403); // seller
      assert.equal((await placeBid(api, buyer(1).token, id, 'abc')).status, 400);
      assert.equal((await rows('SELECT 1 FROM outbox_events')).length, before.length);
      const [a] = await rows<{ auction_event_sequence: string }>(
        'SELECT auction_event_sequence FROM auctions WHERE id = $1',
        [id],
      );
      assert.equal(a?.auction_event_sequence, '1');
    });

    it('if the bid transaction fails AFTER the event was written, neither the bid, the event nor the counters exist', async () => {
      const id = await liveAuction(api, seller.token);
      const key = newKey();
      const service = createBidService(app.db, createAuctionService(app.db), {
        hooks: {
          // A concurrent request "wins" the idempotency key after our recheck: the transaction fails
          // at the very end, after the outbox row was inserted.
          afterIdempotencyRecheck: async () => {
            await app.db.query(
              `INSERT INTO idempotency_records
                 (user_id, operation, idempotency_key, request_hash, response_status, response_body, expires_at)
               VALUES ($1, 'place_bid', $2, $3, 201, '{}'::jsonb, now() + interval '1 day')`,
              [buyer(0).id, key, 'a'.repeat(64)],
            );
          },
        },
      });
      await assert.rejects(
        service.place({
          auctionId: id,
          userId: buyer(0).id,
          idempotencyKey: key,
          input: { amount: '10.00' },
        }),
        /IDEMPOTENCY_KEY_REUSED|already used/,
      );
      assert.equal((await rows('SELECT 1 FROM bids WHERE auction_id = $1', [id])).length, 0);
      assert.equal(
        (await rows('SELECT 1 FROM outbox_events WHERE auction_id = $1', [id])).length,
        0,
      );
      const [a] = await rows<{ auction_event_sequence: string; bid_sequence: string }>(
        'SELECT auction_event_sequence, bid_sequence FROM auctions WHERE id = $1',
        [id],
      );
      assert.deepEqual(a, { auction_event_sequence: '0', bid_sequence: '0' });
    });

    it('the DATABASE refuses to commit an advanced event sequence that has no outbox row', async () => {
      const id = await liveAuction(api, seller.token);
      const client = await app.db.connect();
      try {
        await client.query('BEGIN');
        await acceptBidRaw(client, {
          auctionId: id,
          bidderId: buyer(0).id,
          amount: '10.00',
          withOutbox: false,
        });
        await assert.rejects(client.query('COMMIT'), /has no outbox event/);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      assert.equal((await rows('SELECT 1 FROM bids WHERE auction_id = $1', [id])).length, 0);
      const [a] = await rows<{ auction_event_sequence: string }>(
        'SELECT auction_event_sequence FROM auctions WHERE id = $1',
        [id],
      );
      assert.equal(a?.auction_event_sequence, '0');
    });

    it("an outbox row needs the auction's CURRENT sequence and starts pending with no attempts", async () => {
      const id = await liveAuction(api, seller.token);
      await placeBid(api, buyer(0).token, id, '10.00');
      const insert = (seq: number, status = 'pending', attempts = 0): Promise<unknown> =>
        app.db.query(
          `INSERT INTO outbox_events (auction_id, event_type, schema_version, auction_event_sequence, payload, occurred_at, status, attempt_count)
           VALUES ($1, 'bid.accepted', 2, $2, '{}'::jsonb, now(), $3, $4)`,
          [id, seq, status, attempts],
        );
      await assert.rejects(insert(5), /current auction_event_sequence/);
      await assert.rejects(insert(0), /current auction_event_sequence|outbox_sequence_positive/);
      await assert.rejects(insert(1), /outbox_events_sequence_key|duplicate key/); // already used position
      await assert.rejects(insert(1, 'published', 0), /./);
    });

    it('the event is immutable; only delivery state changes, along the allowed transitions; only published rows are deletable', async () => {
      const id = await auctionWithBids(1);
      const [e] = await rows<{ id: string }>('SELECT id FROM outbox_events WHERE auction_id = $1', [
        id,
      ]);
      const eventId = e?.id;
      const update = (set: string): Promise<unknown> =>
        app.db.query(`UPDATE outbox_events SET ${set} WHERE id = $1`, [eventId]);
      await assert.rejects(update("payload = '{}'::jsonb"), /immutable/);
      await assert.rejects(update('auction_event_sequence = 9'), /immutable/);
      await assert.rejects(update("event_type = 'auction.ended'"), /immutable/);
      await assert.rejects(
        update("status = 'published', published_at = now()"),
        /illegal outbox status transition/,
      );
      await assert.rejects(update("status = 'failed'"), /illegal outbox status transition/);
      await assert.rejects(update("status = 'processing'"), /outbox_lease_when_processing/); // no lease given
      await assert.rejects(
        app.db.query('DELETE FROM outbox_events WHERE id = $1', [eventId]),
        /only published/,
      );

      await update(
        "status = 'processing', lease_owner = 'x', lease_until = now() + interval '1 minute'",
      );
      await assert.rejects(
        update("status = 'pending', lease_owner = 'x'"),
        /outbox_no_lease_otherwise/,
      );
      await update(
        "status = 'published', published_at = now(), lease_owner = NULL, lease_until = NULL",
      );
      await assert.rejects(
        update("status = 'pending', published_at = NULL"),
        /illegal outbox status transition/,
      );
      await assert.rejects(update('attempt_count = 5'), /illegal outbox status transition/);
      await app.db.query('DELETE FROM outbox_events WHERE id = $1', [eventId]); // published: allowed
    });

    it('the retry audit trail is append-only', async () => {
      await app.db.query(
        `INSERT INTO outbox_retry_audit (outbox_event_id, auction_id, auction_event_sequence, actor, reason, previous_attempt_count)
         VALUES (gen_random_uuid(), gen_random_uuid(), 1, 'tester', 'a valid reason', 3)`,
      );
      await assert.rejects(
        app.db.query("UPDATE outbox_retry_audit SET actor = 'someone else'"),
        /append-only/,
      );
      await assert.rejects(app.db.query('DELETE FROM outbox_retry_audit'), /append-only/);
      await assert.rejects(
        app.db.query(
          `INSERT INTO outbox_retry_audit (outbox_event_id, auction_id, auction_event_sequence, actor, reason, previous_attempt_count)
           VALUES (gen_random_uuid(), gen_random_uuid(), 1, 'tester', 'x', 0)`,
        ),
        /outbox_audit_reason_length/,
      );
    });
  });

  describe('claiming: leases, SKIP LOCKED, no transaction held while publishing', () => {
    it('claims only the lowest unpublished event of each auction, and nothing more while it is leased', async () => {
      const a = await auctionWithBids(3);
      const b = await auctionWithBids(2);
      const first = await claimBatch(app.db, { owner: 'w1/1', batchSize: 10, leaseSeconds: 30 });
      assert.deepEqual(
        first.map((r) => [r.auction_id, r.auction_event_sequence]).sort(),
        [
          [a, '1'],
          [b, '1'],
        ].sort(),
        'one event per auction: the head',
      );
      assert.ok(first.every((r) => r.attempt_count === 1));
      // While the heads are leased, later events of those auctions are NOT claimable.
      assert.equal(
        (await claimBatch(app.db, { owner: 'w2/1', batchSize: 10, leaseSeconds: 30 })).length,
        0,
      );
      const processing = await rows<{ lease_owner: string; leased_for_future: boolean }>(
        "SELECT lease_owner, lease_until > clock_timestamp() AS leased_for_future FROM outbox_events WHERE status = 'processing'",
      );
      assert.equal(processing.length, 2);
      assert.ok(processing.every((r) => r.lease_owner === 'w1/1' && r.leased_for_future));
    });

    // SKIP LOCKED is about LIVENESS, not safety: without it the claim would still be correct (the lock
    // wait ends in a re-check that finds the row taken), only a worker could sit idle behind another.
    // The deterministic proof: another transaction holds a row; the claim must not wait for it.
    it('a claim never waits for a row that another transaction has locked (SKIP LOCKED): it takes the other rows', async () => {
      const a = await auctionWithBids(1);
      const b = await auctionWithBids(1);
      const holder = await app.db.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM outbox_events WHERE auction_id = $1 FOR UPDATE', [a]);
        const outcome = await Promise.race([
          claimBatch(app.db, { owner: 'w/1', batchSize: 10, leaseSeconds: 30 }),
          sleep(1500).then(() => 'blocked' as const),
        ]);
        assert.notEqual(
          outcome,
          'blocked',
          'the claim waited for a locked row instead of skipping it',
        );
        assert.deepEqual(
          (outcome as { auction_id: string }[]).map((r) => r.auction_id),
          [b],
        );
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it('two workers claiming at the same instant never get the same event', async () => {
      for (let i = 0; i < 6; i += 1) await auctionWithBids(1);
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          claimBatch(app.db, { owner: `w${String(i)}/1`, batchSize: 3, leaseSeconds: 30 }),
        ),
      );
      const ids = claims.flat().map((r) => r.id);
      assert.equal(ids.length, new Set(ids).size, 'an event was claimed twice');
      assert.equal(ids.length, 6, 'all six heads were claimed, by someone');
    });

    it("a crashed worker's lease expires and another worker takes the event over (crash after claim)", async () => {
      const id = await auctionWithBids(1);
      const crashing = publisher(recordingSink(), {
        id: 'crasher',
        leaseSeconds: 1,
        faults: { crashAfterClaim: true },
      });
      assert.equal((await crashing.runOnce()).claimed, 1);
      const [held] = await rows<{ status: string; lease_owner: string }>(
        'SELECT status, lease_owner FROM outbox_events WHERE auction_id = $1',
        [id],
      );
      assert.equal(held?.status, 'processing');
      assert.match(held?.lease_owner ?? '', /^crasher\//);

      const sink = recordingSink();
      const healthy = publisher(sink, { id: 'healthy' });
      assert.equal((await healthy.runOnce()).claimed, 0, 'the lease has not expired yet');
      await sleep(1300);
      const result = await healthy.runOnce();
      assert.deepEqual(result, { claimed: 1, published: 1, failed: 0, leaseLost: 0 });
      assert.equal(sink.deliveries.length, 1);
      const [done] = await rows<{ status: string; attempt_count: number }>(
        'SELECT status, attempt_count FROM outbox_events WHERE auction_id = $1',
        [id],
      );
      assert.deepEqual(done, { status: 'published', attempt_count: 2 });
    });

    it('marking is conditional on the claim: a worker that lost its lease cannot overwrite the new owner', async () => {
      const id = await auctionWithBids(1);
      const [slow] = await claimBatch(app.db, { owner: 'slow/1', batchSize: 5, leaseSeconds: 1 });
      assert.ok(slow);
      await sleep(1300);
      const [fast] = await claimBatch(app.db, { owner: 'fast/1', batchSize: 5, leaseSeconds: 30 });
      assert.equal(fast?.id, slow.id);
      assert.equal(
        await markPublished(app.db, slow.id, 'slow/1'),
        false,
        'the old claim must be refused',
      );
      const [still] = await rows<{ status: string; lease_owner: string }>(
        'SELECT status, lease_owner FROM outbox_events WHERE auction_id = $1',
        [id],
      );
      assert.deepEqual(still, { status: 'processing', lease_owner: 'fast/1' });
      assert.equal(await markPublished(app.db, slow.id, 'fast/1'), true);
    });

    it('no database transaction is open while an event is being published', async () => {
      for (let i = 0; i < 4; i += 1) await auctionWithBids(1);
      const idleInTransaction: number[] = [];
      const sink: EventSink = {
        async publish() {
          // asked through a DIFFERENT connection, in the middle of the publish
          const r = await app.db.query<{ n: string }>(
            "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'",
          );
          idleInTransaction.push(Number(r.rows[0]?.n));
          await sleep(30);
        },
      };
      const result = await publisher(sink).runOnce();
      assert.equal(result.published, 4);
      assert.deepEqual(idleInTransaction, [0, 0, 0, 0]);
    });
  });

  describe('ordering across workers', () => {
    it('two concurrent workers never publish an event before the earlier events of its auction have been delivered', async () => {
      const auctions: string[] = [];
      for (let i = 0; i < 4; i += 1) auctions.push(await auctionWithBids(10));
      // Both workers share ONE log of deliveries; delays are random so that a worker holding event k+1
      // would overtake a slower worker holding event k, if that were allowed.
      const sink = recordingSink({ delayMs: () => Math.random() * 15 });
      const w1 = publisher(sink, { id: 'w1' });
      const w2 = publisher(sink, { id: 'w2' });
      w1.start();
      w2.start();
      await untilDrained();
      await Promise.all([w1.stop(), w2.stop()]);

      assert.equal(sink.deliveries.length, 40, 'every event once (no failures, no crashes)');
      for (const id of auctions) {
        const mine = sink.deliveries.filter((d) => d.event.auctionId === id);
        assert.deepEqual(
          mine.map((d) => d.event.sequence),
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          'delivery order must be sequence order',
        );
        for (let k = 1; k < mine.length; k += 1) {
          assert.ok(
            (mine[k - 1] as Delivery).end <= (mine[k] as Delivery).start,
            `event ${String(k + 1)} started before event ${String(k)} had finished`,
          );
        }
      }
    });

    it('different auctions are published in parallel (ordering is per auction, not global)', async () => {
      for (let i = 0; i < 3; i += 1) await auctionWithBids(1);
      const sink = recordingSink({ delayMs: () => 150 });
      const started = performance.now();
      const result = await publisher(sink).runOnce(); // one batch: three heads
      const elapsed = performance.now() - started;
      assert.equal(result.published, 3);
      assert.ok(
        elapsed < 400,
        `three 150 ms publishes took ${String(Math.round(elapsed))} ms: they ran one after another`,
      );
    });
  });

  describe('failures: retry, backoff, attempt limit, head-of-line blocking, manual retry', () => {
    it('a failed publish goes back to pending with a backoff, the attempt counted and a secret-free reason', async () => {
      const id = await auctionWithBids(1);
      const sink = recordingSink({
        failWhen: () => new Error('connect ECONNREFUSED redis://user:topsecret@10.0.0.9:6379'),
      });
      const result = await publisher(sink).runOnce();
      assert.deepEqual(result, { claimed: 1, published: 0, failed: 1, leaseLost: 0 });
      const [e] = await rows<{
        status: string;
        attempt_count: number;
        last_error: string;
        lease_owner: string | null;
        wait_seconds: string;
      }>(
        `SELECT status, attempt_count, last_error, lease_owner,
                extract(epoch FROM next_attempt_at - clock_timestamp()) AS wait_seconds
           FROM outbox_events WHERE auction_id = $1`,
        [id],
      );
      assert.equal(e?.status, 'pending');
      assert.equal(e?.attempt_count, 1);
      assert.equal(e?.lease_owner, null);
      const wait = Number(e?.wait_seconds);
      assert.ok(wait > 0 && wait <= 1.05, `backoff of ${String(wait)} s`);
      assert.match(e?.last_error ?? '', /ECONNREFUSED/);
      assert.ok(!(e?.last_error ?? '').includes('topsecret'), 'a secret leaked into last_error');
      // Not claimable again until the backoff has passed.
      assert.equal((await publisher(recordingSink()).runOnce()).claimed, 0);
    });

    it('after the attempt limit an event is FAILED, blocks the later events of ITS auction only, and a manual retry (audited) releases them in order', async () => {
      const blocked = await auctionWithBids(3);
      const healthy = await auctionWithBids(3);
      let broken = true;
      const sink = recordingSink({
        failWhen: (e) => (broken && e.auctionId === blocked ? new Error('boom') : undefined),
      });
      const w = publisher(sink, { maxAttempts: 2 });

      await w.runOnce(); // attempt 1: blocked#1 fails, healthy#1 published
      await sleep(1100); // backoff 1 s
      await w.runOnce(); // attempt 2: blocked#1 fails again -> FAILED
      const [failedRow] = await rows<{ status: string; attempt_count: number }>(
        'SELECT status, attempt_count FROM outbox_events WHERE auction_id = $1 AND auction_event_sequence = 1',
        [blocked],
      );
      assert.deepEqual(failedRow, { status: 'failed', attempt_count: 2 });

      // Drain everything that CAN go: the healthy auction completes, the blocked one does not move.
      for (let i = 0; i < 10; i += 1) await w.runOnce();
      const published = (id: string): number[] =>
        sink.deliveries.filter((d) => d.event.auctionId === id).map((d) => d.event.sequence);
      assert.deepEqual(published(healthy), [1, 2, 3]);
      assert.deepEqual(
        published(blocked),
        [],
        'head-of-line blocking: nothing of the blocked auction is delivered',
      );
      const stats = await outboxStats(app.db);
      assert.equal(stats.failed, 1);
      assert.equal(stats.pending, 2); // blocked#2 and #3 are waiting behind the failed head
      assert.equal((await listFailed(app.db)).length, 1);

      // Manual retry, with an audit trail.
      broken = false;
      const retried = await retryFailed(app.db, {
        actor: 'operator',
        reason: 'redis was misconfigured, fixed',
      });
      assert.equal(retried.length, 1);
      const audit = await rows<{
        actor: string;
        reason: string;
        previous_attempt_count: number;
        previous_error: string;
      }>('SELECT actor, reason, previous_attempt_count, previous_error FROM outbox_retry_audit');
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.actor, 'operator');
      assert.equal(audit[0]?.previous_attempt_count, 2);
      assert.match(audit[0]?.previous_error ?? '', /boom/);

      for (let i = 0; i < 10; i += 1) await w.runOnce();
      assert.deepEqual(published(blocked), [1, 2, 3], 'released, and in order');
      assert.equal((await outboxStats(app.db)).failed, 0);
    });

    it('retryFailed touches only FAILED events (a pending or published event is never reset)', async () => {
      await auctionWithBids(2);
      await publisher(recordingSink()).runOnce(); // one published, one pending
      const retried = await retryFailed(app.db, { actor: 'operator', reason: 'nothing is failed' });
      assert.equal(retried.length, 0);
      assert.equal((await rows('SELECT 1 FROM outbox_retry_audit')).length, 0);
    });

    it('a poison event (payload that breaks the contract) fails after its attempts without stopping the worker or other auctions', async () => {
      const poisoned = await liveAuction(api, seller.token);
      // Written by hand, bypassing the application's validation: a valid-looking row with a bad payload.
      const client = await app.db.connect();
      try {
        await client.query('BEGIN');
        await acceptBidRaw(client, {
          auctionId: poisoned,
          bidderId: buyer(0).id,
          amount: '10.00',
          withOutbox: false,
        });
        await client.query(
          `INSERT INTO outbox_events (auction_id, event_type, schema_version, auction_event_sequence, payload, occurred_at)
           VALUES ($1, 'bid.accepted', 2, 1, '{"amount": "not money"}'::jsonb, now())`,
          [poisoned],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const fine = await auctionWithBids(2);
      const sink = recordingSink();
      const w = publisher(sink, { maxAttempts: 1 });
      for (let i = 0; i < 6; i += 1) await w.runOnce();
      const [row] = await rows<{ status: string; last_error: string }>(
        'SELECT status, last_error FROM outbox_events WHERE auction_id = $1',
        [poisoned],
      );
      assert.equal(row?.status, 'failed');
      assert.match(row?.last_error ?? '', /ZodError|Invalid|amount/i);
      assert.deepEqual(
        sink.deliveries.filter((d) => d.event.auctionId === fine).map((d) => d.event.sequence),
        [1, 2],
      );
    });
  });

  describe('crashes and duplicate delivery (at-least-once)', () => {
    it('a worker that dies after publishing but before marking causes a SECOND delivery of the same event (same eventId)', async () => {
      const id = await auctionWithBids(1);
      const sink1 = recordingSink();
      const dying = publisher(sink1, {
        id: 'dying',
        leaseSeconds: 1,
        faults: { crashAfterPublish: true },
      });
      await dying.runOnce();
      assert.equal(sink1.deliveries.length, 1, 'it did deliver');
      const [after1] = await rows<{ status: string }>(
        'SELECT status FROM outbox_events WHERE auction_id = $1',
        [id],
      );
      assert.equal(after1?.status, 'processing', 'but it never recorded it');

      await sleep(1300);
      const sink2 = recordingSink();
      await publisher(sink2, { id: 'successor' }).runOnce();
      assert.equal(sink2.deliveries.length, 1);
      assert.equal(
        sink2.deliveries[0]?.event.eventId,
        sink1.deliveries[0]?.event.eventId,
        'same event id',
      );
      assert.deepEqual(
        sink2.deliveries[0]?.event,
        sink1.deliveries[0]?.event,
        'byte-for-byte the same message',
      );
      const [done] = await rows<{ status: string }>(
        'SELECT status FROM outbox_events WHERE auction_id = $1',
        [id],
      );
      assert.equal(done?.status, 'published');
    });

    it('a worker that comes back after its lease expired is refused (no overwrite) and its late delivery is a duplicate, not a lost update', async () => {
      const id = await auctionWithBids(1);
      const sinkLate = recordingSink({ delayMs: () => 1500 }); // slower than its 1 s lease
      const late = publisher(sinkLate, { id: 'late', leaseSeconds: 1 });
      const sinkThief = recordingSink();
      const thief = publisher(sinkThief, { id: 'thief' });
      const lateRun = late.runOnce();
      await sleep(1250);
      assert.deepEqual(await thief.runOnce(), {
        claimed: 1,
        published: 1,
        failed: 0,
        leaseLost: 0,
      });
      const result = await lateRun;
      assert.equal(
        result.leaseLost,
        1,
        'the slow worker found its lease gone when it tried to mark',
      );
      assert.equal(
        sinkLate.deliveries.length + sinkThief.deliveries.length,
        2,
        'delivered twice, never zero times',
      );
      const [row] = await rows<{ status: string }>(
        'SELECT status FROM outbox_events WHERE auction_id = $1',
        [id],
      );
      assert.equal(row?.status, 'published');
    });
  });

  describe('retention', () => {
    it('prune deletes only PUBLISHED events older than the retention; unpublished events are never touched', async () => {
      await auctionWithBids(2);
      await publisher(recordingSink()).runOnce(); // #1 published, #2 pending
      assert.equal(await pruneOutbox(app.db, 3600), 0, 'too recent to prune');
      await sleep(30);
      assert.equal(await pruneOutbox(app.db, 0), 1, 'the published one');
      const left = await rows<{ status: string }>('SELECT status FROM outbox_events');
      assert.deepEqual(left, [{ status: 'pending' }]);
    });

    it('stats report counts and the age of the oldest unpublished event', async () => {
      await auctionWithBids(2);
      await sleep(1100);
      await publisher(recordingSink()).runOnce();
      const stats = await outboxStats(app.db);
      assert.equal(stats.pending, 1);
      assert.equal(stats.failed, 0);
      assert.ok(stats.oldestUnpublishedSeconds >= 1);
    });
  });

  describe('the operator tool (scripts/outbox.ts)', () => {
    const cli = async (...args: string[]): Promise<{ stdout: string; code: number }> => {
      try {
        const { stdout } = await run(process.execPath, ['scripts/outbox.ts', ...args], {
          cwd: root,
          env: {
            ...process.env,
            DATABASE_URL: testDatabaseUrl(),
            REDIS_URL: process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379',
          },
        });
        return { stdout, code: 0 };
      } catch (error) {
        const e = error as { stdout?: string; code?: number };
        return { stdout: e.stdout ?? '', code: e.code ?? 1 };
      }
    };

    it('stats, failed and an audited retry work end to end, and a retry needs a reason', async () => {
      const id = await auctionWithBids(1);
      const sink = recordingSink({ failWhen: () => new Error('nope') });
      await publisher(sink, { maxAttempts: 1 }).runOnce(); // -> failed
      const stats = JSON.parse((await cli('stats')).stdout) as { failed: number };
      assert.equal(stats.failed, 1);
      assert.match((await cli('failed')).stdout, /1 failed event/);

      assert.equal((await cli('retry', '--all')).code, 2, 'no reason: refused');
      assert.equal(
        (await cli('retry', '--all', '--reason', 'x')).code,
        2,
        'a one-letter reason is not a reason',
      );
      const done = await cli('retry', '--all', '--reason', 'verified the sink is fixed');
      assert.equal(done.code, 0);
      assert.match(done.stdout, /retried 1 event/);
      const [row] = await rows<{ status: string; attempt_count: number }>(
        'SELECT status, attempt_count FROM outbox_events WHERE auction_id = $1',
        [id],
      );
      assert.deepEqual(row, { status: 'pending', attempt_count: 0 });
      const [audit] = await rows<{ actor: string; reason: string }>(
        'SELECT actor, reason FROM outbox_retry_audit',
      );
      assert.equal(audit?.actor, os.userInfo().username);
      assert.equal(audit?.reason, 'verified the sink is fixed');
    });
  });

  describe('clients: duplicates and gaps are repaired by the sequence rules (real sockets)', () => {
    const connect = async (): Promise<TestSocket> => TestSocket.connect(app.base);
    /** Feeds what a socket received into the web client's reducer, as the browser hook does. */
    const replay = (
      received: { name: string; payload: unknown }[],
      into = initialRoomState,
    ): typeof initialRoomState => {
      let state = into;
      for (const m of received) {
        if (m.name === 'auction.snapshot') {
          const s = parseSnapshot(m.payload);
          if (s) state = roomReducer(state, { type: 'snapshot', ...s });
        } else if (m.name === 'bid.accepted') {
          const accepted = parseBidAccepted(m.payload);
          if (accepted) state = roomReducer(state, { type: 'bid', accepted });
        }
      }
      return state;
    };

    it('every event delivered TWICE (the at-least-once case) leaves the client with each bid once', async () => {
      const id = await liveAuction(api, seller.token);
      const socket = await connect();
      await socket.join(id);
      const base = createSocketIoSink(app.io);
      const duplicating: EventSink = {
        async publish(event) {
          await base.publish(event);
          await base.publish(event); // the same message again
        },
      };
      const w = publisher(duplicating);
      for (let i = 0; i < 4; i += 1)
        await placeBid(api, buyer(i % 3).token, id, `${String(10 + i)}.00`);
      w.start();
      await untilDrained();
      await w.stop();
      await sleep(300);

      const received: { name: string; payload: unknown }[] = [];
      for (;;) {
        const snap = socket.pending('auction.snapshot')[0];
        if (snap) received.push(snap);
        break;
      }
      const events = socket.pending('bid.accepted');
      assert.equal(events.length, 8, 'each of the 4 events arrived twice');
      received.push(...events);
      const state = replay(received);
      assert.equal(state.bids.length, 4, 'each bid shown once');
      assert.equal(state.lastSequence, 4);
      assert.equal(needsResync(state), false);
      socket.close();
    });

    it('a DROPPED event is noticed as a gap, and re-joining repairs it from the snapshot', async () => {
      const id = await liveAuction(api, seller.token);
      const socket = await connect();
      await socket.join(id);
      const base = createSocketIoSink(app.io);
      const losing: EventSink = {
        publish: (event) => (event.sequence === 2 ? Promise.resolve() : base.publish(event)),
      };
      const w = publisher(losing);
      for (let i = 0; i < 4; i += 1)
        await placeBid(api, buyer(i % 3).token, id, `${String(10 + i)}.00`);
      w.start();
      await untilDrained();
      await w.stop();
      await sleep(300);

      const first = socket.pending('auction.snapshot')[0];
      assert.ok(first);
      let state = replay([first, ...socket.pending('bid.accepted')]);
      assert.equal(state.lastSequence, 1, 'event 2 never arrived, so 3 and 4 were NOT applied');
      assert.equal(needsResync(state), true, 'the gap is detected');

      // The client's reaction to a gap: join again, take the snapshot as the truth.
      await socket.join(id);
      const snapshot = await socket.next('auction.snapshot', (p) => p.sequence === 4);
      state = replay([{ name: 'auction.snapshot', payload: snapshot }], state);
      assert.equal(state.lastSequence, 4);
      assert.equal(needsResync(state), false);
      assert.equal(state.bids.length, 4, 'the lost event is in the snapshot');
      socket.close();
    });
  });
});
