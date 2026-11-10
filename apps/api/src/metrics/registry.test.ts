import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Registry } from './registry.ts';

describe('metrics registry', () => {
  it('renders a counter in the Prometheus text format, with help and type', async () => {
    const r = new Registry();
    const c = r.counter('jobs_total', 'Jobs done.', ['kind']);
    c.inc({ kind: 'a' });
    c.inc({ kind: 'a' }, 2);
    c.inc({ kind: 'b' });
    const text = await r.render();
    assert.match(text, /# HELP jobs_total Jobs done\./);
    assert.match(text, /# TYPE jobs_total counter/);
    assert.match(text, /jobs_total\{kind="a"\} 3/);
    assert.match(text, /jobs_total\{kind="b"\} 1/);
  });

  it('a counter without labels starts at 0 and never goes down', async () => {
    const r = new Registry();
    const c = r.counter('x_total', 'x');
    assert.match(await r.render(), /^x_total 0$/m);
    assert.throws(() => {
      c.inc(undefined, -1);
    });
    assert.throws(() => {
      c.inc(undefined, Number.NaN);
    });
    assert.equal(c.get(), 0);
  });

  it('refuses wrong or missing labels (a typo must not create a new series)', () => {
    const r = new Registry();
    const c = r.counter('y_total', 'y', ['route']);
    assert.throws(() => {
      c.inc({ rout: 'x' });
    });
    assert.throws(() => {
      c.inc({});
    });
    assert.throws(() => {
      c.inc({ route: 'a', extra: 'b' });
    });
  });

  it('escapes label values so a hostile value cannot break the output', async () => {
    const r = new Registry();
    const c = r.counter('z_total', 'z', ['v']);
    c.inc({ v: 'a"b\\c\nd' });
    const text = await r.render();
    assert.match(text, /z_total\{v="a\\"b\\\\c\\nd"\} 1/);
    assert.equal(text.split('\n').filter((l) => l.startsWith('z_total{')).length, 1);
  });

  it('histogram: cumulative buckets, +Inf, sum and count', async () => {
    const r = new Registry();
    const h = r.histogram('lat_seconds', 'Latency.', [], [0.1, 1]);
    h.observe(0.05);
    h.observe(0.5);
    h.observe(5);
    const text = await r.render();
    assert.match(text, /lat_seconds_bucket\{le="0\.1"\} 1/);
    assert.match(text, /lat_seconds_bucket\{le="1"\} 2/);
    assert.match(text, /lat_seconds_bucket\{le="\+Inf"\} 3/);
    assert.match(text, /lat_seconds_sum 5\.55/);
    assert.match(text, /lat_seconds_count 3/);
  });

  it('histogram with labels keeps the label next to le; negative and NaN observations are ignored', async () => {
    const r = new Registry();
    const h = r.histogram('l2_seconds', 'x', ['route'], [1]);
    h.observe(0.5, { route: '/a' });
    h.observe(-1, { route: '/a' });
    h.observe(Number.NaN, { route: '/a' });
    const text = await r.render();
    assert.match(text, /l2_seconds_bucket\{route="\/a",le="1"\} 1/);
    assert.match(text, /l2_seconds_count\{route="\/a"\} 1/);
  });

  it('a gauge can be set, and reset drops stale series', async () => {
    const r = new Registry();
    const g = r.gauge('depth', 'd', ['q']);
    g.set(3, { q: 'a' });
    g.reset();
    g.set(1, { q: 'b' });
    const text = await r.render();
    assert.ok(!text.includes('q="a"'));
    assert.match(text, /depth\{q="b"\} 1/);
  });

  it('rejects duplicate names and invalid names', () => {
    const r = new Registry();
    r.counter('dup_total', 'x');
    assert.throws(() => r.counter('dup_total', 'x'));
    assert.throws(() => r.counter('bad name', 'x'));
    assert.throws(() => r.counter('ok_total', 'x', ['le']));
  });

  it('runs scrape collectors, and a failing collector does not fail the scrape', async () => {
    const r = new Registry();
    const g = r.gauge('fresh', 'f');
    r.onScrape(() => {
      g.set(42);
    });
    r.onScrape(() => {
      throw new Error('boom');
    });
    r.onScrape(() => Promise.reject(new Error('async boom')));
    assert.match(await r.render(), /^fresh 42$/m);
  });
});
