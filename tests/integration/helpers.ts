import type { AddressInfo } from 'node:net';
import type { Server } from 'socket.io';
import { createRunningServer } from '../../apps/api/src/createServer.ts';
import { createPool, type Db } from '../../apps/api/src/db/pool.ts';
import { createLogger } from '../../apps/api/src/logging/logger.ts';
import {
  createOutboxPublisher,
  createPublishClient,
  createRedisEmitterSink,
  createSocketIoSink,
  type OutboxFaults,
  type OutboxPublisher,
} from '../../apps/api/src/modules/outbox/index.ts';
import { createRedisPair, type RedisPair } from '../../apps/api/src/modules/realtime/index.ts';

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
  /** The Socket.IO server, for tests that inspect rooms. */
  io: Server;
  /** Present when started with `redisUrl`: this instance is part of a cluster. */
  redis: RedisPair | undefined;
  /** The embedded outbox publisher (publishes through this instance's own Socket.IO server). */
  outbox: OutboxPublisher | undefined;
  close: () => Promise<void>;
}

export interface StartAppOptions {
  sessionTtlSeconds?: number;
  maxRoomsPerSocket?: number;
  /** Connect this instance to other instances through Redis (the Socket.IO adapter). */
  redisUrl?: string;
  instanceId?: string;
  /**
   * By default the instance also runs an outbox publisher that delivers through its own Socket.IO
   * server, so a bid becomes a live event without a separate worker process (the production
   * setup has a separate worker; tests of that path use startEmitterWorker). `false`: none.
   */
  outbox?: false;
}

export async function startApp(options: StartAppOptions = {}): Promise<TestApp> {
  const db = createPool(testDatabaseUrl(), 20);
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger(
    'debug',
    (line) => {
      logs.push(JSON.parse(line) as Record<string, unknown>);
    },
    options.instanceId === undefined ? {} : { instance: options.instanceId },
  );
  const redis =
    options.redisUrl === undefined ? undefined : createRedisPair(options.redisUrl, logger);
  const running = createRunningServer({
    db,
    checks: [],
    logger,
    ...(redis === undefined ? {} : { redis }),
    ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
    sessionTtlSeconds: options.sessionTtlSeconds ?? 3600,
    ...(options.maxRoomsPerSocket === undefined
      ? {}
      : { maxRoomsPerSocket: options.maxRoomsPerSocket }),
  });
  const server = running.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const outbox =
    options.outbox === false
      ? undefined
      : createOutboxPublisher({
          db,
          sink: createSocketIoSink(running.realtime.io),
          logger,
          workerId: options.instanceId ?? 'embedded',
          pollIntervalMs: 20,
        });
  outbox?.start();
  return {
    db,
    logs,
    io: running.realtime.io,
    redis,
    outbox,
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: async () => {
      await outbox?.stop();
      // Closing Socket.IO also closes the HTTP server and all WebSocket connections.
      await running.realtime.close();
      await redis?.close();
      await db.end();
    },
  };
}

export async function resetData(db: Db): Promise<void> {
  await db.query(
    'TRUNCATE notifications, outbox_retry_audit, outbox_events, idempotency_records, bids, sessions, auctions, users RESTART IDENTITY CASCADE',
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

/**
 * Test-only time travel. The database now refuses to move ends_at except as a counted, forward
 * anti-sniping extension, so a test that needs "the auction ends in 1.5 seconds" or "ended a second
 * ago" changes the row with triggers switched off for ONE session (session_replication_role =
 * replica, which needs the superuser of the throwaway test database). The table CHECKs still apply,
 * which is why original_ends_at moves with ends_at. `sqlExpr` is test-controlled SQL, never input.
 */
export async function setAuctionEnd(
  db: Db,
  auctionId: string,
  sqlExpr: string,
  /** The seller's original end time; defaults to the same instant (no extension used). */
  originalSqlExpr?: string,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("SET session_replication_role = 'replica'");
    // Each expression is evaluated ONCE (two clock_timestamp() calls would differ by microseconds).
    await client.query(
      `UPDATE auctions SET ends_at = t.e, original_ends_at = COALESCE(t.o, t.e)
         FROM (SELECT (${sqlExpr}) AS e, (${originalSqlExpr ?? 'NULL::timestamptz'}) AS o) t
        WHERE id = $1`,
      [auctionId],
    );
  } finally {
    await client.query('RESET session_replication_role').catch(() => undefined);
    client.release();
  }
}

/** Test-only time travel for the START time (same mechanism and caveats as setAuctionEnd). */
export async function setAuctionStart(db: Db, auctionId: string, sqlExpr: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("SET session_replication_role = 'replica'");
    await client.query(`UPDATE auctions SET starts_at = ${sqlExpr} WHERE id = $1`, [auctionId]);
  } finally {
    await client.query('RESET session_replication_role').catch(() => undefined);
    client.release();
  }
}

