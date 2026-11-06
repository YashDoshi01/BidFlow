import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// The event contract (docs/EVENTS.md). Every server -> client message is an
// envelope; the schemas below are used by the server to validate what it emits
// and by the tests (and any client) to validate what it receives.

/**
 * Version 2 (Phase 5): `sequence` is the auction's auction_event_sequence, the position of the
 * event among ALL durable events of that auction. In version 1 (Phase 3-4) it was the bid
 * sequence; the two are equal while bids are the only events, but they are different counters.
 */
export const SCHEMA_VERSION = 2;

/** Socket.IO room for one auction. A room is in-memory routing, not durable state. */
export function auctionRoom(auctionId: string): string {
  return `auction:${auctionId}`;
}

const isoInstant = z.iso.datetime({ offset: true });
const moneyString = z.string().regex(/^\d{1,10}\.\d{2}$/);
const safeSequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const envelopeBase = {
  eventId: z.uuid(),
  schemaVersion: z.literal(SCHEMA_VERSION),
  auctionId: z.uuid(),
  occurredAt: isoInstant,
};

/** The `data` of a bid.accepted event. It is built when the bid commits and stored in the outbox. */
export const bidAcceptedDataSchema = z
  .object({
    bidId: z.uuid(),
    bidderId: z.uuid(),
    bidderDisplayName: z.string().min(1).max(50),
    amount: moneyString,
    currentPrice: moneyString,
    // The bid's own position among the accepted bids (not the event's position).
    bidSequence: safeSequence,
    acceptedAt: isoInstant,
    endsAt: isoInstant,
    minimumNextBid: moneyString.nullable(),
  })
  .strict();

export const bidAcceptedEventSchema = z
  .object({
    ...envelopeBase,
    eventType: z.literal('bid.accepted'),
    sequence: safeSequence,
    data: bidAcceptedDataSchema,
  })
  .strict();

/** Phase 6: an auction became LIVE (the worker at starts_at). */
export const auctionStartedDataSchema = z
  .object({ startedAt: isoInstant, startsAt: isoInstant, endsAt: isoInstant })
  .strict();

export const auctionStartedEventSchema = z
  .object({
    ...envelopeBase,
    eventType: z.literal('auction.started'),
    sequence: safeSequence,
    data: auctionStartedDataSchema,
  })
  .strict();

/** Phase 6: anti-sniping moved ends_at forward. Always follows the bid.accepted that caused it. */
export const auctionExtendedDataSchema = z
  .object({
    previousEndsAt: isoInstant,
    endsAt: isoInstant,
    // How many extensions this auction has used, including this one (at most MAX_EXTENSIONS).
    extensionCount: z.number().int().min(1).max(10),
    triggeringBidId: z.uuid(),
  })
  .strict();

export const auctionExtendedEventSchema = z
  .object({
    ...envelopeBase,
    eventType: z.literal('auction.extended'),
    sequence: safeSequence,
    data: auctionExtendedDataSchema,
  })
  .strict();

