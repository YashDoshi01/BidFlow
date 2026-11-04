import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, verifyPassword } from './passwords.ts';
import { hashToken } from './service.ts';

describe('passwords', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    assert.equal(await verifyPassword('correct horse battery', hash), true);
    assert.equal(await verifyPassword('correct horse batterz', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  it('salts: the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password!!'),
      hashPassword('same password!!'),
    ]);
    assert.notEqual(a, b);
  });

  it('never contains the password and records its parameters', async () => {
    const hash = await hashPassword('super secret value');
    assert.ok(!hash.includes('super secret value'));
    assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  });

  it('returns false (does not throw) for malformed stored hashes', async () => {
    for (const bad of [
      '',
      'plain',
      'scrypt$1$2',
      'bcrypt$1$1$1$a$b',
      'scrypt$x$8$1$AAAA$AAAA',
      'scrypt$16384$8$1$AAAA$AAAA',
    ]) {
      assert.equal(await verifyPassword('anything', bad), false, bad);
    }
  });

  it('refuses stored parameters large enough to exhaust memory', async () => {
    assert.equal(
      await verifyPassword('x', `scrypt$${String(2 ** 25)}$8$1$AAAA$${'A'.repeat(86)}`),
      false,
    );
  });
});

describe('session token hashing', () => {
  it('is deterministic, hex, and not the token', () => {
    const token = 'abc'.repeat(15);
    assert.equal(hashToken(token), hashToken(token));
    assert.match(hashToken(token), /^[0-9a-f]{64}$/);
    assert.notEqual(hashToken(token), token);
    assert.notEqual(hashToken(token), hashToken(`${token}x`));
  });
});
