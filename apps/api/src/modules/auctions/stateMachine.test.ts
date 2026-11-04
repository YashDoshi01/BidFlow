import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUCTION_STATUSES,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  canTransition,
  publishTarget,
  validateSchedule,
} from './stateMachine.ts';

describe('auction state machine', () => {
  it('allows exactly the documented transitions', () => {
    const allowed = new Set([
      'DRAFT>SCHEDULED',
      'DRAFT>LIVE',
      'DRAFT>CANCELLED',
      'SCHEDULED>LIVE',
      'SCHEDULED>CANCELLED',
      'LIVE>ENDED',
      'LIVE>CANCELLED',
    ]);
    for (const from of AUCTION_STATUSES) {
      for (const to of AUCTION_STATUSES) {
        assert.equal(canTransition(from, to), allowed.has(`${from}>${to}`), `${from} -> ${to}`);
      }
    }
  });
});

describe('validateSchedule (product rule 14)', () => {
  const start = new Date('2030-01-01T00:00:00Z');
  const at = (ms: number): Date => new Date(start.getTime() + ms);

  it('accepts the inclusive bounds and rejects just outside them', () => {
    assert.equal(validateSchedule(start, at(MIN_DURATION_MS)), undefined);
    assert.equal(validateSchedule(start, at(MAX_DURATION_MS)), undefined);
    assert.ok(validateSchedule(start, at(MIN_DURATION_MS - 1)));
    assert.ok(validateSchedule(start, at(MAX_DURATION_MS + 1)));
    assert.ok(validateSchedule(start, at(-1000)));
  });
});

describe('publishTarget', () => {
  const now = new Date('2030-01-01T12:00:00Z');
  const at = (ms: number): Date => new Date(now.getTime() + ms);

  it('schedules a future start, starts a past or present start, refuses an ended window', () => {
    assert.equal(publishTarget(at(1), at(MIN_DURATION_MS), now), 'SCHEDULED');
    assert.equal(publishTarget(at(0), at(MIN_DURATION_MS), now), 'LIVE'); // start == now: already started
    assert.equal(publishTarget(at(-5000), at(MIN_DURATION_MS), now), 'LIVE');
    assert.equal(publishTarget(at(-MIN_DURATION_MS), at(0), now), undefined); // end == now: over
    assert.equal(publishTarget(at(-MIN_DURATION_MS), at(-1), now), undefined);
  });
});
