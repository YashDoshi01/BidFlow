import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { AuctionView, BidView } from '../room/roomState.ts';
import { myBidStatus } from './bidStatus.ts';
import {
  betterSample,
  observeResponse,
  resetClockForTests,
  sampleFromResponse,
  serverNow,
} from './clock.ts';
import { describeClock, formatRemaining } from './countdown.ts';
import { fromLocalInputValue, toLocalInputValue } from './datetime.ts';
import { describeNotification, parseNotification } from './notificationText.ts';

describe('formatRemaining', () => {
  it('uses the two most useful units', () => {
    assert.equal(formatRemaining(7_000), '7s');
    assert.equal(formatRemaining(4 * 60_000 + 7_000), '4m 07s');
    assert.equal(formatRemaining(3_600_000 + 5 * 60_000), '1h 05m');
    assert.equal(formatRemaining(2 * 86_400_000 + 3 * 3_600_000), '2d 3h');
  });
  it('never shows a negative or fractional value', () => {
    assert.equal(formatRemaining(-5_000), '0s');
    assert.equal(formatRemaining(999), '0s');
  });
});

describe('describeClock', () => {
  const base = {
    startsAt: '2030-01-01T00:00:00.000Z',
    endsAt: '2030-01-01T01:00:00.000Z',
    endedAt: null,
  };
  const t = (iso: string): number => new Date(iso).getTime();

  it('counts down to the END time for a live auction', () => {
    const c = describeClock({ ...base, status: 'LIVE' }, t('2030-01-01T00:59:00.000Z'));
    assert.deepEqual(c, { label: 'Time left', text: '1m 00s', waitingForServer: false });
  });
  it('past the end time but still LIVE: says "ending…", never "ended" (only the server decides)', () => {
    const c = describeClock({ ...base, status: 'LIVE' }, t('2030-01-01T01:00:01.000Z'));
    assert.equal(c.text, 'ending…');
    assert.equal(c.waitingForServer, true);
  });
  it('counts down to the START for a scheduled auction', () => {
    const c = describeClock({ ...base, status: 'SCHEDULED' }, t('2029-12-31T23:59:00.000Z'));
    assert.deepEqual(c, { label: 'Starts in', text: '1m 00s', waitingForServer: false });
    const late = describeClock({ ...base, status: 'SCHEDULED' }, t('2030-01-01T00:00:01.000Z'));
    assert.equal(late.text, 'starting…');
  });
  it('an ended auction shows the recorded end, whatever the clock says', () => {
    const c = describeClock(
      { ...base, status: 'ENDED', endedAt: '2030-01-01T01:00:00.500Z' },
      t('2020-01-01T00:00:00.000Z'),
    );
    assert.equal(c.label, 'Ended');
    assert.equal(c.waitingForServer, false);
  });
  it('an extension moves the countdown because it reads the current endsAt', () => {
    const before = describeClock({ ...base, status: 'LIVE' }, t('2030-01-01T00:59:30.000Z'));
    const after = describeClock(
      { ...base, endsAt: '2030-01-01T01:01:30.000Z', status: 'LIVE' },
      t('2030-01-01T00:59:30.000Z'),
    );
    assert.equal(before.text, '30s');
    assert.equal(after.text, '2m 00s');
  });
});

describe('server clock estimate', () => {
  beforeEach(resetClockForTests);

  it('measures a browser that is behind the server', () => {
    // Server second 12:00:10 (real time in [10, 11)); browser thinks it is 12:00:00 (10 s behind).
    const s = sampleFromResponse(
      'Mon, 01 Jan 2029 12:00:10 GMT',
      Date.parse('2029-01-01T12:00:00.000Z'),
      Date.parse('2029-01-01T12:00:00.100Z'),
    );
    assert.ok(s);
    // midpoint of server interval = 10.5 s, midpoint of the request = 0.05 s
    assert.ok(Math.abs(s.offsetMs - 10_450) < 1);
    assert.equal(s.rttMs, 100);
  });
  it('ignores a missing/garbled header and a request whose clock went backwards', () => {
    assert.equal(sampleFromResponse(null, 0, 10), null);
    assert.equal(sampleFromResponse('not a date', 0, 10), null);
    assert.equal(sampleFromResponse('Mon, 01 Jan 2029 12:00:10 GMT', 100, 50), null);
  });
  it('keeps the sample with the shortest round trip', () => {
    const slow = { offsetMs: 900, rttMs: 800 };
    const fast = { offsetMs: 100, rttMs: 20 };
    assert.equal(betterSample(slow, fast), fast);
    assert.equal(betterSample(fast, slow), fast);
    assert.equal(betterSample(null, null), null);
    assert.equal(betterSample(fast, null), fast);
  });
  it('serverNow adds the offset, and is the browser time before any sample', () => {
    assert.equal(serverNow(1000), 1000);
    observeResponse(
      'Mon, 01 Jan 2029 12:00:10 GMT',
      Date.parse('2029-01-01T12:00:00.000Z'),
      Date.parse('2029-01-01T12:00:00.100Z'),
    );
    const browser = Date.parse('2029-01-01T12:00:05.000Z');
    assert.ok(Math.abs(serverNow(browser) - (browser + 10_450)) < 1);
  });
});

