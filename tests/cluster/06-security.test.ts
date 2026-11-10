// Phase 8 in real containers: the bid rate limit is ONE budget across two API containers (Redis
// counters), what happens to it when Redis stops and returns, the metrics endpoint is reachable
// on the container network but not through NGINX, and a stopped container drains and exits cleanly.
// Runs after the other files (file name order) and leaves the cluster healthy.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { liveAuction, makeClient, newUser, placeBid } from '../integration/helpers.ts';
import {
  bothInstancesInRotation,
  compose,
  freshPool,
  directUrl,
  exitCodeOf,
  logsOf,
  readiness,
  until,
  urls,
} from './harness.ts';

interface User {
  token: string;
  id: string;
}

/** The value of one series in a Prometheus text page (NaN if absent). */
function series(text: string, name: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return line === undefined ? Number.NaN : Number(line.slice(name.length + 1));
}

/** On failure, print what the containers were doing (a lost connection must be explainable). */
async function diagnosed(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error('--- container state at failure ---');
    console.error(await compose('ps', '-a').catch(() => 'ps failed'));
    for (const name of ['api1', 'api2']) {
      const recent = (await logsOf(name).catch(() => [])).filter(
        (l) => l['level'] === 'error' || l['level'] === 'warn' || l.msg === 'shutting down',
      );
      console.error(name, JSON.stringify(recent.slice(-8)));
    }
    throw error;
  }
}

