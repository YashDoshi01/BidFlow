import type http from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server, type Socket } from 'socket.io';
import {
  auctionRoom,
  buildParticipantCountEvent,
  buildSnapshotEvent,
  joinPayloadSchema,
  leavePayloadSchema,
} from '../../events/events.ts';
import { AppError } from '../../http/errors.ts';
import type { Logger } from '../../logging/logger.ts';
import type { AuctionService } from '../auctions/index.ts';
import type { AuthService } from '../auth/index.ts';
import type { BidService } from '../bids/index.ts';
import type { RedisPair } from './redis.ts';

export interface RealtimeDeps {
  auth: AuthService;
  auctions: AuctionService;
  bids: BidService;
  logger: Logger;
  /** Upper bound on auction rooms per socket (memory bound; default 20). */
  maxRoomsPerSocket?: number;
  /**
   * With Redis, rooms and broadcasts span every API instance (ADR-031). Without it (single
   * process: most tests) everything stays in this process.
   */
  redis?: RedisPair;
}

export interface Realtime {
  io: Server;
  close: () => Promise<void>;
}

type Ack = (response: AckResponse) => void;
type AckResponse = { ok: true } | { ok: false; error: { code: string; message: string } };

// The same shape as a bearer token in the REST API (random, URL-safe, 20-128 chars).
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;
const SNAPSHOT_BIDS = 20;
// Counts are recomputed this long after the LAST change in a room and sent once (ADR-032).
const COUNT_DEBOUNCE_MS = 100;
// How long to wait for the other instances to report their sockets before using the local count.
const COUNT_CLUSTER_TIMEOUT_MS = 1000;

interface SocketData {
  /** In memory only, never logged: needed to re-check the session on every join. */
  token?: string;
  userId?: string;
}

const fail = (code: string, message: string): AckResponse => ({
  ok: false,
  error: { code, message },
});

function toAck(candidate: unknown): Ack {
  return typeof candidate === 'function' ? (candidate as Ack) : () => undefined;
}

/**
 * Attaches Socket.IO to an HTTP server (ADR-025).
 *
 * - WebSocket transport only (no long-polling fallback): sticky sessions are not
 *   needed for the handshake (plan section 3.6, decision 4).
 * - Authentication is the same opaque bearer token as REST, sent in the handshake
 *   `auth` payload (not a cookie, so cross-site WebSocket hijacking has nothing to
 *   ride on). No token = anonymous read-only viewer of public auctions.
 * - Rooms are routing only. Membership is decided on the server on every join.
 */
