import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../logging/logger.ts';
import { runWithLogContext } from '../logging/context.ts';
import { isOriginAllowed } from './security.ts';

describe('isOriginAllowed (WebSocket origin policy)', () => {
  const host = 'bidflow.example:8443';

  it('no Origin header (not a browser): allowed', () => {
    assert.equal(isOriginAllowed(undefined, host, []), true);
  });
  it('the page served by this very host: allowed, scheme either way, host compared case-insensitively', () => {
    assert.equal(isOriginAllowed('https://bidflow.example:8443', host, []), true);
    assert.equal(isOriginAllowed('http://BIDFLOW.example:8443', host, []), true);
  });
  it('a different site, a different port, a subdomain: refused', () => {
    assert.equal(isOriginAllowed('https://evil.example', host, []), false);
    assert.equal(isOriginAllowed('https://bidflow.example:9999', host, []), false);
    assert.equal(isOriginAllowed('https://x.bidflow.example:8443', host, []), false);
    assert.equal(isOriginAllowed('https://bidflow.example.evil.com', host, []), false);
  });
  it('an origin that merely CONTAINS the host is not the host', () => {
    assert.equal(isOriginAllowed('https://evil.example/?bidflow.example:8443', host, []), false);
    assert.equal(isOriginAllowed('https://bidflow.example:8443.evil.example', host, []), false);
  });
  it('"null", garbage and non-http schemes: refused', () => {
    assert.equal(isOriginAllowed('null', host, []), false);
    assert.equal(isOriginAllowed('not a url', host, []), false);
    assert.equal(isOriginAllowed('file:///etc/passwd', host, []), false);
    assert.equal(isOriginAllowed('chrome-extension://abc', host, []), false);
  });
  it('an explicitly listed origin is allowed, exact match only', () => {
    const allowed = ['http://localhost:5173'];
    assert.equal(isOriginAllowed('http://localhost:5173', host, allowed), true);
    assert.equal(isOriginAllowed('http://localhost:5174', host, allowed), false);
    assert.equal(isOriginAllowed('https://localhost:5173', host, allowed), false);
  });
  it('a missing Host header allows only listed origins', () => {
    assert.equal(isOriginAllowed('https://a.example', undefined, []), false);
    assert.equal(isOriginAllowed('https://a.example', undefined, ['https://a.example']), true);
  });
});

describe('log context', () => {
  it('adds the request fields to a log line written deep inside the request', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger('debug', (l) =>
      lines.push(JSON.parse(l) as Record<string, unknown>),
    );
    await runWithLogContext({ requestId: 'req-1' }, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 5));
      logger.info('deep');
    });
    assert.equal(lines[0]?.['requestId'], 'req-1');
  });

  it("concurrent requests never see each other's context", async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger('debug', (l) =>
      lines.push(JSON.parse(l) as Record<string, unknown>),
    );
    const work = (id: string, delay: number) =>
      runWithLogContext({ requestId: id }, async () => {
        await new Promise((r) => setTimeout(r, delay));
        logger.info('x', { who: id });
      });
    await Promise.all([work('a', 20), work('b', 5), work('c', 10)]);
    for (const l of lines) assert.equal(l['requestId'], l['who']);
    assert.equal(lines.length, 3);
  });

  it('outside any request there is no requestId; context fields are redacted like any field', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger('debug', (l) =>
      lines.push(JSON.parse(l) as Record<string, unknown>),
    );
    logger.info('outside');
    runWithLogContext({ authorization: 'Bearer secret-token-value' }, () => {
      logger.info('inside');
    });
    assert.equal(lines[0]?.['requestId'], undefined);
    assert.equal(lines[1]?.['authorization'], '[redacted]');
  });
});
