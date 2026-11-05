// Two API instances in one test process, sharing the real PostgreSQL and a real Redis
// (the Socket.IO adapter). They are separate Express/Socket.IO servers with separate
// connection pools, exactly like two processes except for the shared test runner.
// Real processes behind NGINX are tested separately in tests/cluster.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, afterEach, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { bidAcceptedEventSchema } from '../../apps/api/src/events/events.ts';
import {
  liveAuction,
  makeClient,
  newUser,
  placeBid,
  resetData,
  sleep,
  startApp,
  type Api,
  type TestApp,
} from './helpers.ts';
import { TestSocket } from './realtime-helpers.ts';

const run = promisify(execFile);

function redisUrl(): string {
  const url = process.env['TEST_REDIS_URL'];
  if (!url) throw new Error('TEST_REDIS_URL is not set. Run: npm run test:integration');
  return url;
}

/** Stops or starts ONLY the test stack's Redis container. */
async function redisContainer(action: 'stop' | 'start'): Promise<void> {
  const project = process.env['TEST_COMPOSE_PROJECT'];
  const file = process.env['TEST_COMPOSE_FILE'];
  if (!project || !file) throw new Error('TEST_COMPOSE_PROJECT / TEST_COMPOSE_FILE are not set');
  await run('docker', ['compose', '-p', project, '-f', file, action, 'redis'], {
    env: process.env,
  });
}

async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  ms = 20_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

interface User {
  token: string;
  id: string;
}

