import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isClockGuardViolation } from './service.ts';

/** A pg-like error: an Error with a SQLSTATE `code`. */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('isClockGuardViolation (ADR-074)', () => {
  it('recognises the clock-guard trigger error', () => {
    assert.equal(
      isClockGuardViolation(
        pgError('23514', 'accepted_at must be taken inside the bid transaction'),
      ),
      true,
    );
  });

  it('does not recognise any other check violation (they stay 500s)', () => {
    for (const message of [
      'bid is outside the auction window',
      'bid_sequence must be the next number for the auction',
      'a seller cannot bid on their own auction',
    ]) {
      assert.equal(isClockGuardViolation(pgError('23514', message)), false, message);
    }
  });

  it('needs the SQLSTATE as well as the text', () => {
    assert.equal(
      isClockGuardViolation(
        pgError('XX000', 'accepted_at must be taken inside the bid transaction'),
      ),
      false,
    );
  });

  it('is false for non-errors', () => {
    assert.equal(isClockGuardViolation(undefined), false);
    assert.equal(
      isClockGuardViolation('accepted_at must be taken inside the bid transaction'),
      false,
    );
  });
});
