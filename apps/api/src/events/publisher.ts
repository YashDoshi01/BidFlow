import type { Logger } from '../logging/logger.ts';
import type { AuctionEvent } from './events.ts';

/**
 * Where committed events go. Phase 3 publishes directly after the database commit
 * (ADR-026): if the process dies between COMMIT and the emit, the event is lost
 * and clients recover through the REST snapshot. Phase 5 replaces this with the
 * transactional outbox without changing this interface.
 */
export interface EventPublisher {
  publish: (event: AuctionEvent) => void | Promise<void>;
}

export const noopPublisher: EventPublisher = { publish: () => undefined };

/**
 * The HTTP app is built before the Socket.IO server (which needs the HTTP server
 * that wraps the app). The relay is the publisher handed to the app; the real
 * sink is attached once Socket.IO exists.
 */
export interface EventRelay extends EventPublisher {
  attach: (sink: EventPublisher) => void;
}

export function createEventRelay(logger: Logger): EventRelay {
  let sink: EventPublisher | undefined;
  return {
    attach(next) {
      sink = next;
    },
    async publish(event) {
      if (!sink) {
        logger.warn('event dropped: no realtime sink attached', { eventType: event.eventType });
        return;
      }
      await sink.publish(event);
    },
  };
}
