import { Redis } from 'ioredis';
import pg from 'pg';

export interface DependencyCheck {
  name: string;
  /** Resolves if the dependency is reachable, rejects otherwise. */
  run: () => Promise<void>;
  /**
   * Critical: the instance cannot do its job without it (PostgreSQL), so readiness fails and a
   * load balancer stops sending traffic. Optional (default false for Redis): the instance still
   * does its core job (bids are committed to PostgreSQL), only live fan-out degrades. Default: critical.
   */
  critical?: boolean;
}

const CHECK_TIMEOUT_MS = 2000;

export function postgresCheck(connectionString: string): DependencyCheck {
  return {
    name: 'postgres',
    run: async () => {
      // A fresh short-lived client per check: Phase 0 has no connection pool yet.
      const client = new pg.Client({
        connectionString,
        connectionTimeoutMillis: CHECK_TIMEOUT_MS,
      });
      await client.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        await client.end();
      }
    },
  };
}

/**
 * Readiness through the application's OWN pool: it tests the path real requests use, and it does
 * not open a new connection (and a new DNS lookup) on every poll. Found by the cluster test: with
 * a dependency's name unresolvable (a stopped container), lookups take ~4 s, and per-poll
 * connections competed for Node's 4-thread libuv pool.
 */
export function postgresPoolCheck(pool: {
  query: (sql: string) => Promise<unknown>;
}): DependencyCheck {
  return {
    name: 'postgres',
    run: async () => {
      await pool.query('SELECT 1');
    },
  };
}

/**
 * Redis readiness from the state of the long-lived connections the Socket.IO adapter uses. It is
 * what matters for live delivery, and it costs nothing (no new connection per poll). Optional: see
 * DependencyCheck.critical.
 */
export function redisStatusCheck(isUp: () => boolean): DependencyCheck {
  return {
    name: 'redis',
    critical: false,
    run: () => (isUp() ? Promise.resolve() : Promise.reject(new Error('redis not connected'))),
  };
}

export function redisCheck(url: string): DependencyCheck {
  return {
    name: 'redis',
    critical: false,
    run: async () => {
      const client = new Redis(url, {
        lazyConnect: true,
        connectTimeout: CHECK_TIMEOUT_MS,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      // Without a handler an unreachable server emits an unhandled 'error' event.
      client.on('error', () => undefined);
      try {
        await client.connect();
        const reply: string = await client.ping();
        if (reply !== 'PONG') {
          throw new Error(`unexpected PING reply: ${reply}`);
        }
      } finally {
        client.disconnect();
      }
    },
  };
}

export interface CheckResult {
  name: string;
  ok: boolean;
  critical: boolean;
  /** Error message when not ok. Never includes connection strings. */
  error?: string;
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms`));
    }, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function runChecks(checks: DependencyCheck[]): Promise<CheckResult[]> {
  return Promise.all(
    checks.map(async (check): Promise<CheckResult> => {
      try {
        await withTimeout(check.run(), CHECK_TIMEOUT_MS + 500);
        return { name: check.name, ok: true, critical: check.critical ?? true };
      } catch (error) {
        // Only the error class and a short code/message; driver messages for
        // connection failures do not contain the password, but be conservative.
        const code =
          error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : undefined;
        return {
          name: check.name,
          ok: false,
          critical: check.critical ?? true,
          error: code ?? (error instanceof Error ? error.name : 'unknown error'),
        };
      }
    }),
  );
}
