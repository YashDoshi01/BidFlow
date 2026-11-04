import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  PASSWORD,
  makeClient,
  newUser,
  resetData,
  startApp,
  type Api,
  type TestApp,
} from './helpers.ts';

describe('auth (real PostgreSQL)', () => {
  let app: TestApp;
  let api: Api;

  before(async () => {
    app = await startApp();
    api = makeClient(app.base);
    await resetData(app.db);
  });
  after(async () => {
    await app.close();
  });

  it('registers a user and never returns or stores the plain password', async () => {
    const res = await api('POST', '/auth/register', {
      body: { email: ' Alice@Example.com ', password: PASSWORD, displayName: 'Alice' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, 'alice@example.com'); // trimmed + lower-cased
    assert.ok(!JSON.stringify(res.body).includes(PASSWORD));
    assert.ok(!('passwordHash' in res.body.user));
    const { rows } = await app.db.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE email = 'alice@example.com'",
    );
    assert.ok(rows[0]?.password_hash.startsWith('scrypt$'));
    assert.ok(!rows[0]?.password_hash.includes(PASSWORD));
  });

  it('rejects a duplicate email with 409 (case-insensitively)', async () => {
    const res = await api('POST', '/auth/register', {
      body: { email: 'ALICE@example.com', password: PASSWORD, displayName: 'Other' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EMAIL_TAKEN');
  });

  it('rejects bad input with 400 and field paths, never echoing the password', async () => {
    const res = await api('POST', '/auth/register', {
      body: { email: 'not-an-email', password: 'short', displayName: '', extra: 1 },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    assert.ok(res.body.error.details.length >= 3);
    assert.ok(!JSON.stringify(res.body).includes('short'));
  });

  it('answers malformed JSON with 400 INVALID_JSON and oversized bodies with 413', async () => {
    const bad = await api('POST', '/auth/login', { rawBody: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_JSON');
    const big = await api('POST', '/auth/login', {
      rawBody: JSON.stringify({ x: 'a'.repeat(20_000) }),
    });
    assert.equal(big.status, 413);
    assert.equal(big.body.error.code, 'PAYLOAD_TOO_LARGE');
  });

  it('login failures are identical for an unknown email and a wrong password', async () => {
    const wrong = await api('POST', '/auth/login', {
      body: { email: 'alice@example.com', password: 'wrong password!!' },
    });
    const unknown = await api('POST', '/auth/login', {
      body: { email: 'nobody@example.com', password: 'wrong password!!' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(wrong.body.error.message, unknown.body.error.message);
  });

  it('stores only a hash of the session token', async () => {
    const user = await newUser(api, 'hashcheck');
    const { rows } = await app.db.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.token_hash !== user.token && !r.token_hash.includes(user.token)));
  });

  it('GET /users/me works with a valid token and fails without one', async () => {
    const user = await newUser(api, 'me');
    const ok = await api('GET', '/users/me', { token: user.token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.id, user.id);
    assert.equal((await api('GET', '/users/me')).status, 401);
    assert.equal((await api('GET', '/users/me', { token: 'x'.repeat(43) })).status, 401);
    assert.equal(
      (await api('GET', '/users/me', { headers: { Authorization: 'Basic abc' } })).status,
      401,
    );
  });

  it('logout revokes the session server-side', async () => {
    const user = await newUser(api, 'logout');
    assert.equal((await api('POST', '/auth/logout', { token: user.token })).status, 204);
    const after = await api('GET', '/users/me', { token: user.token });
    assert.equal(after.status, 401);
  });

  it('an expired session is rejected', async () => {
    const user = await newUser(api, 'expiry');
    await app.db.query(
      `UPDATE sessions SET created_at = now() - interval '2 hours',
                           expires_at = now() - interval '1 hour'
        WHERE user_id = $1`,
      [user.id],
    );
    assert.equal((await api('GET', '/users/me', { token: user.token })).status, 401);
  });

  it('simultaneous registrations of one email produce exactly one account', async () => {
    const email = `race-${String(Date.now())}@example.com`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        api('POST', '/auth/register', { body: { email, password: PASSWORD, displayName: 'Race' } }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, ...Array<number>(9).fill(409)]);
    const { rows } = await app.db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    assert.equal(rows.length, 1);
  });

  it('error responses carry a request id matching the header and expose no internals', async () => {
    const res = await api('GET', '/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.requestId, res.headers.get('x-request-id'));
    assert.ok(!JSON.stringify(res.body).includes('stack'));
  });

  it('never writes passwords or tokens to the logs', async () => {
    const user = await newUser(api, 'logcheck');
    await api('GET', '/users/me', { token: user.token });
    const text = JSON.stringify(app.logs);
    assert.ok(app.logs.length > 0);
    assert.ok(!text.includes(PASSWORD));
    assert.ok(!text.includes(user.token));
  });
});
