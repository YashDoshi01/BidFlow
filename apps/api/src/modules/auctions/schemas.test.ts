import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../http/errors.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { createAuctionSchema, listQuerySchema, updateAuctionSchema } from './schemas.ts';

const base = {
  title: 'Lamp',
  startingPrice: '10.00',
  startsAt: '2030-01-01T00:00:00Z',
  endsAt: '2030-01-01T01:00:00Z',
};

describe('createAuctionSchema', () => {
  it('applies defaults', () => {
    const v = createAuctionSchema.parse(base);
    assert.equal(v.minimumIncrement, '1.00');
    assert.equal(v.currency, 'USD');
    assert.equal(v.description, '');
  });

  it('accepts only decimal strings for money', () => {
    const bad = [10, '10.123', '0', '0.00', '-1', '1e3', ' 10', '10,5', '', '12345678901'];
    for (const startingPrice of bad) {
      assert.equal(
        createAuctionSchema.safeParse({ ...base, startingPrice }).success,
        false,
        String(startingPrice),
      );
    }
    for (const startingPrice of ['0.01', '1', '10.5', '9999999999.99']) {
      assert.equal(
        createAuctionSchema.safeParse({ ...base, startingPrice }).success,
        true,
        startingPrice,
      );
    }
  });

  it('rejects unknown keys such as sellerId, status and currentPrice', () => {
    for (const key of ['sellerId', 'status', 'currentPrice', 'id']) {
      assert.equal(createAuctionSchema.safeParse({ ...base, [key]: 'x' }).success, false, key);
    }
  });

  it('requires timestamps with an explicit offset', () => {
    assert.equal(
      createAuctionSchema.safeParse({ ...base, startsAt: '2030-01-01T00:00:00' }).success,
      false,
    );
    assert.equal(
      createAuctionSchema.safeParse({ ...base, startsAt: '2030-01-01T00:00:00+05:30' }).success,
      true,
    );
  });
});

describe('updateAuctionSchema', () => {
  it('needs at least one known field', () => {
    assert.equal(updateAuctionSchema.safeParse({}).success, false);
    assert.equal(updateAuctionSchema.safeParse({ title: 'x' }).success, true);
    assert.equal(updateAuctionSchema.safeParse({ status: 'LIVE' }).success, false);
  });
});

describe('listQuerySchema', () => {
  it('defaults the limit and bounds it to 1..50', () => {
    assert.equal(listQuerySchema.parse({}).limit, 20);
    assert.equal(listQuerySchema.safeParse({ limit: '50' }).success, true);
    assert.equal(listQuerySchema.safeParse({ limit: '51' }).success, false);
    assert.equal(listQuerySchema.safeParse({ limit: '0' }).success, false);
    assert.equal(listQuerySchema.safeParse({ limit: '2.5' }).success, false);
  });
});

describe('cursor', () => {
  it('round-trips and rejects garbage with a 400', () => {
    assert.equal(decodeCursor(encodeCursor('12345678901234567')), '12345678901234567');
    for (const bad of [
      '',
      '!!',
      Buffer.from('{"s":"abc"}').toString('base64url'),
      Buffer.from('{"s":1}').toString('base64url'),
      Buffer.from('null').toString('base64url'),
    ]) {
      assert.throws(
        () => decodeCursor(bad),
        (e: unknown) => e instanceof AppError && e.status === 400,
        bad,
      );
    }
  });
});
