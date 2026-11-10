// Phase 8: security, rate limiting, metrics, logs and shutdown, against real PostgreSQL, real Redis
// and real WebSockets. Rate limits are OFF by default in the other test files; here each describe
// block starts its own instances with the limits it needs.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Redis } from 'ioredis';
import { createRunningServer } from '../../apps/api/src/createServer.ts';
import { createPool } from '../../apps/api/src/db/pool.ts';
import { createLogger } from '../../apps/api/src/logging/logger.ts';
import { DEFAULT_RATE_LIMITS } from '../../apps/api/src/ratelimit/policies.ts';
import {
  PASSWORD,
  auctionBody,
  liveAuction,
  makeClient,
  newKey,
  newUser,
  placeBid,
  resetData,
  setAuctionEnd,
  sleep,
  startApp,
  testDatabaseUrl,
  type Api,
  type TestApp,
} from './helpers.ts';
import { TestSocket } from './realtime-helpers.ts';

function redisUrl(): string {
  const url = process.env['TEST_REDIS_URL'];
  if (!url) throw new Error('TEST_REDIS_URL is not set. Run: npm run test:integration');
  return url;
}

async function clearRateLimitKeys(): Promise<void> {
  const redis = new Redis(redisUrl());
  try {
    const keys = await redis.keys('bidflow:rl:*');
    if (keys.length > 0) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}

describe('authentication and authorization are enforced by the server', () => {
  let app: TestApp;
  let api: Api;
  let seller: { token: string; id: string };
  let buyer: { token: string; id: string };
  let auctionId: string;
  let draftId: string;

  before(async () => {
    app = await startApp();
    api = makeClient(app.base);
    await resetData(app.db);
    seller = await newUser(api, 'seller');
    buyer = await newUser(api, 'buyer');
    auctionId = await liveAuction(api, seller.token);
    const draft = await api('POST', '/auctions', { token: seller.token, body: auctionBody() });
    draftId = draft.body.auction.id as string;
  });
  after(async () => {
    await app.close();
  });

  const uuid = '00000000-0000-4000-8000-000000000000';

  it('every protected endpoint refuses a request without a session, and one with a bad token', async () => {
    const protectedRoutes: [string, string, unknown?][] = [
      ['POST', '/auth/logout'],
      ['GET', '/users/me'],
      ['POST', '/auctions', auctionBody()],
      ['PATCH', `/auctions/${uuid}`, { title: 'x' }],
      ['POST', `/auctions/${uuid}/publish`],
      ['POST', `/auctions/${uuid}/bids`, { amount: '10.00' }],
      ['GET', '/notifications'],
      ['POST', '/notifications/read-all'],
      ['POST', `/notifications/${uuid}/read`],
      ['GET', '/auctions?mine=true'],
    ];
    for (const [method, path, body] of protectedRoutes) {
      const none = await api(method, path, {
        ...(body === undefined ? {} : { body }),
        headers: { 'Idempotency-Key': newKey() },
      });
      assert.equal(none.status, 401, `${method} ${path} without a token`);
      assert.equal(none.body.error.code, 'UNAUTHENTICATED');
      const bad = await api(method, path, {
        token: 'x'.repeat(43),
        ...(body === undefined ? {} : { body }),
        headers: { 'Idempotency-Key': newKey() },
      });
      assert.equal(bad.status, 401, `${method} ${path} with an unknown token`);
    }
    // malformed Authorization headers are also just 401
    for (const header of [
      'Bearer',
      'Bearer ',
      'Basic abc',
      'bearer abcdefghijklmnopqrstuvwxyz',
      'Bearer a b',
    ]) {
      const res = await api('GET', '/users/me', { headers: { Authorization: header } });
      assert.equal(res.status, 401, header);
    }
  });

  it('the public read endpoints work without a session (and do not need one)', async () => {
    assert.equal((await api('GET', '/auctions')).status, 200);
    assert.equal((await api('GET', `/auctions/${auctionId}`)).status, 200);
    assert.equal((await api('GET', `/auctions/${auctionId}/bids`)).status, 200);
    assert.equal((await api('GET', '/health/live')).status, 200);
  });

  it('seller-only actions: another user cannot edit or publish (403 on a live auction, 404 on a draft)', async () => {
    const edit = await api('PATCH', `/auctions/${auctionId}`, {
      token: buyer.token,
      body: { title: 'hijacked' },
    });
    assert.equal(edit.status, 403);
    const editDraft = await api('PATCH', `/auctions/${draftId}`, {
      token: buyer.token,
      body: { title: 'hijacked' },
    });
    assert.equal(editDraft.status, 404, 'a draft that is not yours does not exist for you');
    const publish = await api('POST', `/auctions/${draftId}/publish`, { token: buyer.token });
    assert.equal(publish.status, 404);
    const { rows } = await app.db.query<{ title: string; status: string }>(
      'SELECT title, status FROM auctions WHERE id = ANY($1)',
      [[auctionId, draftId]],
    );
    assert.ok(rows.every((r) => r.title !== 'hijacked'));
    assert.equal(
      rows.find((r) => r.status === 'DRAFT') !== undefined,
      true,
      'the draft is still a draft',
    );
  });

  it('a seller cannot bid on their own auction; an anonymous visitor cannot bid', async () => {
    const own = await placeBid(api, seller.token, auctionId, '10.00');
    assert.equal(own.status, 403);
    assert.equal(own.body.error.code, 'BIDDER_IS_SELLER');
    assert.equal((await placeBid(api, undefined, auctionId, '10.00')).status, 401);
    const { rows } = await app.db.query('SELECT 1 FROM bids WHERE auction_id = $1', [auctionId]);
    assert.equal(rows.length, 0);
  });

  it('the acting user is the session, never the body: identity fields in a body are refused', async () => {
    const forged = await api('POST', '/auctions', {
      token: buyer.token,
      body: auctionBody({ sellerId: seller.id }),
    });
    assert.equal(forged.status, 400);
    const status = await api('POST', '/auctions', {
      token: buyer.token,
      body: auctionBody({ status: 'LIVE', currentPrice: '999.00' }),
    });
    assert.equal(status.status, 400);
    const bid = await api('POST', `/auctions/${auctionId}/bids`, {
      token: buyer.token,
      body: { amount: '10.00', bidderId: seller.id },
      headers: { 'Idempotency-Key': newKey() },
    });
    assert.equal(bid.status, 400);
    const ok = await placeBid(api, buyer.token, auctionId, '10.00');
    assert.equal(ok.status, 201);
    assert.equal(ok.body.bid.bidderId, buyer.id);
  });

  it("another user's notification cannot be read or marked: it looks like it does not exist", async () => {
    // make sure there is one to attack: the buyer was just outbid by nobody, so write one via a second bidder
    const rival = await newUser(api, 'rival');
    await placeBid(api, rival.token, auctionId, '11.00'); // outbids the buyer: a notification for the buyer
    const mine = await api('GET', '/notifications', { token: buyer.token });
    assert.ok(mine.body.items.length >= 1);
    const id = mine.body.items[0].id as string;
    const stolen = await api('POST', `/notifications/${id}/read`, { token: rival.token });
    assert.equal(stolen.status, 404);
    const stillUnread = await api('GET', '/notifications?unread=true', { token: buyer.token });
    assert.ok(stillUnread.body.items.some((n: { id: string }) => n.id === id));
  });

  it('a revoked session stops working at once, over REST and for a new socket', async () => {
    const user = await newUser(api, 'revoked');
    assert.equal((await api('GET', '/users/me', { token: user.token })).status, 200);
    assert.equal((await api('POST', '/auth/logout', { token: user.token })).status, 204);
    assert.equal((await api('GET', '/users/me', { token: user.token })).status, 401);
    await assert.rejects(TestSocket.connect(app.base, user.token), /UNAUTHENTICATED/);
  });

  it('rooms: a draft cannot be joined by a stranger or anonymously, only by its seller', async () => {
    const stranger = await TestSocket.connect(app.base, buyer.token);
    const anon = await TestSocket.connect(app.base);
    const owner = await TestSocket.connect(app.base, seller.token);
    try {
      assert.equal((await stranger.join(draftId)).ok, false);
      assert.equal((await stranger.join(draftId)).error?.code, 'NOT_FOUND');
      assert.equal((await anon.join(draftId)).ok, false);
      assert.equal((await owner.join(draftId)).ok, true);
      assert.equal((await anon.join(auctionId)).ok, true, 'a live auction is public');
    } finally {
      for (const s of [stranger, anon, owner]) s.close();
    }
  });

  it('a socket that sends a malformed join is refused, and the server stays up', async () => {
    const s = await TestSocket.connect(app.base, buyer.token);
    try {
      for (const bad of [
        null,
        {},
        { auctionId: 'nope' },
        { auctionId: 5 },
        'x',
        { auctionId: uuid, extra: 1 },
      ]) {
        const ack = await s.ack('auction.join', bad);
        assert.equal(ack.ok, false);
      }
      assert.equal((await s.join(auctionId)).ok, true);
    } finally {
      s.close();
    }
  });
});

describe('input limits and safe errors', () => {
  let app: TestApp;
  let api: Api;
  let user: { token: string; id: string };
  let auctionId: string;

  before(async () => {
    app = await startApp();
    api = makeClient(app.base);
    await resetData(app.db);
    const seller = await newUser(api, 'seller');
    user = await newUser(api, 'bidder');
    auctionId = await liveAuction(api, seller.token);
  });
  after(async () => {
    await app.close();
  });

  it('a body over 16 KB is 413 and is not parsed; invalid JSON is 400', async () => {
    const big = await api('POST', '/auctions', {
      token: user.token,
      rawBody: JSON.stringify({ title: 'x'.repeat(20_000) }),
    });
    assert.equal(big.status, 413);
    assert.equal(big.body.error.code, 'PAYLOAD_TOO_LARGE');
    const broken = await api('POST', '/auctions', { token: user.token, rawBody: '{"title":' });
    assert.equal(broken.status, 400);
    assert.equal(broken.body.error.code, 'INVALID_JSON');
  });

  it('money is a decimal string with at most 2 decimals; numbers, exponents and signs are refused', async () => {
    const attempts: unknown[] = [
      10,
      10.5,
      '1e3',
      '10.123',
      '-5',
      '+5',
      '0x10',
      '',
      ' 11',
      '11 ',
      'NaN',
      'Infinity',
      '١١',
      null,
      [],
      {},
    ];
    for (const amount of attempts) {
      const res = await placeBid(api, user.token, auctionId, amount);
      assert.equal(res.status, 400, `amount ${JSON.stringify(amount)} must be rejected`);
    }
    const { rows } = await app.db.query('SELECT 1 FROM bids');
    assert.equal(rows.length, 0);
  });

  it('hostile strings are data, never code: SQL, markup and control characters round-trip as text', async () => {
    const title = `'; DROP TABLE users; -- <img src=x onerror=alert(1)> \u0000`.replace(
      '\u0000',
      '',
    );
    const created = await api('POST', '/auctions', {
      token: user.token,
      body: auctionBody({ title }),
    });
    assert.equal(created.status, 201);
    // the server trims surrounding whitespace; everything else is stored exactly as sent
    assert.equal(created.body.auction.title, title.trim());
    const { rows } = await app.db.query('SELECT count(*)::int AS n FROM users');
    assert.ok((rows[0] as { n: number }).n >= 2, 'the users table still exists');
    const search = await api('GET', `/auctions?q=${encodeURIComponent("'; DROP")}`);
    assert.equal(search.status, 200);
  });

  it('path parameters must be UUIDs; query strings are validated and unknown keys refused', async () => {
    for (const path of [
      '/auctions/1',
      '/auctions/not-a-uuid',
      `/auctions/${'a'.repeat(200)}`,
      '/auctions/%00',
    ]) {
      assert.equal((await api('GET', path)).status, 400, path);
    }
    assert.equal((await api('GET', '/auctions?limit=abc')).status, 400);
    assert.equal((await api('GET', '/auctions?sellerId=x')).status, 400);
    assert.equal((await api('GET', '/auctions?__proto__=1')).status, 400);
  });

  it('Idempotency-Key must be well formed: missing, too short, odd characters', async () => {
    for (const key of [null, 'short', 'has space in it!!', 'x'.repeat(200), '../../etc/passwd']) {
      const res = await placeBid(api, user.token, auctionId, '10.00', key);
      assert.equal(res.status, 400, `key ${String(key)}`);
    }
  });

  it('errors never expose stack traces, file paths, SQL or internals', async () => {
    const responses = [
      await api('GET', '/nope'),
      await api('GET', '/auctions/zzz'),
      await api('POST', '/auctions', { token: user.token, rawBody: '{' }),
      await api('POST', '/auth/login', { body: { email: 'a@b.co', password: 'x'.repeat(20) } }),
    ];
    for (const r of responses) {
      const text = JSON.stringify(r.body);
      assert.ok(!/stack|at \w+ \(|node_modules|\.ts:|SELECT |pg_|ECONN/i.test(text), text);
      assert.ok(r.headers.get('x-request-id'));
    }
  });

  it('a replayed bid request returns the stored result and adds no bid', async () => {
    const key = newKey();
    const first = await placeBid(api, user.token, auctionId, '10.00', key);
    const again = await placeBid(api, user.token, auctionId, '10.00', key);
    assert.equal(first.status, 201);
    assert.equal(again.status, 201);
    assert.equal(again.headers.get('idempotent-replay'), 'true');
    assert.equal(again.body.bid.id, first.body.bid.id);
    const { rows } = await app.db.query('SELECT 1 FROM bids WHERE auction_id = $1', [auctionId]);
    assert.equal(rows.length, 1);
  });
});

describe('browser-facing policy: headers, CORS, WebSocket origin', () => {
  let app: TestApp;
  let api: Api;
  let seller: { token: string; id: string };
  let auctionId: string;

  before(async () => {
    app = await startApp({ allowedOrigins: ['http://localhost:5173'] });
    api = makeClient(app.base);
    await resetData(app.db);
    seller = await newUser(api, 'seller');
    auctionId = await liveAuction(api, seller.token);
  });
  after(async () => {
    await app.close();
  });

  it('every response carries the security headers, success and error alike', async () => {
    for (const res of [
      await api('GET', '/auctions'),
      await api('GET', '/nope'),
      await api('GET', '/health/live'),
      await api('GET', '/users/me'),
    ]) {
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.match(
        res.headers.get('content-security-policy') ?? '',
        /default-src 'none'.*frame-ancestors 'none'/,
      );
      assert.equal(res.headers.get('x-powered-by'), null);
    }
  });

  it('no CORS headers are ever sent, and a cross-origin preflight is not approved', async () => {
    const get = await fetch(`${app.base}/auctions`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(get.headers.get('access-control-allow-origin'), null);
    assert.equal(get.headers.get('access-control-allow-credentials'), null);
    const pre = await fetch(`${app.base}/auctions/${auctionId}/bids`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key',
      },
    });
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    assert.equal(pre.headers.get('access-control-allow-methods'), null);
    // Express answers OPTIONS itself (status 200, an Allow header). That is harmless: a browser only
    // lets the real request follow if the reply carries Access-Control-Allow-* headers, and it has none.
    assert.equal(pre.headers.get('access-control-allow-headers'), null);
  });

  it("WebSocket: a foreign page cannot connect; the page's own origin, a listed origin and non-browsers can", async () => {
    const own = app.base; // http://127.0.0.1:<port> is also the Host the client sends
    await assert.rejects(
      TestSocket.connect(app.base, undefined, { origin: 'https://evil.example' }),
    );
    await assert.rejects(TestSocket.connect(app.base, undefined, { origin: 'null' }));
    await assert.rejects(
      TestSocket.connect(app.base, undefined, { origin: 'http://localhost:5174' }),
    );
    for (const origin of [own, 'http://localhost:5173', undefined]) {
      const s = await TestSocket.connect(
        app.base,
        undefined,
        origin === undefined ? {} : { origin },
      );
      assert.equal((await s.join(auctionId)).ok, true, `origin ${String(origin)}`);
      s.close();
    }
    assert.ok(
      app.logs.some((l) => l['msg'] === 'websocket refused: origin not allowed'),
      'a refusal is logged',
    );
  });

  it('a refused origin is counted in the metrics', async () => {
    const text = await (await fetch(`${app.base}/metrics`)).text();
    assert.match(text, /bidflow_ws_connections_refused_total\{reason="origin"\} [1-9]/);
  });
});

describe('rate limiting (single process, in-memory counters)', () => {
  let app: TestApp;
  let api: Api;
  let seller: { token: string; id: string };

  before(async () => {
    app = await startApp({
      rateLimits: {
        enabled: true,
        bidUserMax: 3,
        bidAuctionMax: 6,
        // newUser() registers AND logs in; keep those out of the way. The login-by-email test below
        // counts that login too (1 + 3 wrong = the limit of 4).
        loginIpMax: 1000,
        loginEmailMax: 4,
        registerIpMax: 1000,
        readIpMax: 1000,
      },
    });
    api = makeClient(app.base);
    await resetData(app.db);
    seller = await newUser(api, 'seller');
  });
  after(async () => {
    await app.close();
  });

  it('bids: the 4th request in a window is 429 with Retry-After and rate-limit headers, and adds no bid', async () => {
    const id = await liveAuction(api, seller.token);
    const ann = await newUser(api, 'ann');
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await placeBid(api, ann.token, id, `${String(10 + i)}.00`);
      codes.push(res.status);
      if (res.status === 429) {
        assert.equal(res.body.error.code, 'RATE_LIMITED');
        assert.equal(res.body.error.data.policy, 'bid_user');
        assert.ok(Number(res.headers.get('retry-after')) >= 1);
        assert.equal(res.headers.get('ratelimit-limit'), '3');
        assert.equal(res.headers.get('ratelimit-remaining'), '0');
        assert.equal(res.body.error.requestId, res.headers.get('x-request-id'));
      }
    }
    assert.deepEqual(codes, [201, 201, 201, 429, 429]);
    const { rows } = await app.db.query('SELECT 1 FROM bids WHERE auction_id = $1', [id]);
    assert.equal(rows.length, 3, 'a limited request never reaches the bid transaction');
  });

  it('headers on a SUCCESSFUL bid describe the tightest budget (the user limit), not whichever limiter ran last', async () => {
    const id = await liveAuction(api, seller.token);
    const user = await newUser(api, 'headers');
    const res = await placeBid(api, user.token, id, '10.00');
    assert.equal(res.status, 201);
    assert.equal(
      res.headers.get('ratelimit-limit'),
      '3',
      'user limit 3 is tighter than auction 6 and address 1000',
    );
    assert.equal(res.headers.get('ratelimit-remaining'), '2');
  });

  it('bids: one user being limited does not limit another', async () => {
    const id = await liveAuction(api, seller.token);
    const ann = await newUser(api, 'ann');
    const bob = await newUser(api, 'bob');
    for (let i = 0; i < 4; i += 1) await placeBid(api, ann.token, id, `${String(10 + i)}.00`);
    assert.equal((await placeBid(api, ann.token, id, '20.00')).status, 429);
    assert.equal((await placeBid(api, bob.token, id, '20.00')).status, 201);
  });

  it('bids: the auction budget is shared by everyone, and per auction', async () => {
    const hot = await liveAuction(api, seller.token);
    const other = await liveAuction(api, seller.token);
    const users = [await newUser(api, 'u1'), await newUser(api, 'u2'), await newUser(api, 'u3')];
    let amount = 10;
    const statuses: number[] = [];
    // 3 users x 3 bids = 9 attempts; each is within its own per-user limit, but the auction allows 6.
    for (let round = 0; round < 3; round += 1) {
      for (const u of users) {
        statuses.push((await placeBid(api, u.token, hot, `${String(amount)}.00`)).status);
        amount += 1;
      }
    }
    assert.equal(statuses.filter((s) => s === 201).length, 6);
    const limited = statuses.filter((s) => s === 429);
    assert.equal(limited.length, 3);
    const blocked = await placeBid(api, users[0]?.token, hot, '99.00');
    assert.equal(blocked.status, 429);
    // another auction is unaffected
    assert.equal(
      (await placeBid(api, (await newUser(api, 'fresh')).token, other, '10.00')).status,
      201,
    );
  });

  it('bids: a user already limited does NOT use up the auction budget (user limit is checked first)', async () => {
    const id = await liveAuction(api, seller.token);
    const spammer = await newUser(api, 'spammer');
    const others = [await newUser(api, 'o1'), await newUser(api, 'o2'), await newUser(api, 'o3')];
    // 10 requests: 3 pass the user limit (and use 3 of the auction's 6); 7 are refused by the user limit.
    let amount = 10;
    for (let i = 0; i < 10; i += 1)
      await placeBid(api, spammer.token, id, `${String(amount++)}.00`);
    const results: number[] = [];
    for (const o of others)
      results.push((await placeBid(api, o.token, id, `${String(amount++)}.00`)).status);
    assert.deepEqual(
      results,
      [201, 201, 201],
      'the remaining 3 of the auction budget are still there',
    );
  });

  it('the limit is on attempts, including rejected ones (a script probing amounts is limited too)', async () => {
    const id = await liveAuction(api, seller.token);
    const probe = await newUser(api, 'probe');
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1)
      codes.push((await placeBid(api, probe.token, id, '0.01')).status);
    assert.deepEqual(codes, [409, 409, 409, 429]);
  });

  it('login: the same EMAIL is limited from any address; the email is case-insensitive', async () => {
    const victim = await newUser(api, 'victim');
    const { rows } = await app.db.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1',
      [victim.id],
    );
    const email = (rows[0] as { email: string }).email;
    const attempt = (e: string, password: string, ip: string) =>
      api('POST', '/auth/login', {
        body: { email: e, password },
        headers: { 'X-Forwarded-For': ip },
      });
    // X-Forwarded-For is ignored here (no trusted proxy), so every request is the same address;
    // the per-email limit is what is exercised by using a fresh address AND the loginIp budget is 4.
    assert.equal((await attempt(email, 'wrong-password-1', '1.1.1.1')).status, 401);
    assert.equal((await attempt(email.toUpperCase(), 'wrong-password-2', '2.2.2.2')).status, 401);
    assert.equal((await attempt(email, 'wrong-password-3', '3.3.3.3')).status, 401);
    const locked = await attempt(email, PASSWORD, '4.4.4.4'); // even the CORRECT password
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.data.policy, 'login_email');
  });

  it('login: one ADDRESS trying many accounts is limited', async () => {
    const own = await startApp({ rateLimits: { enabled: true, loginIpMax: 4 } });
    try {
      const client = makeClient(own.base);
      const codes: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await client('POST', '/auth/login', {
          body: { email: `nobody${String(i)}@example.com`, password: 'wrong-password-x' },
        });
        codes.push(res.status);
      }
      assert.deepEqual(codes, [401, 401, 401, 401, 429, 429]);
      assert.equal(
        (await client('GET', '/auctions')).status,
        200,
        'only login is limited, not everything',
      );
    } finally {
      await own.close();
    }
  });

  it('register: limited per address', async () => {
    const own = await startApp({ rateLimits: { enabled: true, registerIpMax: 2 } });
    try {
      const client = makeClient(own.base);
      const codes: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await client('POST', '/auth/register', {
          body: {
            email: `reg${String(i)}-${String(Date.now())}@example.com`,
            password: PASSWORD,
            displayName: 'R',
          },
        });
        codes.push(res.status);
      }
      assert.deepEqual(codes, [201, 201, 429, 429]);
    } finally {
      await own.close();
    }
  });
});

