import { Emitter } from '@socket.io/redis-emitter';
import type { Server } from 'socket.io';
import { auctionRoom, type DurableEvent } from '../../events/events.ts';

/**
 * Where the outbox publisher delivers an event. `publish` must REJECT when delivery failed: the row
 * is only marked published after it resolves.
 */
export interface EventSink {
  publish: (event: DurableEvent) => Promise<void>;
}

/** The part of a Redis client the emitter uses. */
export interface PublishingClient {
  publish: (channel: string, message: string | Buffer) => Promise<number>;
}

/**
 * Delivery from a process that has NO Socket.IO server (the outbox worker): the Socket.IO Redis
 * emitter publishes in the adapter's wire format, and the API instances' adapters deliver the
 * message to their own sockets in the room (ADR-041).
 *
 * `Emitter.emit()` calls `redis.publish(...)` and ignores the result: it cannot tell the caller
 * whether the message was accepted. This sink hands the emitter a client that records the promise,
 * then awaits it, so a Redis failure rejects here (and the row is retried) instead of being marked
 * published. `PUBLISH` resolving means Redis accepted the message, NOT that a client received it.
 */
export function createRedisEmitterSink(redis: PublishingClient): EventSink {
  return {
    async publish(event) {
      let pending: Promise<number> | undefined;
      const capture = {
        publish: (channel: string, message: string | Buffer): Promise<number> => {
          pending = redis.publish(channel, message);
          return pending;
        },
      };
      new Emitter(capture as never).to(auctionRoom(event.auctionId)).emit(event.eventType, event);
      if (!pending) throw new Error('the emitter did not publish anything');
      await pending;
    },
  };
}

/**
 * Delivery from a process that HAS the Socket.IO server (tests, or a single-process setup): the
 * server's own adapter takes it from there (to this process's sockets, and to the other instances
 * when a Redis adapter is installed). There is no failure to report from here.
 */
export function createSocketIoSink(io: Server): EventSink {
  return {
    publish(event) {
      io.to(auctionRoom(event.auctionId)).emit(event.eventType, event);
      return Promise.resolve();
    },
  };
}
