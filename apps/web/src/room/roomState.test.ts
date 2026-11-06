import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_BIDS_KEPT,
  initialRoomState,
  needsResync,
  roomReducer,
  type AcceptedBid,
  type AuctionView,
  type BidView,
  type RoomAction,
  type RoomState,
} from './roomState.ts';

const auction = (sequence: number, price = '10.00'): AuctionView => ({
  id: 'a1',
  sellerId: 's1',
  title: 'Lamp',
  description: '',
  startingPrice: '10.00',
  currentPrice: price,
  minimumIncrement: '1.00',
  currency: 'USD',
  status: 'LIVE',
  startsAt: '2030-01-01T00:00:00.000Z',
  endsAt: '2030-01-01T01:00:00.000Z',
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-01T00:00:00.000Z',
  bidSequence: String(sequence),
  eventSequence: String(sequence),
  highestBidId: sequence === 0 ? null : `b${String(sequence)}`,
  extensionCount: 0,
  endedAt: null,
  winningBidId: null,
  minimumNextBid: '11.00',
});

const bid = (sequence: number, amount = `${String(9 + sequence)}.00`): BidView => ({
  id: `b${String(sequence)}`,
  auctionId: 'a1',
  bidderId: 'u1',
  bidderDisplayName: 'Ann',
  amount,
  bidSequence: String(sequence),
  acceptedAt: '2030-01-01T00:10:00.000Z',
});

const accepted = (sequence: number): AcceptedBid => ({
  sequence,
  bid: bid(sequence),
  currentPrice: bid(sequence).amount,
  endsAt: '2030-01-01T01:00:00.000Z',
  minimumNextBid: `${String(10 + sequence)}.00`,
});

const run = (actions: RoomAction[], from: RoomState = initialRoomState): RoomState =>
  actions.reduce(roomReducer, from);

const snapshot = (sequence: number, recent: BidView[] = []): RoomAction => ({
  type: 'snapshot',
  sequence,
  auction: auction(sequence),
  recentBids: recent,
});

describe('roomReducer', () => {
  it('applies the next event: price, sequence, highest bid and the bid list', () => {
    const s = run([snapshot(0), { type: 'bid', accepted: accepted(1) }]);
    assert.equal(s.lastSequence, 1);
    assert.ok(s.auction);
    assert.equal(s.auction.currentPrice, '10.00');
    assert.equal(s.auction.bidSequence, '1');
    assert.equal(s.auction.highestBidId, 'b1');
    assert.deepEqual(
      s.bids.map((b) => b.id),
      ['b1'],
    );
  });

  it('orders by the EVENT sequence and keeps the bid sequence separate (they are different counters)', () => {
    // Future-proof: an event that is not a bid (say sequence 2) was applied earlier, so the next
    // bid is event 3 but only the 2nd bid.
    const base = run([snapshot(2, [bid(1)])]);
    const secondBidAsThirdEvent: AcceptedBid = {
      sequence: 3,
      bid: { ...bid(2), bidSequence: '2' },
      currentPrice: '11.00',
      endsAt: '2030-01-01T01:00:00.000Z',
      minimumNextBid: '12.00',
    };
    const s = roomReducer(base, { type: 'bid', accepted: secondBidAsThirdEvent });
    assert.equal(s.lastSequence, 3);
    assert.ok(s.auction);
    assert.equal(s.auction.eventSequence, '3');
    assert.equal(s.auction.bidSequence, '2');
    assert.equal(needsResync(s), false);
  });

  it('ignores a duplicate event (same sequence delivered twice)', () => {
    const once = run([snapshot(0), { type: 'bid', accepted: accepted(1) }]);
    const twice = roomReducer(once, { type: 'bid', accepted: accepted(1) });
    assert.deepEqual(twice, once);
  });

  it('ignores a stale event (older than the snapshot)', () => {
    const s = run([snapshot(5, [bid(5)]), { type: 'bid', accepted: accepted(3) }]);
    assert.equal(s.lastSequence, 5);
    assert.equal(s.bids.length, 1);
    assert.equal(needsResync(s), false);
  });

  it('a gap is not applied and asks for a resync', () => {
    const s = run([
      snapshot(0),
      { type: 'bid', accepted: accepted(1) },
      { type: 'bid', accepted: accepted(3) },
    ]);
    assert.equal(s.lastSequence, 1); // 3 was NOT applied
    assert.equal(needsResync(s), true);
    assert.equal(s.gapTarget, 3);
    assert.equal(s.resyncRequests, 1);
    assert.deepEqual(
      s.bids.map((b) => b.id),
      ['b1'],
    );
  });

  it('out-of-order delivery (2 arrives after 3) ends in the right state after the snapshot', () => {
    let s = run([snapshot(1, [bid(1)]), { type: 'bid', accepted: accepted(3) }]);
    assert.equal(needsResync(s), true);
    s = roomReducer(s, { type: 'bid', accepted: accepted(2) }); // 2 is applied, 3 was dropped
    assert.equal(s.lastSequence, 2);
    assert.equal(needsResync(s), true); // still behind the gap target
    s = roomReducer(s, snapshot(3, [bid(3), bid(2), bid(1)]));
    assert.equal(s.lastSequence, 3);
    assert.equal(needsResync(s), false);
    assert.deepEqual(
      s.bids.map((b) => b.id),
      ['b3', 'b2', 'b1'],
    );
  });

  it('a snapshot replaces the state and clears the gap', () => {
    let s = run([snapshot(0), { type: 'bid', accepted: accepted(4) }]);
    assert.equal(needsResync(s), true);
    s = roomReducer(s, snapshot(4, [bid(4), bid(3)]));
    assert.equal(s.lastSequence, 4);
    assert.equal(needsResync(s), false);
    assert.equal(s.auction?.bidSequence, '4');
  });

  it('a snapshot older than the current state never moves it backwards', () => {
    const s = run([
      snapshot(0),
      { type: 'bid', accepted: accepted(1) },
      { type: 'bid', accepted: accepted(2) },
    ]);
    const after = roomReducer(s, snapshot(1, [bid(1)]));
    assert.equal(after.lastSequence, 2);
    assert.equal(after.bids.length, 2);
  });

  it('events that arrive before the first snapshot are kept and replayed in order', () => {
    const s = run([
      { type: 'bid', accepted: accepted(3) },
      { type: 'bid', accepted: accepted(2) },
      { type: 'bid', accepted: accepted(1) },
      snapshot(1, [bid(1)]), // the snapshot already covers 1
    ]);
    assert.equal(s.lastSequence, 3);
    assert.deepEqual(
      s.bids.map((b) => b.id),
      ['b3', 'b2', 'b1'],
    );
    assert.equal(s.buffered.length, 0);
  });

  it('our own confirmed reply and the live event for the same bid count once', () => {
    const s = run([
      snapshot(0),
      { type: 'bid', accepted: accepted(1) }, // from the REST 201
      { type: 'bid', accepted: accepted(1) }, // from the live event
    ]);
    assert.equal(s.bids.length, 1);
    assert.equal(s.lastSequence, 1);
  });

  it('nothing appears before the server confirms: no auction and no bids until a snapshot', () => {
    const s = run([{ type: 'bid', accepted: accepted(1) }]);
    assert.equal(s.auction, null);
    assert.equal(s.bids.length, 0);
  });

  it('keeps only the newest MAX_BIDS_KEPT bids', () => {
    const actions: RoomAction[] = [snapshot(0)];
    for (let i = 1; i <= MAX_BIDS_KEPT + 10; i += 1)
      actions.push({ type: 'bid', accepted: accepted(i) });
    const s = run(actions);
    assert.equal(s.bids.length, MAX_BIDS_KEPT);
    assert.equal(s.bids[0]?.id, `b${String(MAX_BIDS_KEPT + 10)}`);
  });

  it('tracks connection status and the participant count', () => {
    let s = roomReducer(initialRoomState, { type: 'connection', status: 'connected' });
    s = roomReducer(s, { type: 'participants', count: 4 });
    assert.equal(s.connection, 'connected');
    assert.equal(s.participants, 4);
  });
});

