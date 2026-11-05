import type { AddressInfo } from 'node:net';
import { createApp } from '../../apps/api/src/app.ts';
import { createPool, type Db } from '../../apps/api/src/db/pool.ts';
import { createLogger } from '../../apps/api/src/logging/logger.ts';

export function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. Run: npm run test:integration');
  }
  return url;
}

export interface TestApp {
  db: Db;
  base: string;
  /** Every log line the app wrote, parsed. */
  logs: Record<string, unknown>[];
  close: () => Promise<void>;
}

export async function startApp(options: { sessionTtlSeconds?: number } = {}): Promise<TestApp> {
  const db = createPool(testDatabaseUrl(), 20);
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger('debug', (line) => {
    logs.push(JSON.parse(line) as Record<string, unknown>);
  });
  const server = createApp({
    db,
    checks: [],
    logger,
    sessionTtlSeconds: options.sessionTtlSeconds ?? 3600,
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    db,
    logs,
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await db.end();
    },
  };
}

export async function resetData(db: Db): Promise<void> {
  await db.query(
    'TRUNCATE idempotency_records, bids, sessions, auctions, users RESTART IDENTITY CASCADE',
  );
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  // Test code asserts on the shape; the server output is not typed here.
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function makeClient(base: string) {
  return async function api(
    method: string,
    path: string,
    options: {
      token?: string | undefined;
      body?: unknown;
      rawBody?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
    let body: string | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      headers['Content-Type'] = 'application/json';
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: text.length > 0 ? JSON.parse(text) : undefined,
    };
  };
}

export type Api = ReturnType<typeof makeClient>;

let counter = 0;
export const PASSWORD = 'correct horse battery';

/** Registers and logs in a fresh user; returns the bearer token and user id. */
export async function newUser(
  api: Api,
  name = 'user',
): Promise<{ token: string; id: string; email: string }> {
  counter += 1;
  const email = `${name}${String(counter)}-${String(Date.now())}@example.com`;
  const reg = await api('POST', '/auth/register', {
    body: { email, password: PASSWORD, displayName: name },
  });
  if (reg.status !== 201) throw new Error(`register failed: ${String(reg.status)}`);
  const login = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
  if (login.status !== 200) throw new Error(`login failed: ${String(login.status)}`);
  return { token: login.body.token as string, id: reg.body.user.id as string, email };
}

export function inFuture(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export const HOUR = 3_600_000;

export function auctionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Vintage camera',
    startingPrice: '10.00',
    startsAt: inFuture(HOUR),
    endsAt: inFuture(2 * HOUR),
    ...overrides,
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let keyCounter = 0;
/** A fresh, valid Idempotency-Key. */
export function newKey(): string {
  keyCounter += 1;
  return `test-key-${String(Date.now())}-${String(keyCounter)}`;
}

/** Creates and publishes an auction that is LIVE right now. Returns its id. */
export async function liveAuction(
  api: Api,
  sellerToken: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await api('POST', '/auctions', {
    token: sellerToken,
    body: auctionBody({
      startsAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      endsAt: inFuture(2 * HOUR),
      ...overrides,
    }),
  });
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const id = created.body.auction.id as string;
  const published = await api('POST', `/auctions/${id}/publish`, { token: sellerToken });
  if (published.body.auction.status !== 'LIVE') throw new Error('auction did not become LIVE');
  return id;
}

export function placeBid(
  api: Api,
  token: string | undefined,
  auctionId: string,
  amount: unknown,
  key: string | null = newKey(),
): Promise<ApiResponse> {
  return api('POST', `/auctions/${auctionId}/bids`, {
    token,
    body: { amount },
    ...(key === null ? {} : { headers: { 'Idempotency-Key': key } }),
  });
}
