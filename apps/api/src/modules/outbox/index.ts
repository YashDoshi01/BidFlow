// Public surface of the outbox module. Other modules import only from here.
export { createOutboxPublisher, type OutboxFaults, type OutboxPublisher } from './publisher.ts';
export { createPublishClient } from './redis.ts';
export {
  claimBatch,
  insertOutboxEvent,
  listFailed,
  markAttemptFailed,
  markPublished,
  outboxStats,
  pruneOutbox,
  retryFailed,
  type ClaimedEvent,
  type FailedEvent,
  type OutboxStats,
} from './repository.ts';
export { createRedisEmitterSink, createSocketIoSink, type EventSink } from './sink.ts';
export { describeError, retryDelaySeconds, toEnvelope } from './envelope.ts';