describe('rate limiting: reads, health, metrics and the client address', () => {
  it('reads are limited per address; health and metrics never are', async () => {
    const app = await startApp({ rateLimits: { enabled: true, readIpMax: 5 } });
    const api = makeClient(app.base);
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i += 1) codes.push((await api('GET', '/auctions')).status);
      assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
      for (let i = 0; i < 20; i += 1) {
        assert.equal((await api('GET', '/health/live')).status, 200);
        assert.equal((await api('GET', '/health/ready')).status, 200);
        assert.equal((await fetch(`${app.base}/metrics`)).status, 200);
      }
    } finally {
      await app.close();
    }
  });

  it('with no trusted proxy, X-Forwarded-For is ignored: a client cannot choose its own address', async () => {
    const app = await startApp({ rateLimits: { enabled: true, readIpMax: 3 }, trustProxyHops: 0 });
    const api = makeClient(app.base);
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        codes.push(
          (await api('GET', '/auctions', { headers: { 'X-Forwarded-For': `9.9.9.${String(i)}` } }))
            .status,
        );
      }
      assert.deepEqual(
        codes,
        [200, 200, 200, 429, 429],
        'spoofed addresses must not reset the limit',
      );
    } finally {
      await app.close();
    }
  });

  it('behind ONE trusted proxy, the address the proxy appended is the client; a spoofed prefix does not help', async () => {
    const app = await startApp({ rateLimits: { enabled: true, readIpMax: 3 }, trustProxyHops: 1 });
    const api = makeClient(app.base);
    const get = (xff: string) => api('GET', '/auctions', { headers: { 'X-Forwarded-For': xff } });
    try {
      // The client lies in the first entry; the proxy (trusted) appended the real address last.
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) codes.push((await get(`spoof${String(i)}, 7.7.7.7`)).status);
      assert.deepEqual(codes, [200, 200, 200, 429, 429]);
      assert.equal(
        (await get('8.8.8.8')).status,
        200,
        'a different real client has its own budget',
      );
    } finally {
      await app.close();
    }
  });
});

