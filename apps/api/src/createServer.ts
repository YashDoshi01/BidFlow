import http from 'node:http';
import type express from 'express';
import { createApp, type AppDeps } from './app.ts';
import { attachRealtime, type Realtime, type RedisPair } from './modules/realtime/index.ts';
import { createServices } from './services.ts';

export interface RunningServer {
  server: http.Server;
  app: express.Express;
  realtime: Realtime;
}

/**
 * Builds the HTTP app and the Socket.IO gateway on one server, sharing one set of services.
 *
 * Note what is NOT here: nothing in this process announces bids. A bid commits together with its
 * outbox event (ADR-039); a separate worker publishes it (apps/workers). This process only holds
 * the WebSocket connections and delivers what the adapter hands it.
 */
export function createRunningServer(
  deps: Omit<AppDeps, 'services'> & {
    maxRoomsPerSocket?: number;
    /** Connects this instance's rooms and broadcasts to the other instances. */
    redis?: RedisPair;
  },
): RunningServer {
  const services = createServices(deps.db, { sessionTtlSeconds: deps.sessionTtlSeconds });
  const app = createApp({ ...deps, services });
  const server = http.createServer(app);
  const realtime = attachRealtime(server, {
    auth: services.auth,
    auctions: services.auctions,
    bids: services.bids,
    logger: deps.logger,
    ...(deps.maxRoomsPerSocket === undefined ? {} : { maxRoomsPerSocket: deps.maxRoomsPerSocket }),
    ...(deps.redis === undefined ? {} : { redis: deps.redis }),
  });
  return { server, app, realtime };
}
