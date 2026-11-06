// Phase 7: the whole UI in a real browser (Edge) against the real API, real PostgreSQL and real
// WebSockets. Every number on screen comes from the server; the only thing faked is time
// (Playwright's clock) and the network (route interception) where a test says so.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Page, WebSocketRoute } from 'playwright-core';
import { createLogger } from '../../apps/api/src/logging/logger.ts';
import { createLifecycleWorker } from '../../apps/api/src/modules/lifecycle/index.ts';
import {
  PASSWORD,
  liveAuction,
  makeClient,
  newUser,
  placeBid,
  resetData,
  setAuctionEnd,
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
const hashFor = (id: string): string => `#/auction/${id}`;
const pad = (n: number): string => String(n).padStart(2, '0');
/** A local `datetime-local` value for a time `ms` from now. */
const local = (ms: number): string => {
  const d = new Date(Date.now() + ms);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

describe('the full UI in a real browser (Edge, real API, real PostgreSQL)', () => {
  let h: Harness;
  let api: Api;
  let seller: User;
  let ann: User;
  let bob: User;
  const watched: Watched[] = [];
  const quiet = createLogger('error', () => undefined);

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
    await page.getByTestId(id).filter({ hasText: expected }).first().waitFor({ timeout: 8000 });
  };
  const runLifecycleOnce = async (): Promise<void> => {
    const worker = createLifecycleWorker({
      db: h.api.db,
      logger: quiet,
      workerId: 'e2e-lifecycle',
      pollIntervalMs: 20,
    });
    await worker.runOnce();
  };

  it('a seller creates and publishes an auction through the form; the seller comes from the session', async () => {
    const s = await open({ session: as(seller, 'Seller'), hash: '#/sell' });
    await s.page.getByTestId('mine-empty').waitFor();
    await s.page.getByTestId('new-auction').click();
    await s.page.getByTestId('f-title').fill('Hand-made clock');
    await s.page.getByTestId('f-description').fill('Oak case.\nSecond line.');
    await s.page.getByTestId('f-price').fill('25.00');
    await s.page.getByTestId('f-increment').fill('2.50');
    await s.page.getByTestId('f-publish').click();

    await s.page.getByRole('heading', { name: 'Hand-made clock' }).waitFor();
    await waitText(s.page, 'status', 'LIVE');
    assert.match(await text(s.page, 'price'), /^25\.00/);
    assert.equal(await text(s.page, 'min-next'), '25.00');
    const { rows } = await h.api.db.query<{
      seller_id: string;
      minimum_increment: string;
      status: string;
    }>("SELECT seller_id, minimum_increment, status FROM auctions WHERE title = 'Hand-made clock'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.seller_id, seller.id);
    assert.equal(rows[0]?.minimum_increment, '2.50');
    assert.equal(rows[0]?.status, 'LIVE');

    // it is in the public list and in the seller's own list
    const pub = await open({ hash: '' });
    await pub.page.getByRole('link', { name: /Hand-made clock/ }).waitFor();
    assert.deepEqual(s.problems, []);
  });

  it('draft: server validation errors are shown; save, edit, then publish from the list; a draft is private', async () => {
    const s = await open({ session: as(seller, 'Seller'), hash: '#/sell' });
    await s.page.getByTestId('new-auction').click();
    await s.page.getByTestId('f-title').fill('Draft lamp');
    // ends 30 seconds after it starts: the server's rule is "at least 1 minute"
    await s.page.getByTestId('f-starts').fill(local(2 * 3_600_000));
    await s.page.getByTestId('f-ends').fill(local(2 * 3_600_000));
    await s.page.getByTestId('f-save').click();
    await s.page.getByTestId('form-error').waitFor();
    assert.match(await text(s.page, 'form-error'), /endsAt|minute/i);

    await s.page.getByTestId('f-ends').fill(local(3 * 3_600_000));
    await s.page.getByTestId('f-save').click();
    await s.page.getByTestId('mine-row').filter({ hasText: 'Draft lamp' }).waitFor();
    const row = s.page.getByTestId('mine-row').filter({ hasText: 'Draft lamp' });
    await row.locator('.badge', { hasText: 'DRAFT' }).waitFor();

    // another user cannot find it, by search or by link
    const search = await api('GET', '/auctions?q=Draft%20lamp');
    assert.equal(search.body.items.length, 0);
    const id = (
      await h.api.db.query<{ id: string }>("SELECT id FROM auctions WHERE title = 'Draft lamp'")
    ).rows[0]?.id as string;
    const other = await open({ session: as(bob, 'Bob'), hash: hashFor(id) });
    await other.page.getByRole('heading', { name: 'Auction not found' }).waitFor();

    // edit the draft, then publish it from the list. It starts in 2 hours, so it is SCHEDULED.
    await row.getByRole('button', { name: 'Edit' }).click();
    await s.page.getByTestId('f-title').fill('Draft lamp (edited)');
    await s.page.getByTestId('f-save').click();
    const edited = s.page.getByTestId('mine-row').filter({ hasText: 'Draft lamp (edited)' });
    await edited.waitFor();
    await edited.getByRole('button', { name: 'Publish' }).click();
    await edited.locator('.badge', { hasText: 'SCHEDULED' }).waitFor();
    assert.equal(
      await edited.getByRole('button', { name: 'Edit' }).count(),
      0,
      'no edit once published',
    );
    // The only console error allowed is the browser's own line for the deliberate 400 above.
    assert.deepEqual(s.problems, [
      'console.error: Failed to load resource: the server responded with a status of 400 (Bad Request)',
    ]);
  });

  it('discovery: paging, search, status filter, empty and error states', async () => {
    await resetData(h.api.db);
    seller = await newUser(api, 'Seller');
    ann = await newUser(api, 'Ann');
    bob = await newUser(api, 'Bob');
    for (let i = 1; i <= 13; i += 1)
      await liveAuction(api, seller.token, { title: `Lot ${pad(i)}` });
    await liveAuction(api, seller.token, { title: 'Zebra statue' });

    const v = await open({ hash: '' });
    await v.page.getByTestId('auction-link').first().waitFor();
    assert.equal(await v.page.getByTestId('auction-link').count(), 12, 'one page');
    await v.page.getByTestId('load-more').click();
    await v.page.getByTestId('load-more').waitFor({ state: 'detached' });
    assert.equal(await v.page.getByTestId('auction-link').count(), 14);

    await v.page.getByTestId('search').fill('zebra');
    await v.page.getByTestId('auction-link').nth(1).waitFor({ state: 'detached' });
    assert.equal(await v.page.getByTestId('auction-link').count(), 1);
    assert.match(await text(v.page, 'auction-link'), /Zebra statue/);

    await v.page.getByTestId('search').fill('nothing matches this');
    await waitText(v.page, 'list-empty', /No auction matches/);

    await v.page.getByTestId('search').fill('');
    await v.page.getByTestId('status-filter').selectOption('ENDED');
    await waitText(v.page, 'list-empty', /No auction matches/);

    // error state: the network fails; then it recovers through the retry button
    await v.page.route('**/api/auctions?*', (route) => route.abort('connectionreset'));
    await v.page.getByTestId('status-filter').selectOption('LIVE');
    await v.page.getByTestId('list-error').waitFor();
    assert.match(await text(v.page, 'list-error'), /Could not reach the server/);
    await v.page.unroute('**/api/auctions?*');
    await v.page.getByRole('button', { name: 'Try again' }).click();
    await v.page.getByTestId('auction-link').first().waitFor();
    assert.equal(await v.page.getByTestId('list-error').count(), 0);
  });

  it('own bid status and outbid notifications: live status, bell count, notification page, mark as read', async () => {
    const id = await liveAuction(api, seller.token, { title: 'Contested vase' });
    const a = await open({ session: as(ann, 'Ann'), hash: hashFor(id) });
    await waitText(a.page, 'connection', 'Live');
    assert.equal(await a.page.getByTestId('my-status').count(), 0, 'no status before any bid');

    await a.page.getByTestId('bid-input').fill('12.00');
    await a.page.getByTestId('bid-submit').click();
    await a.page.getByTestId('bid-accepted').waitFor();
    assert.match(await text(a.page, 'bid-accepted'), /Accepted: your bid of 12\.00/);
    await waitText(a.page, 'my-status', /highest bidder at 12\.00/);
    assert.equal(await a.page.getByTestId('unread-count').count(), 0);

    // Bob (through the API, like another browser) outbids Ann: she learns live, and gets a notification.
    await placeBid(api, bob.token, id, '15.00');
    await waitText(a.page, 'my-status', /You were outbid/);
    assert.equal(await a.page.getByTestId('my-status').getAttribute('data-kind'), 'outbid');
    await waitText(a.page, 'unread-count', '1');

    await a.page.getByTestId('bell').click();
    await waitText(a.page, 'notification', /You were outbid on Contested vase/);
    assert.equal(await a.page.getByTestId('notification').count(), 1);
    await a.page.getByRole('button', { name: 'Mark as read' }).click();
    await a.page.getByTestId('unread-count').waitFor({ state: 'detached' });
    assert.equal(await a.page.getByTestId('notification').count(), 1, 'read, not deleted');

    // Bob never sees Ann's notification (his own list is empty), and the server refuses a stranger's id.
    const bobList = await api('GET', '/notifications', { token: bob.token });
    assert.equal(bobList.body.items.length, 0);
    assert.deepEqual(a.problems, []);
  });

  it('ended auction: result shown, "won" / "lost" per user, notifications for everyone involved', async () => {
    const id = await liveAuction(api, seller.token, { title: 'Closing teapot' });
    await placeBid(api, ann.token, id, '10.00');
    await placeBid(api, bob.token, id, '12.00');
    const a = await open({ session: as(ann, 'Ann'), hash: hashFor(id) });
    const b = await open({ session: as(bob, 'Bob'), hash: hashFor(id) });
    const s = await open({ session: as(seller, 'Seller'), hash: hashFor(id) });
    for (const w of [a, b, s]) await waitText(w.page, 'connection', 'Live');
    await waitText(a.page, 'my-status', /You were outbid/);

    await setAuctionEnd(h.api.db, id, "clock_timestamp() - interval '1 second'");
    await runLifecycleOnce();

    for (const w of [a, b, s]) await waitText(w.page, 'status', 'ENDED');
    await waitText(b.page, 'result', /Won by\s*Bob\s*at\s*12\.00/);
    await waitText(b.page, 'my-status', /You won this auction at 12\.00/);
    await waitText(a.page, 'my-status', /You did not win/);
    assert.equal(await a.page.getByTestId('bid-input').count(), 0, 'no bid form once ended');
    assert.equal(await text(a.page, 'min-next'), '—');

    // notifications: the winner, the loser and the seller each get exactly their own
    await a.page.getByTestId('bell').click();
    await waitText(a.page, 'notification', /You did not win Closing teapot/);
    await b.page.getByTestId('bell').click();
    await waitText(b.page, 'notification', /You won Closing teapot/);
    await s.page.getByTestId('bell').click();
    await waitText(s.page, 'notification', /Your auction Closing teapot has ended/);
    await waitText(s.page, 'notification', /Won by Bob at 12\.00/);
    for (const w of [a, b, s]) assert.deepEqual(w.problems, []);
  });

  it('the countdown follows the server clock, not a wrong browser clock, and never says "ended" by itself', async () => {
    const id = await liveAuction(api, seller.token, { title: 'Clock check' });
    await setAuctionEnd(h.api.db, id, "clock_timestamp() + interval '10 minutes'");
    // The browser's clock is 3 hours behind: computed from it, the countdown would show "3h ...".
    const behind = await open({ hash: hashFor(id), clockOffsetMs: -3 * 3_600_000 });
    await waitText(behind.page, 'connection', 'Live');
    await sleep(1500); // let the one-off clock sync land and the next tick repaint
    const shown = await text(behind.page, 'countdown');
    assert.match(
      shown,
      /^(9m|10m)/,
      `countdown ${shown} should be ~10 minutes with a browser 3h behind`,
    );

    // Past the end time but the worker has not run: "ending…", status still LIVE, bids refused by the server.
    const late = await liveAuction(api, seller.token, { title: 'Overdue' });
    const w = await open({ session: as(ann, 'Ann'), hash: hashFor(late) });
    await waitText(w.page, 'connection', 'Live');
    await setAuctionEnd(h.api.db, late, "clock_timestamp() - interval '2 seconds'");
    await w.page.reload();
    await waitText(w.page, 'connection', 'Live');
    await waitText(w.page, 'countdown', 'ending…');
    assert.equal(await w.page.getByTestId('countdown').getAttribute('data-waiting'), 'true');
    assert.equal(await text(w.page, 'status'), 'LIVE');
    await w.page.getByTestId('bid-input').fill('50');
    await w.page.getByTestId('bid-submit').click();
    await waitText(w.page, 'bid-error', /has ended/);
    await runLifecycleOnce();
    await waitText(w.page, 'status', 'ENDED');
  });

  it('anti-sniping is visible: a late bid moves the end time and the room shows the extension', async () => {
    const id = await liveAuction(api, seller.token, { title: 'Sniped' });
    await setAuctionEnd(h.api.db, id, "clock_timestamp() + interval '60 seconds'");
    const a = await open({ session: as(ann, 'Ann'), hash: hashFor(id) });
    const b = await open({ hash: hashFor(id) });
    await waitText(a.page, 'connection', 'Live');
    await waitText(b.page, 'connection', 'Live');
    assert.match(await text(a.page, 'countdown'), /^(59s|1m 00s|[1-5]\ds)/);
    assert.equal(await a.page.getByTestId('extensions').count(), 0);

    await a.page.getByTestId('bid-input').fill('11');
    await a.page.getByTestId('bid-submit').click();
    await waitText(a.page, 'extensions', /extended 1×/);
    await waitText(b.page, 'extensions', /extended 1×/); // the other room learns from auction.extended
    // two minutes from the bid, so now well over a minute left
    await waitText(b.page, 'countdown', /^(1m 5\ds|1m [1-5]\ds|2m 00s|1m 4\ds)/);
  });

  it('reconnect and reconcile: stale banner when live updates stop; the refresh button restores the authoritative state', async () => {
    const id = await liveAuction(api, seller.token, { title: 'Flaky link' });
    let blocked = false;
    let blockedAttempts = 0;
    const open_: WebSocketRoute[] = [];
    const w = await open({ session: as(ann, 'Ann') });
    await w.page.routeWebSocket(/socket\.io/, (ws) => {
      if (blocked) {
        blockedAttempts += 1;
        void ws.close();
        return;
      }
      ws.connectToServer();
      open_.push(ws);
    });
    // routeWebSocket only affects documents loaded AFTER it is installed; a different query string
    // makes this a new document (a hash-only change would not reload the page).
    await w.page.goto(`${h.webUrl}/?routed=1${hashFor(id)}`);
    await waitText(w.page, 'connection', 'Live');
    assert.equal(await w.page.getByTestId('stale-banner').count(), 0);

    // The link dies and cannot come back. A bid happens meanwhile.
    blocked = true;
    for (const ws of open_) void ws.close();
    await w.page.getByTestId('stale-banner').waitFor();
    await placeBid(api, bob.token, id, '33.00');
    await sleep(500);
    assert.match(
      await text(w.page, 'price'),
      /^10\.00/,
      'the page must not pretend to know the new price',
    );
    assert.match(await text(w.page, 'stale-banner'), /may be out of date/);
    // Still blocked: pressing refresh must make an IMMEDIATE new connection attempt (the route
    // handler sees it within a second). Socket.IO's own retry may be waiting for seconds, so a
    // refresh that only called socket.connect() does nothing here (mutation-tested).
    const attemptsBefore = blockedAttempts;
    await w.page.getByTestId('refresh').click();
    for (let i = 0; i < 20 && blockedAttempts === attemptsBefore; i += 1) await sleep(50);
    assert.ok(blockedAttempts > attemptsBefore, 'refresh did not try to reconnect at once');
    await sleep(300);
    assert.equal(await w.page.getByTestId('stale-banner').count(), 1);

    // The link returns; the user presses refresh; the snapshot restores the truth.
    blocked = false;
    await w.page.getByTestId('refresh').click();
    await waitText(w.page, 'price', /^33.00/);
    await w.page.getByTestId('stale-banner').waitFor({ state: 'detached' });
    assert.equal(await w.page.getByTestId('bid-row').count(), 1);
    assert.deepEqual(w.problems, []);
  });

  it('opening the notifications page asks the server again (the list in memory may be 20 s old)', async () => {
    const id = await liveAuction(api, seller.token, { title: 'Quiet outbid' });
    // A fresh user: earlier tests left unread notifications for Ann.
    const cy = await newUser(api, 'Cy');
    await placeBid(api, cy.token, id, '10.00');
    // Cy sits on the list page: no auction room open, so nothing tells the bell to refresh.
    const a = await open({ session: as(cy, 'Cy'), hash: '' });
    await a.page.getByTestId('auction-link').first().waitFor();
    await sleep(500); // the first notification fetch has finished: nothing unread
    assert.equal(await a.page.getByTestId('unread-count').count(), 0);
    await placeBid(api, bob.token, id, '15.00'); // writes Cy's "outbid" row
    await a.page.getByTestId('bell').click();
    await a.page
      .getByTestId('notification')
      .filter({ hasText: /You were outbid on Quiet outbid/ })
      .waitFor({ timeout: 3000 });
  });

  it('offline: a banner explains it; it clears when the connection returns', async () => {
    const id = await liveAuction(api, seller.token, { title: 'Offline test' });
    const w = await open({ session: as(ann, 'Ann'), hash: hashFor(id) });
    await waitText(w.page, 'connection', 'Live');
    await w.context.setOffline(true);
    await w.page.getByTestId('offline').waitFor();
    assert.match(await text(w.page, 'offline'), /You are offline/);
    await w.context.setOffline(false);
    await w.page.getByTestId('offline').waitFor({ state: 'detached' });
    await waitText(w.page, 'connection', 'Live');
  });

  it('account page, sign out revokes the token on the server, protected pages ask for sign-in', async () => {
    const anon = await open({ hash: '#/sell' });
    await anon.page.getByRole('link', { name: 'Sign in' }).first().waitFor();
    assert.equal(await anon.page.getByTestId('new-auction').count(), 0);

    const login = await api('POST', '/auth/login', {
      body: { email: ann.email, password: PASSWORD },
    });
    const token = login.body.token as string;
    const w = await open({
      session: { token, userId: ann.id, displayName: 'Ann' },
      hash: '#/account',
    });
    await waitText(w.page, 'account-name', 'Ann');
    assert.equal(await text(w.page, 'account-email'), ann.email.toLowerCase());
    assert.equal((await api('GET', '/users/me', { token })).status, 200);
    await w.page.getByTestId('account-signout').click();
    await w.page.getByRole('link', { name: 'Sign in' }).first().waitFor();
    for (let i = 0; i < 20; i += 1) {
      if ((await api('GET', '/users/me', { token })).status === 401) break;
      await sleep(100);
    }
    assert.equal(
      (await api('GET', '/users/me', { token })).status,
      401,
      'the token must be revoked',
    );
  });

  it('screenshots of every page (light, dark, phone), no horizontal scroll, no console errors', async () => {
    const id = await liveAuction(api, seller.token, {
      title: 'Screenshot subject with a fairly long title',
    });
    await placeBid(api, ann.token, id, '20.00');
    await placeBid(api, bob.token, id, '25.00');
    const pages: [string, string, User, string][] = [
      ['list', '', ann, 'Auctions'],
      ['auction', hashFor(id), ann, 'Screenshot subject'],
      ['notifications', '#/notifications', ann, 'Notifications'],
      ['account', '#/account', ann, 'Account'],
      ['seller', '#/sell', seller, 'Your auctions'],
    ];
    const variants: [string, 'light' | 'dark', { width: number; height: number }][] = [
      ['light-desktop', 'light', { width: 1100, height: 900 }],
      ['dark-desktop', 'dark', { width: 1100, height: 900 }],
      ['light-phone', 'light', { width: 390, height: 844 }],
      ['dark-phone', 'dark', { width: 390, height: 844 }],
    ];
    for (const [page, hash, user, heading] of pages) {
      for (const [variant, colorScheme, viewport] of variants) {
        const w = await open({
          session: as(user, user === seller ? 'Seller' : 'Ann'),
          hash,
          colorScheme,
          viewport,
        });
        await w.page
          .getByRole('heading', { name: new RegExp(heading) })
          .first()
          .waitFor();
        if (page === 'auction') await waitText(w.page, 'bid-count', '2');
        if (page === 'seller') await w.page.getByTestId('new-auction').click();
        await sleep(300);
        const overflow = await w.page.evaluate<number>(
          'document.documentElement.scrollWidth - document.documentElement.clientWidth',
        );
        assert.ok(overflow <= 0, `${page}/${variant}: horizontal scroll of ${String(overflow)}px`);
        await w.page.screenshot({
          path: path.join(screenshotDir, `ui-${page}-${variant}.png`),
          fullPage: true,
        });
        assert.deepEqual(w.problems, [], `${page}/${variant}: console problems`);
        await w.context.close();
      }
    }
  });
});
