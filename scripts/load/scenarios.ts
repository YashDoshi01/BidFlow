// The Phase 9 scenarios. Each one seeds its own users and auctions (deterministically), applies a
// workload, checks the database invariants (lib.ts: checkInvariants) and returns a ScenarioResult.
// Nothing here is a benchmark of "the best case": the load generator runs on the SAME machine as
// the cluster, so every number is a statement about this machine and this workload only.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { TestSocket } from '../../tests/integration/realtime-helpers.ts';
import {
  breakdown,
  checkInvariants,
  rng,
  runBidder,
  seedAuctions,
  seedUsers,
  sleep,
  summarize,
  throughput,
  type Sample,
  type ScenarioResult,
} from './lib.ts';

export interface Ctx {
  /** Base URL of the REST API through NGINX (…/api). */
  api: string;
  /** Base URL of NGINX (Socket.IO connects here). */
  nginx: string;
  seconds: number;
  /** Prefix that makes seeded emails/tokens unique per run. */
  tag: string;
  /** A pool on the CURRENT published PostgreSQL port; the caller ends it. */
  getPool: () => Promise<Pool>;
  compose: (...args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Recreates api1 and api2 with extra environment variables (a different configuration). */
  reconfigure: (env: Record<string, string>) => Promise<void>;
  concurrency: number;
}

export interface Scenario {
  name: string;
  /** Environment for api1/api2 while this scenario runs (the runner reconfigures when it changes). */
  apiEnv: Record<string, string>;
  run: (ctx: Ctx, name: string) => Promise<ScenarioResult>;
}

const STARTING = '100.00';
const INCREMENT = '1.00';

async function seed(ctx: Ctx, pool: Pool, name: string, bidders: number, auctions: number) {
  const users = await seedUsers(pool, bidders + 1, `${ctx.tag}-${name}`);
  const seller = users[0];
  if (seller === undefined) throw new Error('no seller');
  const auctionIds = await seedAuctions(pool, seller.id, auctions, name, STARTING, INCREMENT);
  return { bidders: users.slice(1), auctionIds };
}

function startBidders(
  ctx: Ctx,
  name: string,
  users: { id: string; token: string }[],
  auctionIds: string[],
  samples: Sample[],
  runStart: number,
  until: number,
  extra: { thinkMs?: number; retryUnknown?: boolean } = {},
): Promise<void>[] {
  return users.map((user, i) =>
    runBidder({
      base: ctx.api,
      user,
      auctionIds,
      startingPrice: STARTING,
      increment: INCREMENT,
      until,
      runStart,
      random: rng(1000 + i),
      keyPrefix: `${ctx.tag}-${name}-${String(i)}`,
      record: (s) => samples.push(s),
      ...extra,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// 1. browsing (read-only HTTP)
// ---------------------------------------------------------------------------------------------
const browse: Scenario['run'] = async (ctx, name) => {
  const pool = await ctx.getPool();
  try {
    const { auctionIds } = await seed(ctx, pool, name, 1, 200);
    const samples: Sample[] = [];
    const runStart = Date.now();
    const until = runStart + ctx.seconds * 1000;
    const random = rng(7);
    await Promise.all(
      Array.from({ length: ctx.concurrency }, async () => {
        while (Date.now() < until) {
          const detail = random() < 0.3;
          const url = detail
            ? `${ctx.api}/auctions/${auctionIds[Math.floor(random() * auctionIds.length)] ?? ''}`
            : `${ctx.api}/auctions?limit=20`;
          const at = Date.now() - runStart;
          const t0 = performance.now();
          let status = 0;
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
            status = res.status;
            await res.arrayBuffer();
          } catch {
            // status stays 0: no answer
          }
          samples.push({
            at,
            ms: performance.now() - t0,
            status,
            code: status === 200 ? '' : 'ERR',
          });
        }
      }),
    );
    const elapsed = (Date.now() - runStart) / 1000;
    return {
      scenario: name,
      workload: {
        kind: 'read-only HTTP through NGINX',
        concurrentClients: ctx.concurrency,
        mix: '70% GET /auctions?limit=20, 30% GET /auctions/:id',
        seededAuctions: auctionIds.length,
        seconds: ctx.seconds,
      },
      measured: {
        requestsPerSecond: throughput(samples, elapsed),
        latencyMs: summarize(samples.map((s) => s.ms)),
        outcomes: breakdown(samples).byOutcome,
      },
      violations: samples.some((s) => s.status !== 200) ? ['some reads did not return 200'] : [],
      raw: samples,
    };
  } finally {
    await pool.end();
  }
};

const execFileAsync = promisify(execFile);

/**
 * Diagnostic sampler (Phase 9 bottleneck hunt). While a load runs it records, every ~250 ms, what
 * the backend sessions of the throwaway database are doing (pg_stat_activity: state and wait
 * event) and, every few seconds, CPU % and memory of the throwaway containers (docker stats).
 * It is a second connection and a `docker stats` call, so it adds a little load of its own.
 */
function startSampler(pool: Pool): { stop: () => Promise<Record<string, unknown>> } {
  const state = { running: true };
  const waits: Record<string, number> = {};
  let pgSamples = 0;
  const cpu: Record<string, number[]> = {};
  const mem: Record<string, number[]> = {};
  const pgLoop = (async () => {
    while (state.running) {
      try {
        const r = await pool.query<{ k: string; n: string }>(
          `SELECT coalesce(wait_event_type, 'none') || ':' || coalesce(wait_event, '-') || ' ' || state AS k,
                  count(*)::text AS n
             FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
            GROUP BY 1`,
        );
        pgSamples++;
        for (const row of r.rows) waits[row.k] = (waits[row.k] ?? 0) + Number(row.n);
      } catch {
        // sampling must never fail a run
      }
      await sleep(250);
    }
  })();
  const dockerLoop = (async () => {
    while (state.running) {
      try {
        const { stdout } = await execFileAsync('docker', [
          'stats',
          '--no-stream',
          '--format',
          '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}',
        ]);
        for (const line of stdout.split('\n')) {
          const [name, cpuPct, memUse] = line.trim().split('|');
          if (name === undefined || !name.startsWith('bidflow-load')) continue;
          const short = name.replace(/^bidflow-load-/, '').replace(/-\d+$/, '');
          (cpu[short] ??= []).push(parseFloat(cpuPct ?? '0'));
          (mem[short] ??= []).push(parseFloat((memUse ?? '0').split('/')[0] ?? '0'));
        }
      } catch {
        // ignore
      }
    }
  })();
  return {
    stop: async () => {
      state.running = false;
      await Promise.all([pgLoop, dockerLoop]);
      const total = Object.values(waits).reduce((a, b) => a + b, 0);
      const stat = (xs: number[]) => ({
        samples: xs.length,
        mean: Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)) * 10) / 10,
        max: Math.max(0, ...xs),
      });
      return {
        pgSamples,
        backendSessionSamples: total,
        backendsByStateAndWait: Object.fromEntries(
          Object.entries(waits)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => [k, Math.round((v / Math.max(pgSamples, 1)) * 100) / 100]),
        ),
        note: 'backendsByStateAndWait = average number of backend sessions in that state per sample; containerCpuPercent: 100 = one full core',
        containerCpuPercent: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, stat(v)])),
        containerMemMiB: Object.fromEntries(Object.entries(mem).map(([k, v]) => [k, stat(v)])),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 2/3. bid load: one hot auction, or the same bidders spread over many auctions
// ---------------------------------------------------------------------------------------------
function bidLoad(auctions: number, kind: string): Scenario['run'] {
  return async (ctx, name) => {
    const pool = await ctx.getPool();
    try {
      const { bidders, auctionIds } = await seed(ctx, pool, name, ctx.concurrency, auctions);
      const samples: Sample[] = [];
      const samplerPool = await ctx.getPool();
      const sampler = startSampler(samplerPool);
      const runStart = Date.now();
      await Promise.all(
        startBidders(
          ctx,
          name,
          bidders,
          auctionIds,
          samples,
          runStart,
          runStart + ctx.seconds * 1000,
        ),
      );
      const elapsed = (Date.now() - runStart) / 1000;
      const sampled = await sampler.stop();
      await samplerPool.end();
      const report = await checkInvariants(pool, auctionIds, samples);
      const accepted = samples.filter((s) => s.status === 201);
      const lock = await pool.query<{ waiting: string }>(
        `SELECT count(*)::text AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock'`,
      );
      return {
        scenario: name,
        workload: {
          kind,
          concurrentBidders: ctx.concurrency,
          auctions,
          bidding:
            'closed loop: next bid is sent when the previous answer arrives; each bidder bids the minimum it believes is acceptable plus 0-2 increments; it learns the real minimum from the answer',
          seconds: ctx.seconds,
          seed: 'rng(1000 + bidderIndex); users and tokens derived from the tag',
        },
        measured: {
          requestsPerSecond: throughput(samples, elapsed),
          acceptedPerSecond: throughput(samples, elapsed, (s) => s.status === 201),
          outcomes: breakdown(samples).byOutcome,
          latencyAllMs: summarize(samples.map((s) => s.ms)),
          latencyAcceptedMs: summarize(accepted.map((s) => s.ms)),
          latencyRejectedMs: summarize(samples.filter((s) => s.status === 409).map((s) => s.ms)),
          bidsInDatabase: report.bidsInDatabase,
          sessionsWaitingOnLockAtTheEnd: Number(lock.rows[0]?.waiting),
          sampled,
        },
        violations: report.violations,
        raw: samples,
      };
    } finally {
      await pool.end();
    }
  };
}

// ---------------------------------------------------------------------------------------------
// 4. WebSocket fan-out across two instances
// ---------------------------------------------------------------------------------------------
const fanout: Scenario['run'] = async (ctx, name) => {
  const pool = await ctx.getPool();
  const sockets: TestSocket[] = [];
  try {
    const { bidders, auctionIds } = await seed(ctx, pool, name, 1, 1);
    const auctionId = auctionIds[0] ?? '';
    const bidder = bidders[0];
    if (bidder === undefined) throw new Error('no bidder');
    const connections = ctx.concurrency;
    const bids = 100;
    // received[i] = [{sequence, at}] for socket i, in arrival order
    const received: { sequence: number; at: number }[][] = [];
    for (let i = 0; i < connections; i += 1) {
      const s = await TestSocket.connect(ctx.nginx);
      const mine: { sequence: number; at: number }[] = [];
      received.push(mine);
      s.socket.on('bid.accepted', (event: { sequence: number }) => {
        mine.push({ sequence: event.sequence, at: performance.now() });
      });
      const ack = await s.join(auctionId);
      if (!ack.ok) throw new Error('join refused');
      sockets.push(s);
    }
    // Which instance holds each socket: answered from the instances' own logs.
    const where = new Map<string, string>();
    for (const svc of ['api1', 'api2']) {
      const out = (await ctx.compose('logs', '--no-color', '--no-log-prefix', svc)).stdout;
      for (const line of out.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const l = JSON.parse(line) as { msg?: string; socketId?: string };
          if (l.msg === 'socket connected' && l.socketId !== undefined) where.set(l.socketId, svc);
        } catch {
          // partial line
        }
      }
    }
    const sentAt: number[] = [];
    const bidSamples: Sample[] = [];
    let amount = 100;
    for (let n = 1; n <= bids; n += 1) {
      amount += 1;
      sentAt[n] = performance.now();
      const res = await fetch(`${ctx.api}/auctions/${auctionId}/bids`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bidder.token}`,
          'Idempotency-Key': `${ctx.tag}-fanout-${String(n)}`,
        },
        body: JSON.stringify({ amount: amount.toFixed(2) }),
      });
      if (res.status !== 201) throw new Error(`bid ${String(n)} answered ${String(res.status)}`);
      const body = (await res.json()) as { bid: { id: string } };
      bidSamples.push({ at: 0, ms: 0, status: 201, code: '', bidId: body.bid.id });
      await sleep(100);
    }
    await sleep(3000); // let the last events arrive
    const latencies: number[] = [];
    const perInstance: Record<string, number[]> = {};
    const violations: string[] = [];
    let deliveries = 0;
    for (let i = 0; i < connections; i += 1) {
      const mine = received[i] ?? [];
      const sequences = mine.map((e) => e.sequence);
      const inst = where.get(sockets[i]?.socket.id ?? '') ?? 'unknown';
      deliveries += mine.length;
      if (sequences.length !== bids || sequences.some((q, k) => q !== k + 1)) {
        violations.push(
          `socket ${String(i)} on ${inst}: got ${String(sequences.length)} events, not exactly 1..${String(bids)} in order`,
        );
      }
      for (const e of mine) {
        const l = e.at - (sentAt[e.sequence] ?? e.at);
        latencies.push(l);
        (perInstance[inst] ??= []).push(l);
      }
    }
    const published = await pool.query<{ ms: number[] }>(
      `SELECT array_agg(extract(epoch FROM published_at - created_at) * 1000) AS ms
       FROM outbox_events WHERE auction_id = $1`,
      [auctionId],
    );
    const report = await checkInvariants(pool, auctionIds, bidSamples);
    violations.push(...report.violations);
    const dbOnly = await pool.query<{ out: string }>(
      `SELECT count(*)::text AS out FROM outbox_events WHERE auction_id = $1 AND status = 'published'`,
      [auctionId],
    );
    return {
      scenario: name,
      workload: {
        kind: 'one auction, many sockets across two API instances behind NGINX (least_conn)',
        sockets: connections,
        bids,
        bidPacing: 'one bid every ~100 ms from one bidder (POST through NGINX)',
        latencyDefinition:
          'time from sending the POST until the socket received bid.accepted, same process clock (performance.now); it includes the bid transaction, the outbox worker poll, Redis, and the instance fan-out',
      },
      measured: {
        socketsPerInstance: Object.fromEntries(
          Object.entries(
            [...where.values()].reduce<Record<string, number>>(
              (a, v) => ({ ...a, [v]: (a[v] ?? 0) + 1 }),
              {},
            ),
          ),
        ),
        deliveriesExpected: connections * bids,
        deliveriesReceived: deliveries,
        endToEndLatencyMs: summarize(latencies),
        endToEndLatencyByInstanceMs: Object.fromEntries(
          Object.entries(perInstance).map(([k, v]) => [k, summarize(v)]),
        ),
        outboxPublicationDelayMs: summarize(published.rows[0]?.ms ?? []),
        outboxPublished: Number(dbOnly.rows[0]?.out),
      },
      violations,
      raw: { latencies },
    };
  } finally {
    sockets.forEach((s) => {
      s.close();
    });
    await pool.end();
  }
};

// ---------------------------------------------------------------------------------------------
// Fault helpers
// ---------------------------------------------------------------------------------------------

interface TimelinePoint {
  t: number;
  pending: number;
}

/** Samples the outbox backlog once a second until stopped. */
function backlogSampler(ctx: Ctx, runStart: number): { stop: () => Promise<TimelinePoint[]> } {
  const points: TimelinePoint[] = [];
  const state = { running: true };
  const loop = (async () => {
    let pool: Pool | undefined;
    while (state.running) {
      try {
        pool ??= await ctx.getPool();
        const r = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM outbox_events WHERE status <> 'published'`,
        );
        points.push({
          t: Math.round((Date.now() - runStart) / 100) / 10,
          pending: Number(r.rows[0]?.n),
        });
      } catch {
        points.push({ t: Math.round((Date.now() - runStart) / 100) / 10, pending: -1 }); // -1: database unreachable
        await pool?.end().catch(() => undefined);
        pool = undefined;
      }
      await sleep(1000);
    }
    await pool?.end().catch(() => undefined);
  })();
  return {
    stop: async () => {
      state.running = false;
      await loop;
      return points;
    },
  };
}

