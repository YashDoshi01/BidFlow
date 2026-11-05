import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postgresPoolCheck, redisStatusCheck, runChecks } from './dependencies.ts';

describe('postgresPoolCheck', () => {
  it('runs SELECT 1 on the shared pool (no new connection per poll)', async () => {
    const queries: string[] = [];
    const check = postgresPoolCheck({
      query: (sql) => {
        queries.push(sql);
        return Promise.resolve({});
      },
    });
    const [result] = await runChecks([check]);
    assert.deepEqual(result, { name: 'postgres', ok: true, critical: true });
    assert.deepEqual(queries, ['SELECT 1']);
  });

  it('is critical and reports a failing pool without leaking the error text', async () => {
    const check = postgresPoolCheck({
      query: () => Promise.reject(new Error('connect ECONNREFUSED postgres://u:secret@db/x')),
    });
    const results = await runChecks([check]);
    assert.equal(results.length, 1);
    assert.deepEqual(
      results.map((x) => [x.ok, x.critical]),
      [[false, true]],
    );
    assert.ok(!JSON.stringify(results).includes('secret'));
  });
});

describe('redisStatusCheck', () => {
  it('is optional (not critical) and follows the live connection state', async () => {
    let up = true;
    const check = redisStatusCheck(() => up);
    const [ok] = await runChecks([check]);
    assert.deepEqual(ok, { name: 'redis', ok: true, critical: false });
    up = false;
    const down = await runChecks([check]);
    assert.deepEqual(
      down.map((x) => [x.ok, x.critical]),
      [[false, false]],
    );
  });
});
