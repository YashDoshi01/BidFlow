import http from 'node:http';
import type express from 'express';
import { createApp, type AppDeps } from './app.ts';
import { createEventRelay } from './events/publisher.ts';
import { attachRealtime, type Realtime, type RedisPair } from './modules/realtime/index.ts';
import { createServices } from './services.ts';

export interface RunningServer {
  server: http.Server;
  app: express.Express;
  realtime: Realtime;
}

/**
 * Builds the HTTP app and the Socket.IO gateway on one server, sharing one set of
 * services. The order matters: the app needs a publisher, Socket.IO needs the HTTP
 * server that wraps the app, so the publisher is a relay that is connected last.
 */
export function createRunningServer(
  deps: Omit<AppDeps, 'services' | 'publisher'> & {
    maxRoomsPerSocket?: number;
    /** Connects this instance's rooms and broadcasts to the other instances. */
    redis?: RedisPair;
  },
): RunningServer {
  const relay = createEventRelay(deps.logger);
  const services = createServices(deps.db, {
    sessionTtlSeconds: deps.sessionTtlSeconds,
    logger: deps.logger,
    publisher: relay,
  });
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
  relay.attach(realtime.publisher);
  return { server, app, realtime };
}
