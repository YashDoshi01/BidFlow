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
  highestBidId: sequence === 0 ? null : `b${String(sequence)}`,
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
