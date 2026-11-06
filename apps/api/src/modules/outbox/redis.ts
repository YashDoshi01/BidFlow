import { Redis } from 'ioredis';
import type { Logger } from '../../logging/logger.ts';

/**
 * The outbox worker's connection to Redis. Unlike the API's adapter connections, a failed publish here
 * MUST be reported (no swallowing wrapper): it is what keeps the event `pending` for a retry.
 *
 *  - No offline queue: while Redis is unreachable, a publish fails immediately instead of waiting in
 *    memory; the outbox row, not the Redis client, is the queue.
 *  - Reconnects forever with a capped backoff; the loss/restoration is logged once, not per retry.
 */
export function createPublishClient(url: string, logger: Logger): Redis {
  const client = new Redis(url, {
    connectionName: 'bidflow-outbox',
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    retryStrategy: (attempt) => Math.min(200 * 2 ** Math.min(attempt - 1, 4), 3000),
  });
  let up = false;
  client.on('ready', () => {
    if (!up) {
      up = true;
      logger.info('redis connection ready', { role: 'outbox' });
    }
  });
  client.on('close', () => {
    if (up) {
      up = false;
      logger.warn('redis connection lost (events stay in the outbox until it returns)', {
        role: 'outbox',
      });
    }
  });
  client.on('error', () => undefined);
  return client;
}
