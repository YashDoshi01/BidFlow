import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseBidAccepted,
  parseLifecycleEvent,
  parseParticipantCount,
  parseSnapshot,
} from './parseEvents.ts';

const bidEvent = (over: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}) => ({
  eventId: 'e1',
  eventType: 'bid.accepted',
  schemaVersion: 2,
  auctionId: 'a1',
  sequence: 7,
  occurredAt: '2030-01-01T00:00:00.000Z',
  data: {
    bidId: 'b1',
    bidderId: 'u1',
    bidderDisplayName: 'Ann',
    amount: '12.00',
    currentPrice: '12.00',
    bidSequence: 4,
    acceptedAt: '2030-01-01T00:00:00.000Z',
    endsAt: '2030-01-01T01:00:00.000Z',
    minimumNextBid: '13.00',
    ...dataOver,
  },
  ...over,
});

describe('parseBidAccepted', () => {
  it('keeps the EVENT sequence and the BID sequence apart (they are different counters)', () => {
    const parsed = parseBidAccepted(bidEvent());
    assert.ok(parsed);
    assert.equal(parsed.sequence, 7);
    assert.equal(parsed.bid.bidSequence, '4');
    assert.equal(parsed.bid.amount, '12.00');
    assert.equal(parsed.minimumNextBid, '13.00');
  });

  it('drops anything malformed instead of guessing', () => {
    const bad: unknown[] = [
      null,
      'x',
      [],
      bidEvent({ eventType: 'bid.rejected' }),
      bidEvent({ sequence: '7' }),
      bidEvent({ sequence: 1.5 }),
      bidEvent({}, { amount: '12' }),
      bidEvent({}, { bidSequence: 'four' }),
      bidEvent({}, { bidSequence: 1.5 }),
      bidEvent({}, { minimumNextBid: 13 }),
      bidEvent({ data: null }),
    ];
    for (const payload of bad)
      assert.equal(parseBidAccepted(payload), null, JSON.stringify(payload));
  });
});

describe('parseSnapshot', () => {
  const auction = {
    id: 'a1',
    sellerId: 's1',
    title: 'Lamp',
    description: '',
    startingPrice: '10.00',
    currentPrice: '12.00',
    minimumIncrement: '1.00',
    currency: 'USD',
    status: 'LIVE',
    startsAt: '2030-01-01T00:00:00.000Z',
    endsAt: '2030-01-01T01:00:00.000Z',
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
    bidSequence: '4',
    eventSequence: '7',
    highestBidId: 'b1',
    extensionCount: 0,
    endedAt: null,
    winningBidId: null,
    minimumNextBid: '13.00',
  };
  const snapshot = (a: Record<string, unknown> = auction) => ({
    eventType: 'auction.snapshot',
    sequence: 7,
    data: { auction: a, recentBids: [] },
  });

  it('reads both counters and requires the event sequence', () => {
    const parsed = parseSnapshot(snapshot());
    assert.ok(parsed);
    assert.equal(parsed.sequence, 7);
    assert.equal(parsed.auction.eventSequence, '7');
    assert.equal(parsed.auction.bidSequence, '4');
    const withoutEventSequence: Record<string, unknown> = { ...auction };
    delete withoutEventSequence['eventSequence'];
    assert.equal(parseSnapshot(snapshot(withoutEventSequence)), null);
  });

  it('rejects an unknown status and a non-money price', () => {
    assert.equal(parseSnapshot(snapshot({ ...auction, status: 'OPEN' })), null);
    assert.equal(parseSnapshot(snapshot({ ...auction, currentPrice: '12' })), null);
  });
});

describe('parseParticipantCount', () => {
  it('accepts a non-negative integer only', () => {
    const event = (count: unknown) => ({ eventType: 'participant.count', data: { count } });
    assert.equal(parseParticipantCount(event(3)), 3);
    assert.equal(parseParticipantCount(event(0)), 0);
    for (const bad of [-1, 1.5, '3', null]) assert.equal(parseParticipantCount(event(bad)), null);
  });
});

describe('parseLifecycleEvent', () => {
  const envelope = (eventType: string, sequence: unknown, data: unknown) => ({
    eventType,
    sequence,
    data,
  });

  it('reads started, extended and ended', () => {
    assert.deepEqual(
      parseLifecycleEvent(envelope('auction.started', 1, { endsAt: '2030-01-01T01:00:00.000Z' })),
      { kind: 'started', sequence: 1, endsAt: '2030-01-01T01:00:00.000Z' },
    );
    assert.deepEqual(
      parseLifecycleEvent(
        envelope('auction.extended', 5, { endsAt: '2030-01-01T01:02:00.000Z', extensionCount: 2 }),
      ),
      { kind: 'extended', sequence: 5, endsAt: '2030-01-01T01:02:00.000Z', extensionCount: 2 },
    );
    assert.deepEqual(
      parseLifecycleEvent(
        envelope('auction.ended', 9, {
          endedAt: '2030-01-01T01:02:00.000Z',
          winningBidId: null,
          finalPrice: '10.00',
        }),
      ),
      {
        kind: 'ended',
        sequence: 9,
        endedAt: '2030-01-01T01:02:00.000Z',
        winningBidId: null,
        finalPrice: '10.00',
      },
    );
  });

  it('drops anything malformed or unknown instead of guessing', () => {
    assert.equal(parseLifecycleEvent(envelope('auction.started', 1, {})), null);
    assert.equal(
      parseLifecycleEvent(envelope('auction.extended', 1.5, { endsAt: 'x', extensionCount: 1 })),
      null,
    );
    assert.equal(
      parseLifecycleEvent(envelope('auction.extended', 2, { endsAt: 'x', extensionCount: '1' })),
      null,
    );
    assert.equal(
      parseLifecycleEvent(
        envelope('auction.ended', 3, { endedAt: 'x', winningBidId: null, finalPrice: '10' }),
      ),
      null,
    );
    assert.equal(parseLifecycleEvent(envelope('auction.cancelled', 4, {})), null);
    assert.equal(parseLifecycleEvent('nope'), null);
  });
});
