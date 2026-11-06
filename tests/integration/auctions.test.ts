import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  HOUR,
  auctionBody,
  inFuture,
  makeClient,
  newUser,
  resetData,
  startApp,
  type Api,
  type TestApp,
} from './helpers.ts';

describe('auctions (real PostgreSQL)', () => {
  let app: TestApp;
  let api: Api;
  let seller: { token: string; id: string };
  let other: { token: string; id: string };

  before(async () => {
    app = await startApp();
    api = makeClient(app.base);
    await resetData(app.db);
    seller = await newUser(api, 'seller');
    other = await newUser(api, 'other');
  });
  after(async () => {
    await app.close();
  });

  const createDraft = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const res = await api('POST', '/auctions', {
      token: seller.token,
      body: auctionBody(overrides),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.auction.id as string;
  };

  describe('create', () => {
    it('creates a DRAFT with defaults; the seller is the authenticated user', async () => {
      const res = await api('POST', '/auctions', { token: seller.token, body: auctionBody() });
      assert.equal(res.status, 201);
      const a = res.body.auction;
      assert.equal(a.status, 'DRAFT');
      assert.equal(a.sellerId, seller.id);
      assert.equal(a.currentPrice, '10.00');
      assert.equal(a.minimumIncrement, '1.00');
      assert.equal(a.currency, 'USD');
    });

    it('requires authentication', async () => {
      assert.equal((await api('POST', '/auctions', { body: auctionBody() })).status, 401);
    });

    it('rejects a client-supplied sellerId (tenant comes from the session)', async () => {
      const res = await api('POST', '/auctions', {
        token: seller.token,
        body: auctionBody({ sellerId: other.id }),
      });
      assert.equal(res.status, 400);
      const { rows } = await app.db.query('SELECT 1 FROM auctions WHERE seller_id = $1', [
        other.id,
      ]);
      assert.equal(rows.length, 0);
    });

    it('rejects bad money, bad currency and bad schedules', async () => {
      const cases: Record<string, unknown>[] = [
        { startingPrice: 10 }, // JSON number, not a decimal string
        { startingPrice: '10.001' },
        { startingPrice: '0.00' },
        { startingPrice: '-5' },
        { startingPrice: '1e3' },
        { minimumIncrement: '0' },
        { currency: 'usd' },
        { title: '   ' },
        { endsAt: inFuture(HOUR) }, // equals startsAt: shorter than 1 minute
        { endsAt: inFuture(HOUR + 31 * 24 * HOUR) }, // clearly longer than 30 days
        { startsAt: 'tomorrow' },
      ];
      for (const overrides of cases) {
        const res = await api('POST', '/auctions', {
          token: seller.token,
          body: auctionBody(overrides),
        });
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(overrides)}`);
        assert.equal(res.body.error.code, 'VALIDATION_FAILED');
      }
    });

    it('stores money exactly (no floating-point drift)', async () => {
      const id = await createDraft({ startingPrice: '0.10', minimumIncrement: '0.20' });
      const res = await api('GET', `/auctions/${id}`, { token: seller.token });
      assert.equal(res.body.auction.startingPrice, '0.10');
      assert.equal(res.body.auction.minimumIncrement, '0.20');
    });
  });

  describe('visibility and authorization', () => {
    it('a draft is visible to its seller only; others get 404, not 403', async () => {
      const id = await createDraft();
      assert.equal((await api('GET', `/auctions/${id}`, { token: seller.token })).status, 200);
      assert.equal((await api('GET', `/auctions/${id}`, { token: other.token })).status, 404);
      assert.equal((await api('GET', `/auctions/${id}`)).status, 404);
    });

    it('a malformed or unknown id is 400 / 404', async () => {
      assert.equal((await api('GET', '/auctions/not-a-uuid')).status, 400);
      const res = await api('GET', '/auctions/00000000-0000-4000-8000-000000000000');
      assert.equal(res.status, 404);
    });

    it('a non-owner cannot edit or publish: 404 for a draft, 403 for a published auction', async () => {
      const draft = await createDraft();
      assert.equal(
        (await api('PATCH', `/auctions/${draft}`, { token: other.token, body: { title: 'x' } }))
          .status,
        404,
      );
      assert.equal(
        (await api('POST', `/auctions/${draft}/publish`, { token: other.token })).status,
        404,
      );

      await api('POST', `/auctions/${draft}/publish`, { token: seller.token });
      assert.equal(
        (await api('PATCH', `/auctions/${draft}`, { token: other.token, body: { title: 'x' } }))
          .status,
        403,
      );
      assert.equal(
        (await api('POST', `/auctions/${draft}/publish`, { token: other.token })).status,
        403,
      );
      const { rows } = await app.db.query<{ title: string }>(
        'SELECT title FROM auctions WHERE id = $1',
        [draft],
      );
      assert.equal(rows[0]?.title, 'Vintage camera');
    });

    it('mutations require authentication', async () => {
      const id = await createDraft();
      assert.equal((await api('PATCH', `/auctions/${id}`, { body: { title: 'x' } })).status, 401);
      assert.equal((await api('POST', `/auctions/${id}/publish`)).status, 401);
    });
  });

  describe('update', () => {
    it('edits draft fields and keeps current_price equal to starting_price', async () => {
      const id = await createDraft();
      const res = await api('PATCH', `/auctions/${id}`, {
        token: seller.token,
        body: { title: 'New title', startingPrice: '25.50' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.auction.title, 'New title');
      assert.equal(res.body.auction.startingPrice, '25.50');
      assert.equal(res.body.auction.currentPrice, '25.50');
    });

    it('rejects an empty patch, unknown fields, and a patch that breaks the schedule', async () => {
      const id = await createDraft();
      const attempts = [
        {},
        { status: 'LIVE' },
        { currentPrice: '999.00' },
        { endsAt: inFuture(HOUR) },
      ];
      for (const body of attempts) {
        const res = await api('PATCH', `/auctions/${id}`, { token: seller.token, body });
        assert.equal(res.status, 400, JSON.stringify(body));
      }
    });

    it('cannot edit after publication (409), and the row is unchanged', async () => {
      const id = await createDraft();
      await api('POST', `/auctions/${id}/publish`, { token: seller.token });
      const res = await api('PATCH', `/auctions/${id}`, {
        token: seller.token,
        body: { title: 'hacked' },
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'INVALID_STATE');
      const { rows } = await app.db.query<{ title: string }>(
        'SELECT title FROM auctions WHERE id = $1',
        [id],
      );
      assert.equal(rows[0]?.title, 'Vintage camera');
    });
  });

  describe('publish', () => {
    it('a future start becomes SCHEDULED', async () => {
      const id = await createDraft();
      const res = await api('POST', `/auctions/${id}/publish`, { token: seller.token });
      assert.equal(res.status, 200);
      assert.equal(res.body.auction.status, 'SCHEDULED');
    });

    it('a start in the past (end still in the future) becomes LIVE immediately', async () => {
      const id = await createDraft({
        startsAt: new Date(Date.now() - HOUR).toISOString(),
        endsAt: inFuture(HOUR),
      });
      const res = await api('POST', `/auctions/${id}/publish`, { token: seller.token });
      assert.equal(res.body.auction.status, 'LIVE');
    });

    it('refuses to publish an auction whose end is already in the past', async () => {
      const id = await createDraft({
        startsAt: new Date(Date.now() - 3 * HOUR).toISOString(),
        endsAt: new Date(Date.now() - HOUR).toISOString(),
      });
      const res = await api('POST', `/auctions/${id}/publish`, { token: seller.token });
      assert.equal(res.status, 409);
      const { rows } = await app.db.query<{ status: string }>(
        'SELECT status FROM auctions WHERE id = $1',
        [id],
      );
      assert.equal(rows[0]?.status, 'DRAFT');
    });

    it('publishing twice is 409, not a second transition', async () => {
      const id = await createDraft();
      assert.equal(
        (await api('POST', `/auctions/${id}/publish`, { token: seller.token })).status,
        200,
      );
      assert.equal(
        (await api('POST', `/auctions/${id}/publish`, { token: seller.token })).status,
        409,
      );
    });

    it('concurrent publishes: exactly one wins', async () => {
      const id = await createDraft();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          api('POST', `/auctions/${id}/publish`, { token: seller.token }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, ...Array<number>(7).fill(409)]);
    });

    // Deterministic lock test (no timing luck): another connection holds the
    // row lock; the request MUST wait for it, then re-read the fresh state.
    // Found by mutation testing: removing FOR UPDATE survived the racing tests.
    for (const [label, call] of [
      ['publish', (id: string) => api('POST', `/auctions/${id}/publish`, { token: seller.token })],
      [
        'edit',
        (id: string) =>
          api('PATCH', `/auctions/${id}`, { token: seller.token, body: { title: 'late edit' } }),
      ],
    ] as const) {
      it(`${label} waits for the auction row lock and then sees the committed state`, async () => {
        const id = await createDraft({ title: 'locked' });
        const holder = await app.db.connect();
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [id]);
          let settled = false;
          const pending = call(id).then((r) => {
            settled = true;
            return r;
          });
          await new Promise((resolve) => setTimeout(resolve, 400));
          assert.equal(settled, false, `${label} must block while the row is locked`);
          await holder.query("UPDATE auctions SET status = 'CANCELLED' WHERE id = $1", [id]);
          await holder.query('COMMIT');
          const res = await pending;
          // It re-read the row after the lock: the auction is CANCELLED, so 409.
          assert.equal(res.status, 409, JSON.stringify(res.body));
          assert.equal(res.body.error.code, 'INVALID_STATE');
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          holder.release();
        }
        const { rows } = await app.db.query<{ status: string; title: string }>(
          'SELECT status, title FROM auctions WHERE id = $1',
          [id],
        );
        const row = rows[0];
        assert.ok(row);
        assert.equal(row.status, 'CANCELLED');
        assert.equal(row.title, 'locked');
      });
    }

    it('a concurrent PATCH and publish never leave an edit applied to a published auction', async () => {
      for (let i = 0; i < 20; i += 1) {
        const id = await createDraft({ title: 'before' });
        const [patch, publish] = await Promise.all([
          api('PATCH', `/auctions/${id}`, { token: seller.token, body: { title: 'after' } }),
          api('POST', `/auctions/${id}/publish`, { token: seller.token }),
        ]);
        assert.equal(publish.status, 200);
        assert.ok([200, 409].includes(patch.status), `patch status ${String(patch.status)}`);
        const { rows } = await app.db.query<{ title: string; status: string }>(
          'SELECT title, status FROM auctions WHERE id = $1',
          [id],
        );
        const row = rows[0];
        assert.ok(row);
        assert.equal(row.status, 'SCHEDULED');
        // Consistent either way: the edit is applied if and only if the PATCH said 200.
        assert.equal(row.title, patch.status === 200 ? 'after' : 'before');
      }
    });
  });

  describe('listing', () => {
    it('public listing excludes drafts; mine=true includes them; mine needs auth', async () => {
      await resetData(app.db);
      seller = await newUser(api, 'seller');
      other = await newUser(api, 'other');
      const draft = await createDraft({ title: 'draft one' });
      const pub = await createDraft({ title: 'public one' });
      await api('POST', `/auctions/${pub}/publish`, { token: seller.token });

      const pubList = await api('GET', '/auctions');
      assert.deepEqual(
        pubList.body.items.map((a: { id: string }) => a.id),
        [pub],
      );
      const otherList = await api('GET', '/auctions?mine=true', { token: other.token });
      assert.equal(otherList.body.items.length, 0);
      const mine = await api('GET', '/auctions?mine=true', { token: seller.token });
      assert.deepEqual(
        mine.body.items.map((a: { id: string }) => a.id).sort(),
        [draft, pub].sort(),
      );
      assert.equal((await api('GET', '/auctions?mine=true')).status, 401);
      assert.equal(
        (await api('GET', `/auctions?mine=true&sellerId=${other.id}`, { token: seller.token }))
          .status,
        400,
      );
      // Asking for DRAFT publicly does not leak drafts.
      assert.equal((await api('GET', '/auctions?status=DRAFT')).body.items.length, 0);
    });

    it('pages through every row exactly once, newest first, with bounded page size', async () => {
      await resetData(app.db);
      seller = await newUser(api, 'seller');
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const id = await createDraft({ title: `item ${String(i)}` });
        await api('POST', `/auctions/${id}/publish`, { token: seller.token });
        ids.push(id);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q: string = `/auctions?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await api('GET', q);
        assert.ok(res.body.items.length <= 3);
        seen.push(...res.body.items.map((a: { id: string }) => a.id));
        cursor = res.body.nextCursor as string | null;
        pages += 1;
      } while (cursor && pages < 10);
      assert.equal(pages, 3);
      assert.deepEqual(seen, [...ids].reverse());
    });

    it('searches titles case-insensitively, takes wildcards literally, never leaks drafts, and pages', async () => {
      await resetData(app.db);
      seller = await newUser(api, 'seller');
      const publish = async (title: string): Promise<string> => {
        const id = await createDraft({ title });
        await api('POST', `/auctions/${id}/publish`, { token: seller.token });
        return id;
      };
      const lamp = await publish('Brass Lamp');
      const lamp2 = await publish('antique LAMP shade');
      await publish('Vase');
      const percent = await publish('100% cotton');
      const underscore = await publish('a_b');
      await publish('axb');
      const draft = await createDraft({ title: 'Secret lamp' });

      const titles = async (q: string, token?: string): Promise<string[]> => {
        const res = await api('GET', `/auctions?q=${encodeURIComponent(q)}`, { token });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.items.map((a: { id: string }) => a.id);
      };
      // case-insensitive, substring, newest first
      assert.deepEqual(await titles('lamp'), [lamp2, lamp]);
      // a typed wildcard is a literal character, not "match everything"
      assert.deepEqual(await titles('%'), [percent]);
      assert.deepEqual(await titles('_'), [underscore]);
      assert.deepEqual(await titles('\\'), []);
      assert.deepEqual(await titles("' OR 1=1 --"), []);
      assert.deepEqual(await titles('nothing like this'), []);
      // a draft is invisible to the public search, visible to its seller with mine=true
      assert.ok(!(await titles('secret')).includes(draft));
      const mine = await api('GET', `/auctions?mine=true&q=secret`, { token: seller.token });
      assert.deepEqual(
        mine.body.items.map((a: { id: string }) => a.id),
        [draft],
      );
      // the search composes with paging
      const page1 = await api('GET', '/auctions?q=lamp&limit=1');
      assert.equal(page1.body.items[0].id, lamp2);
      const cursor1 = page1.body.nextCursor as string;
      const page2 = await api('GET', `/auctions?q=lamp&limit=1&cursor=${cursor1}`);
      assert.equal(page2.body.items[0].id, lamp);
      assert.equal(page2.body.nextCursor, null);
      // bounds
      assert.equal((await api('GET', '/auctions?q=')).status, 400);
      assert.equal((await api('GET', `/auctions?q=${'x'.repeat(101)}`)).status, 400);
    });

    it('rejects an out-of-range limit, a bad cursor and unknown filters', async () => {
      assert.equal((await api('GET', '/auctions?limit=51')).status, 400);
      assert.equal((await api('GET', '/auctions?limit=0')).status, 400);
      assert.equal((await api('GET', '/auctions?cursor=%25%25')).status, 400);
      assert.equal((await api('GET', '/auctions?status=NOPE')).status, 400);
      assert.equal((await api('GET', '/auctions?foo=bar')).status, 400);
    });
  });
});