async function untilPublished(pool: Pool, auctionIds: string[], ms: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox_events WHERE auction_id = ANY($1::uuid[]) AND status <> 'published'`,
      [auctionIds],
    );
    if (Number(r.rows[0]?.n) === 0) return Date.now() - t0;
    await sleep(250);
  }
  return -1;
}

async function waitHealthy(ctx: Ctx, services: string[]): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const out = (await ctx.compose('ps', '--format', 'json', ...services)).stdout;
      const rows = out
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => JSON.parse(l) as { State: string; Health?: string });
      if (
        rows.length === services.length &&
        rows.every(
          (r) =>
            r.State === 'running' &&
            (r.Health === undefined || r.Health === '' || r.Health === 'healthy'),
        )
      )
        return;
    } catch {
      // not ready
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${services.join(', ')}`);
}

/** Per-second accepted/failed counts, so the effect of a fault is visible over time. */
function perSecond(samples: Sample[]): { second: number; ok: number; failed: number }[] {
  const out = new Map<number, { ok: number; failed: number }>();
  for (const s of samples) {
    const sec = Math.floor(s.at / 1000);
    const row = out.get(sec) ?? { ok: 0, failed: 0 };
    if (s.status === 201) row.ok += 1;
    else if (s.status === 0 || s.status >= 500) row.failed += 1;
    out.set(sec, row);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([second, v]) => ({ second, ...v }));
}