describe('rate limiting across instances (shared Redis counters)', () => {
  let a: TestApp;
  let b: TestApp;
  let privateA: TestApp;
  let privateB: TestApp;
  let apiA: Api;
  let apiB: Api;
  let seller: { token: string; id: string };

  before(async () => {
    const limits = { enabled: true, bidUserMax: 4 };
    a = await startApp({
      redisUrl: redisUrl(),
      instanceId: 'a',
      outbox: false,
      rateLimits: limits,
    });
    b = await startApp({
      redisUrl: redisUrl(),
      instanceId: 'b',
      outbox: false,
      rateLimits: limits,
    });
    privateA = await startApp({ instanceId: 'pa', outbox: false, rateLimits: limits });
    privateB = await startApp({ instanceId: 'pb', outbox: false, rateLimits: limits });
    apiA = makeClient(a.base);
    apiB = makeClient(b.base);
    await resetData(a.db);
    seller = await newUser(apiA, 'seller');
  });
  beforeEach(clearRateLimitKeys);
  after(async () => {
    for (const x of [a, b, privateA, privateB]) await x.close();
  });

  it('a user alternating between two instances gets ONE budget of 4, not 4 per instance', async () => {
    const id = await liveAuction(apiA, seller.token);
    const user = await newUser(apiA, 'alternating');
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const api = i % 2 === 0 ? apiA : apiB;
      statuses.push((await placeBid(api, user.token, id, `${String(10 + i)}.00`)).status);
    }
    assert.equal(statuses.filter((s) => s === 201).length, 4);
    assert.equal(statuses.filter((s) => s === 429).length, 4);
    assert.deepEqual(statuses, [201, 201, 201, 201, 429, 429, 429, 429]);
  });

  it('CONTROL: with private per-process counters the same traffic gets 4 per instance (8 in total)', async () => {
    const pa = makeClient(privateA.base);
    const pb = makeClient(privateB.base);
    const id = await liveAuction(pa, seller.token);
    const user = await newUser(pa, 'private');
    let accepted = 0;
    for (let i = 0; i < 10; i += 1) {
      const api = i % 2 === 0 ? pa : pb;
      if ((await placeBid(api, user.token, id, `${String(10 + i)}.00`)).status === 201)
        accepted += 1;
    }
    assert.equal(accepted, 8, 'this is the bug that shared counters exist to prevent');
  });

  it('concurrent requests to both instances never exceed the limit', async () => {
    const id = await liveAuction(apiA, seller.token);
    const user = await newUser(apiA, 'concurrent');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        placeBid(i % 2 === 0 ? apiA : apiB, user.token, id, `${String(10 + i)}.00`),
      ),
    );
    const passed = results.filter((r) => r.status !== 429).length;
    assert.equal(passed, 4, 'exactly the limit got through the limiter (atomic INCR)');
  });

  it('counters expire: the keys live in Redis with a TTL, and contain no email or token', async () => {
    const user = await newUser(apiA, 'ttl');
    const { rows } = await a.db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [
      user.id,
    ]);
    const email = (rows[0] as { email: string }).email;
    await apiA('POST', '/auth/login', { body: { email, password: 'wrong-password-1' } });
    const redis = new Redis(redisUrl());
    try {
      const keys = await redis.keys('bidflow:rl:*');
      assert.ok(keys.length > 0);
      for (const k of keys) {
        assert.ok(!k.includes('@'), `key ${k} must not contain an email`);
        assert.ok(!k.includes(user.token));
        assert.ok((await redis.pttl(k)) > 0, `key ${k} must have an expiry`);
      }
    } finally {
      redis.disconnect();
    }
  });
});

