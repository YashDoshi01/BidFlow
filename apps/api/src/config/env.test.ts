import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EnvValidationError, parseEnv } from './env.ts';

const valid = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:55432/db',
  REDIS_URL: 'redis://127.0.0.1:56379',
};

describe('parseEnv', () => {
  it('applies defaults and coerces the port to a number', () => {
    const env = parseEnv({ ...valid, API_PORT: '4000' });
    assert.equal(env.API_PORT, 4000);
    assert.equal(env.NODE_ENV, 'development');
    assert.equal(env.LOG_LEVEL, 'info');
  });

  it('rejects a missing DATABASE_URL and names the variable', () => {
    assert.throws(
      () => parseEnv({ REDIS_URL: valid.REDIS_URL }),
      (error: unknown) =>
        error instanceof EnvValidationError &&
        error.problems.some((p) => p.startsWith('DATABASE_URL')),
    );
  });

  it('rejects an out-of-range port', () => {
    assert.throws(() => parseEnv({ ...valid, API_PORT: '70000' }), EnvValidationError);
    assert.throws(() => parseEnv({ ...valid, API_PORT: 'abc' }), EnvValidationError);
  });

  it('rejects a DATABASE_URL with the wrong scheme', () => {
    assert.throws(
      () => parseEnv({ ...valid, DATABASE_URL: 'http://example.com/db' }),
      EnvValidationError,
    );
  });

  it('never puts the offending value in the error message (secrets)', () => {
    const secretUrl = 'mysql://admin:SuperSecret123@10.0.0.1/db';
    try {
      parseEnv({ ...valid, DATABASE_URL: secretUrl });
      assert.fail('expected parseEnv to throw');
    } catch (error) {
      assert.ok(error instanceof EnvValidationError);
      assert.ok(!error.message.includes('SuperSecret123'));
    }
  });
});