/**
 * Bid load with a fault injected at `faultAtS`. Clients retry the SAME idempotency key on a network
 * error or 5xx (what a real client does). Afterwards the same invariants must hold and every
 * accepted bid must be published.
 */
function faultUnderLoad(options: {
  kind: string;
  auctions: number;
  bidders: number;
  totalS: number;
  faultAtS: number;
  fault: (ctx: Ctx, pool: Pool, notes: string[]) => Promise<void>;
  expectation: string;
}): Scenario['run'] {
  return async (ctx, name) => {
    const setup = await ctx.getPool();
    const notes: string[] = [];
    try {
      const { bidders, auctionIds } = await seed(
        ctx,
        setup,
        name,
        options.bidders,
        options.auctions,
      );
      await setup.end();
      const samples: Sample[] = [];
      const runStart = Date.now();
      const sampler = backlogSampler(ctx, runStart);
      const loads = startBidders(
        ctx,
        name,
        bidders,
        auctionIds,
        samples,
        runStart,
        runStart + options.totalS * 1000,
        {
          thinkMs: 20,
          retryUnknown: true,
        },
      );
      await sleep(options.faultAtS * 1000);
      const faultAt = (Date.now() - runStart) / 1000;
      const pool1 = await ctx.getPool();
      await options.fault(ctx, pool1, notes);
      await pool1.end().catch(() => undefined);
      await Promise.all(loads);
      const timeline = await sampler.stop();
      const pool = await ctx.getPool();
      try {
        const drainMs = await untilPublished(pool, auctionIds, 60_000);
        const report = await checkInvariants(pool, auctionIds, samples);
        const delays = await pool.query<{ ms: number[] }>(
          `SELECT array_agg(extract(epoch FROM o.published_at - o.created_at) * 1000) AS ms
           FROM outbox_events o WHERE o.auction_id = ANY($1::uuid[])`,
          [auctionIds],
        );
        const slow = samples.filter((s) => s.ms > 1000);
        return {
          scenario: name,
          workload: {
            kind: options.kind,
            bidders: options.bidders,
            auctions: options.auctions,
            seconds: options.totalS,
            faultInjectedAtSecond: Math.round(faultAt * 10) / 10,
            clientBehaviour:
              'retries the same Idempotency-Key on network error or 5xx (up to 100 times, 150 ms apart)',
          },
          expectation: options.expectation,
          measured: {
            acceptedBids: report.acceptedByClients,
            bidsInDatabase: report.bidsInDatabase,
            outcomes: breakdown(samples).byOutcome,
            requestsSlowerThan1sIncludingRetries: slow.length,
            requestsThatNeededARetry: samples.filter((s) => (s.retries ?? 0) > 0).length,
            totalRetryAttempts: samples.reduce((a, s) => a + (s.retries ?? 0), 0),
            requestsThatGaveUp: samples.filter((s) => s.status === 0 || s.status >= 500).length,
            slowestRequestMs: Math.round(Math.max(0, ...samples.map((s) => s.ms))),
            perSecond: perSecond(samples),
            outboxBacklogTimeline: timeline,
            msFromEndOfLoadUntilEveryEventPublished: drainMs,
            outboxPublicationDelayMs: summarize(delays.rows[0]?.ms ?? []),
          },
          violations: [
            ...report.violations,
            ...(drainMs < 0
              ? ['outbox was not fully published within 60 s after the load ended']
              : []),
          ],
          notes,
          raw: samples,
        };
      } finally {
        await pool.end();
      }
    } finally {
      await setup.end().catch(() => undefined);
    }
  };
}