/** Phase 6: the auction ended; the winner is the highest accepted bid (null if nobody bid). */
export const auctionEndedDataSchema = z
  .object({
    endedAt: isoInstant,
    endsAt: isoInstant,
    winningBidId: z.uuid().nullable(),
    winnerId: z.uuid().nullable(),
    winnerDisplayName: z.string().min(1).max(50).nullable(),
    finalPrice: moneyString,
    bidCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const auctionEndedEventSchema = z
  .object({
    ...envelopeBase,
    eventType: z.literal('auction.ended'),
    sequence: safeSequence,
    data: auctionEndedDataSchema,
  })
  .strict();

/** Every durable event: what the outbox may contain and what a worker validates before publishing. */
export const durableEventSchema = z.discriminatedUnion('eventType', [
  bidAcceptedEventSchema,
  auctionStartedEventSchema,
  auctionExtendedEventSchema,
  auctionEndedEventSchema,
]);

export const participantCountEventSchema = z
  .object({
    ...envelopeBase,
    eventType: z.literal('participant.count'),
    // Ephemeral: not part of the durable sequence.
    data: z.object({ count: z.number().int().min(0) }).strict(),
  })
  .strict();

const bidViewSchema = z
  .object({
    id: z.uuid(),
    auctionId: z.uuid(),
    bidderId: z.uuid(),
    bidderDisplayName: z.string().min(1).max(50),
    amount: moneyString,
    bidSequence: z.string().regex(/^\d{1,18}$/),
    acceptedAt: isoInstant,
  })
  .strict();

const auctionViewSchema = z
  .object({
    id: z.uuid(),
    sellerId: z.uuid(),
    title: z.string(),
    description: z.string(),
    startingPrice: moneyString,
    currentPrice: moneyString,
    minimumIncrement: moneyString,
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: z.enum(['DRAFT', 'SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED']),
    startsAt: isoInstant,
    endsAt: isoInstant,
    createdAt: isoInstant,
    updatedAt: isoInstant,
    bidSequence: z.string().regex(/^\d{1,18}$/),
    eventSequence: z.string().regex(/^\d{1,18}$/),
    highestBidId: z.uuid().nullable(),
    extensionCount: z.number().int().min(0).max(10),
    endedAt: isoInstant.nullable(),
    winningBidId: z.uuid().nullable(),
    minimumNextBid: moneyString.nullable(),
  })
  .strict();

/**
 * Sent only to the socket that just joined: the authoritative state at that moment.
 * `sequence` is the auction's auction_event_sequence, so the client can discard any live
 * event whose sequence is not greater than it.
 */
export const auctionSnapshotEventSchema = z
  .object({
    ...envelopeBase,
    eventType: z.literal('auction.snapshot'),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    data: z
      .object({ auction: auctionViewSchema, recentBids: z.array(bidViewSchema).max(50) })
      .strict(),
  })
  .strict();

export type AuctionSnapshotEvent = z.infer<typeof auctionSnapshotEventSchema>;
export type BidAcceptedData = z.infer<typeof bidAcceptedDataSchema>;
export type BidAcceptedEvent = z.infer<typeof bidAcceptedEventSchema>;
export type AuctionStartedData = z.infer<typeof auctionStartedDataSchema>;
export type AuctionExtendedData = z.infer<typeof auctionExtendedDataSchema>;
export type AuctionEndedData = z.infer<typeof auctionEndedDataSchema>;
export type DurableEvent = z.infer<typeof durableEventSchema>;
export type ParticipantCountEvent = z.infer<typeof participantCountEventSchema>;

// Client -> server messages.
export const joinPayloadSchema = z.object({ auctionId: z.uuid() }).strict();
export const leavePayloadSchema = joinPayloadSchema;

/** What the bid transaction knows about a bid it is committing. */
export interface AcceptedBidFacts {
  bidId: string;
  bidderId: string;
  bidderDisplayName: string;
  amount: string;
  currentPrice: string;
  bidSequence: string;
  acceptedAt: string;
  endsAt: string;
  minimumNextBid: string | null;
}

function safeInteger(value: string, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${what} is not a safe integer`);
  return n;
}

/**
 * The payload stored in the outbox with the bid. Validated HERE, inside the bid transaction, so a
 * malformed event fails the bid loudly instead of becoming a poison row that blocks the auction's
 * queue later.
 */
export function buildBidAcceptedPayload(f: AcceptedBidFacts): BidAcceptedData {
  return bidAcceptedDataSchema.parse({
    bidId: f.bidId,
    bidderId: f.bidderId,
    bidderDisplayName: f.bidderDisplayName,
    amount: f.amount,
    currentPrice: f.currentPrice,
    bidSequence: safeInteger(f.bidSequence, 'bidSequence'),
    acceptedAt: f.acceptedAt,
    endsAt: f.endsAt,
    minimumNextBid: f.minimumNextBid,
  });
}

/** Payload builders for the lifecycle events: validated inside the transaction that writes them. */
export function buildAuctionStartedPayload(f: AuctionStartedData): AuctionStartedData {
  return auctionStartedDataSchema.parse(f);
}

export function buildAuctionExtendedPayload(f: AuctionExtendedData): AuctionExtendedData {
  return auctionExtendedDataSchema.parse(f);
}

export function buildAuctionEndedPayload(f: AuctionEndedData): AuctionEndedData {
  return auctionEndedDataSchema.parse(f);
}

export function buildParticipantCountEvent(
  auctionId: string,
  count: number,
): ParticipantCountEvent {
  return participantCountEventSchema.parse({
    eventId: randomUUID(),
    eventType: 'participant.count',
    schemaVersion: SCHEMA_VERSION,
    auctionId,
    occurredAt: new Date().toISOString(),
    data: { count },
  });
}

export function buildSnapshotEvent(
  auctionId: string,
  auction: { eventSequence: string },
  recentBids: unknown[],
): AuctionSnapshotEvent {
  return auctionSnapshotEventSchema.parse({
    eventId: randomUUID(),
    eventType: 'auction.snapshot',
    schemaVersion: SCHEMA_VERSION,
    auctionId,
    sequence: safeInteger(auction.eventSequence, 'eventSequence'),
    occurredAt: new Date().toISOString(),
    data: { auction, recentBids },
  });
}