/**
 * Ends an auction the way the worker's SQL does (status, time, winner, event counter, and the outbox
 * row, in one transaction), for tests that exercise the database rules directly.
 */
export async function endAuctionRaw(db: Db, auctionId: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ auction_event_sequence: string }>(
      `UPDATE auctions
          SET status = 'ENDED', ended_at = clock_timestamp(), winning_bid_id = highest_bid_id,
              auction_event_sequence = auction_event_sequence + 1
        WHERE id = $1 RETURNING auction_event_sequence`,
      [auctionId],
    );
    await client.query(
      `INSERT INTO outbox_events (auction_id, event_type, schema_version, auction_event_sequence, payload, occurred_at)
       VALUES ($1, 'auction.ended', 2, $2, '{}'::jsonb, clock_timestamp())`,
      [auctionId, (rows[0] as { auction_event_sequence: string }).auction_event_sequence],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

export interface EmitterWorker {
  publisher: OutboxPublisher;
  /** Same shape as a worker process: a Redis publish client, no Socket.IO server. */
  close: () => Promise<void>;
}

/**
 * An outbox worker as it runs in production: its own pool and Redis connection, delivering with the
 * Socket.IO Redis EMITTER (there is no Socket.IO server in the worker). Not started: call
 * `publisher.start()` or `runOnce()`.
 */
export function startEmitterWorker(options: {
  redisUrl: string;
  workerId: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  pollIntervalMs?: number;
  faults?: OutboxFaults;
  logs?: Record<string, unknown>[];
}): EmitterWorker {
  const db = createPool(testDatabaseUrl(), 5);
  const lines = options.logs ?? [];
  const logger = createLogger(
    'debug',
    (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
    { instance: options.workerId, role: 'outbox-worker' },
  );
  const redis = createPublishClient(options.redisUrl, logger);
  const publisher = createOutboxPublisher({
    db,
    sink: createRedisEmitterSink(redis),
    logger,
    workerId: options.workerId,
    pollIntervalMs: options.pollIntervalMs ?? 20,
    ...(options.leaseSeconds === undefined ? {} : { leaseSeconds: options.leaseSeconds }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.faults === undefined ? {} : { faults: options.faults }),
  });
  return {
    publisher,
    close: async () => {
      await publisher.stop();
      await redis.quit().catch(() => undefined);
      await db.end();
    },
  };
}

/**
 * What the bid transaction does to an auction, in raw SQL, for tests that bypass the application:
 * insert the bid, advance BOTH counters with the price, and write the outbox event. Must run inside
 * the client's open transaction. Returns the new event sequence.
 */
export async function acceptBidRaw(
  client: import('pg').PoolClient,
  p: { auctionId: string; bidderId: string; amount: string; withOutbox?: boolean },
): Promise<{ bidId: string; eventSequence: string }> {
  const a = await client.query<{ bid_sequence: string }>(
    'SELECT bid_sequence FROM auctions WHERE id = $1 FOR UPDATE',
    [p.auctionId],
  );
  const bidSequence = String(BigInt((a.rows[0] as { bid_sequence: string }).bid_sequence) + 1n);
  const bid = await client.query<{ id: string; accepted_at: Date }>(
    `INSERT INTO bids (auction_id, bidder_id, amount, bid_sequence, accepted_at)
     VALUES ($1, $2, $3, $4, clock_timestamp()) RETURNING id, accepted_at`,
    [p.auctionId, p.bidderId, p.amount, bidSequence],
  );
  const bidRow = bid.rows[0] as { id: string; accepted_at: Date };
  const updated = await client.query<{ auction_event_sequence: string }>(
    `UPDATE auctions
        SET current_price = $2, highest_bid_id = $3, bid_sequence = $4,
            auction_event_sequence = auction_event_sequence + 1
      WHERE id = $1 RETURNING auction_event_sequence`,
    [p.auctionId, p.amount, bidRow.id, bidSequence],
  );
  const eventSequence = (updated.rows[0] as { auction_event_sequence: string })
    .auction_event_sequence;
  if (p.withOutbox !== false) {
    await client.query(
      `INSERT INTO outbox_events (auction_id, event_type, schema_version, auction_event_sequence, payload, occurred_at)
       VALUES ($1, 'bid.accepted', 2, $2, $3::jsonb, $4)`,
      [
        p.auctionId,
        eventSequence,
        JSON.stringify({
          bidId: bidRow.id,
          bidderId: p.bidderId,
          bidderDisplayName: 'raw',
          amount: p.amount,
          currentPrice: p.amount,
          bidSequence: Number(bidSequence),
          acceptedAt: bidRow.accepted_at.toISOString(),
          endsAt: new Date(Date.now() + 3_600_000).toISOString(),
          minimumNextBid: null,
        }),
        bidRow.accepted_at,
      ],
    );
  }
  return { bidId: bidRow.id, eventSequence };
}