const faultApiKill = faultUnderLoad({
  kind: 'bid load while api1 is killed (docker kill, no graceful shutdown), restarted 8 s later',
  auctions: 5,
  bidders: 20,
  totalS: 30,
  faultAtS: 8,
  expectation:
    'Requests in flight on api1 fail; clients retry the same key and are served by api2 (NGINX marks api1 failed). No accepted bid is lost, none is duplicated, sequences stay gapless.',
  fault: async (ctx, _pool, notes) => {
    await ctx.compose('kill', 'api1');
    notes.push('api1 killed');
    await sleep(8000);
    await ctx.compose('start', 'api1');
    await waitHealthy(ctx, ['api1']);
    notes.push('api1 healthy again');
  },
});

const faultPostgres = faultUnderLoad({
  kind: 'bid load while PostgreSQL is stopped for 6 s',
  auctions: 5,
  bidders: 20,
  totalS: 30,
  faultAtS: 8,
  expectation:
    'Bids cannot be accepted while the database is down (5xx); clients retry the same key; after it returns, the invariants hold and nothing is duplicated. The outbox backlog cannot be read while it is down.',
  fault: async (ctx, _pool, notes) => {
    await ctx.compose('stop', 'postgres');
    notes.push('postgres stopped');
    await sleep(6000);
    await ctx.compose('start', 'postgres');
    await waitHealthy(ctx, ['postgres']);
    notes.push('postgres healthy again');
    await sleep(3000);
  },
});