const bid = (id: string, bidderId: string, amount: string, seq: number): BidView => ({
  id,
  auctionId: 'a',
  bidderId,
  bidderDisplayName: bidderId,
  amount,
  bidSequence: String(seq),
  acceptedAt: '2030-01-01T00:00:00.000Z',
});
const auction = (
  over: Partial<AuctionView> = {},
): Pick<AuctionView, 'status' | 'highestBidId' | 'winningBidId' | 'currentPrice'> => ({
  status: 'LIVE',
  highestBidId: null,
  winningBidId: null,
  currentPrice: '10.00',
  ...over,
});

describe('myBidStatus', () => {
  const bids = [
    bid('b3', 'bob', '30.00', 3),
    bid('b2', 'ann', '20.00', 2),
    bid('b1', 'bob', '10.00', 1),
  ];

  it('no bids of mine, or signed out: none', () => {
    assert.deepEqual(myBidStatus(auction({ highestBidId: 'b3' }), bids, 'cy'), { kind: 'none' });
    assert.deepEqual(myBidStatus(auction({ highestBidId: 'b3' }), bids, undefined), {
      kind: 'none',
    });
    assert.deepEqual(myBidStatus(auction(), [], 'ann'), { kind: 'none' });
  });
  it('holding the highest bid: leading', () => {
    assert.deepEqual(myBidStatus(auction({ highestBidId: 'b3' }), bids, 'bob'), {
      kind: 'leading',
      amount: '30.00',
    });
  });
  it('bid beaten: outbid, with my best (newest) bid and the current price', () => {
    assert.deepEqual(
      myBidStatus(auction({ highestBidId: 'b3', currentPrice: '30.00' }), bids, 'ann'),
      {
        kind: 'outbid',
        yourBest: '20.00',
        currentPrice: '30.00',
      },
    );
  });
  it('ended: the winner won, another bidder lost, a non-bidder is none', () => {
    const ended = auction({
      status: 'ENDED',
      highestBidId: 'b3',
      winningBidId: 'b3',
      currentPrice: '30.00',
    });
    assert.deepEqual(myBidStatus(ended, bids, 'bob'), { kind: 'won', amount: '30.00' });
    assert.deepEqual(myBidStatus(ended, bids, 'ann'), {
      kind: 'lost',
      yourBest: '20.00',
      finalPrice: '30.00',
    });
    assert.deepEqual(myBidStatus(ended, bids, 'cy'), { kind: 'none' });
  });
  it('ended without a winner: none for everyone', () => {
    assert.deepEqual(myBidStatus(auction({ status: 'ENDED' }), [], 'ann'), { kind: 'none' });
  });
});

describe('notifications', () => {
  const row = (type: string, data: Record<string, unknown>) => ({
    id: 'n1',
    auctionId: 'a1',
    type,
    data,
    createdAt: '2030-01-01T00:00:00.000Z',
    readAt: null,
  });

  it('parses a valid row and drops malformed ones instead of rendering them', () => {
    assert.ok(parseNotification(row('outbid', {})));
    assert.equal(parseNotification(row('made_up_type', {})), null);
    assert.equal(parseNotification({ ...row('outbid', {}), id: 5 }), null);
    assert.equal(parseNotification({ ...row('outbid', {}), data: null }), null);
    assert.equal(parseNotification({ ...row('outbid', {}), readAt: 5 }), null);
    assert.equal(parseNotification(null), null);
    assert.equal(parseNotification('x'), null);
  });
  it('links to the auction and reads the snapshot fields', () => {
    const n = parseNotification(
      row('outbid', {
        auctionTitle: 'Lamp',
        yourAmount: '10.00',
        currentPrice: '12.00',
        minimumNextBid: '13.00',
      }),
    );
    assert.ok(n);
    const text = describeNotification(n);
    assert.equal(text.href, '#/auction/a1');
    assert.match(text.title, /outbid on Lamp/);
    assert.match(text.body, /10\.00.*12\.00.*13\.00/);
  });
  it('every type produces text, and missing data never throws', () => {
    for (const type of ['outbid', 'ending_soon', 'auction_won', 'auction_lost', 'auction_ended']) {
      const n = parseNotification(row(type, {}));
      assert.ok(n);
      const text = describeNotification(n);
      assert.ok(text.title.length > 0 && text.body.length > 0);
    }
  });
  it('text is returned as plain strings (React escapes them); markup in a title stays text', () => {
    const n = parseNotification(
      row('auction_won', { auctionTitle: '<img src=x onerror=alert(1)>' }),
    );
    assert.ok(n);
    assert.equal(typeof describeNotification(n).title, 'string');
  });
  it('the seller notification distinguishes sold from unsold', () => {
    const sold = parseNotification(
      row('auction_ended', {
        sold: true,
        winnerDisplayName: 'Ann',
        finalPrice: '5.00',
        currency: 'USD',
      }),
    );
    const unsold = parseNotification(row('auction_ended', { sold: false }));
    assert.ok(sold && unsold);
    assert.match(describeNotification(sold).body, /Won by Ann at 5\.00 USD/);
    assert.match(describeNotification(unsold).body, /without any bids/);
  });
});

describe('datetime-local conversion', () => {
  it('round-trips an instant to the minute, in any time zone', () => {
    const iso = '2030-06-15T10:34:00.000Z';
    assert.equal(fromLocalInputValue(toLocalInputValue(iso)), iso);
  });
  it('empty or invalid input is null / empty, never an exception', () => {
    assert.equal(fromLocalInputValue(''), null);
    assert.equal(fromLocalInputValue('garbage'), null);
    assert.equal(toLocalInputValue('garbage'), '');
  });
  it('has the shape the input expects', () => {
    assert.match(toLocalInputValue('2030-06-15T10:34:00.000Z'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