describe('rate limiting when Redis is unavailable (documented fallback)', () => {
  let app: TestApp;
  let api: Api;
  let seller: { token: string; id: string };

  before(async () => {
    // Nothing listens on port 1: every Redis call fails at once.
    app = await startApp({
      redisUrl: 'redis://127.0.0.1:1',
      outbox: false,
      rateLimits: { enabled: true, bidUserMax: 20, readIpMax: 3, loginEmailMax: 8 },
    });
    api = makeClient(app.base);
    await resetData(app.db);
    seller = await newUser(api, 'seller');
  });
  after(async () => {
    await app.close();
  });

  it('bids and logins use the conservative per-process limit (a quarter), and bidding still works', async () => {
    const id = await liveAuction(api, seller.token);
    const user = await newUser(api, 'fallback');
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1)
      statuses.push((await placeBid(api, user.token, id, `${String(10 + i)}.00`)).status);
    assert.deepEqual(
      statuses,
      [201, 201, 201, 201, 201, 429, 429, 429],
      'fallback limit is 5, not 20, not 0',
    );
    const refused = await placeBid(api, user.token, id, '99.00');
    assert.equal(refused.headers.get('ratelimit-limit'), '5');
  });

  it('reads are ALLOWED through while Redis is down (fail-open for reads)', async () => {
    for (let i = 0; i < 12; i += 1) assert.equal((await api('GET', '/auctions')).status, 200);
  });

  it('the decisions are counted as fallbacks and the outage is logged once', async () => {
    const text = await (await fetch(`${app.base}/metrics`)).text();
    assert.match(
      text,
      /bidflow_rate_limit_decisions_total\{decision="fallback_limited",policy="bid_user"\} [1-9]/,
    );
    assert.match(
      text,
      /bidflow_rate_limit_decisions_total\{decision="fallback_allowed",policy="read_ip"\} [1-9]/,
    );
    const warnings = app.logs.filter(
      (l) => l['msg'] === 'rate limit store unavailable: using per-process fallback limits',
    );
    assert.equal(warnings.length, 1, 'state change is logged once, not per request');
  });
});

