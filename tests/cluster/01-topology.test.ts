// Real containers: NGINX -> api1 + api2 -> PostgreSQL + Redis. No mocks, no in-process servers.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { bidAcceptedEventSchema } from '../../apps/api/src/events/events.ts';
import { liveAuction, makeClient, newUser, placeBid, type Api } from '../integration/helpers.ts';
import { TestSocket } from '../integration/realtime-helpers.ts';
import {
  databaseUrl,
  instanceHolding,
  directUrl,
  logsOf,
  socketsOnBothInstances,
  until,
  urls,
} from './harness.ts';

interface User {
  token: string;
  id: string;
}

describe('cluster topology (NGINX, two API containers, PostgreSQL, Redis)', () => {
  const viaNginx = makeClient(`${urls.nginx}/api`);
  let direct1: Api;
  let direct2: Api;
  let pool: Pool;
  let seller: User;
  let buyers: User[];
  const open: TestSocket[] = [];

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
    pool.on('error', () => undefined);
    direct1 = makeClient(await directUrl('api1'));
    direct2 = makeClient(await directUrl('api2'));
    seller = await newUser(viaNginx, 'seller');
    buyers = [];
    for (let i = 0; i < 4; i += 1) buyers.push(await newUser(viaNginx, `buyer${String(i)}`));
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

  it('both instances are ready, each names itself, and NGINX is up', async () => {
    for (const [name, api] of [
      ['api1', direct1],
      ['api2', direct2],
    ] as [string, Api][]) {
      const res = await api('GET', '/health/ready');
      assert.equal(res.status, 200, name);
      assert.equal(res.body.instance, name);
      assert.equal(res.headers.get('x-instance-id'), name);
      assert.deepEqual(
        res.body.checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]),
        [
          ['postgres', true],
          ['redis', true],
        ],
      );
    }
    const health = await fetch(`${urls.nginx}/nginx-health`);
    assert.equal(health.status, 200);
  });

  it('NGINX spreads REST requests over both instances; the serving instance is visible in X-Instance-Id', async () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 30; i += 1) {
      const res = await viaNginx('GET', '/health/live');
      assert.equal(res.status, 200);
      const instance = res.headers.get('x-instance-id') ?? 'none';
      seen.set(instance, (seen.get(instance) ?? 0) + 1);
    }
    assert.deepEqual([...seen.keys()].sort(), ['api1', 'api2']);
    assert.ok(
      [...seen.values()].every((n) => n >= 5),
      `uneven: ${JSON.stringify([...seen])}`,
    );
  });

  it('the API prefix is stripped and unknown paths still reach the API (404 from the API, not NGINX)', async () => {
    const res = await viaNginx('GET', '/definitely-not-a-route');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND'); // the API\'s JSON error, not an NGINX page
    assert.ok(res.headers.get('x-instance-id'));
  });

  it('the web app is served by NGINX (single-page fallback)', async () => {
    const root = await fetch(`${urls.nginx}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<div id="root">/);
    const deep = await fetch(`${urls.nginx}/auction/some-route`);
    assert.equal(deep.status, 200);
  });

  it('WebSocket upgrades pass through NGINX, connections spread over both instances, and the logs prove where each landed', async () => {
    const sockets: TestSocket[] = [];
    for (let i = 0; i < 10; i += 1) sockets.push(await TestSocket.connect(urls.nginx));
    open.push(...sockets);
    const where = new Map<string, number>();
    for (const s of sockets) {
      let instance: string | undefined;
      await until('socket appears in an instance log', async () => {
        instance = await instanceHolding(s.socket.id ?? '');
        return instance !== undefined;
      });
      where.set(instance ?? '?', (where.get(instance ?? '?') ?? 0) + 1);
      // the engine really used WebSocket (no polling fallback)
      assert.equal(s.socket.io.engine.transport.name, 'websocket');
    }
    assert.deepEqual([...where.keys()].sort(), ['api1', 'api2']);
    // least_conn keeps open connections balanced
    assert.ok(
      [...where.values()].every((n) => n >= 3),
      `unbalanced: ${JSON.stringify([...where])}`,
    );
  });

  it('HTTP long-polling is refused through NGINX too (so no sticky sessions are needed)', async () => {
    const res = await fetch(`${urls.nginx}/socket.io/?EIO=4&transport=polling`);
    assert.ok(res.status >= 400, `polling answered ${String(res.status)}`);
  });

  it('a client on api1 and a client on api2 receive the same event for a bid placed through NGINX', async () => {
    const id = await liveAuction(viaNginx, seller.token);
    const { api1, api2, spare } = await socketsOnBothInstances();
    open.push(api1, api2, ...spare);
    assert.equal(await instanceHolding(api1.socket.id ?? ''), 'api1');
    assert.equal(await instanceHolding(api2.socket.id ?? ''), 'api2');
    await api1.join(id);
    await api2.join(id);

    assert.equal((await placeBid(viaNginx, buyer(0).token, id, '10.00')).status, 201);
    const e1 = bidAcceptedEventSchema.parse(await api1.next('bid.accepted'));
    const e2 = bidAcceptedEventSchema.parse(await api2.next('bid.accepted'));
    assert.equal(e1.eventId, e2.eventId);

    // Through each instance directly as well (the publisher and the listener on different containers).
    assert.equal((await placeBid(direct1, buyer(1).token, id, '12.00')).status, 201);
    assert.equal(bidAcceptedEventSchema.parse(await api2.next('bid.accepted')).sequence, 2);
    assert.equal(bidAcceptedEventSchema.parse(await api1.next('bid.accepted')).sequence, 2);
    assert.equal((await placeBid(direct2, buyer(2).token, id, '14.00')).status, 201);
    assert.equal(bidAcceptedEventSchema.parse(await api1.next('bid.accepted')).sequence, 3);
    assert.equal(bidAcceptedEventSchema.parse(await api2.next('bid.accepted')).sequence, 3);

    // the same room is also visible to the instances' own logs: the bid was handled by 3 different
    // request paths, and the request log names the instance
    const handled = (await logsOf('api1')).filter(
      (l) => l.msg === 'request' && l['path'] === `/auctions/${id}/bids`,
    );
    assert.ok(handled.every((l) => l.instance === 'api1'));
  });

  it('participant.count counts sockets on BOTH containers', async () => {
    const id = await liveAuction(viaNginx, seller.token);
    const { api1, api2, spare } = await socketsOnBothInstances();
    open.push(api1, api2, ...spare);
    await api1.join(id);
    await api2.join(id);
    assert.equal((await api1.next('participant.count', (p) => p.data.count === 2)).data.count, 2);
    assert.equal((await api2.next('participant.count', (p) => p.data.count === 2)).data.count, 2);
    await api2.disconnectAndWait();
    assert.equal((await api1.next('participant.count', (p) => p.data.count === 1)).data.count, 1);
  });

  it('bids sent through NGINX concurrently are ordered by PostgreSQL, whichever container handled them', async () => {
    const id = await liveAuction(viaNginx, seller.token);
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        placeBid(viaNginx, buyer(i % 4).token, id, `${String(11 + i)}.00`),
      ),
    );
    const accepted = results.filter((r) => r.status === 201);
    assert.ok(results.every((r) => r.status === 201 || r.status === 409));
    const handledBy = new Set(results.map((r) => r.headers.get('x-instance-id')));
    assert.deepEqual([...handledBy].sort(), ['api1', 'api2'], 'both containers took part');
    const { rows } = await pool.query<{ amount: string; bid_sequence: string }>(
      'SELECT amount, bid_sequence FROM bids WHERE auction_id = $1 ORDER BY bid_sequence',
      [id],
    );
    assert.equal(rows.length, accepted.length);
    rows.forEach((r, i) => {
      assert.equal(r.bid_sequence, String(i + 1));
      if (i > 0)
        assert.ok(Number(r.amount) >= Number((rows[i - 1] as { amount: string }).amount) + 1);
    });
  });
});