describe('two API instances, real PostgreSQL, real Redis', () => {
  let a: TestApp;
  let b: TestApp;
  let apiA: Api;
  let apiB: Api;
  let seller: User;
  let buyers: User[];
  const sockets: TestSocket[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  // Both instances have subscribed to Redis once each of them counts two servers.
  const clusterFormed = async (): Promise<void> => {
    await until('both instances see each other through Redis', async () => {
      const [x, y] = await Promise.all([
        a.io.of('/').adapter.serverCount(),
        b.io.of('/').adapter.serverCount(),
      ]);
      return x === 2 && y === 2;
    });
  };

  before(async () => {
    process.on('unhandledRejection', onUnhandled);
    a = await startApp({ redisUrl: redisUrl(), instanceId: 'inst-a' });
    b = await startApp({ redisUrl: redisUrl(), instanceId: 'inst-b' });
    apiA = makeClient(a.base);
    apiB = makeClient(b.base);
    await resetData(a.db);
    seller = await newUser(apiA, 'seller');
    buyers = [];
    for (let i = 0; i < 4; i += 1)
      buyers.push(await newUser(i % 2 === 0 ? apiA : apiB, `buyer${String(i)}`));
    await clusterFormed();
  });
  afterEach(() => {
    sockets.splice(0).forEach((s) => {
      s.close();
    });
  });
  after(async () => {
    process.off('unhandledRejection', onUnhandled);
    await a.close();
    await b.close();
  });

  const buyer = (i = 0): User => buyers[i] as User;
  const connectTo = async (app: TestApp): Promise<TestSocket> => {
    const s = await TestSocket.connect(app.base);
    sockets.push(s);
    return s;
  };

  it('a client on each instance receives the same committed event, whichever instance took the bid', async () => {
    const id = await liveAuction(apiA, seller.token);
    const onA = await connectTo(a);
    const onB = await connectTo(b);
    await onA.join(id);
    await onB.join(id);

    // Placed through instance B: the publisher is on B, one listener is on A.
    assert.equal((await placeBid(apiB, buyer(0).token, id, '10.00')).status, 201);
    const eventA = bidAcceptedEventSchema.parse(await onA.next('bid.accepted'));
    const eventB = bidAcceptedEventSchema.parse(await onB.next('bid.accepted'));
    assert.equal(eventA.eventId, eventB.eventId);
    assert.equal(eventA.data.amount, '10.00');

    // And the other way round.
    assert.equal((await placeBid(apiA, buyer(1).token, id, '12.00')).status, 201);
    assert.equal(bidAcceptedEventSchema.parse(await onA.next('bid.accepted')).sequence, 2);
    assert.equal(bidAcceptedEventSchema.parse(await onB.next('bid.accepted')).sequence, 2);

    // Exactly once per socket: the publishing instance does not hear its own message twice.
    assert.equal((await onA.quiet(400, 'bid.accepted')).length, 0);
    assert.equal((await onB.quiet(10, 'bid.accepted')).length, 0);
  });

  it('a socket on another instance and in another auction hears nothing', async () => {
    const watched = await liveAuction(apiA, seller.token);
    const other = await liveAuction(apiA, seller.token);
    const elsewhere = await connectTo(b);
    await elsewhere.join(other);
    const watcher = await connectTo(b);
    await watcher.join(watched);
    await placeBid(apiA, buyer(0).token, watched, '10.00');
    await watcher.next('bid.accepted');
    assert.equal((await elsewhere.quiet(400, 'bid.accepted')).length, 0);
  });

  it('participant.count is cluster-wide and follows joins, leaves and disconnects across instances', async () => {
    const id = await liveAuction(apiA, seller.token);
    const onA = await connectTo(a);
    const onB = await connectTo(b);
    await onA.join(id);
    await onB.join(id);
    assert.equal((await onA.next('participant.count', (p) => p.data.count === 2)).data.count, 2);
    assert.equal((await onB.next('participant.count', (p) => p.data.count === 2)).data.count, 2);

    const second = await connectTo(a);
    await second.join(id);
    assert.equal((await onB.next('participant.count', (p) => p.data.count === 3)).data.count, 3);

    await onB.disconnectAndWait();
    assert.equal((await onA.next('participant.count', (p) => p.data.count === 2)).data.count, 2);
    await second.leave(id);
    assert.equal((await onA.next('participant.count', (p) => p.data.count === 1)).data.count, 1);
  });

  it('bids sent to both instances at once: one global order in PostgreSQL, each accepted bid announced once everywhere', async () => {
    const id = await liveAuction(apiA, seller.token);
    const onA = await connectTo(a);
    const onB = await connectTo(b);
    await onA.join(id);
    await onB.join(id);

    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        placeBid(i % 2 === 0 ? apiA : apiB, buyer(i % 4).token, id, `${String(11 + i)}.00`),
      ),
    );
    const accepted = results.filter((r) => r.status === 201);
    assert.ok(accepted.length >= 1);
    assert.ok(results.every((r) => r.status === 201 || r.status === 409));

    // PostgreSQL (not either instance) decided: contiguous sequence, increasing prices.
    const { rows } = await a.db.query<{ amount: string; bid_sequence: string }>(
      'SELECT amount, bid_sequence FROM bids WHERE auction_id = $1 ORDER BY bid_sequence',
      [id],
    );
    assert.equal(rows.length, accepted.length);
    rows.forEach((r, i) => {
      assert.equal(r.bid_sequence, String(i + 1));
      if (i > 0)
        assert.ok(Number(r.amount) >= Number((rows[i - 1] as { amount: string }).amount) + 1);
    });

    for (const socket of [onA, onB]) {
      const seen = new Set<number>();
      for (let i = 0; i < accepted.length; i += 1) {
        seen.add(bidAcceptedEventSchema.parse(await socket.next('bid.accepted')).sequence);
      }
      assert.equal(seen.size, accepted.length);
      assert.equal((await socket.quiet(300, 'bid.accepted')).length, 0);
    }
  });

  it('every log line carries the instance id, and connections are logged for tracing', async () => {
    const id = await liveAuction(apiA, seller.token);
    const s = await connectTo(b);
    await s.join(id);
    assert.ok(a.logs.length > 0 && b.logs.length > 0);
    assert.ok(a.logs.every((l) => l['instance'] === 'inst-a'));
    assert.ok(b.logs.every((l) => l['instance'] === 'inst-b'));
    const connected = b.logs.find(
      (l) => l['msg'] === 'socket connected' && l['socketId'] === s.socket.id,
    );
    assert.ok(connected, 'the socket is traceable to the instance that holds it');
    assert.ok(!a.logs.some((l) => l['socketId'] === s.socket.id));
  });

  describe('Redis outage (Pub/Sub is not durable)', () => {
    after(async () => {
      await redisContainer('start').catch(() => undefined);
    });

    it('bids keep committing, same-instance clients still hear them, other instances miss them, nothing crashes; recovery needs only a re-join', async () => {
      const id = await liveAuction(apiA, seller.token);
      const onA = await connectTo(a);
      const onB = await connectTo(b);
      await onA.join(id);
      await onB.join(id);
      await placeBid(apiA, buyer(0).token, id, '10.00');
      await onA.next('bid.accepted');
      await onB.next('bid.accepted');
      const droppedBefore = a.redis?.droppedPublishes() ?? 0;
      const rejectionsBefore = unhandled.length;

      await redisContainer('stop');
      await until(
        'both instances notice Redis is gone',
        () => a.redis?.isUp() === false && b.redis?.isUp() === false,
      );

      // The bid is a PostgreSQL transaction: Redis is not involved in accepting it.
      const during = await placeBid(apiA, buyer(1).token, id, '12.00');
      assert.equal(during.status, 201, JSON.stringify(during.body));
      assert.equal(during.body.bid.bidSequence, '2');
      // Local delivery still works (the adapter delivers to this instance's sockets itself) ...
      assert.equal(bidAcceptedEventSchema.parse(await onA.next('bid.accepted')).sequence, 2);
      // ... but the other instance cannot be told: this loss is the documented limitation.
      assert.equal((await onB.quiet(800, 'bid.accepted')).length, 0);
      assert.ok(
        (a.redis?.droppedPublishes() ?? 0) > droppedBefore,
        'the failed publish was counted, not queued',
      );

      // The other instance keeps serving too.
      assert.equal((await placeBid(apiB, buyer(2).token, id, '14.00')).status, 201);
      assert.equal(bidAcceptedEventSchema.parse(await onB.next('bid.accepted')).sequence, 3);

      // A fresh join still works without Redis (the snapshot comes from PostgreSQL); the
      // participant count falls back to this instance's sockets.
      const late = await connectTo(a);
      assert.deepEqual(await late.join(id), { ok: true });
      assert.equal((await late.next('auction.snapshot')).sequence, 3);
      // The count is still announced: the other instances cannot be asked, so it falls back to
      // the sockets on this instance (onA and late), which is what the room on A can know.
      const fallback = await late.next('participant.count', undefined, 5000);
      assert.equal(fallback.data.count, 2);

      await redisContainer('start');
      await until(
        'both instances reconnect to Redis',
        () => a.redis?.isUp() === true && b.redis?.isUp() === true,
      );
      await clusterFormed();

      // Delivery across instances works again, with no restart and no manual step.
      assert.equal((await placeBid(apiA, buyer(3).token, id, '16.00')).status, 201);
      assert.equal(bidAcceptedEventSchema.parse(await onB.next('bid.accepted')).sequence, 4);

      // onB heard #1 (before the outage), #3 (placed through B) and #4 (after Redis returned) but
      // never #2 (published while Redis was down). Its reducer sees #3 after #1: a gap. It recovers
      // by joining again: the snapshot is the truth.
      await onB.join(id);
      const snapshot = await onB.next('auction.snapshot', (p) => p.sequence === 4);
      assert.deepEqual(
        snapshot.data.recentBids.map((x: { bidSequence: string }) => x.bidSequence),
        ['4', '3', '2', '1'],
      );
      assert.equal(
        unhandled.length,
        rejectionsBefore,
        'a Redis outage must not cause an unhandled rejection',
      );
    });
  });
});