describe('security and operations in the cluster (real containers)', () => {
  const viaNginx = makeClient(`${urls.nginx}/api`);
  let pool: Pool;
  let seller: User;

  before(async () => {
    // Not databaseUrl: an earlier file restarts PostgreSQL and Docker then publishes a NEW host port.
    pool = await freshPool();
    await bothInstancesInRotation();
    seller = await newUser(viaNginx, 'seller');
  });
  after(async () => {
    await compose('start', 'redis').catch(() => undefined);
    await compose('start', 'api1', 'api2').catch(() => undefined);
    await pool.end();
  });

  const scrape = async (instance: 'api1' | 'api2'): Promise<string> => {
    const res = await fetch(`${await directUrl(instance)}/metrics`);
    assert.equal(res.status, 200);
    return res.text();
  };

  it('the metrics page is on the container network, NOT behind NGINX', async () => {
    const through = await fetch(`${urls.nginx}/api/metrics`);
    assert.equal(through.status, 404);
    for (const instance of ['api1', 'api2'] as const) {
      const text = await scrape(instance);
      assert.match(text, /bidflow_http_requests_total/);
      assert.equal(series(text, 'bidflow_redis_up'), 1);
      assert.equal(series(text, 'bidflow_metrics_db_up'), 1);
    }
  });

  it('NGINX adds the security headers to the app and passes the API ones through', async () => {
    const app = await fetch(`${urls.nginx}/`);
    const csp = app.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(app.headers.get('x-frame-options'), 'DENY');
    assert.equal(app.headers.get('x-content-type-options'), 'nosniff');
    const api = await fetch(`${urls.nginx}/api/auctions`);
    assert.equal(api.headers.get('cache-control'), 'no-store');
    assert.match(api.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(api.headers.get('access-control-allow-origin'), null);
  });

  it("a WebSocket from a foreign origin is refused through NGINX; the page's own origin is accepted", async () => {
    const { TestSocket } = await import('../integration/realtime-helpers.ts');
    await assert.rejects(
      TestSocket.connect(urls.nginx, undefined, { origin: 'https://evil.example' }),
    );
    // The browser's own origin includes the port NGINX listens on: it only matches because NGINX
    // passes Host WITH the port ($http_host).
    const own = await TestSocket.connect(urls.nginx, undefined, { origin: urls.nginx });
    own.close();
  });

  it('ONE bid budget across both containers: 70 bids alternating between them, exactly 60 get through', () =>
    diagnosed(async () => {
      const id = await liveAuction(viaNginx, seller.token);
      const user = await newUser(viaNginx, 'budget');
      const bases = [await directUrl('api1'), await directUrl('api2')];
      const before = await Promise.all([scrape('api1'), scrape('api2')]);
      const statuses: number[] = [];
      const served = new Set<string>();
      for (let i = 0; i < 70; i += 1) {
        const api = makeClient(bases[i % 2] as string);
        const res = await placeBid(api, user.token, id, `${String(10 + i)}.00`);
        statuses.push(res.status);
        served.add(res.headers.get('x-instance-id') ?? '');
      }
      assert.deepEqual([...served].sort(), ['api1', 'api2']);
      assert.equal(
        statuses.filter((s) => s === 201).length,
        60,
        'the cluster limit is 60 per 10 s per user, in total (production default: 20)',
      );
      assert.equal(statuses.filter((s) => s === 429).length, 10);
      assert.deepEqual(
        statuses.slice(0, 60).every((s) => s === 201),
        true,
      );
      const { rows } = await pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM bids WHERE auction_id = $1',
        [id],
      );
      assert.equal(Number((rows[0] as { n: string }).n), 60);

      // The metrics of the two containers add up to exactly what the database holds.
      const after = await Promise.all([scrape('api1'), scrape('api2')]);
      const delta = (name: string): number =>
        [0, 1].reduce(
          (sum, i) =>
            sum +
            (series(after[i] as string, name) || 0) -
            (series(before[i] as string, name) || 0),
          0,
        );
      assert.equal(delta('bidflow_bid_attempts_total{outcome="accepted"}'), 60);
      assert.equal(
        delta('bidflow_rate_limit_decisions_total{decision="limited",policy="bid_user"}'),
        10,
      );
    }));

  describe('Redis stops and returns', () => {
    it('limits fall back to the conservative per-process value (15, a quarter of 60) while Redis is down, and return to 60 afterwards', async () => {
      const id = await liveAuction(viaNginx, seller.token);
      const user = await newUser(viaNginx, 'fallback');
      const api1 = makeClient(await directUrl('api1'));
      const api2 = makeClient(await directUrl('api2'));

      await compose('stop', 'redis');
      await until('both instances report Redis down', async () => {
        const [r1, r2] = await Promise.all([
          readiness(await directUrl('api1')),
          readiness(await directUrl('api2')),
        ]);
        return r1.body?.status === 'degraded' && r2.body?.status === 'degraded';
      });

      // Bidding still works (PostgreSQL decides), with the conservative limit on each instance.
      const first: number[] = [];
      let amount = 10;
      for (let i = 0; i < 18; i += 1)
        first.push((await placeBid(api1, user.token, id, `${String(amount++)}.00`)).status);
      assert.deepEqual(first, [...Array<number>(15).fill(201), 429, 429, 429]);
      const limited = await placeBid(api1, user.token, id, `${String(amount)}.00`);
      assert.equal(limited.headers.get('ratelimit-limit'), '15');
      // The other instance counts on its own: this is the documented price of the fallback. Three
      // instances at 15 each would still be 60 = the real limit.
      const second = (await placeBid(api2, user.token, id, `${String(amount++)}.00`)).status;
      assert.equal(
        second,
        201,
        'per-process fallback: the other instance has its own small budget',
      );

      const logs = await logsOf('api1');
      assert.ok(
        logs.some(
          (l) => l.msg === 'rate limit store unavailable: using per-process fallback limits',
        ),
      );

      await compose('start', 'redis');
      await until(
        'both instances report Redis up',
        async () => {
          const [r1, r2] = await Promise.all([
            readiness(await directUrl('api1')),
            readiness(await directUrl('api2')),
          ]);
          return r1.body?.status === 'ready' && r2.body?.status === 'ready';
        },
        60_000,
      );

      // After the reconnect and the short cooldown the shared counters are used again: a fresh user's
      // limit is 60 once more.
      await until(
        'the limit is 60 again',
        async () => {
          const fresh = await newUser(viaNginx, 'recovered');
          const res = await placeBid(api1, fresh.token, id, `${String(amount++)}.00`);
          return res.headers.get('ratelimit-limit') === '60';
        },
        30_000,
      );
      assert.ok(
        (await logsOf('api1')).some((l) => l.msg === 'rate limit store recovered'),
        'the recovery is logged',
      );
    });
  });

  describe('graceful stop', () => {
    it("a stopped container drains, closes its sockets, and exits 0 well inside Docker's 10 s grace period", async () => {
      const draining = (await logsOf('api2')).filter((l) => l.msg === 'draining').length;
      const started = Date.now();
      await compose('stop', 'api2');
      const took = Date.now() - started;
      assert.ok(
        took < 8000,
        `stop took ${String(took)} ms (a hung shutdown would be killed at 10 s)`,
      );
      assert.equal(await exitCodeOf('api2'), 0, 'exit code 0 = clean shutdown, 137 = killed');
      const after = await logsOf('api2');
      assert.ok(
        after.filter((l) => l.msg === 'draining').length > draining,
        'it announced draining',
      );
      assert.ok(after.some((l) => l.msg === 'shutting down'));
      await compose('start', 'api2');
      await bothInstancesInRotation();
    });
  });
});
