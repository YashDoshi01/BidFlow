import { Redis } from 'ioredis';
import type { Logger } from '../../logging/logger.ts';

/**
 * The two Redis connections the Socket.IO adapter needs (ADR-031). A connection that
 * has issued SUBSCRIBE can run no other commands, so publishing and subscribing use
 * separate clients.
 *
 * Failure policy (Redis Pub/Sub is not durable; plan section 3.6):
 *
 * - Reconnect forever, with a backoff that is bounded (200 ms, 400 ms ... capped at 3 s).
 *   An API instance must find Redis again by itself; giving up would need a restart.
 * - The publishing client has NO offline queue. While Redis is unreachable a publish
 *   fails immediately and is DROPPED, instead of piling up in memory and being delivered
 *   minutes later, out of date. Dropped events are recovered by clients through the
 *   snapshot (docs/EVENTS.md). The subscribing client keeps its queue: it only issues the
 *   subscriptions once, and ioredis re-subscribes by itself after a reconnect.
 * - The adapter calls `publish` without awaiting it. A rejected promise there would be an
 *   unhandled rejection that terminates the process, so the wrapper below turns every
 *   failure into a counted drop. Local delivery (sockets on this instance) still happens.
 * - Connection errors are logged on state change only (lost, restored), never per retry:
 *   a Redis outage must not flood the logs. No connection string is ever logged.
 */
export interface RedisPair {
  pub: Redis;
  sub: Redis;
  /**
   * A third connection for rate-limit counters (Phase 8). Separate so a slow or failing limiter
   * cannot delay Socket.IO publishes, and configured to FAIL FAST: no offline queue and a short
   * command timeout, so while Redis is down a request is judged by the fallback policy at once
   * instead of waiting.
   */
  limiter: Redis;
  /** Whether both connections are currently usable. */
  isUp: () => boolean;
  /** Publishes dropped since start because Redis was unreachable. */
  droppedPublishes: () => number;
  close: () => Promise<void>;
}

const backoff = (attempt: number): number => Math.min(200 * 2 ** Math.min(attempt - 1, 4), 3000);

export function createRedisPair(url: string, logger: Logger): RedisPair {
  const common = { retryStrategy: backoff, connectTimeout: 3000 };
  const pub = new Redis(url, {
    ...common,
    connectionName: 'bidflow-pub',
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  // maxRetriesPerRequest: null = a queued command waits for as long as it takes. With ioredis's
  // default (20) the adapter's one-time SUBSCRIBE was REJECTED after about a minute of Redis being
  // unreachable at startup, and that rejection is unhandled inside the adapter: the process died.
  // (Found in Phase 8 by starting an instance against a dead Redis.) "Reconnect forever" has to
  // include the first connection.
  const sub = new Redis(url, {
    ...common,
    connectionName: 'bidflow-sub',
    maxRetriesPerRequest: null,
  });
  const limiter = new Redis(url, {
    ...common,
    connectionName: 'bidflow-limiter',
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: 250,
  });

  let dropped = 0;
  let droppedDuringOutage = 0;

  // Wrap `publish`: a failed publish is a counted drop, never an unhandled rejection.
  const publishOnce = pub.publish.bind(pub) as (...args: unknown[]) => Promise<number>;
  (pub as unknown as { publish: (...args: unknown[]) => Promise<number> }).publish = (
    ...args: unknown[]
  ): Promise<number> =>
    publishOnce(...args).catch(() => {
      dropped += 1;
      droppedDuringOutage += 1;
      return 0;
    });

  const watch = (client: Redis, role: 'pub' | 'sub' | 'limiter'): void => {
    let up = false;
    client.on('ready', () => {
      if (!up) {
        up = true;
        logger.info('redis connection ready', { role, droppedDuringOutage });
        if (role === 'pub') droppedDuringOutage = 0;
      }
    });
    client.on('close', () => {
      if (up) {
        up = false;
        logger.warn('redis connection lost (reconnecting with bounded backoff)', { role });
      }
    });
    // Required: without a listener ioredis would print every retry error itself.
    client.on('error', () => undefined);
  };
  watch(pub, 'pub');
  watch(sub, 'sub');
  watch(limiter, 'limiter');

  return {
    pub,
    sub,
    limiter,
    isUp: () => pub.status === 'ready' && sub.status === 'ready',
    droppedPublishes: () => dropped,
    close: async () => {
      // QUIT is polite only if the connection works; on a dead one it would wait for ever (the
      // queue has no retry limit, above), so every client gets one second, then is cut.
      await Promise.allSettled(
        [pub, sub, limiter].map(async (client) => {
          if (client.status === 'ready') {
            await Promise.race([
              client.quit(),
              new Promise<void>((resolve) => setTimeout(resolve, 1000)),
            ]).catch(() => undefined);
          }
          client.disconnect();
        }),
      );
    },
  };
}
