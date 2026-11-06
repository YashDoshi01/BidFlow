// The lifecycle workers (`scheduler1`, `scheduler2`) as REAL containers: the same image as the API, a
// third command. They end auctions with no browser and no API instance involved; the outbox workers
// deliver the resulting events through Redis to sockets on both API containers.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import {
  liveAuction,
  makeClient,
  newUser,
  placeBid,
  setAuctionEnd,
} from '../integration/helpers.ts';
import { TestSocket } from '../integration/realtime-helpers.ts';
import {
  bothInstancesInRotation,
  compose,
  exitCodeOf,
  freshPool,
  logsOf,
  socketsOnBothInstances,
  until,
  urls,
} from './harness.ts';

interface User {
  token: string;
  id: string;
}

describe('lifecycle workers in containers', () => {
  const viaNginx = makeClient(`${urls.nginx}/api`);
  let pool: Pool;
  let seller: User;
  let alice: User;
  let bob: User;
  const open: TestSocket[] = [];

  before(async () => {
    pool = await freshPool(); // an earlier test restarted PostgreSQL: it may have a new port
    seller = await newUser(viaNginx, 'seller');
    alice = await newUser(viaNginx, 'alice');
    bob = await newUser(viaNginx, 'bob');
    await bothInstancesInRotation();
  });
  afterEach(async () => {
    open.splice(0).forEach((s) => {
      s.close();
    });
    await compose('start', 'scheduler1', 'scheduler2', 'worker1', 'worker2');
  });
  after(async () => {
    await compose('start', 'scheduler1', 'scheduler2', 'worker1', 'worker2').catch(() => undefined);
    await pool.end();
  });

  const status = async (id: string): Promise<string> =>
    (await pool.query<{ status: string }>('SELECT status FROM auctions WHERE id = $1', [id]))
      .rows[0]?.status ?? 'missing';
  const endedEvents = async (id: string): Promise<number> =>
    Number(
      (
        await pool.query<{ n: string }>(
          "SELECT count(*) AS n FROM outbox_events WHERE auction_id = $1 AND event_type = 'auction.ended'",
          [id],
        )
      ).rows[0]?.n,
    );

  /** A LIVE auction with two bids (alice 10.00, bob 11.00) whose end time is a second in the past. */
  async function overdue(): Promise<string> {
    const id = await liveAuction(viaNginx, seller.token);
    assert.equal((await placeBid(viaNginx, alice.token, id, '10.00')).status, 201);
    assert.equal((await placeBid(viaNginx, bob.token, id, '11.00')).status, 201);
    await setAuctionEnd(pool, id, "now() - interval '1 second'");
    return id;
  }

  it('two scheduler containers end every overdue auction exactly once, and watchers on BOTH API containers are told', async () => {
    const testStart = new Date().toISOString();
    const watched = await liveAuction(viaNginx, seller.token);
    const { api1, api2, spare } = await socketsOnBothInstances();
    open.push(api1, api2, ...spare);
    await api1.join(watched);
    await api2.join(watched);
    assert.equal((await placeBid(viaNginx, alice.token, watched, '10.00')).status, 201);
    await setAuctionEnd(pool, watched, "now() - interval '1 second'");

    const others: string[] = [];
    for (let i = 0; i < 4; i += 1) others.push(await overdue());

    await until(
      'every overdue auction is ENDED',
      async () => (await Promise.all([watched, ...others].map(status))).every((s) => s === 'ENDED'),
      60_000,
    );
    for (const id of [watched, ...others]) assert.equal(await endedEvents(id), 1, id);

    // The event travelled outbox -> Redis -> both API containers -> the watchers.
    for (const socket of [api1, api2]) {
      const ended = await socket.next('auction.ended', undefined, 60_000);
      assert.equal(ended.auctionId, watched);
      assert.equal(ended.data.winnerDisplayName, 'alice');
    }

    // The winner is told through the API (one request through NGINX).
    const notes = await viaNginx('GET', '/notifications', { token: bob.token });
    assert.equal(notes.status, 200);
    assert.equal(
      notes.body.items.filter((n: { type: string }) => n.type === 'auction_won').length,
      4,
    );

    // Both schedulers did work or idled, but never produced a duplicate end: one log line per ending.
    const lines = [...(await logsOf('scheduler1')), ...(await logsOf('scheduler2'))];
    assert.equal(
      lines.filter((l) => l.msg === 'auction lifecycle step' && l['kind'] === 'end').length,
      5,
    );
    // (Earlier tests stopped PostgreSQL on purpose, and the schedulers rightly logged errors then:
    // only what was logged during THIS test counts.)
    const errors = lines.filter(
      (l) => l.level === 'error' && typeof l['time'] === 'string' && l['time'] >= testStart,
    );
    assert.deepEqual(errors, []);
  });

  it('with every scheduler stopped nothing ends and bids are still refused; one scheduler then catches up and stops gracefully', async () => {
    await compose('stop', 'scheduler1', 'scheduler2');
    // SIGTERM was handled: they finished and exited 0.
    assert.equal(await exitCodeOf('scheduler1'), 0);
    assert.equal(await exitCodeOf('scheduler2'), 0);
    assert.ok(
      [...(await logsOf('scheduler1')), ...(await logsOf('scheduler2'))].filter(
        (l) => l.msg === 'shutting down',
      ).length >= 2,
    );

    const id = await overdue();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(await status(id), 'LIVE', 'nobody is ending it');
    // The bid path does not wait for a worker: it checks the clock itself.
    const late = await placeBid(viaNginx, alice.token, id, '50.00');
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'AUCTION_ENDED');

    await compose('start', 'scheduler1'); // ONE is enough
    await until('the auction ends', async () => (await status(id)) === 'ENDED', 60_000);
    assert.equal(await endedEvents(id), 1);
  });

  it('SIGKILL of both schedulers loses nothing: the restarted ones finish the work', async () => {
    const id = await overdue();
    await compose('kill', '-s', 'SIGKILL', 'scheduler1', 'scheduler2');
    const second = await overdue(); // becomes due while nobody is running
    await compose('start', 'scheduler1', 'scheduler2');
    await until(
      'both auctions end',
      async () => (await status(id)) === 'ENDED' && (await status(second)) === 'ENDED',
      60_000,
    );
    assert.equal(await endedEvents(id), 1);
    assert.equal(await endedEvents(second), 1);
  });
});
