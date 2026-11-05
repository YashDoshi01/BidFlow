import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger, redact } from './logger.ts';

describe('logger', () => {
  it('writes one JSON object per line with time, level and msg', () => {
    const lines: string[] = [];
    createLogger('info', (l) => lines.push(l)).info('hello', { requestId: 'r1' });
    const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    assert.equal(entry['msg'], 'hello');
    assert.equal(entry['level'], 'info');
    assert.equal(entry['requestId'], 'r1');
    assert.ok(typeof entry['time'] === 'string');
  });

  it('adds the base fields (the instance id) to every line, and redacts them too', () => {
    const lines: string[] = [];
    const log = createLogger('info', (line) => lines.push(line), {
      instance: 'api1',
      apiKey: 'sk-1',
    });
    log.info('a');
    log.warn('b', { requestId: 'r' });
    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      assert.equal(entry['instance'], 'api1');
      assert.equal(entry['apiKey'], '[redacted]');
    }
    assert.ok(!lines.join('').includes('sk-1'));
  });

  it('honours the level threshold', () => {
    const lines: string[] = [];
    const log = createLogger('warn', (l) => lines.push(l));
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    assert.equal(lines.length, 2);
  });

  it('redacts sensitive keys at any depth, including inside arrays', () => {
    const out = JSON.stringify(
      redact({
        password: 'p1',
        nested: { token: 't1', Authorization: 'Bearer a', ok: 'visible' },
        list: [{ passwordHash: 'h1' }, { apiKey: 'k1' }, { cookie: 'c1' }],
      }),
    );
    for (const secret of ['p1', 't1', 'Bearer a', 'h1', 'k1', 'c1']) {
      assert.ok(!out.includes(secret), secret);
    }
    assert.ok(out.includes('visible'));
  });
});
