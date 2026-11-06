// The outbox with REAL worker containers (the same image as the API, a different command), real
// Redis, real NGINX, two API containers. These tests stop, kill and restart the workers.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { bidAcceptedEventSchema } from '../../apps/api/src/events/events.ts';
import { liveAuction, makeClient, newUser, placeBid } from '../integration/helpers.ts';
import { TestSocket } from '../integration/realtime-helpers.ts';
import {
  bidWithRetry,
  bothInstancesInRotation,
  compose,
  exitCodeOf,
  freshPool,
  logsOf,
  sleep,
  socketsOnBothInstances,
  until,
  urls,
} from './harness.ts';

interface User {
  token: string;
  id: string;
}

describe('outbox workers in containers', () => {
  const viaNginx = makeClient(`${urls.nginx}/api`);
  const apiBase = `${urls.nginx}/api`;
  let pool: Pool;
  let seller: User;
  let buyers: User[];
  const open: TestSocket[] = [];

  before(async () => {
    // An earlier test restarted PostgreSQL, which may have a new published port now.
    pool = await freshPool();
    seller = await newUser(viaNginx, 'seller');
    buyers = [];
    for (let i = 0; i < 3; i += 1) buyers.push(await newUser(viaNginx, `buyer${String(i)}`));
    await bothInstancesInRotation();
  });
  afterEach(async () => {
    open.splice(0).forEach((s) => {
      s.close();
    });
    // Whatever a test did to the workers, the next one starts with both running.
    await compose('start', 'worker1', 'worker2');
  });
  after(async () => {
    await compose('start', 'worker1', 'worker2').catch(() => undefined);
    await pool.end();
  });

  const buyer = (i = 0): User => buyers[i] as User;
  const sequencesOf = async (
    socket: TestSocket,
    count: number,
    timeoutMs = 60_000,
  ): Promise<number[]> => {
    const arrived: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const event = await socket.next('bid.accepted', undefined, timeoutMs);
      arrived.push(bidAcceptedEventSchema.parse(event).sequence);
    }
    return arrived;
  };
  const outboxOf = async (id: string): Promise<{ status: string; attempt_count: number }[]> =>
    (
      await pool.query<{ status: string; attempt_count: number }>(
        'SELECT status, attempt_count FROM outbox_events WHERE auction_id = $1 ORDER BY auction_event_sequence',
        [id],
      )
    ).rows;
  const untilPublished = async (id: string): Promise<void> => {
    await until(
      'the outbox of the auction is fully published',
      async () => (await outboxOf(id)).every((r) => r.status === 'published'),
      60_000,
    );
  };

  it('two worker containers publish every event once, in order, to clients on BOTH API containers', async () => {
    const id = await liveAuction(viaNginx, seller.token);
    const { api1, api2, spare } = await socketsOnBothInstances();
    open.push(api1, api2, ...spare);
    await api1.join(id);
    await api2.join(id);

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        placeBid(viaNginx, buyer(i % 3).token, id, `${String(11 + i)}.00`),
      ),
    );
    const accepted = results.filter((r) => r.status === 201).length;
    assert.ok(accepted >= 2);
    const expected = Array.from({ length: accepted }, (_, i) => i + 1);
    assert.deepEqual(await sequencesOf(api1, accepted), expected);
    assert.deepEqual(await sequencesOf(api2, accepted), expected);
    assert.equal((await api1.quiet(500, 'bid.accepted')).length, 0);
    await untilPublished(id);
    // Nothing failed, nothing was claimed twice: one attempt per event.
    assert.ok((await outboxOf(id)).every((r) => r.attempt_count === 1));
  });

  it('with EVERY worker stopped, bids still commit and events pile up; one worker starting delivers the backlog in order; workers stop gracefully', async () => {
    const id = await liveAuction(viaNginx, seller.token);
    const { api1, api2, spare } = await socketsOnBothInstances();
    open.push(api1, api2, ...spare);
    await api1.join(id);
    await api2.join(id);

    await compose('stop', 'worker1', 'worker2');
    // SIGTERM was handled: the worker finished what it was doing and exited with 0.
    assert.equal(await exitCodeOf('worker1'), 0);
    assert.equal(await exitCodeOf('worker2'), 0);
    const shutdowns = [...(await logsOf('worker1')), ...(await logsOf('worker2'))].filter(
      (l) => l.msg === 'shutting down',
    );
    assert.ok(shutdowns.length >= 2);

    for (let i = 0; i < 6; i += 1) {
      assert.equal(
        (await placeBid(viaNginx, buyer(i % 3).token, id, `${String(10 + i)}.00`)).status,
        201,
      );
    }
    assert.equal(
      (await api1.quiet(1500, 'bid.accepted')).length,
      0,
      'nobody can announce anything',
    );
    assert.deepEqual(
      (await outboxOf(id)).map((r) => r.status),
      Array<string>(6).fill('pending'),
      'six durable events are waiting',
    );

    await compose('start', 'worker1'); // ONE worker is enough
    const expected = [1, 2, 3, 4, 5, 6];
    assert.deepEqual(await sequencesOf(api1, 6), expected);
    assert.deepEqual(await sequencesOf(api2, 6), expected);
    await untilPublished(id);
  });

  it('both workers hard-killed (SIGKILL) in the middle of a stream of bids, then restarted: no event is lost and the order never regresses', async () => {
    const id = await liveAuction(viaNginx, seller.token);
    const { api1, api2, spare } = await socketsOnBothInstances();
    open.push(api1, api2, ...spare);
    await api1.join(id);
    await api2.join(id);
    const startsBefore = (await logsOf('worker1')).filter(
      (l) => l.msg === 'outbox worker started',
    ).length;

    const total = 40;
    const stream = (async () => {
      for (let i = 0; i < total; i += 1) {
        const r = await bidWithRetry(
          apiBase,
          buyer(i % 3).token,
          id,
          `${String(11 + i)}.00`,
          `kill-key-${String(i).padStart(4, '0')}`,
        );
        assert.equal(r.status, 201);
        await sleep(40);
      }
    })();
    await sleep(500);
    // SIGKILL: no chance to finish, release or mark anything. (`docker compose kill` counts as a
    // manual stop, so Docker does not restart the containers by itself; the explicit start below
    // stands in for the supervisor. Sending the signal from INSIDE the container does not work either:
    // Linux ignores SIGKILL sent to PID 1 from within its own namespace.)
    await compose('kill', '-s', 'SIGKILL', 'worker1', 'worker2');
    await sleep(1500);
    await compose('start', 'worker1', 'worker2');
    await stream;

    // Whatever the dead workers had claimed is taken over once its lease expires (3 s here).
    await untilPublished(id);
    const arrived: number[] = [];
    for (const socket of [api1, api2]) {
      arrived.length = 0;
      // Drain what arrived. Duplicates are allowed (a killed worker may have delivered an event it
      // never got to mark); a LOSS or a regression in order is not.
      for (let waited = 0; waited < 40; waited += 1) {
        const pending = socket.pending('bid.accepted');
        if (pending.length > 0 && new Set(pending.map((p) => p.payload.sequence)).size === total)
          break;
        await sleep(250);
      }
      const raw = socket
        .pending('bid.accepted')
        .map((p) => bidAcceptedEventSchema.parse(p.payload).sequence);
      assert.deepEqual(
        [...new Set(raw)],
        Array.from({ length: total }, (_, i) => i + 1),
        'no event lost',
      );
      for (let i = 1; i < raw.length; i += 1) {
        assert.ok(
          (raw[i] as number) >= (raw[i - 1] as number),
          `the order regressed at ${String(i)}: ${raw.join(',')}`,
        );
      }
      arrived.push(...raw);
    }
    const startsAfter = (await logsOf('worker1')).filter(
      (l) => l.msg === 'outbox worker started',
    ).length;
    assert.ok(startsAfter > startsBefore, 'worker1 was started again');
    console.log(
      `      (${String(arrived.length)} deliveries for ${String(total)} events: duplicates are the redelivery after the kill)`,
    );
  });

  it('a lease left behind by a dead worker holds the queue of that auction until it expires, then a live worker takes the event over', async () => {
    const id = await liveAuction(viaNginx, seller.token);
    const { api1, api2, spare } = await socketsOnBothInstances();
    open.push(api1, api2, ...spare);
    await api1.join(id);
    await compose('stop', 'worker1', 'worker2');
    assert.equal((await placeBid(viaNginx, buyer(0).token, id, '10.00')).status, 201);
    assert.equal((await placeBid(viaNginx, buyer(1).token, id, '12.00')).status, 201);

    // Exactly the state a crash leaves behind: event 1 claimed by a worker that no longer exists,
    // its lease valid for another 4 seconds. (A legal transition: pending -> processing.)
    await pool.query(
      `UPDATE outbox_events
          SET status = 'processing', lease_owner = 'ghost/1',
              lease_until = clock_timestamp() + interval '4 seconds', attempt_count = 1
        WHERE auction_id = $1 AND auction_event_sequence = 1`,
      [id],
    );
    const t0 = Date.now();
    await compose('start', 'worker1', 'worker2');

    // The live workers must leave it alone while the lease is valid, and event 2 waits behind it.
    assert.equal((await api1.quiet(2000, 'bid.accepted')).length, 0);
    assert.deepEqual(await sequencesOf(api1, 2), [1, 2], 'taken over, then in order');
    assert.ok(Date.now() - t0 >= 3500, 'the event was taken before its lease expired');
    await untilPublished(id);
    assert.deepEqual(
      (await outboxOf(id)).map((r) => r.attempt_count),
      [2, 1],
      'event 1: the dead worker, then the takeover; event 2: one attempt',
    );
  });

  it('the operator tool is part of the same image and reads the real outbox', async () => {
    const out = await compose('exec', '-T', 'worker2', 'node', 'scripts/outbox.ts', 'stats');
    const stats = JSON.parse(out) as { pending: number; processing: number; failed: number };
    assert.equal(typeof stats.pending, 'number');
    assert.equal(stats.failed, 0);
  });

  it('worker log lines say which worker wrote them, and the worker announces its settings', async () => {
    const lines = await logsOf('worker1');
    const started = lines.find((l) => l.msg === 'outbox worker started');
    assert.ok(started);
    assert.equal(started.instance, 'worker1');
    assert.equal(started['role'], 'outbox-worker');
    assert.equal(started['leaseSeconds'], 3);
    assert.ok(
      lines.every(
        (l) => l.instance === 'worker1' || l.source !== undefined || l.instance === undefined,
      ),
    );
  });
});