const faultRedis = faultUnderLoad({
  kind: 'bid load while Redis is stopped for 10 s',
  auctions: 5,
  bidders: 20,
  totalS: 35,
  faultAtS: 8,
  expectation:
    'Bids are still accepted (the limiter is off here; with it on it falls back per process, tested in tests/cluster/06). Events stay pending in the outbox while Redis is down; after it returns, every event is published, ordered per auction.',
  fault: async (ctx, _pool, notes) => {
    await ctx.compose('stop', 'redis');
    notes.push('redis stopped');
    await sleep(10_000);
    await ctx.compose('start', 'redis');
    await waitHealthy(ctx, ['redis']);
    notes.push('redis healthy again');
  },
});

const faultWorkers = faultUnderLoad({
  kind: 'bid load; worker1 killed at 8 s, then worker2 killed at 16 s (no publisher at all), both restarted at 24 s',
  auctions: 5,
  bidders: 20,
  totalS: 40,
  faultAtS: 8,
  expectation:
    'Killing one worker: the other takes over its leased rows after the lease (3 s here). Killing both: bids are still accepted, the backlog grows, and it drains after a worker returns. No event is lost or duplicated in the database.',
  fault: async (ctx, _pool, notes) => {
    await ctx.compose('kill', 'worker1');
    notes.push('worker1 killed');
    await sleep(8000);
    await ctx.compose('kill', 'worker2');
    notes.push('worker2 killed');
    await sleep(8000);
    await ctx.compose('start', 'worker1', 'worker2');
    notes.push('workers restarted');
  },
});

