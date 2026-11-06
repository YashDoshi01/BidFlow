import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANTI_SNIPING_WINDOW_MS,
  EXTENSION_MS,
  MAX_EXTENSIONS,
  MAX_TOTAL_EXTENSION_MS,
  computeExtension,
} from './antiSniping.ts';

const T0 = Date.UTC(2030, 0, 1, 12, 0, 0); // the seller's end time
const MIN = 60_000;

const input = (over: Partial<Parameters<typeof computeExtension>[0]> = {}) => ({
  nowMs: T0 - 30_000,
  endsAtMs: T0,
  originalEndsAtMs: T0,
  extensionCount: 0,
  ...over,
});

describe('the anti-sniping policy (product rule 13)', () => {
  it('the numbers are the documented ones', () => {
    assert.equal(ANTI_SNIPING_WINDOW_MS, 2 * MIN);
    assert.equal(EXTENSION_MS, 2 * MIN);
    assert.equal(MAX_EXTENSIONS, 10);
    assert.equal(MAX_TOTAL_EXTENSION_MS, 60 * MIN);
  });

  it('extends a bid in the last 2 minutes to bid time + 2 minutes', () => {
    const now = T0 - 30_000;
    assert.deepEqual(computeExtension(input({ nowMs: now })), {
      extend: true,
      newEndsAtMs: now + 2 * MIN,
      extensionCount: 1,
    });
  });

  it('the window edge: 1 ms inside the window extends; exactly 2 minutes out gains nothing; earlier is out of the window', () => {
    const inside = computeExtension(input({ nowMs: T0 - 2 * MIN + 1 }));
    assert.deepEqual(inside, { extend: true, newEndsAtMs: T0 + 1, extensionCount: 1 });
    // now + 2 minutes == ends_at: the end would not move, so there is no extension and no event.
    assert.deepEqual(computeExtension(input({ nowMs: T0 - 2 * MIN })), {
      extend: false,
      reason: 'no-gain',
    });
    assert.deepEqual(computeExtension(input({ nowMs: T0 - 2 * MIN - 1 })), {
      extend: false,
      reason: 'not-in-window',
    });
  });

  it('the last millisecond still extends; at ends_at or later it never does (boundary rule 12)', () => {
    assert.equal(computeExtension(input({ nowMs: T0 - 1 })).extend, true);
    assert.deepEqual(computeExtension(input({ nowMs: T0 })), {
      extend: false,
      reason: 'already-over',
    });
    assert.deepEqual(computeExtension(input({ nowMs: T0 + 5000 })), {
      extend: false,
      reason: 'already-over',
    });
  });

  it('counts extensions and stops after the 10th', () => {
    const ninth = computeExtension(input({ extensionCount: 9 }));
    assert.deepEqual(ninth, {
      extend: true,
      newEndsAtMs: T0 - 30_000 + 2 * MIN,
      extensionCount: 10,
    });
    assert.deepEqual(computeExtension(input({ extensionCount: 10 })), {
      extend: false,
      reason: 'extension-limit',
    });
    assert.deepEqual(computeExtension(input({ extensionCount: 11 })), {
      extend: false,
      reason: 'extension-limit',
    });
  });

  it('never moves the end beyond the original end + 1 hour: clamps, then stops', () => {
    const cap = T0 + 60 * MIN;
    // 59 minutes in: a normal extension would reach +61 min, so it is clamped to the cap.
    const now = T0 + 59 * MIN;
    const clamped = computeExtension(
      input({ nowMs: now, endsAtMs: now + 30_000, extensionCount: 4 }),
    );
    assert.deepEqual(clamped, { extend: true, newEndsAtMs: cap, extensionCount: 5 });
    // Already at the cap: nothing to extend, the bid is simply accepted.
    assert.deepEqual(
      computeExtension(input({ nowMs: cap - 10_000, endsAtMs: cap, extensionCount: 5 })),
      { extend: false, reason: 'no-gain' },
    );
  });

  it('is decided by the original end time, not the current one', () => {
    // The auction was extended to T0 + 50 min; the cap is still T0 + 60 min.
    const endsAt = T0 + 50 * MIN;
    const result = computeExtension({
      nowMs: endsAt - 10_000,
      endsAtMs: endsAt,
      originalEndsAtMs: T0,
      extensionCount: 3,
    });
    assert.deepEqual(result, {
      extend: true,
      newEndsAtMs: endsAt - 10_000 + 2 * MIN,
      extensionCount: 4,
    });
  });
});
