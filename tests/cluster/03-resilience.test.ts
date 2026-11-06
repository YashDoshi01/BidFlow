// Failure behaviour with real containers. These tests restart or stop containers, so they run
// AFTER the others (file name order) and each one leaves the cluster healthy again.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { bidAcceptedEventSchema } from '../../apps/api/src/events/events.ts';
import { liveAuction, makeClient, newUser } from '../integration/helpers.ts';
import { TestSocket } from '../integration/realtime-helpers.ts';
import {
  bidWithRetry,
  bothInstancesInRotation,
  compose,
  databaseUrl,
  freshPool,
  directUrl,
  logsOf,
  readiness,
  sleep,
  socketsOnBothInstances,
  startedAt,
  until,
  urls,
} from './harness.ts';

interface User {
  token: string;
  id: string;
}

describe('cluster resilience (real containers)', () => {
  const viaNginx = makeClient(`${urls.nginx}/api`);
  const apiBase = `${urls.nginx}/api`;
  let pool: Pool;
  let seller: User;
  let buyers: User[];
  const open: TestSocket[] = [];

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
    // PostgreSQL is stopped on purpose below; an idle connection erroring must not crash the test run.
    pool.on('error', () => undefined);
    seller = await newUser(viaNginx, 'seller');
    buyers = [];
    for (let i = 0; i < 3; i += 1) buyers.push(await newUser(viaNginx, `buyer${String(i)}`));
  });
  afterEach(() => {
    open.splice(0).forEach((s) => {
      s.close();
    });
  });
  after(async () => {
    await pool.end();
  });

  const buyer = (i = 0): User => buyers[i] as User;
  const bidCount = async (auctionId: string): Promise<number> =>
    Number(
      (
        await pool.query<{ n: string }>('SELECT count(*) AS n FROM bids WHERE auction_id = $1', [
          auctionId,
        ])
      ).rows[0]?.n,
    );

  describe('Redis outage', () => {
    after(async () => {
      await compose('start', 'redis').catch(() => undefined);
    });

    it('bids keep working, both instances stay in rotation ("degraded", HTTP 200), no process restarts, and the events that could not be published are delivered LATE, after Redis returns', async () => {
      await bothInstancesInRotation();
      const id = await liveAuction(viaNginx, seller.token);
      const { api1, api2, spare } = await socketsOnBothInstances();
      open.push(api1, api2, ...spare);
      await api1.join(id);
      await api2.join(id);
      const started = [
        await startedAt('api1'),
        await startedAt('api2'),
        await startedAt('worker1'),
        await startedAt('worker2'),
      ];

      await compose('stop', 'redis');
      // Readiness reports Redis as down but stays 200: PostgreSQL is the critical dependency.
      await until('both instances report Redis down', async () => {
        const [r1, r2] = await Promise.all([
          readiness(await directUrl('api1')),
          readiness(await directUrl('api2')),
        ]);
        return r1.body?.status === 'degraded' && r2.body?.status === 'degraded';
      });
      for (const url of [await directUrl('api1'), await directUrl('api2')]) {
        const r = await readiness(url);
        assert.equal(r.status, 200, 'an instance with Redis down must stay in the balancer');
        assert.deepEqual(
          r.body.checks.map((c: { name: string; ok: boolean; critical: boolean }) => [
            c.name,
            c.ok,
            c.critical,
          ]),
          [
            ['postgres', true, true],
            ['redis', false, false],
          ],
        );
      }
      // Through NGINX both instances still answer.
      const seen = new Set<string>();
      for (let i = 0; i < 20; i += 1) {
        const res = await viaNginx('GET', '/health/live');
        assert.equal(res.status, 200);
        seen.add(res.headers.get('x-instance-id') ?? '');
      }
      assert.deepEqual([...seen].sort(), ['api1', 'api2']);

      // A bid is a PostgreSQL transaction: it commits, and its event is written to the outbox in the
      // same transaction. Redis is involved in neither.
      const direct1 = makeClient(await directUrl('api1'));
      const res = await direct1('POST', `/auctions/${id}/bids`, {
        token: buyer(0).token,
        body: { amount: '10.00' },
        headers: { 'Idempotency-Key': 'outage-key-0001' },
      });
      assert.equal(res.status, 201);

      // Nobody hears it for now: the workers cannot reach Redis. (Phase 4: sockets on the same
      // instance still did, the others never would. Now the event is DURABLE and merely late.)
      assert.equal((await api1.quiet(1500, 'bid.accepted')).length, 0);
      assert.equal((await api2.quiet(10, 'bid.accepted')).length, 0);
      const waiting = await pool.query<{ status: string }>(
        'SELECT status FROM outbox_events WHERE auction_id = $1',
        [id],
      );
      assert.equal(waiting.rows.length, 1, 'the event is in the outbox');
      assert.ok(
        ['pending', 'processing'].includes((waiting.rows[0] as { status: string }).status),
        'and it is not published',
      );

      await compose('start', 'redis');
      await until('Redis is back on both instances', async () => {
        const [r1, r2] = await Promise.all([
          readiness(await directUrl('api1')),
          readiness(await directUrl('api2')),
        ]);
        return r1.body?.status === 'ready' && r2.body?.status === 'ready';
      });

      // Without any restart or manual step, the workers retry (with backoff) and the event reaches
      // the sockets on BOTH instances, exactly once.
      assert.equal(
        bidAcceptedEventSchema.parse(await api1.next('bid.accepted', undefined, 60_000)).sequence,
        1,
      );
      assert.equal(
        bidAcceptedEventSchema.parse(await api2.next('bid.accepted', undefined, 10_000)).sequence,
        1,
      );
      const second = await direct1('POST', `/auctions/${id}/bids`, {
        token: buyer(1).token,
        body: { amount: '12.00' },
        headers: { 'Idempotency-Key': 'outage-key-0002' },
      });
      assert.equal(second.status, 201);
      for (const socket of [api1, api2]) {
        assert.equal(bidAcceptedEventSchema.parse(await socket.next('bid.accepted')).sequence, 2);
        assert.equal((await socket.quiet(300, 'bid.accepted')).length, 0);
      }
      await until('the outbox is empty again', async () => {
        const left = await pool.query("SELECT 1 FROM outbox_events WHERE status <> 'published'");
        return left.rows.length === 0;
      });

      // No process was restarted by the outage; the logs tell the story.
      assert.deepEqual(
        [
          await startedAt('api1'),
          await startedAt('api2'),
          await startedAt('worker1'),
          await startedAt('worker2'),
        ],
        started,
      );
      for (const service of ['api1', 'api2']) {
        const msgs = (await logsOf(service)).map((l) => l.msg);
        assert.ok(
          msgs.includes('redis connection lost (reconnecting with bounded backoff)'),
          service,
        );
        assert.ok(msgs.filter((m) => m === 'redis connection ready').length >= 3, service);
      }
      const workerMsgs = [...(await logsOf('worker1')), ...(await logsOf('worker2'))].map(
        (l) => l.msg,
      );
      assert.ok(
        workerMsgs.includes('redis connection lost (events stay in the outbox until it returns)'),
      );
    });
  });

  describe('API instance restart', () => {
    it('restarting api1 while bids and clients are active loses no bid, duplicates no bid, and clients come back', async () => {
      await bothInstancesInRotation();
      const id = await liveAuction(viaNginx, seller.token);

      // Clients through NGINX that follow the documented rules: join on every connect.
      const clients: TestSocket[] = [];
      for (let i = 0; i < 6; i += 1) {
        const s = await TestSocket.connect(urls.nginx, undefined, { reconnection: true });
        s.socket.on('connect', () => {
          s.socket.emit('auction.join', { auctionId: id });
        });
        await s.join(id);
        clients.push(s);
      }
      open.push(...clients);
      const before1 = (await logsOf('api1')).filter((l) => l.msg === 'api listening').length;

      // A steady stream of bids through NGINX, each with its own key, retried on 5xx/network errors.
      // The stream does not stop until the restart is over (and at least 40 bids were sent), so
      // bids are certainly in flight while the container stops and starts.
      let restartStarted = 0;
      let restartFinished = 0;
      const sent: { start: number; end: number }[] = [];
      const stream = (async () => {
        const results: { key: string; status: number; attempts: number }[] = [];
        for (let i = 0; restartFinished === 0 || i < 40; i += 1) {
          const key = `restart-key-${String(i).padStart(4, '0')}`;
          const start = Date.now();
          const r = await bidWithRetry(
            apiBase,
            buyer(i % 3).token,
            id,
            `${String(11 + i)}.00`,
            key,
          );
          sent.push({ start, end: Date.now() });
          results.push({ key, ...r });
          await sleep(60);
        }
        return results;
      })();

      await sleep(500);
      restartStarted = Date.now();
      await compose('restart', 'api1'); // SIGTERM, graceful shutdown, start again
      await until(
        'api1 is healthy again',
        async () => (await readiness(await directUrl('api1'))).status === 200,
        60_000,
      );
      restartFinished = Date.now();
      const results = await stream;
      const total = results.length;
      const overlapping = sent.filter((x) => x.start < restartFinished && x.end > restartStarted);
      assert.ok(
        overlapping.length >= 3,
        `only ${String(overlapping.length)} bids overlapped the restart: the test would prove nothing`,
      );

      // Every bid ended definitively; sequential increasing amounts, so all are accepted exactly once.
      assert.ok(
        results.every((r) => r.status === 201),
        JSON.stringify(results.filter((r) => r.status !== 201)),
      );
      assert.equal(await bidCount(id), total);
      const { rows } = await pool.query<{ amount: string; bid_sequence: string }>(
        'SELECT amount, bid_sequence FROM bids WHERE auction_id = $1 ORDER BY bid_sequence',
        [id],
      );
      rows.forEach((r, i) => {
        assert.equal(r.bid_sequence, String(i + 1));
        assert.equal(r.amount, `${String(11 + i)}.00`);
      });
      const retried = results.filter((r) => r.attempts > 1).length;
      console.log(
        `      (${String(retried)} of ${String(total)} bids needed a retry with the same key)`,
      );

      // The instance shut down gracefully and came back.
      const logs = await logsOf('api1');
      assert.ok(logs.some((l) => l.msg === 'shutting down'));
      assert.equal(logs.filter((l) => l.msg === 'api listening').length, before1 + 1);

      // Clients reconnected (to either instance) and are subscribed exactly once: the cluster-wide
      // count settles at exactly 6, and a final bid is heard once by every client.
      const probe = await TestSocket.connect(urls.nginx);
      open.push(probe);
      await probe.join(id);
      await probe.next('participant.count', (p) => p.data.count === 7, 20_000);
      // Above whatever the stream reached (it ran until the restart was over, however long that took).
      const finalAmount = `${String(11 + total + 10)}.00`;
      const final = await bidWithRetry(
        apiBase,
        buyer(0).token,
        id,
        finalAmount,
        'restart-key-final',
      );
      assert.equal(final.status, 201);
      for (const c of clients) {
        await c.next('bid.accepted', (p) => p.data.amount === finalAmount, 10_000);
      }
      for (const c of clients) {
        assert.equal(
          c.pending('bid.accepted').filter((e) => e.payload.data.amount === finalAmount).length,
          0,
        );
      }
      assert.equal(await bidCount(id), total + 1);
    });
  });

  describe('PostgreSQL outage', () => {
    after(async () => {
      await compose('start', 'postgres').catch(() => undefined);
    });

    it('is the CRITICAL dependency: readiness turns 503, liveness stays 200, and the service recovers by itself with the data intact', async () => {
      const id = await liveAuction(viaNginx, seller.token);
      assert.equal(
        (await bidWithRetry(apiBase, buyer(0).token, id, '10.00', 'pg-key-before-01')).status,
        201,
      );
      const started = [await startedAt('api1'), await startedAt('api2')];

      await compose('stop', 'postgres');
      await until('both instances report PostgreSQL down', async () => {
        const [r1, r2] = await Promise.all([
          readiness(await directUrl('api1')),
          readiness(await directUrl('api2')),
        ]);
        return r1.status === 503 && r2.status === 503;
      });
      const down = await readiness(await directUrl('api1'));
      assert.equal(down.body.status, 'unavailable');
      assert.equal(down.body.checks.find((c: { name: string }) => c.name === 'redis').ok, true);
      assert.equal(
        (await fetch(`${await directUrl('api1')}/health/live`)).status,
        200,
        'liveness must not depend on PostgreSQL',
      );
      const failing = await viaNginx('GET', '/auctions');
      assert.equal(failing.status, 500);
      assert.equal(failing.body.error.code, 'INTERNAL_ERROR'); // generic: no internals leak

      await compose('start', 'postgres');
      // The test's own connection pointed at the old published port.
      await pool.end().catch(() => undefined);
      pool = await freshPool();
      await until(
        'both instances are ready again',
        async () => {
          const [r1, r2] = await Promise.all([
            readiness(await directUrl('api1')),
            readiness(await directUrl('api2')),
          ]);
          return r1.status === 200 && r2.status === 200;
        },
        60_000,
      );

      // No restart of any API process was needed, and the committed bid survived.
      assert.deepEqual([await startedAt('api1'), await startedAt('api2')], started);
      assert.equal(await bidCount(id), 1);
      assert.equal(
        (await bidWithRetry(apiBase, buyer(1).token, id, '12.00', 'pg-key-after-001')).status,
        201,
      );
      assert.equal(await bidCount(id), 2);
    });
  });
});
