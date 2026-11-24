// Shared pieces of the load tests (Phase 9): a seeded random generator, deterministic seed data,
// latency statistics, a closed-loop bidder, the correctness checker and the result files.
//
// Everything here talks to a THROWAWAY cluster (scripts/load/run.ts starts it); nothing reads .env.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------------------------
// Determinism: the same seed gives the same users, tokens, auctions and bid choices.
// ---------------------------------------------------------------------------------------------

/** mulberry32: a tiny seeded generator. Math.random() cannot be seeded, so it is not used. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface SeedUser {
  id: string;
  token: string;
}

/**
 * Users written straight into PostgreSQL, with a session each. Registering through the API would
 * measure scrypt password hashing (deliberately slow), not bidding, and would take minutes.
 * The token is derived from the seed, so a rerun uses the same identities. The password hash is a
 * placeholder that no password can match: these users can only act through their session.
 */
export async function seedUsers(pool: Pool, count: number, seed: string): Promise<SeedUser[]> {
  const emails: string[] = [];
  const names: string[] = [];
  const tokens: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    emails.push(`load-${seed}-${String(i)}@example.test`);
    names.push(`Load ${String(i)}`);
    const token = sha256(`bidflow-load-token:${seed}:${String(i)}`);
    tokens.push(token);
    hashes.push(sha256(token));
  }
  const users = await pool.query<{ id: string; email: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     SELECT e, 'not-a-real-hash', n FROM unnest($1::text[], $2::text[]) AS t(e, n)
     RETURNING id, email`,
    [emails, names],
  );
  const idByEmail = new Map(users.rows.map((r) => [r.email, r.id]));
  const ids = emails.map((e) => idByEmail.get(e) ?? '');
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     SELECT u, h, now() + interval '1 day' FROM unnest($1::uuid[], $2::text[]) AS t(u, h)`,
    [ids, hashes],
  );
  return ids.map((id, i) => ({ id, token: tokens[i] ?? '' }));
}

/** LIVE auctions with a far end time, so the lifecycle worker does not touch them during a run. */
export async function seedAuctions(
  pool: Pool,
  sellerId: string,
  count: number,
  label: string,
  startingPrice = '100.00',
  increment = '1.00',
): Promise<string[]> {
  const rows = await pool.query<{ id: string }>(
    `INSERT INTO auctions (seller_id, title, starting_price, current_price, minimum_increment,
                           status, starts_at, ends_at)
     SELECT $1, $2 || ' ' || g, $3::numeric, $3::numeric, $4::numeric, 'LIVE',
            now() - interval '1 minute', now() + interval '6 hours'
     FROM generate_series(1, $5::int) AS g
     RETURNING id`,
    [sellerId, label, startingPrice, increment, count],
  );
  return rows.rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

export interface LatencySummary {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank percentile: the smallest value that at least p% of the samples are <=. */
export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length, Math.max(1, rank)) - 1] ?? Number.NaN;
}

export function summarize(samples: number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const round = (n: number): number => Math.round(n * 100) / 100;
  return {
    count: sorted.length,
    min: round(sorted[0] ?? Number.NaN),
    mean: round(sorted.length === 0 ? Number.NaN : sum / sorted.length),
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? Number.NaN),
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

export interface Sample {
  /** Milliseconds since the start of the run when the request was sent. */
  at: number;
  ms: number;
  status: number;
  /** The API error code for non-2xx answers ('' otherwise); 'NETWORK' when no answer came. */
  code: string;
  auctionId?: string;
  amount?: string;
  bidSequence?: number;
  bidId?: string;
  /** Extra attempts with the same Idempotency-Key after a network error or 5xx. */
  retries?: number;
}

interface BidAnswer {
  bid?: { id: string; amount: string; bidSequence: string };
  auction?: { minimumNextBid: string | null };
  error?: { code: string; data?: { minimumAcceptableBid?: string } };
}

export async function postBid(
  base: string,
  token: string,
  auctionId: string,
  amount: string,
  key: string,
  timeoutMs = 15_000,
): Promise<{ status: number; ms: number; body: BidAnswer | undefined; networkError?: boolean }> {
  const started = performance.now();
  try {
    const res = await fetch(`${base}/auctions/${auctionId}/bids`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ amount }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => undefined)) as BidAnswer | undefined;
    return { status: res.status, ms: performance.now() - started, body };
  } catch {
    return { status: 0, ms: performance.now() - started, body: undefined, networkError: true };
  }
}

/** Adds cents-exact decimal strings without floating point surprises (integers of cents). */
export function addMoney(a: string, b: string): string {
  const cents = (s: string): number => Math.round(Number(s) * 100);
  return ((cents(a) + cents(b)) / 100).toFixed(2);
}

