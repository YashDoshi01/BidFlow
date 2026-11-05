import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// The event contract (docs/EVENTS.md). Every server -> client message is an
// envelope; the schemas below are used by the server to validate what it emits
// and by the tests (and any client) to validate what it receives.

export const SCHEMA_VERSION = 1;

/** Socket.IO room for one auction. A room is in-memory routing, not durable state. */
export function auctionRoom(auctionId: string): string {
  return `auction:${auctionId}`;
}

const isoInstant = z.iso.datetime({ offset: true });
const moneyString = z.string().regex(/^\d{1,10}\.\d{2}$/);

const envelopeBase = {
  eventId: z.uuid(),
  schemaVersion: z.literal(SCHEMA_VERSION),
  auctionId: z.uuid(),
  occurredAt: isoInstant,
};

/**
 * Phase 3: `sequence` is the auction's bid_sequence (a safe integer). It orders the
 * durable events a client sees. Phase 5 introduces auction_event_sequence for all
 * event types and will bump schemaVersion if the meaning changes (ADR-025).
 */
export const bidAcceptedEventSchema = z
  .object({
    ...envelopeBase,
    eventType: z.literal('bid.accepted'),
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    data: z
      .object({
        bidId: z.uuid(),
        bidderId: z.uuid(),
        bidderDisplayName: z.string().min(1).max(50),
        amount: moneyString,
        currentPrice: moneyString,
        bidSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        acceptedAt: isoInstant,
        endsAt: isoInstant,
        minimumNextBid: moneyString.nullable(),
      })
      .strict(),
  })
  .strict();

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
    highestBidId: z.uuid().nullable(),
    minimumNextBid: moneyString.nullable(),
  })
  .strict();

/**
 * Sent only to the socket that just joined: the authoritative state at that moment.
 * `sequence` is the auction's bid_sequence, so the client can discard any live
 * `bid.accepted` event whose sequence is not greater than it.
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
export type BidAcceptedEvent = z.infer<typeof bidAcceptedEventSchema>;
export type ParticipantCountEvent = z.infer<typeof participantCountEventSchema>;
export type AuctionEvent = BidAcceptedEvent | ParticipantCountEvent;

// Client -> server messages.
export const joinPayloadSchema = z.object({ auctionId: z.uuid() }).strict();
export const leavePayloadSchema = joinPayloadSchema;

/** What the server needs to know about a committed bid to announce it. */
export interface AcceptedBidFacts {
  auctionId: string;
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

export function buildBidAcceptedEvent(f: AcceptedBidFacts): BidAcceptedEvent {
  const sequence = safeInteger(f.bidSequence, 'bidSequence');
  return bidAcceptedEventSchema.parse({
    eventId: randomUUID(),
    eventType: 'bid.accepted',
    schemaVersion: SCHEMA_VERSION,
    auctionId: f.auctionId,
    sequence,
    occurredAt: f.acceptedAt,
    data: {
      bidId: f.bidId,
      bidderId: f.bidderId,
      bidderDisplayName: f.bidderDisplayName,
      amount: f.amount,
      currentPrice: f.currentPrice,
      bidSequence: sequence,
      acceptedAt: f.acceptedAt,
      endsAt: f.endsAt,
      minimumNextBid: f.minimumNextBid,
    },
  });
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
  auction: { bidSequence: string },
  recentBids: unknown[],
): AuctionSnapshotEvent {
  return auctionSnapshotEventSchema.parse({
    eventId: randomUUID(),
    eventType: 'auction.snapshot',
    schemaVersion: SCHEMA_VERSION,
    auctionId,
    sequence: safeInteger(auction.bidSequence, 'bidSequence'),
    occurredAt: new Date().toISOString(),
    data: { auction, recentBids },
  });
}