export function attachRealtime(httpServer: http.Server, deps: RealtimeDeps): Realtime {
  const { auth, auctions, bids, logger } = deps;
  const maxRooms = deps.maxRoomsPerSocket ?? 20;

  const io = new Server(httpServer, {
    transports: ['websocket'],
    // Inbound messages are tiny; refuse anything big before it is parsed.
    maxHttpBufferSize: 8 * 1024,
    // Same-origin only: no `cors` option, so browsers refuse cross-origin handshakes.
    serveClient: false,
  });

  // With the adapter, `io.to(room).emit(...)` reaches the sockets of every instance through
  // Redis Pub/Sub, and `fetchSockets()` asks every instance. Redis is NOT a source of truth:
  // it forwards messages that PostgreSQL has already committed, and it can lose them.
  if (deps.redis) {
    io.adapter(
      createAdapter(deps.redis.pub, deps.redis.sub, { requestsTimeout: COUNT_CLUSTER_TIMEOUT_MS }),
    );
  }

  const authenticateHandshake = async (
    socket: Socket,
    next: (error?: Error) => void,
  ): Promise<void> => {
    try {
      const raw: unknown = (socket.handshake.auth as Record<string, unknown>)['token'];
      if (raw === undefined) {
        next(); // anonymous
        return;
      }
      const principal =
        typeof raw === 'string' && TOKEN.test(raw) ? await auth.authenticate(raw) : undefined;
      if (!principal || typeof raw !== 'string') {
        next(new Error('UNAUTHENTICATED'));
        return;
      }
      const data = socket.data as SocketData;
      data.token = raw;
      data.userId = principal.userId;
      next();
    } catch (error) {
      logger.error('socket authentication failed', {
        errorName: error instanceof Error ? error.name : 'non-error',
      });
      next(new Error('INTERNAL_ERROR'));
    }
  };
  io.use((socket, next) => {
    void authenticateHandshake(socket, next);
  });

  const localRoomSize = (room: string): number => io.sockets.adapter.rooms.get(room)?.size ?? 0;

  // Number of sockets in the room across ALL instances. If the other instances cannot be
  // asked (Redis down, or too slow) this falls back to the sockets on this instance: the
  // number is a display value, and a wrong one is better than none.
  const clusterRoomSize = async (room: string): Promise<number> => {
    try {
      return (await io.in(room).fetchSockets()).length;
    } catch {
      return localRoomSize(room);
    }
  };

  // One pending count per room, per instance. This map only rate-limits an approximate
  // display value; nothing a bid depends on reads it, and losing it (a restart) loses
  // at most one count message (ADR-032).
  const countTimers = new Map<string, NodeJS.Timeout>();
  const scheduleCount = (auctionId: string): void => {
    if (countTimers.has(auctionId)) return;
    const timer = setTimeout(() => {
      countTimers.delete(auctionId);
      void clusterRoomSize(auctionRoom(auctionId)).then(
        (count) => {
          io.to(auctionRoom(auctionId)).emit(
            'participant.count',
            buildParticipantCountEvent(auctionId, count),
          );
        },
        () => undefined,
      );
    }, COUNT_DEBOUNCE_MS);
    timer.unref();
    countTimers.set(auctionId, timer);
  };

  /**
   * Runs one client message handler. Nothing a client sends may throw out of here:
   * an unhandled rejection would take the whole process down.
   */
  const safe =
    (name: string, handler: (socket: Socket, payload: unknown) => Promise<void>, ack: Ack) =>
    async (socket: Socket, payload: unknown): Promise<void> => {
      try {
        await handler(socket, payload);
      } catch (error) {
        if (error instanceof AppError) {
          ack(fail(error.code, error.message));
          return;
        }
        logger.error('socket handler failed', {
          handler: name,
          errorName: error instanceof Error ? error.name : 'non-error',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        ack(fail('INTERNAL_ERROR', 'Internal server error'));
      }
    };

  io.on('connection', (socket) => {
    const data = socket.data as SocketData;

    socket.on('auction.join', (payload: unknown, maybeAck: unknown) => {
      const ack = toAck(maybeAck);
      void safe(
        'auction.join',
        async (s, p) => {
          const parsed = joinPayloadSchema.safeParse(p);
          if (!parsed.success) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid join payload');
          const { auctionId } = parsed.data;
          const room = auctionRoom(auctionId);

          // A session may have been revoked or expired since the handshake.
          if (data.token !== undefined && !(await auth.authenticate(data.token))) {
            ack(fail('UNAUTHENTICATED', 'Session is no longer valid'));
            s.disconnect(true);
            return;
          }

          // Authorization is decided here, by the server, for this user and this
          // auction (a draft is invisible to everyone but its seller: 404).
          await auctions.get(auctionId, data.userId);

          if (!s.rooms.has(room) && s.rooms.size - 1 >= maxRooms) {
            throw new AppError(429, 'TOO_MANY_ROOMS', 'Too many rooms for this connection');
          }

          // Join FIRST, then read the snapshot: an event committed in between is
          // delivered live, and the client drops it if the snapshot already covers it
          // (by sequence). Reading first would leave a window where it is in neither.
          await s.join(room);
          const [auction, recent] = await Promise.all([
            auctions.get(auctionId, data.userId),
            bids.history(auctionId, data.userId, { limit: SNAPSHOT_BIDS }),
          ]);
          s.emit('auction.snapshot', buildSnapshotEvent(auctionId, auction, recent.items));
          ack({ ok: true });
          scheduleCount(auctionId);
        },
        ack,
      )(socket, payload);
    });

    socket.on('auction.leave', (payload: unknown, maybeAck: unknown) => {
      const ack = toAck(maybeAck);
      void safe(
        'auction.leave',
        async (s, p) => {
          const parsed = leavePayloadSchema.safeParse(p);
          if (!parsed.success)
            throw new AppError(400, 'VALIDATION_FAILED', 'Invalid leave payload');
          const room = auctionRoom(parsed.data.auctionId);
          if (s.rooms.has(room)) {
            await s.leave(room);
            scheduleCount(parsed.data.auctionId);
          }
          ack({ ok: true }); // leaving a room you are not in is not an error
        },
        ack,
      )(socket, payload);
    });

    // Socket.IO removes the socket from its rooms itself on disconnect; the only job here
    // is to tell the people still in those rooms. The count is taken after the debounce,
    // when the socket is already gone, so it needs no special case.
    socket.on('disconnecting', (reason: string) => {
      logger.info('socket disconnected', { socketId: socket.id, reason });
      for (const room of socket.rooms) {
        if (room.startsWith('auction:')) scheduleCount(room.slice('auction:'.length));
      }
    });
    logger.info('socket connected', { socketId: socket.id, anonymous: data.userId === undefined });
  });

  return {
    io,
    close: () => {
      countTimers.forEach((timer) => {
        clearTimeout(timer);
      });
      countTimers.clear();
      return new Promise<void>((resolve) => {
        void io.close(() => {
          resolve();
        });
      });
    },
  };
}