export interface BidderOptions {
  base: string;
  user: SeedUser;
  auctionIds: string[];
  startingPrice: string;
  increment: string;
  /** Run until this wall-clock time (ms since epoch). */
  until: number;
  runStart: number;
  random: () => number;
  keyPrefix: string;
  /** Pause between a bidder's requests (0 = closed loop: the next one starts at once). */
  thinkMs?: number;
  /** Retry the SAME idempotency key on a network error / 5xx until an answer arrives (fault runs). */
  retryUnknown?: boolean;
  /** Receives every finished request. */
  record: (sample: Sample) => void;
}

/**
 * One simulated bidder in a closed loop: choose an auction, bid the lowest amount it believes
 * is acceptable (plus 0-2 extra increments), learn the real minimum from the answer, repeat.
 * Under contention many bids lose the race and get 409 BID_TOO_LOW: that is correct behaviour
 * and is counted, not hidden.
 */
export async function runBidder(o: BidderOptions): Promise<void> {
  const knownMin = new Map<string, string>(o.auctionIds.map((a) => [a, o.startingPrice]));
  let n = 0;
  while (Date.now() < o.until) {
    const auctionId = o.auctionIds[Math.floor(o.random() * o.auctionIds.length)] ?? '';
    const base = knownMin.get(auctionId) ?? o.startingPrice;
    const extra = Math.floor(o.random() * 3);
    let amount = base;
    for (let i = 0; i < extra; i += 1) amount = addMoney(amount, o.increment);
    n += 1;
    const key = `${o.keyPrefix}-${String(n)}`;
    const at = Date.now() - o.runStart;
    let answer = await postBid(o.base, o.user.token, auctionId, amount, key);
    let totalMs = answer.ms;
    let retries = 0;
    if (o.retryUnknown === true) {
      for (
        let attempt = 0;
        (answer.status === 0 || answer.status >= 500) && attempt < 100;
        attempt += 1
      ) {
        retries += 1;
        await sleep(150);
        answer = await postBid(o.base, o.user.token, auctionId, amount, key);
        totalMs += answer.ms;
      }
    }
    const code = answer.networkError === true ? 'NETWORK' : (answer.body?.error?.code ?? '');
    const sample: Sample = {
      at,
      ms: totalMs,
      status: answer.status,
      code,
      auctionId,
      amount,
      retries,
    };
    if (answer.status === 201 && answer.body?.bid !== undefined) {
      sample.bidSequence = Number(answer.body.bid.bidSequence);
      sample.bidId = answer.body.bid.id;
      const next = answer.body.auction?.minimumNextBid;
      if (next) knownMin.set(auctionId, next);
    } else if (answer.status === 409 && code === 'BID_TOO_LOW') {
      const next = answer.body?.error?.data?.minimumAcceptableBid;
      if (next) knownMin.set(auctionId, next);
    }
    o.record(sample);
    if (o.thinkMs !== undefined && o.thinkMs > 0) await sleep(o.thinkMs);
  }
}

export interface StatusBreakdown {
  total: number;
  accepted: number;
  /** Counts by `${status} ${code}`. */
  byOutcome: Record<string, number>;
}

export function breakdown(samples: Sample[]): StatusBreakdown {
  const byOutcome: Record<string, number> = {};
  for (const s of samples) {
    const k = `${String(s.status)}${s.code === '' ? '' : ` ${s.code}`}`;
    byOutcome[k] = (byOutcome[k] ?? 0) + 1;
  }
  return {
    total: samples.length,
    accepted: samples.filter((s) => s.status === 201).length,
    byOutcome,
  };
}

// ---------------------------------------------------------------------------------------------
// Correctness: HTTP success is not enough. The database must satisfy every invariant.
// ---------------------------------------------------------------------------------------------

export interface InvariantReport {
  auctions: number;
  bidsInDatabase: number;
  acceptedByClients: number;
  violations: string[];
}

/**
 * After a run: for every auction, the bids are numbered 1..n with no gap, each amount beats the
 * one before by at least the increment (the first one reaches the starting price), the auction row
 * agrees with the bids (price, count, highest bid), the outbox has exactly one event per durable
 * event with no gap, and the clients' 201 answers match the rows one to one.
 */
