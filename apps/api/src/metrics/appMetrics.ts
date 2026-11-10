import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Db } from '../db/pool.ts';
import { LATENCY_BUCKETS, Registry } from './registry.ts';

/**
 * The metrics of this system, in one place. Each one answers a question an operator asks:
 *
 *  - Are bids being accepted, and why are they refused?        bid_attempts_total
 *  - How long does a bid take, and how much is waiting on the
 *    auction row lock?                                          bid_transaction_seconds, bid_lock_wait_seconds
 *  - Are users being limited?                                   rate_limit_decisions_total
 *  - Is live delivery healthy?                                  ws_*, redis_up, redis_dropped_publishes
 *  - Are the workers keeping up?                                outbox_*, auctions_overdue_*
 *  - Is the database being starved?                             db_pool_*
 *  - Is this process itself struggling?                         eventloop_lag_seconds
 *
 * Values that live in OTHER processes (the outbox and lifecycle workers) are not scraped from
 * those processes. They are derived from PostgreSQL at scrape time, which is the shared truth
 * and costs one cheap indexed query each. If PostgreSQL cannot answer, `metrics_db_up` is 0 and
 * the rest of the page still renders.
 */
export function createAppMetrics(registry: Registry = new Registry()) {
  const httpRequests = registry.counter(
    'bidflow_http_requests_total',
    'HTTP requests by route pattern, method and status class.',
    ['route', 'method', 'status_class'],
  );
  const httpDuration = registry.histogram(
    'bidflow_http_request_duration_seconds',
    'HTTP request duration by route pattern.',
    ['route'],
    LATENCY_BUCKETS,
  );
  const bidAttempts = registry.counter(
    'bidflow_bid_attempts_total',
    'Bid requests that reached the bid service, by outcome (accepted, replayed, or the error code).',
    ['outcome'],
  );
  const bidTransaction = registry.histogram(
    'bidflow_bid_transaction_seconds',
    'Bid service time from start to result, including waiting for a pooled connection and the row lock.',
    ['outcome_class'],
    LATENCY_BUCKETS,
  );
  const bidLockWait = registry.histogram(
    'bidflow_bid_lock_wait_seconds',
    'Time to acquire the auction row lock (includes one query round trip).',
    [],
    LATENCY_BUCKETS,
  );
  const rateLimit = registry.counter(
    'bidflow_rate_limit_decisions_total',
    'Rate limit decisions by policy and decision (allowed, limited, fallback_allowed, fallback_limited).',
    ['policy', 'decision'],
  );
  const wsConnections = registry.gauge(
    'bidflow_ws_connections',
    'WebSocket connections open on this instance.',
  );
  const wsRooms = registry.gauge(
    'bidflow_ws_rooms',
    'Auction rooms with a member on this instance.',
  );
  const wsConnectionsTotal = registry.counter(
    'bidflow_ws_connections_total',
    'WebSocket connections accepted since start (a reconnect is a new connection).',
  );
  const wsConnectionsRefused = registry.counter(
    'bidflow_ws_connections_refused_total',
    'WebSocket handshakes refused, by reason (origin, unauthenticated).',
    ['reason'],
  );
  const wsJoins = registry.counter(
    'bidflow_ws_joins_total',
    'auction.join requests by result (ok or the error code).',
    ['result'],
  );
  const redisUp = registry.gauge('bidflow_redis_up', '1 if both Redis connections are ready.');
  const redisDropped = registry.gauge(
    'bidflow_redis_dropped_publishes',
    'Socket.IO adapter publishes dropped since start because Redis was unreachable.',
  );
  const dbUp = registry.gauge(
    'bidflow_metrics_db_up',
    '1 if the scrape-time database queries succeeded.',
  );
  const outboxBacklog = registry.gauge(
    'bidflow_outbox_backlog',
    'Outbox events not yet published (pending or being processed).',
  );
  const outboxFailed = registry.gauge(
    'bidflow_outbox_failed',
    'Outbox events that gave up and need a manual retry.',
  );
  const outboxOldest = registry.gauge(
    'bidflow_outbox_oldest_pending_age_seconds',
    'Age of the oldest unpublished outbox event (0 if none).',
  );
  const outboxLatencyAvg = registry.gauge(
    'bidflow_outbox_publish_latency_avg_seconds',
    'Mean time from commit to publication over events published in the last 5 minutes.',
  );
  const outboxLatencyMax = registry.gauge(
    'bidflow_outbox_publish_latency_max_seconds',
    'Maximum time from commit to publication over events published in the last 5 minutes.',
  );
  const overdueCount = registry.gauge(
    'bidflow_auctions_overdue',
    'LIVE auctions whose end time passed more than 5 seconds ago (the lifecycle worker is behind or down).',
  );
  const overdueLag = registry.gauge(
    'bidflow_auctions_overdue_max_seconds',
    'How long the most overdue LIVE auction has been past its end time (0 if none).',
  );
  const poolTotal = registry.gauge('bidflow_db_pool_connections', 'Connections in the pool.');
  const poolIdle = registry.gauge('bidflow_db_pool_idle', 'Idle connections in the pool.');
  const poolWaiting = registry.gauge(
    'bidflow_db_pool_waiting',
    'Requests waiting for a pooled connection (a sustained value above 0 means the pool is saturated).',
  );
  const eventLoopLag = registry.gauge(
    'bidflow_eventloop_lag_p99_seconds',
    'p99 event loop delay since the previous scrape.',
  );
  const uptime = registry.gauge(
    'bidflow_process_uptime_seconds',
    'Seconds since the process started.',
  );
  const memory = registry.gauge('bidflow_process_resident_memory_bytes', 'Resident set size.');

  // Event loop delay: sampled by Node in the background; read and reset at each scrape.
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  registry.onScrape(() => {
    eventLoopLag.set(loop.count > 0 ? loop.percentile(99) / 1e9 : 0);
    loop.reset();
    uptime.set(process.uptime());
    memory.set(process.memoryUsage.rss());
  });

  return {
    registry,
    httpRequests,
    httpDuration,
    bidAttempts,
    bidTransaction,
    bidLockWait,
    rateLimit,
    wsConnections,
    wsRooms,
    wsConnectionsTotal,
    wsConnectionsRefused,
    wsJoins,
    redisUp,
    redisDropped,
    dbUp,
    outboxBacklog,
    outboxFailed,
    outboxOldest,
    outboxLatencyAvg,
    outboxLatencyMax,
    overdueCount,
    overdueLag,
    poolTotal,
    poolIdle,
    poolWaiting,
    stopSampling: () => {
      loop.disable();
    },
  };
}

