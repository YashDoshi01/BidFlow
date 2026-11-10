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

  it('binds to loopback by default, accepts an explicit host, and validates INSTANCE_ID', () => {
    assert.equal(parseEnv({ ...valid }).API_HOST, '127.0.0.1');
    assert.equal(parseEnv({ ...valid, API_HOST: '0.0.0.0' }).API_HOST, '0.0.0.0');
    assert.equal(parseEnv({ ...valid }).INSTANCE_ID, undefined);
    assert.equal(parseEnv({ ...valid, INSTANCE_ID: 'api-1.eu' }).INSTANCE_ID, 'api-1.eu');
    for (const bad of ['has space', 'a'.repeat(65), 'semi;colon', '']) {
      assert.throws(() => parseEnv({ ...valid, INSTANCE_ID: bad }), EnvValidationError, bad);
    }
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

describe('Phase 8 settings', () => {
  it('have safe defaults: limits on, no proxy trusted, no extra origins, no metrics token', () => {
    const env = parseEnv(valid);
    assert.equal(env.RATE_LIMIT_ENABLED, true);
    assert.equal(env.TRUST_PROXY_HOPS, 0);
    assert.deepEqual(env.ALLOWED_ORIGINS, []);
    assert.equal(env.METRICS_TOKEN, undefined);
    assert.equal(env.RATE_LIMIT_BID_USER_MAX, 20);
  });
  it('parses the boolean and the origin list', () => {
    const env = parseEnv({
      ...valid,
      RATE_LIMIT_ENABLED: 'false',
      ALLOWED_ORIGINS: 'http://localhost:5173, https://app.example',
    });
    assert.equal(env.RATE_LIMIT_ENABLED, false);
    assert.deepEqual(env.ALLOWED_ORIGINS, ['http://localhost:5173', 'https://app.example']);
  });
  it('rejects an origin with a path, a bad boolean, a short metrics token, absurd hop counts', () => {
    assert.throws(
      () => parseEnv({ ...valid, ALLOWED_ORIGINS: 'http://a.example/x' }),
      EnvValidationError,
    );
    assert.throws(() => parseEnv({ ...valid, ALLOWED_ORIGINS: '*' }), EnvValidationError);
    assert.throws(() => parseEnv({ ...valid, RATE_LIMIT_ENABLED: 'yes' }), EnvValidationError);
    assert.throws(() => parseEnv({ ...valid, METRICS_TOKEN: 'short' }), EnvValidationError);
    assert.throws(() => parseEnv({ ...valid, TRUST_PROXY_HOPS: '99' }), EnvValidationError);
  });
  it('the metrics token never appears in an error message', () => {
    try {
      parseEnv({ ...valid, METRICS_TOKEN: 'tooshort', API_PORT: 'x' });
      assert.fail('expected a throw');
    } catch (error) {
      assert.ok(error instanceof EnvValidationError);
      assert.ok(!error.message.includes('tooshort'));
    }
  });
});