// ---------------------------------------------------------------------------------------------
// Client disconnect / reconnect
// ---------------------------------------------------------------------------------------------
const reconnect: Scenario['run'] = async (ctx, name) => {
  const pool = await ctx.getPool();
  const sockets: TestSocket[] = [];
  try {
    const { bidders, auctionIds } = await seed(ctx, pool, name, 6, 1);
    const auctionId = auctionIds[0] ?? '';
    const clients = 40;
    interface Client {
      lastSequence: number;
      disconnectedAt?: number | undefined;
      recoveredMs: number[];
      reconnects: number;
    }
    const state: Client[] = [];
    for (let i = 0; i < clients; i += 1) {
      const s = await TestSocket.connect(ctx.nginx, undefined, { reconnection: true });
      const c: Client = { lastSequence: 0, recoveredMs: [], reconnects: 0 };
      state.push(c);
      // What the real web client does (docs/EVENTS.md): on every (re)connect, join again and take the snapshot.
      s.socket.on('connect', () => {
        void s.socket.emitWithAck('auction.join', { auctionId }).catch(() => undefined);
      });
      s.socket.on(
        'auction.snapshot',
        (snap: { eventSequence?: number; auction?: { eventSequence?: string | number } }) => {
          const seq = Number(snap.eventSequence ?? snap.auction?.eventSequence ?? 0);
          if (seq >= c.lastSequence) c.lastSequence = seq;
          if (c.disconnectedAt !== undefined) {
            c.recoveredMs.push(performance.now() - c.disconnectedAt);
            c.disconnectedAt = undefined;
            c.reconnects += 1;
          }
        },
      );
      s.socket.on('bid.accepted', (e: { sequence: number }) => {
        if (e.sequence > c.lastSequence) c.lastSequence = e.sequence;
      });
      s.socket.on('disconnect', () => {
        c.disconnectedAt = performance.now();
      });
      sockets.push(s);
      await s.join(auctionId);
    }
    const samples: Sample[] = [];
    const runStart = Date.now();
    const loads = startBidders(
      ctx,
      name,
      bidders,
      auctionIds,
      samples,
      runStart,
      runStart + 30_000,
      {
        thinkMs: 100,
        retryUnknown: true,
      },
    );
    await sleep(8000);
    await ctx.compose('kill', 'api1');
    await sleep(8000);
    await ctx.compose('start', 'api1');
    await Promise.all(loads);
    await sleep(4000);
    const report = await checkInvariants(pool, auctionIds, samples);
    const final = await pool.query<{ s: string }>(
      'SELECT auction_event_sequence::text AS s FROM auctions WHERE id = $1',
      [auctionId],
    );
    const finalSeq = Number(final.rows[0]?.s);
    const reconnected = state.filter((c) => c.reconnects > 0);
    const behind = state.filter((c) => c.lastSequence !== finalSeq);
    return {
      scenario: name,
      workload: {
        kind: '40 sockets with automatic reconnection on one auction; api1 killed at ~8 s, restarted 8 s later; bidding continues',
        clients,
      },
      expectation:
        'Sockets on api1 lose their connection and reconnect (through NGINX, to api2 or api1 again), re-join, and receive a fresh snapshot. At the end every client knows the final event sequence.',
      measured: {
        clientsThatReconnected: reconnected.length,
        clientsNotOnFinalSequence: behind.length,
        finalEventSequence: finalSeq,
        timeFromDisconnectToSnapshotMs: summarize(reconnected.flatMap((c) => c.recoveredMs)),
        acceptedBids: report.acceptedByClients,
        bidsInDatabase: report.bidsInDatabase,
        perSecond: perSecond(samples),
      },
      violations: [
        ...report.violations,
        ...behind.map((_, i) => `a client is not on the final sequence (${String(i)})`),
      ],
      raw: samples,
    };
  } finally {
    sockets.forEach((s) => {
      s.close();
    });
    await pool.end();
  }
};

