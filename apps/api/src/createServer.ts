import http from 'node:http';
import type express from 'express';
import { createApp, type AppDeps } from './app.ts';
import {
  createAppMetrics,
  registerDatabaseMetrics,
  type AppMetrics,
} from './metrics/appMetrics.ts';
import { attachRealtime, type Realtime, type RedisPair } from './modules/realtime/index.ts';
import { createRateLimiter, memoryCounterStore, redisCounterStore } from './ratelimit/limiter.ts';
import { createServices } from './services.ts';

export interface ShutdownOptions {
  /**
   * How long to report "draining" (readiness 503, `Connection: close`) BEFORE closing anything, so a
   * load balancer that polls readiness stops sending new work first. 0 = close at once.
   */
  drainMs?: number;
  /** Hard deadline: connections still open after this are cut. */
  graceMs?: number;
}

export interface RunningServer {
  server: http.Server;
  app: express.Express;
  realtime: Realtime;
  metrics: AppMetrics;
  isDraining: () => boolean;
  /**
   * Graceful shutdown of the HTTP server and the WebSockets:
   *  1. mark draining (new readiness checks fail, responses carry `Connection: close`);
   *  2. wait `drainMs`;
   *  3. stop accepting connections and close idle ones; requests already running finish;
   *  4. close every WebSocket (clients reconnect elsewhere and re-join);
   *  5. after `graceMs`, cut whatever is still open.
   * The caller then closes Redis and the database pool (they are the caller's to open).
   */
  shutdown: (options?: ShutdownOptions) => Promise<void>;
}

/**
 * Builds the HTTP app and the Socket.IO gateway on one server, sharing one set of services.
 *
 * Note what is NOT here: nothing in this process announces bids. A bid commits together with its
 * outbox event (ADR-039); a separate worker publishes it (apps/workers). This process only holds
 * the WebSocket connections and delivers what the adapter hands it.
 */
export function createRunningServer(
  deps: Omit<AppDeps, 'services' | 'metrics' | 'limiter' | 'isDraining'> & {
    maxRoomsPerSocket?: number;
    /** Joins one WebSocket may make per 10 s (default 30). */
    maxJoinsPerWindow?: number;
    /** Connects this instance's rooms and broadcasts to the other instances. */
    redis?: RedisPair;
    /** Extra browser origins allowed to open a WebSocket (same-host is always allowed). */
    allowedOrigins?: string[];
  },
): RunningServer {
  const metrics = createAppMetrics();
  registerDatabaseMetrics(metrics, deps.db);
  const bidObserver = {
    lockWaited: (seconds: number): void => {
      metrics.bidLockWait.observe(seconds);
    },
    finished: (outcome: string, seconds: number): void => {
      metrics.bidAttempts.inc({ outcome });
      const outcomeClass =
        outcome === 'accepted' || outcome === 'replayed' || outcome === 'error'
          ? outcome
          : 'rejected';
      metrics.bidTransaction.observe(seconds, { outcome_class: outcomeClass });
    },
  };
  const services = createServices(deps.db, {
    sessionTtlSeconds: deps.sessionTtlSeconds,
    bidObserver,
    logger: deps.logger,
  });

  // Rate-limit counters live in Redis so every instance sees the same numbers; without Redis
  // (single process) they are per process. A Redis failure is logged on state change only.
  let storeFailing = false;
  const limiter = createRateLimiter({
    ...(deps.redis ? { shared: redisCounterStore(deps.redis.limiter) } : {}),
    fallback: memoryCounterStore(),
    onDecision: (policy, decision) => {
      metrics.rateLimit.inc({ policy, decision });
      if (decision === 'allowed' || decision === 'limited') {
        if (storeFailing) {
          storeFailing = false;
          deps.logger.info('rate limit store recovered');
        }
      }
    },
    onStoreError: () => {
      if (!storeFailing) {
        storeFailing = true;
        deps.logger.warn('rate limit store unavailable: using per-process fallback limits');
      }
    },
  });

  let draining = false;
  const isDraining = (): boolean => draining;

  const app = createApp({ ...deps, services, metrics, limiter, isDraining });
  const server = http.createServer(app);
  const realtime = attachRealtime(server, {
    auth: services.auth,
    auctions: services.auctions,
    bids: services.bids,
    logger: deps.logger,
    metrics,
    allowedOrigins: deps.allowedOrigins ?? [],
    ...(deps.maxRoomsPerSocket === undefined ? {} : { maxRoomsPerSocket: deps.maxRoomsPerSocket }),
    ...(deps.maxJoinsPerWindow === undefined ? {} : { maxJoinsPerWindow: deps.maxJoinsPerWindow }),
    ...(deps.redis === undefined ? {} : { redis: deps.redis }),
  });

  return {
    server,
    app,
    realtime,
    metrics,
    isDraining,
    shutdown: async ({ drainMs = 0, graceMs = 10_000 } = {}) => {
      draining = true;
      deps.logger.info('draining', { drainMs });
      if (drainMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, drainMs));
      // Closing Socket.IO closes the HTTP server too: no new connections, WebSockets disconnected.
      const closing = realtime.close();
      server.closeIdleConnections();
      const deadline = setTimeout(() => {
        deps.logger.warn('shutdown deadline reached: cutting open connections');
        server.closeAllConnections();
      }, graceMs);
      try {
        await closing;
      } finally {
        clearTimeout(deadline);
        metrics.stopSampling();
      }
    },
  };
}