export type AppMetrics = ReturnType<typeof createAppMetrics>;

interface OutboxRow {
  backlog: string;
  failed: string;
  oldest: string;
}
interface OverdueRow {
  n: string;
  max_age: string;
}

/** Reads the cross-process signals from PostgreSQL at scrape time. See createAppMetrics. */
export function registerDatabaseMetrics(
  metrics: AppMetrics,
  db: Db,
  options: { queryTimeoutMs?: number } = {},
): void {
  const timeout = options.queryTimeoutMs ?? 2000;
  metrics.registry.onScrape(async () => {
    metrics.poolTotal.set(db.totalCount);
    metrics.poolIdle.set(db.idleCount);
    metrics.poolWaiting.set(db.waitingCount);
    try {
      // One connection, one short READ ONLY transaction. `SET LOCAL statement_timeout` lasts only for
      // this transaction (a session-level SET would leak onto the pooled connection), so a stuck
      // database cannot hang the scrape. A failure is reported through bidflow_metrics_db_up.
      const client = await db.connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${String(timeout)}`);
        const outbox = await client.query<OutboxRow>(
          `SELECT
             count(*) FILTER (WHERE status IN ('pending','processing'))::text AS backlog,
             count(*) FILTER (WHERE status = 'failed')::text AS failed,
             COALESCE(EXTRACT(EPOCH FROM clock_timestamp() - min(created_at)
                                FILTER (WHERE status IN ('pending','processing'))), 0)::text AS oldest
             FROM outbox_events WHERE status <> 'published'`,
        );
        const latency = await client.query<{ lat_avg: string; lat_max: string }>(
          `SELECT COALESCE(avg(EXTRACT(EPOCH FROM published_at - created_at)), 0)::text AS lat_avg,
                  COALESCE(max(EXTRACT(EPOCH FROM published_at - created_at)), 0)::text AS lat_max
             FROM outbox_events
            WHERE status = 'published' AND published_at > clock_timestamp() - interval '5 minutes'`,
        );
        const overdue = await client.query<OverdueRow>(
          `SELECT count(*)::text AS n,
                  COALESCE(max(EXTRACT(EPOCH FROM clock_timestamp() - ends_at)), 0)::text AS max_age
             FROM auctions
            WHERE status = 'LIVE' AND ends_at < clock_timestamp() - interval '5 seconds'`,
        );
        const o = outbox.rows[0] as OutboxRow;
        const l = latency.rows[0] as { lat_avg: string; lat_max: string };
        const d = overdue.rows[0] as OverdueRow;
        metrics.outboxBacklog.set(Number(o.backlog));
        metrics.outboxFailed.set(Number(o.failed));
        metrics.outboxOldest.set(Number(o.oldest));
        metrics.outboxLatencyAvg.set(Number(l.lat_avg));
        metrics.outboxLatencyMax.set(Number(l.lat_max));
        metrics.overdueCount.set(Number(d.n));
        metrics.overdueLag.set(Number(d.max_age));
        await client.query('COMMIT');
        metrics.dbUp.set(1);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } catch {
      metrics.dbUp.set(0);
    }
  });
}