// ---------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------

/** Rate limits off: these scenarios measure the bid path and the database, not the limiter. */
const NO_LIMITS = { RATE_LIMIT_ENABLED: 'false' };
/** Limiter ON with limits too high to ever trigger: the control that prices the limiter itself. */
const LIMITS_ON_HIGH = {
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_BID_USER_MAX: '100000',
  RATE_LIMIT_BID_AUCTION_MAX: '1000000',
};

export const scenarios: Scenario[] = [
  { name: 'browse', apiEnv: NO_LIMITS, run: browse },
  {
    name: 'hot-auction',
    apiEnv: NO_LIMITS,
    run: bidLoad(1, 'many bidders on ONE auction (row-lock contention)'),
  },
  {
    name: 'many-auctions',
    apiEnv: NO_LIMITS,
    run: bidLoad(100, 'the same bidders spread over 100 auctions'),
  },
  {
    name: 'hot-auction-limiter-on',
    apiEnv: LIMITS_ON_HIGH,
    run: bidLoad(
      1,
      'ONE auction, rate limiter ON (limits too high to trigger): prices the limiter',
    ),
  },
  { name: 'fanout', apiEnv: NO_LIMITS, run: fanout },
  { name: 'fault-api-kill', apiEnv: NO_LIMITS, run: faultApiKill },
  { name: 'fault-postgres-stop', apiEnv: NO_LIMITS, run: faultPostgres },
  { name: 'fault-redis-stop', apiEnv: NO_LIMITS, run: faultRedis },
  { name: 'fault-workers-kill', apiEnv: NO_LIMITS, run: faultWorkers },
  { name: 'fault-client-reconnect', apiEnv: NO_LIMITS, run: reconnect },
];