describe('metrics', () => {
  let app: TestApp;
  let api: Api;
  let seller: { token: string; id: string };
  const TOKEN = 'metrics-token-0123456789abcdef';

  before(async () => {
    app = await startApp({ outbox: false, metricsToken: TOKEN, instanceId: 'metrics-test' });
    api = makeClient(app.base);
    await resetData(app.db);
    seller = await newUser(api, 'seller');
  });
  after(async () => {
    await app.close();
  });

  const scrape = async (): Promise<string> => {
    const res = await fetch(`${app.base}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain; version=0\.0\.4/);
    return res.text();
  };
  const value = (text: string, series: string): number => {
    const line = text.split('\n').find((l) => l.startsWith(`${series} `));
    return line === undefined ? Number.NaN : Number(line.slice(series.length + 1));
  };

  it('requires the bearer token when one is configured (and says nothing about why it refused)', async () => {
    const none = await fetch(`${app.base}/metrics`);
    assert.equal(none.status, 401);
    const wrong = await fetch(`${app.base}/metrics`, {
      headers: { Authorization: 'Bearer wrong-wrong-wrong-wrong' },
    });
    assert.equal(wrong.status, 401);
    assert.ok(!(await wrong.text()).includes(TOKEN));
  });

  it('counts bids by outcome, with transaction and lock-wait histograms', async () => {
    const id = await liveAuction(api, seller.token);
    const ann = await newUser(api, 'ann');
    const bob = await newUser(api, 'bob');
    const before = await scrape();
    const key = newKey();
    await placeBid(api, ann.token, id, '10.00', key);
    await placeBid(api, ann.token, id, '10.00', key); // replay
    await placeBid(api, bob.token, id, '10.50'); // too low
    await placeBid(api, seller.token, id, '20.00'); // seller
    const text = await scrape();
    const d = (s: string): number => value(text, s) - (value(before, s) || 0);
    assert.equal(d('bidflow_bid_attempts_total{outcome="accepted"}'), 1);
    assert.equal(d('bidflow_bid_attempts_total{outcome="replayed"}'), 1);
    assert.equal(d('bidflow_bid_attempts_total{outcome="BID_TOO_LOW"}'), 1);
    assert.equal(d('bidflow_bid_attempts_total{outcome="BIDDER_IS_SELLER"}'), 1);
    assert.match(text, /bidflow_bid_transaction_seconds_count\{outcome_class="accepted"\} [1-9]/);
    assert.match(text, /bidflow_bid_transaction_seconds_count\{outcome_class="rejected"\} [1-9]/);
    assert.match(text, /bidflow_bid_lock_wait_seconds_bucket\{le="\+Inf"\} [1-9]/);
  });

  it('labels are route PATTERNS: no auction id, user id, email or token ever becomes a label', async () => {
    const id = await liveAuction(api, seller.token);
    const user = await newUser(api, 'labels');
    await placeBid(api, user.token, id, '10.00');
    for (let i = 0; i < 25; i += 1)
      await api('GET', `/random/${String(i)}/${String(Math.random())}`);
    const text = await scrape();
    assert.match(
      text,
      /bidflow_http_requests_total\{method="POST",route="\/auctions\/:auctionId\/bids",status_class="2xx"\} [1-9]/,
    );
    assert.ok(!text.includes(id), 'an auction id must not appear in the metrics');
    assert.ok(
      !text.includes(user.id) && !text.includes(user.token) && !text.includes('@example.com'),
    );
    const unmatched = text
      .split('\n')
      .filter(
        (l) => l.startsWith('bidflow_http_requests_total{') && l.includes('route="unmatched"'),
      );
    assert.equal(
      unmatched.length <= 2,
      true,
      'random URLs share ONE label (a scanner cannot grow memory)',
    );
    const series = text
      .split('\n')
      .filter((l) => l.startsWith('bidflow_http_requests_total{')).length;
    assert.ok(series < 40, `series count stays small (${String(series)})`);
  });

  it('exposes live WebSocket connections and rooms, read at scrape time', async () => {
    const id = await liveAuction(api, seller.token);
    const before = value(await scrape(), 'bidflow_ws_connections');
    const s1 = await TestSocket.connect(app.base);
    const s2 = await TestSocket.connect(app.base);
    await s1.join(id);
    await s2.join(id);
    let text = await scrape();
    assert.equal(value(text, 'bidflow_ws_connections'), before + 2);
    assert.ok(value(text, 'bidflow_ws_rooms') >= 1);
    s1.close();
    for (let i = 0; i < 40 && value(text, 'bidflow_ws_connections') !== before + 1; i += 1) {
      await sleep(50);
      text = await scrape();
    }
    assert.equal(value(text, 'bidflow_ws_connections'), before + 1);
    s2.close();
    assert.match(text, /bidflow_ws_joins_total\{result="ok"\} [1-9]/);
  });

  it('outbox backlog, oldest age and failures come from PostgreSQL (no outbox worker is running here)', async () => {
    await app.db.query('TRUNCATE outbox_events CASCADE');
    const id = await liveAuction(api, seller.token);
    const u = await newUser(api, 'backlog');
    for (let i = 0; i < 3; i += 1) await placeBid(api, u.token, id, `${String(10 + i * 2)}.00`);
    const { rows } = await app.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM outbox_events WHERE status <> 'published'",
    );
    const expected = Number((rows[0] as { n: string }).n);
    assert.ok(expected >= 3);
    await sleep(1100);
    const text = await scrape();
    assert.equal(value(text, 'bidflow_outbox_backlog'), expected);
    assert.ok(value(text, 'bidflow_outbox_oldest_pending_age_seconds') >= 1);
    assert.equal(value(text, 'bidflow_outbox_failed'), 0);
    assert.equal(value(text, 'bidflow_metrics_db_up'), 1);
    await app.db
      .query(
        "UPDATE outbox_events SET status = 'failed' WHERE id = (SELECT id FROM outbox_events LIMIT 1)",
      )
      .catch(() => undefined);
  });

  it('an auction past its end that nobody ended shows as overdue (the lifecycle worker is behind)', async () => {
    const id = await liveAuction(api, seller.token);
    const base = await scrape();
    await setAuctionEnd(app.db, id, "clock_timestamp() - interval '30 seconds'");
    const text = await scrape();
    assert.equal(
      value(text, 'bidflow_auctions_overdue') - (value(base, 'bidflow_auctions_overdue') || 0),
      1,
    );
    assert.ok(value(text, 'bidflow_auctions_overdue_max_seconds') >= 29);
  });

  it('pool and process gauges are present; the scrape reports nothing about users', async () => {
    const text = await scrape();
    for (const name of [
      'bidflow_db_pool_connections',
      'bidflow_db_pool_idle',
      'bidflow_db_pool_waiting',
      'bidflow_eventloop_lag_p99_seconds',
      'bidflow_process_uptime_seconds',
      'bidflow_process_resident_memory_bytes',
    ]) {
      assert.ok(Number.isFinite(value(text, name)), name);
    }
    assert.ok(!/password|authorization|bearer/i.test(text));
  });
});

describe('logs: correlation ids, and nothing sensitive', () => {
  let app: TestApp;
  let api: Api;

  before(async () => {
    app = await startApp({ instanceId: 'log-test' });
    api = makeClient(app.base);
    await resetData(app.db);
  });
  after(async () => {
    await app.close();
  });

  it('a bid is traceable: request id, auction id, bid id, event sequence and instance are on its log lines', async () => {
    const seller = await newUser(api, 'seller');
    const bidder = await newUser(api, 'bidder');
    const id = await liveAuction(api, seller.token);
    const res = await placeBid(api, bidder.token, id, '10.00');
    assert.equal(res.status, 201);
    const requestId = res.headers.get('x-request-id');
    const lines = app.logs.filter((l) => l['requestId'] === requestId);
    const accepted = lines.find((l) => l['msg'] === 'bid accepted');
    assert.ok(accepted, 'the bid service line carries the request id without being given it');
    assert.equal(accepted['auctionId'], id);
    assert.equal(accepted['bidId'], res.body.bid.id);
    assert.equal(accepted['eventSequence'], res.body.auction.eventSequence);
    assert.equal(accepted['instance'], 'log-test');
    const request = lines.find((l) => l['msg'] === 'request');
    assert.ok(request);
    assert.equal(request['status'], 201);
    assert.equal(request['path'], `/auctions/${id}/bids`);
  });

  it('the outbox event is traceable too: event id, auction id and sequence at debug level', async () => {
    await sleep(300); // the embedded publisher delivers it
    const published = app.logs.filter((l) => l['msg'] === 'outbox event published');
    assert.ok(published.length >= 1);
    for (const l of published) {
      assert.equal(typeof l['eventId'], 'string');
      assert.equal(typeof l['auctionId'], 'string');
      assert.ok(Number.isInteger(l['sequence'] ?? Number.NaN) || typeof l['sequence'] === 'string');
    }
  });

  it('logs never contain passwords, tokens, Authorization headers, idempotency keys, amounts, query text or emails', async () => {
    const seller = await newUser(api, 'seller2');
    const bidder = await newUser(api, 'bidder2');
    const id = await liveAuction(api, seller.token);
    const key = `secret-key-${String(Date.now())}-abc`;
    const amount = '1234.56';
    await placeBid(api, bidder.token, id, amount, key);
    await api('GET', '/auctions?q=very-private-search-text', { token: bidder.token });
    await api('POST', '/auth/login', {
      body: { email: 'someone@example.com', password: 'hunter2-hunter2' },
    });
    await api('GET', '/users/me', { headers: { Authorization: `Bearer ${bidder.token}` } });
    const socket = await TestSocket.connect(app.base, bidder.token);
    await socket.join(id);
    socket.close();
    await sleep(300);
    const text = JSON.stringify(app.logs);
    for (const secret of [
      PASSWORD,
      'hunter2-hunter2',
      bidder.token,
      seller.token,
      key,
      'very-private-search-text',
      'someone@example.com',
      `"amount":"${amount}"`,
    ]) {
      assert.ok(!text.includes(secret), `a log line contains ${secret.slice(0, 12)}…`);
    }
    assert.ok(!/bearer /i.test(text));
    assert.ok(!text.includes(amount), 'the bid amount is business data and is not logged');
  });

  it('if a call site passes a secret by mistake, it is redacted before anything is written', () => {
    const lines: string[] = [];
    const logger = createLogger('debug', (l) => lines.push(l));
    logger.info('oops', {
      authorization: 'Bearer abc',
      nested: { password: 'p', ok: 1 },
      sessionToken: 't',
    });
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.equal(parsed['authorization'], '[redacted]');
    assert.equal(parsed['sessionToken'], '[redacted]');
    assert.deepEqual(parsed['nested'], { password: '[redacted]', ok: 1 });
  });
});

describe('WebSocket abuse limits', () => {
  it('a connection cannot flood auction.join: past the window limit it gets RATE_LIMITED, the rest of the system is fine', async () => {
    const app = await startApp({ maxJoinsPerWindow: 5 });
    const api = makeClient(app.base);
    try {
      const seller = await newUser(api, 'seller');
      const id = await liveAuction(api, seller.token);
      const flooder = await TestSocket.connect(app.base);
      const other = await TestSocket.connect(app.base);
      try {
        const acks = [];
        for (let i = 0; i < 8; i += 1) acks.push(await flooder.join(id));
        assert.deepEqual(
          acks.map((a) => a.ok),
          [true, true, true, true, true, false, false, false],
        );
        assert.equal(acks[5]?.error?.code, 'RATE_LIMITED');
        assert.equal((await other.join(id)).ok, true, 'another connection has its own budget');
      } finally {
        flooder.close();
        other.close();
      }
    } finally {
      await app.close();
    }
  });
});

describe('graceful shutdown', () => {
  /** A server built directly, so the test controls its readiness checks. */
  async function build(slowMs: number) {
    const db = createPool(testDatabaseUrl(), 5);
    const logs: Record<string, unknown>[] = [];
    const logger = createLogger('debug', (l) =>
      logs.push(JSON.parse(l) as Record<string, unknown>),
    );
    const running = createRunningServer({
      db,
      logger,
      sessionTtlSeconds: 3600,
      rateLimits: { ...DEFAULT_RATE_LIMITS, enabled: false },
      checks: [
        {
          name: 'slow',
          critical: false,
          run: async () => {
            await sleep(slowMs);
          },
        },
      ],
    });
    running.server.listen(0, '127.0.0.1');
    await new Promise((r) => running.server.once('listening', r));
    const port = (running.server.address() as { port: number }).port;
    return { db, running, logs, base: `http://127.0.0.1:${String(port)}` };
  }

  it('a request already running finishes with 200; new connections are refused afterwards; readiness says draining first', async () => {
    const { db, running, base } = await build(600);
    try {
      const inFlight = fetch(`${base}/health/ready`);
      await sleep(100); // the request is inside the slow check
      const stopping = running.shutdown({ drainMs: 300, graceMs: 5000 });
      await sleep(50);
      assert.equal(running.isDraining(), true);
      // during the drain delay the server is still listening and reports "draining"
      const ready = await fetch(`${base}/health/ready`);
      assert.equal(ready.status, 503);
      assert.equal(((await ready.json()) as { status: string }).status, 'draining');
      assert.equal(ready.headers.get('connection'), 'close');
      const live = await fetch(`${base}/health/live`);
      assert.equal(live.status, 200, 'liveness stays 200: the process is healthy, it is leaving');
      const finished = await inFlight;
      assert.equal(finished.status, 200, 'the in-flight request was not cut');
      await stopping;
      await assert.rejects(fetch(`${base}/health/live`), 'no new connections after shutdown');
    } finally {
      await db.end();
    }
  });

  it('WebSocket clients are disconnected by the server and see a disconnect, not a hang', async () => {
    const { db, running, base } = await build(0);
    try {
      const socket = await TestSocket.connect(base);
      await running.shutdown({ graceMs: 2000 });
      for (let i = 0; i < 40 && socket.disconnectReason === undefined; i += 1) await sleep(50);
      assert.ok(socket.disconnectReason !== undefined, 'the client was told the connection closed');
      socket.close();
    } finally {
      await db.end();
    }
  });

  it('a connection that will not close is cut at the deadline, so shutdown always finishes', async () => {
    const { db, running, base } = await build(5000);
    try {
      const stuck = fetch(`${base}/health/ready`).catch(() => undefined); // takes 5 s
      await sleep(100);
      const started = Date.now();
      await running.shutdown({ graceMs: 400 });
      assert.ok(Date.now() - started < 3000, 'shutdown did not wait for the 5 s request');
      await stuck;
    } finally {
      await db.end();
    }
  });
});