export async function checkInvariants(
  pool: Pool,
  auctionIds: string[],
  samples: Sample[],
): Promise<InvariantReport> {
  const violations: string[] = [];
  const accepted = samples.filter((s) => s.status === 201);
  const rows = await pool.query<{
    auction_id: string;
    n: string;
    max_seq: string;
    min_seq: string;
    bad_step: string;
    first_ok: boolean;
    last_amount: string;
    last_id: string;
  }>(
    `WITH b AS (
       SELECT b.auction_id, b.bid_sequence, b.amount, b.id, a.minimum_increment, a.starting_price,
              lag(b.amount) OVER (PARTITION BY b.auction_id ORDER BY b.bid_sequence) AS prev
       FROM bids b JOIN auctions a ON a.id = b.auction_id
       WHERE b.auction_id = ANY($1::uuid[])
     )
     SELECT auction_id, count(*)::text AS n, max(bid_sequence)::text AS max_seq,
            min(bid_sequence)::text AS min_seq,
            count(*) FILTER (WHERE prev IS NOT NULL AND amount < prev + minimum_increment)::text AS bad_step,
            bool_and(CASE WHEN prev IS NULL THEN amount >= starting_price ELSE true END) AS first_ok,
            (array_agg(amount ORDER BY bid_sequence DESC))[1]::text AS last_amount,
            (array_agg(id ORDER BY bid_sequence DESC))[1]::text AS last_id
     FROM b GROUP BY auction_id`,
    [auctionIds],
  );
  const perAuction = new Map(rows.rows.map((r) => [r.auction_id, r]));
  const auctions = await pool.query<{
    id: string;
    current_price: string;
    bid_sequence: string;
    auction_event_sequence: string;
    highest_bid_id: string | null;
    starting_price: string;
    outbox_count: string;
    outbox_max: string;
    outbox_distinct: string;
  }>(
    `SELECT a.id, a.current_price::text, a.bid_sequence::text, a.auction_event_sequence::text,
            a.highest_bid_id, a.starting_price::text,
            (SELECT count(*) FROM outbox_events o WHERE o.auction_id = a.id)::text AS outbox_count,
            COALESCE((SELECT max(auction_event_sequence) FROM outbox_events o WHERE o.auction_id = a.id), 0)::text AS outbox_max,
            (SELECT count(DISTINCT auction_event_sequence) FROM outbox_events o WHERE o.auction_id = a.id)::text AS outbox_distinct
     FROM auctions a WHERE a.id = ANY($1::uuid[])`,
    [auctionIds],
  );
  let bidsInDatabase = 0;
  for (const a of auctions.rows) {
    const r = perAuction.get(a.id);
    const n = r === undefined ? 0 : Number(r.n);
    bidsInDatabase += n;
    const tag = `auction ${a.id.slice(0, 8)}`;
    if (Number(a.bid_sequence) !== n)
      violations.push(`${tag}: bid_sequence ${a.bid_sequence} != ${String(n)} bids`);
    if (r !== undefined) {
      if (Number(r.min_seq) !== 1 || Number(r.max_seq) !== n)
        violations.push(`${tag}: sequence has a gap`);
      if (Number(r.bad_step) !== 0)
        violations.push(`${tag}: ${r.bad_step} bids did not beat the previous by the increment`);
      if (!r.first_ok) violations.push(`${tag}: first bid below starting price`);
      if (Number(a.current_price) !== Number(r.last_amount))
        violations.push(`${tag}: current_price != last bid`);
      if (a.highest_bid_id !== r.last_id)
        violations.push(`${tag}: highest_bid_id is not the last bid`);
    } else if (Number(a.current_price) !== Number(a.starting_price)) {
      violations.push(`${tag}: no bids but the price moved`);
    }
    if (Number(a.outbox_count) !== Number(a.auction_event_sequence))
      violations.push(
        `${tag}: outbox rows ${a.outbox_count} != event sequence ${a.auction_event_sequence}`,
      );
    if (
      Number(a.outbox_distinct) !== Number(a.outbox_max) ||
      Number(a.outbox_max) !== Number(a.auction_event_sequence)
    )
      violations.push(`${tag}: outbox sequence has a gap`);
  }
  // The clients' view must equal the database one to one: no accepted bid lost, none invented.
  if (accepted.length !== bidsInDatabase) {
    violations.push(
      `clients saw ${String(accepted.length)} accepted bids, database has ${String(bidsInDatabase)}`,
    );
  }
  const ids = accepted.map((s) => s.bidId ?? '');
  if (new Set(ids).size !== ids.length) violations.push('a bid id was reported twice to clients');
  if (ids.length > 0) {
    const found = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM bids WHERE id = ANY($1::uuid[])',
      [ids],
    );
    if (Number(found.rows[0]?.n) !== ids.length)
      violations.push('a bid the client was told was accepted is not in the database');
  }
  return {
    auctions: auctionIds.length,
    bidsInDatabase,
    acceptedByClients: accepted.length,
    violations,
  };
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export interface ScenarioResult {
  scenario: string;
  /** What was run (parameters). */
  workload: Record<string, unknown>;
  /** What was measured. */
  measured: Record<string, unknown>;
  /** Invariant violations; an empty list means every check passed. */
  violations: string[];
  /** Raw per-request data, written to its own file. */
  raw?: unknown;
  notes?: string[];
}

export function writeResult(dir: string, result: ScenarioResult): void {
  mkdirSync(dir, { recursive: true });
  const { raw, ...summary } = result;
  writeFileSync(path.join(dir, `${result.scenario}.json`), JSON.stringify(summary, null, 2));
  if (raw !== undefined)
    writeFileSync(path.join(dir, `${result.scenario}.raw.json`), JSON.stringify(raw));
}

export function throughput(
  samples: Sample[],
  seconds: number,
  only?: (s: Sample) => boolean,
): number {
  const n = only === undefined ? samples.length : samples.filter(only).length;
  return Math.round((n / seconds) * 100) / 100;
}
