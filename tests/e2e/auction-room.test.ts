import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright-core';
import {
  PASSWORD,
  liveAuction,
  makeClient,
  newUser,
  placeBid,
  resetData,
  sleep,
  type Api,
} from '../integration/helpers.ts';
import { openPage, startHarness, type Harness, type Watched } from './harness.ts';

interface User {
  token: string;
  id: string;
  email: string;
}

const screenshotDir = process.env['E2E_SCREENSHOT_DIR'] ?? path.join(tmpdir(), 'bidflow-e2e');

describe('auction room in a real browser (Edge, real API, real PostgreSQL)', () => {
  let h: Harness;
  let api: Api;
  let seller: User;
  let ann: User;
  let bob: User;
  const watched: Watched[] = [];

  before(async () => {
    h = await startHarness();
    api = makeClient(h.api.base);
    await resetData(h.api.db);
    await mkdir(screenshotDir, { recursive: true });
    seller = await newUser(api, 'Seller');
    ann = await newUser(api, 'Ann');
    bob = await newUser(api, 'Bob');
  });
  after(async () => {
    await Promise.all(watched.map((w) => w.context.close()));
    await h.close();
  });

  const as = (u: User, name: string): { token: string; userId: string; displayName: string } => ({
    token: u.token,
    userId: u.id,
    displayName: name,
  });
  const open = async (
    ...args: Parameters<typeof openPage> extends [unknown, ...infer R] ? R : never
  ) => {
    const w = await openPage(h, ...args);
    watched.push(w);
    return w;
  };
  const text = (page: Page, id: string): Promise<string> =>
    page.getByTestId(id).first().innerText({ timeout: 5000 });
  const waitText = async (page: Page, id: string, expected: string | RegExp): Promise<void> => {
    await page.getByTestId(id).filter({ hasText: expected }).waitFor({ timeout: 5000 });
  };
  const hashFor = (id: string): string => `#/auction/${id}`;

  it('signs in through the real form, then shows the live auction from the snapshot', async () => {
    const id = await liveAuction(api, seller.token, { title: 'Brass lamp' });
    const { page, problems } = await open({});
    await page.getByRole('link', { name: 'Sign in' }).click();
    await page.getByLabel('Email').fill(ann.email);
    await page.getByLabel(/Password/).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByTestId('whoami').waitFor();
    assert.equal(await text(page, 'whoami'), 'Ann');

    await page.goto(`${h.webUrl}/${hashFor(id)}`);
    await page.getByRole('heading', { name: 'Brass lamp' }).waitFor();
    await waitText(page, 'connection', 'Live');
    assert.equal(await text(page, 'status'), 'LIVE');
    assert.match(await text(page, 'price'), /^10\.00/);
    assert.equal(await text(page, 'min-next'), '10.00');
    assert.deepEqual(problems, []);
  });

  it('two browsers: a bid placed in one appears in the other without a reload', async () => {
    const id = await liveAuction(api, seller.token, { title: 'Two browsers' });
    const a = await open({ session: as(ann, 'Ann'), hash: hashFor(id) });
    const b = await open({ session: as(bob, 'Bob'), hash: hashFor(id) });
    await waitText(a.page, 'connection', 'Live');
    await waitText(b.page, 'connection', 'Live');
    await waitText(a.page, 'participants', '2 watching');
    await waitText(b.page, 'participants', '2 watching');

    await a.page.getByTestId('bid-input').fill('12.50');
    await a.page.getByTestId('bid-submit').click();

    // Ann sees her own bid (confirmed by the server) ...
    await waitText(a.page, 'price', /^12\.50/);
    // ... and Bob sees it arrive live, with no reload and no action.
    await waitText(b.page, 'price', /^12\.50/);
    await b.page.getByTestId('bid-row').first().waitFor();
    assert.match(await text(b.page, 'bid-row'), /#1\s*Ann\s*12\.50/);
    assert.equal(await text(b.page, 'bid-count'), '1');
    assert.equal(await text(b.page, 'min-next'), '13.50');
    assert.equal(await b.page.getByTestId('bid-row').count(), 1);
    assert.equal(
      await a.page.getByTestId('bid-row').count(),
      1,
      'the REST reply and the live event must count once',
    );

    // Bob outbids; Ann sees it.
    await b.page.getByTestId('bid-input').fill('14');
    await b.page.getByTestId('bid-submit').click();
    await waitText(a.page, 'price', /^14\.00/);
    assert.equal(await a.page.getByTestId('bid-row').count(), 2);
    assert.match(await text(a.page, 'bid-row'), /#2\s*Bob\s*14\.00/); // newest first

    assert.deepEqual(a.problems, []);
    assert.deepEqual(b.problems, []);
  });

  it('a rejected bid shows the reason and is not shown to anyone as accepted', async () => {
    const id = await liveAuction(api, seller.token);
    const a = await open({ session: as(ann, 'Ann'), hash: hashFor(id) });
    const watcher = await open({ hash: hashFor(id) }); // anonymous viewer
    await waitText(a.page, 'connection', 'Live');
    await waitText(watcher.page, 'connection', 'Live');
    await placeBid(api, bob.token, id, '20.00'); // price is now 20.00
    await waitText(a.page, 'price', /^20\.00/);

    await a.page.getByTestId('bid-input').fill('20.50'); // below 21.00
    await a.page.getByTestId('bid-submit').click();
    await a.page.getByTestId('bid-error').waitFor();
    assert.match(await text(a.page, 'bid-error'), /minimum bid is 21\.00/);
    await sleep(400);
    assert.equal(await a.page.getByTestId('bid-row').count(), 1);
    assert.equal(await watcher.page.getByTestId('bid-row').count(), 1);
    assert.match(await text(watcher.page, 'price'), /^20\.00/);
  });

  it('nothing is shown as accepted while the server has not answered (no optimistic display)', async () => {
    const id = await liveAuction(api, seller.token);
    const a = await open({ session: as(ann, 'Ann'), hash: hashFor(id) });
    await waitText(a.page, 'connection', 'Live');
    await a.page.route('**/api/auctions/*/bids', async (route) => {
      if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await a.page.getByTestId('bid-input').fill('11.00');
    await a.page.getByTestId('bid-submit').click();
    await a.page.getByRole('button', { name: /Waiting for the server/ }).waitFor();
    assert.equal(
      await a.page.getByTestId('bid-row').count(),
      0,
      'a bid was displayed before the server confirmed it',
    );
    assert.match(await text(a.page, 'price'), /^10\.00/);
    await waitText(a.page, 'price', /^11\.00/); // after the reply
    assert.equal(await a.page.getByTestId('bid-row').count(), 1);
  });

  it('a network failure keeps the same Idempotency-Key, so repeating the click cannot buy twice', async () => {
    const id = await liveAuction(api, seller.token);
    const a = await open({ session: as(ann, 'Ann'), hash: hashFor(id) });
    await waitText(a.page, 'connection', 'Live');
    const keys: string[] = [];
    let first = true;
    await a.page.route('**/api/auctions/*/bids', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.continue();
      keys.push(request.headers()['idempotency-key'] ?? '');
      if (first) {
        first = false;
        // The request reaches the server (the bid is committed) but the reply is lost.
        await route.fetch();
        return route.abort('connectionreset');
      }
      return route.continue();
    });
    await a.page.getByTestId('bid-input').fill('15.00');
    await a.page.getByTestId('bid-submit').click();
    await a.page.getByTestId('bid-error').waitFor();
    assert.match(await text(a.page, 'bid-error'), /Network problem/);
    await a.page.getByTestId('bid-submit').click(); // the user repeats the same amount
    await waitText(a.page, 'price', /^15\.00/);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], 'the retry must reuse the same key');
    const { rows } = await h.api.db.query('SELECT 1 FROM bids WHERE auction_id = $1', [id]);
    assert.equal(rows.length, 1, 'exactly one bid despite the lost reply and the retry');
  });

  it('after the connection drops it reconnects, re-joins once, and shows each bid once', async () => {
    const id = await liveAuction(api, seller.token);
    const a = await open({ session: as(ann, 'Ann'), hash: hashFor(id) });
    const b = await open({ session: as(bob, 'Bob'), hash: hashFor(id) });
    await waitText(a.page, 'participants', '2 watching');

    // Kill every WebSocket transport from the server side, as a network drop would.
    for (const socket of h.api.io.sockets.sockets.values()) socket.conn.close();
    await waitText(a.page, 'connection', /Live/); // reconnects on its own
    await waitText(a.page, 'participants', '2 watching'); // not 3 or 4: no duplicate subscriptions
    await waitText(b.page, 'participants', '2 watching');

    await placeBid(api, bob.token, id, '10.00');
    await waitText(a.page, 'price', /^10\.00/);
    assert.equal(await a.page.getByTestId('bid-row').count(), 1);
    assert.equal(await b.page.getByTestId('bid-row').count(), 1);
    await sleep(400);
    assert.equal(await a.page.getByTestId('bid-row').count(), 1, 'a bid was shown twice');
  });

  it('leaving the page leaves the room on the server (unmount cleanup)', async () => {
    const id = await liveAuction(api, seller.token);
    const a = await open({ session: as(ann, 'Ann'), hash: hashFor(id) });
    const b = await open({ hash: hashFor(id) });
    await waitText(b.page, 'participants', '2 watching');
    const connectionsBefore = h.api.io.sockets.sockets.size;
    await a.page.evaluate("window.location.hash = '#/'");
    await a.page.getByRole('heading', { name: 'Auctions' }).waitFor();
    await waitText(b.page, 'participants', '1 watching');
    // The room count alone is not enough: leaving the room is a message, closing the connection
    // is separate. Found by mutation testing (removing disconnect() survived).
    for (let i = 0; i < 40 && h.api.io.sockets.sockets.size !== connectionsBefore - 1; i += 1) {
      await sleep(50);
    }
    assert.equal(
      h.api.io.sockets.sockets.size,
      connectionsBefore - 1,
      'leaving the page must close its WebSocket, not just leave the room',
    );
  });

  it('roles and visibility: the seller has no bid form; a draft is "not found" for others; anonymous sees a sign-in prompt', async () => {
    const id = await liveAuction(api, seller.token);
    const s = await open({ session: as(seller, 'Seller'), hash: hashFor(id) });
    await s.page.getByText('You are the seller of this auction.').waitFor();
    assert.equal(await s.page.getByTestId('bid-input').count(), 0);

    const anon = await open({ hash: hashFor(id) });
    await anon.page.getByRole('link', { name: 'Sign in' }).first().waitFor();
    assert.equal(await anon.page.getByTestId('bid-input').count(), 0);

    const draft = await api('POST', '/auctions', {
      token: seller.token,
      body: {
        title: 'Secret',
        startingPrice: '5.00',
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 7_200_000).toISOString(),
      },
    });
    const draftId = draft.body.auction.id as string;
    const other = await open({ session: as(bob, 'Bob'), hash: hashFor(draftId) });
    await other.page.getByRole('heading', { name: 'Auction not found' }).waitFor();
  });

  it('screenshots (light, dark, phone), phone layout without horizontal scroll, and no console errors', async () => {
    const id = await liveAuction(api, seller.token, {
      title: 'Vintage camera with a rather long title to test wrapping',
    });
    for (const [i, buyer] of [ann, bob, ann].entries()) {
      await placeBid(api, buyer.token, id, `${String(20 + i * 5)}.00`);
    }
    const shots: [string, 'light' | 'dark', { width: number; height: number }][] = [
      ['light-desktop', 'light', { width: 1100, height: 900 }],
      ['dark-desktop', 'dark', { width: 1100, height: 900 }],
      ['light-phone', 'light', { width: 390, height: 844 }],
      ['dark-phone', 'dark', { width: 390, height: 844 }],
    ];
    for (const [name, colorScheme, viewport] of shots) {
      const w = await open({ session: as(bob, 'Bob'), hash: hashFor(id), colorScheme, viewport });
      await waitText(w.page, 'connection', 'Live');
      await w.page.getByTestId('bid-row').first().waitFor();
      await waitText(w.page, 'bid-count', '3');
      const overflow = await w.page.evaluate<number>(
        'document.documentElement.scrollWidth - document.documentElement.clientWidth',
      );
      assert.ok(overflow <= 0, `${name}: horizontal scroll of ${String(overflow)}px`);
      await w.page.screenshot({
        path: path.join(screenshotDir, `auction-${name}.png`),
        fullPage: true,
      });
      assert.deepEqual(w.problems, [], `${name}: console problems`);
    }
  });
});