describe('lifecycle events (Phase 6)', () => {
  const auctionOf = (state: RoomState): AuctionView => {
    assert.ok(state.auction);
    return state.auction;
  };
  const extended = (
    sequence: number,
    endsAt = '2030-01-01T01:02:00.000Z',
    count = 1,
  ): RoomAction => ({
    type: 'lifecycle',
    event: { kind: 'extended', sequence, endsAt, extensionCount: count },
  });
  const ended = (sequence: number, winningBidId: string | null = 'b1'): RoomAction => ({
    type: 'lifecycle',
    event: {
      kind: 'ended',
      sequence,
      endedAt: '2030-01-01T01:02:00.000Z',
      winningBidId,
      finalPrice: '10.00',
    },
  });

  it('a bid and the extension it caused apply in order and move the end time', () => {
    const s = run([snapshot(0), { type: 'bid', accepted: accepted(1) }, extended(2)]);
    assert.equal(s.lastSequence, 2);
    assert.equal(auctionOf(s).endsAt, '2030-01-01T01:02:00.000Z');
    assert.equal(auctionOf(s).extensionCount, 1);
    assert.equal(auctionOf(s).eventSequence, '2');
    assert.equal(auctionOf(s).bidSequence, '1'); // the extension is an event, not a bid
  });

  it('the end closes the auction: status, winner, final price, no next bid', () => {
    const s = run([snapshot(0), { type: 'bid', accepted: accepted(1) }, ended(2)]);
    assert.equal(auctionOf(s).status, 'ENDED');
    assert.equal(auctionOf(s).winningBidId, 'b1');
    assert.equal(auctionOf(s).currentPrice, '10.00');
    assert.equal(auctionOf(s).minimumNextBid, null);
    assert.equal(auctionOf(s).endedAt, '2030-01-01T01:02:00.000Z');
  });

  it('a started event makes a scheduled auction LIVE', () => {
    const scheduled: RoomAction = {
      type: 'snapshot',
      sequence: 0,
      auction: { ...auction(0), status: 'SCHEDULED' },
      recentBids: [],
    };
    const s = run([
      scheduled,
      {
        type: 'lifecycle',
        event: { kind: 'started', sequence: 1, endsAt: '2030-01-01T01:00:00.000Z' },
      },
    ]);
    assert.equal(auctionOf(s).status, 'LIVE');
    assert.equal(s.lastSequence, 1);
  });

  it('duplicates are ignored and a gap asks for a snapshot, like bids', () => {
    const base = run([snapshot(0), { type: 'bid', accepted: accepted(1) }, extended(2)]);
    assert.equal(roomReducer(base, extended(2)), base); // duplicate
    const gap = roomReducer(base, ended(4)); // 3 is missing
    assert.equal(gap.lastSequence, 2);
    assert.equal(auctionOf(gap).status, 'LIVE');
    assert.ok(needsResync(gap));
  });

  it('out-of-order delivery around a snapshot ends in the right state', () => {
    // The extension (2) arrives BEFORE the snapshot; the snapshot is at 1.
    const s = run([
      extended(2),
      { type: 'bid', accepted: accepted(1) },
      { type: 'snapshot', sequence: 0, auction: auction(0), recentBids: [] },
    ]);
    assert.equal(s.lastSequence, 2);
    assert.equal(auctionOf(s).extensionCount, 1);
    assert.equal(s.bids.length, 1);
  });
});
