// Real browsers (Edge) -> NGINX (serves the built React app and proxies /api and /socket.io)
// -> two API containers -> PostgreSQL + Redis. Which container a page's socket landed on is
// read from the containers' own logs, never assumed.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { liveAuction, makeClient, newUser } from '../integration/helpers.ts';
import {
  bothInstancesInRotation,
  compose,
  logsOf,
  sleep,
  until,
  urls,
  type InstanceName,
} from './harness.ts';

interface User {
  token: string;
  id: string;
}

const screenshotDir = process.env['E2E_SCREENSHOT_DIR'] ?? path.join(tmpdir(), 'bidflow-e2e');

async function connectedCounts(): Promise<Record<InstanceName, number>> {
  const [one, two] = await Promise.all([logsOf('api1'), logsOf('api2')]);
  const count = (lines: { msg?: string }[]): number =>
    lines.filter((l) => l.msg === 'socket connected').length;
  return { api1: count(one), api2: count(two) };
}

describe('browsers through NGINX across two API containers', () => {
  const viaNginx = makeClient(`${urls.nginx}/api`);
  let browser: Browser;
  let seller: User;
  let ann: User;
  let bob: User;
  const contexts: BrowserContext[] = [];

  before(async () => {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    await mkdir(screenshotDir, { recursive: true });
    seller = await newUser(viaNginx, 'Seller');
    ann = await newUser(viaNginx, 'Ann');
    bob = await newUser(viaNginx, 'Bob');
  });
  after(async () => {
    await Promise.all(contexts.map((c) => c.close()));
    await browser.close();
  });

  const session = (
    u: User,
    name: string,
  ): { token: string; userId: string; displayName: string } => ({
    token: u.token,
    userId: u.id,
    displayName: name,
  });

  /** Opens the auction in a new browser context and says which container holds its socket. */
  async function openAuction(
    id: string,
    user: User,
    name: string,
  ): Promise<{ page: Page; instance: InstanceName; problems: string[] }> {
    const before = await connectedCounts();
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    contexts.push(context);
    await context.addInitScript(
      (s) => {
        sessionStorage.setItem('bidflow.session', JSON.stringify(s));
      },
      session(user, name),
    );
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
    });
    page.on('pageerror', (e) => {
      problems.push(`pageerror: ${e.message}`);
    });
    await page.goto(`${urls.nginx}/#/auction/${id}`);
    await page.getByTestId('connection').filter({ hasText: 'Live' }).waitFor({ timeout: 10_000 });
    let instance: InstanceName | undefined;
    await until(
      'the new socket shows up in exactly one container log',
      async () => {
        const now = await connectedCounts();
        const grew = (['api1', 'api2'] as const).filter((k) => now[k] > before[k]);
        if (grew.length === 1) instance = grew[0];
        return instance !== undefined;
      },
      10_000,
    );
    return { page, instance: instance as InstanceName, problems };
  }

  const text = (page: Page, id: string): Promise<string> =>
    page.getByTestId(id).first().innerText({ timeout: 8000 });
  const waitText = async (page: Page, id: string, expected: string | RegExp): Promise<void> => {
    await page.getByTestId(id).filter({ hasText: expected }).first().waitFor({ timeout: 15_000 });
  };

  it("pages whose sockets are on DIFFERENT containers see each other's bids live and the same participant count", async () => {
    const id = await liveAuction(viaNginx, seller.token, { title: 'Cluster auction' });
    const pages: { page: Page; instance: InstanceName; problems: string[]; who: string }[] = [];
    const users: [User, string][] = [
      [ann, 'Ann'],
      [bob, 'Bob'],
      [ann, 'Ann'],
      [bob, 'Bob'],
    ];
    for (const [user, name] of users) {
      if (new Set(pages.map((p) => p.instance)).size === 2 && pages.length >= 2) break;
      pages.push({ ...(await openAuction(id, user, name)), who: name });
    }
    assert.deepEqual(
      [...new Set(pages.map((p) => p.instance))].sort(),
      ['api1', 'api2'],
      'pages must span both containers',
    );
    const total = pages.length;
    for (const p of pages) await waitText(p.page, 'participants', `${String(total)} watching`);

    const first = pages[0];
    const other = pages.find((p) => p.instance !== first?.instance);
    assert.ok(first && other);
    // The first page bids; a page on the OTHER container shows it, with no reload.
    await first.page.getByTestId('bid-input').fill('12.50');
    await first.page.getByTestId('bid-submit').click();
    await waitText(first.page, 'price', /^12\.50/);
    await waitText(other.page, 'price', /^12\.50/);
    assert.match(await text(other.page, 'bid-row'), /#1\s*\w+\s*12\.50/);
    // And back the other way.
    await other.page.getByTestId('bid-input').fill('15');
    await other.page.getByTestId('bid-submit').click();
    for (const p of pages) await waitText(p.page, 'price', /^15\.00/);
    for (const p of pages) assert.equal(await p.page.getByTestId('bid-row').count(), 2);

    await other.page.screenshot({
      path: path.join(screenshotDir, 'cluster-other-container.png'),
      fullPage: true,
    });
    for (const p of pages) assert.deepEqual(p.problems, [], `console problems on ${p.instance}`);
  });

  it('a real container restart under open pages: they show reconnecting, come back on their own, and nothing is shown twice', async () => {
    const id = await liveAuction(viaNginx, seller.token, { title: 'Restart under load' });
    const a = await openAuction(id, ann, 'Ann');
    let b = await openAuction(id, bob, 'Bob');
    for (let i = 0; i < 4 && b.instance === a.instance; i += 1) {
      b = await openAuction(id, bob, 'Bob'); // keep going until the second page is on the other container
    }
    assert.notEqual(a.instance, b.instance);
    await waitText(a.page, 'participants', /watching/);

    await a.page.getByTestId('bid-input').fill('10.00');
    await a.page.getByTestId('bid-submit').click();
    await waitText(b.page, 'price', /^10\.00/);

    // Restart the container that holds Ann's socket.
    await compose('restart', a.instance);
    await a.page.getByTestId('connection').filter({ hasText: 'Live' }).waitFor({ timeout: 40_000 });

    // After reconnecting and re-joining, Ann is subscribed exactly once: Bob's bid reaches her once.
    await b.page.getByTestId('bid-input').fill('11.00');
    await b.page.getByTestId('bid-submit').click();
    await waitText(a.page, 'price', /^11\.00/);
    await sleep(500);
    assert.equal(await a.page.getByTestId('bid-row').count(), 2, 'a bid was shown twice or lost');
    assert.equal(await b.page.getByTestId('bid-row').count(), 2);
    await waitText(a.page, 'bid-count', '2');
    await waitText(b.page, 'bid-count', '2');
    assert.match(await text(a.page, 'participants'), /\d+ watching/);
    await bothInstancesInRotation(); // leave the cluster as we found it for the next test
  });
});
