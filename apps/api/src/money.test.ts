import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addMoney,
  compareMoney,
  fromMinorUnits,
  isMoney,
  normalizeMoney,
  toMinorUnits,
} from './money.ts';

describe('money', () => {
  it('parses to exact minor units', () => {
    assert.equal(toMinorUnits('0.10'), 10n);
    assert.equal(toMinorUnits('0.1'), 10n);
    assert.equal(toMinorUnits('125'), 12500n);
    assert.equal(toMinorUnits('9999999999.99'), 999_999_999_999n);
  });

  it('is exact where floating point is not', () => {
    assert.notEqual(0.1 + 0.2, 0.3); // the problem being avoided
    assert.equal(addMoney('0.10', '0.20'), '0.30');
    assert.equal(addMoney('1.15', '2.30'), '3.45');
    assert.equal(compareMoney('0.30', addMoney('0.1', '0.2') as string), 0);
  });

  it('normalises to two decimals', () => {
    assert.equal(normalizeMoney('125'), '125.00');
    assert.equal(normalizeMoney('125.5'), '125.50');
    assert.equal(normalizeMoney('0.05'), '0.05');
    assert.equal(normalizeMoney('007'), '7.00');
  });

  it('compares numerically, not as text', () => {
    assert.equal(compareMoney('9.00', '10.00'), -1);
    assert.equal(compareMoney('10.00', '9.99'), 1);
    assert.equal(compareMoney('10', '10.00'), 0);
  });

  it('refuses a result that would not fit NUMERIC(12,2)', () => {
    assert.equal(addMoney('9999999999.99', '0.01'), undefined);
    assert.equal(fromMinorUnits(-1n), undefined);
    assert.equal(fromMinorUnits(1_000_000_000_000n), undefined);
  });

  it('isMoney rejects everything that is not a plain decimal', () => {
    for (const bad of [
      '',
      '-1',
      '1e3',
      '1.234',
      ' 1',
      '1 ',
      '1,5',
      '.5',
      '5.',
      '12345678901',
      'NaN',
    ]) {
      assert.equal(isMoney(bad), false, bad);
    }
    for (const good of ['0', '0.0', '1', '1.5', '1.50', '9999999999.99']) {
      assert.equal(isMoney(good), true, good);
    }
  });
});
