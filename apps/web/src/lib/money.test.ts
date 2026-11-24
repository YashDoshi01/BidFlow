import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromCents, groupThousands, quickBids, toCents } from './money.ts';

describe('toCents / fromCents', () => {
  it('round-trips without floating point', () => {
    assert.equal(toCents('13.50'), 1350);
    assert.equal(toCents('13.5'), 1350);
    assert.equal(toCents('13'), 1300);
    assert.equal(toCents('0.07'), 7);
    assert.equal(fromCents(1350), '13.50');
    assert.equal(fromCents(7), '0.07');
    // 0.1 + 0.2 is the classic float trap; cents avoid it.
    assert.equal(fromCents((toCents('0.10') ?? 0) + (toCents('0.20') ?? 0)), '0.30');
  });
  it('refuses malformed input', () => {
    for (const bad of ['', 'abc', '-1.00', '1.234', '1e3', '12345678901']) {
      assert.equal(toCents(bad), null, bad);
    }
  });
});

describe('quickBids', () => {
  it('suggests the minimum, plus one increment, plus five', () => {
    assert.deepEqual(quickBids('13.50', '1.00'), ['13.50', '14.50', '18.50']);
    assert.deepEqual(quickBids('25.00', '2.50'), ['25.00', '27.50', '37.50']);
  });
  it('suggests nothing when no bid is possible or the data is malformed', () => {
    assert.deepEqual(quickBids(null, '1.00'), []);
    assert.deepEqual(quickBids('13.50', '0.00'), []);
    assert.deepEqual(quickBids('x', '1.00'), []);
  });
});

describe('groupThousands', () => {
  it('groups the whole part only', () => {
    assert.equal(groupThousands('1234567.50'), '1,234,567.50');
    assert.equal(groupThousands('999.00'), '999.00');
    assert.equal(groupThousands('1000'), '1,000');
  });
});
