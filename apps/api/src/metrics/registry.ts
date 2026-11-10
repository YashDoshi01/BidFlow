// A tiny metrics registry that renders the Prometheus text exposition format (version 0.0.4).
//
// Why not a library: the format is small, and writing it shows exactly what a "metric" is: a name,
// a type, labels, and numbers a scraper reads on a schedule. What it deliberately does NOT do:
// no summaries/quantiles (histograms let the scraper compute them across instances), no default
// process metrics beyond what server code adds, no push. Everything here is per process; a
// scraper adds instances together.
//
// Cardinality rule: a label value must come from a SMALL FIXED SET (a route pattern, a status
// class, an outcome name). Never a user id, auction id, token or raw path: every distinct value
// is a new time series held in memory for ever.

export type Labels = Record<string, string>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Stable text for a label set: sorted by name, so the same labels always give the same series. */
function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabelValue(labels[k] as string)}"`)
    .join(',');
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  return String(n);
}

function checkNames(name: string, labelNames: readonly string[]): void {
  if (!NAME.test(name)) throw new Error(`invalid metric name: ${name}`);
  for (const l of labelNames) {
    if (!LABEL_NAME.test(l) || l === 'le') throw new Error(`invalid label name: ${l}`);
  }
}

interface Metric {
  readonly name: string;
  render: () => string[];
}

abstract class Base implements Metric {
  readonly name: string;
  protected readonly help: string;
  protected readonly labelNames: readonly string[];
  protected abstract readonly type: 'counter' | 'gauge' | 'histogram';

  constructor(name: string, help: string, labelNames: readonly string[]) {
    checkNames(name, labelNames);
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  protected labelsOf(labels: Labels | undefined): Labels {
    const given = labels ?? {};
    const keys = Object.keys(given);
    if (keys.length !== this.labelNames.length || !this.labelNames.every((n) => n in given)) {
      throw new Error(`${this.name}: expected labels [${this.labelNames.join(', ')}]`);
    }
    return given;
  }

  protected header(): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`];
  }

  abstract render(): string[];
}

export class Counter extends Base {
  protected readonly type = 'counter' as const;
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  /** Counters only go up. A negative or non-finite increment is a programming error. */
  inc(labels?: Labels, by = 1): void {
    if (!Number.isFinite(by) || by < 0) throw new Error(`${this.name}: bad increment`);
    const l = this.labelsOf(labels);
    const key = seriesKey(l);
    const entry = this.values.get(key);
    if (entry) entry.value += by;
    else this.values.set(key, { labels: { ...l }, value: by });
  }

  get(labels?: Labels): number {
    return this.values.get(seriesKey(this.labelsOf(labels)))?.value ?? 0;
  }

  render(): string[] {
    const lines = this.header();
    if (this.values.size === 0 && this.labelNames.length === 0) lines.push(`${this.name} 0`);
    for (const { labels, value } of this.values.values()) {
      const k = seriesKey(labels);
      lines.push(`${this.name}${k ? `{${k}}` : ''} ${formatNumber(value)}`);
    }
    return lines;
  }
}

export class Gauge extends Base {
  protected readonly type = 'gauge' as const;
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  set(value: number, labels?: Labels): void {
    const l = this.labelsOf(labels);
    this.values.set(seriesKey(l), { labels: { ...l }, value });
  }

  /** Forget every series (a gauge fed by a scrape-time query must not keep stale label sets). */
  reset(): void {
    this.values.clear();
  }

  get(labels?: Labels): number | undefined {
    return this.values.get(seriesKey(this.labelsOf(labels)))?.value;
  }

  render(): string[] {
    const lines = this.header();
    for (const { labels, value } of this.values.values()) {
      const k = seriesKey(labels);
      lines.push(`${this.name}${k ? `{${k}}` : ''} ${formatNumber(value)}`);
    }
    return lines;
  }
}

export class Histogram extends Base {
  protected readonly type = 'histogram' as const;
  private readonly bounds: readonly number[];
  private readonly series = new Map<
    string,
    { labels: Labels; buckets: number[]; sum: number; count: number }
  >();

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
  ) {
    super(name, help, labelNames);
    const sorted = [...buckets].sort((a, b) => a - b);
    if (
      sorted.length === 0 ||
      sorted.some((b, i) => !Number.isFinite(b) || (i > 0 && b === sorted[i - 1]))
    ) {
      throw new Error(`${name}: buckets must be finite and distinct`);
    }
    this.bounds = sorted;
  }

  observe(value: number, labels?: Labels): void {
    if (!Number.isFinite(value) || value < 0) return; // a clock glitch must not poison the sum
    const l = this.labelsOf(labels);
    const key = seriesKey(l);
    let s = this.series.get(key);
    if (!s) {
      s = {
        labels: { ...l },
        buckets: new Array<number>(this.bounds.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, s);
    }
    // Buckets are cumulative in the output; store per-bucket counts and accumulate when rendering.
    const i = this.bounds.findIndex((b) => value <= b);
    if (i >= 0) (s.buckets[i] as number) += 1;
    s.sum += value;
    s.count += 1;
  }

  count(labels?: Labels): number {
    return this.series.get(seriesKey(this.labelsOf(labels)))?.count ?? 0;
  }

  render(): string[] {
    const lines = this.header();
    for (const s of this.series.values()) {
      const base = seriesKey(s.labels);
      const withLe = (le: string): string => `{${base ? `${base},` : ''}le="${le}"}`;
      let cumulative = 0;
      this.bounds.forEach((b, i) => {
        cumulative += s.buckets[i] as number;
        lines.push(`${this.name}_bucket${withLe(formatNumber(b))} ${String(cumulative)}`);
      });
      lines.push(`${this.name}_bucket${withLe('+Inf')} ${String(s.count)}`);
      const plain = base ? `{${base}}` : '';
      lines.push(`${this.name}_sum${plain} ${formatNumber(s.sum)}`);
      lines.push(`${this.name}_count${plain} ${String(s.count)}`);
    }
    return lines;
  }
}

/** Runs at scrape time, just before rendering (for values that are read, not counted). */
export type Collector = () => void | Promise<void>;

export class Registry {
  private readonly metrics = new Map<string, Metric>();
  private readonly collectors: Collector[] = [];

  private add<T extends Metric>(metric: T): T {
    if (this.metrics.has(metric.name)) throw new Error(`duplicate metric: ${metric.name}`);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.add(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.add(new Gauge(name, help, labelNames));
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
  ): Histogram {
    return this.add(new Histogram(name, help, labelNames, buckets));
  }

  onScrape(collector: Collector): void {
    this.collectors.push(collector);
  }

  /** Runs the collectors (a failing one is skipped, never fails the scrape) and renders everything. */
  async render(): Promise<string> {
    await Promise.all(
      this.collectors.map(async (c) => {
        try {
          await c();
        } catch {
          // The collector is responsible for exposing its own "up" value.
        }
      }),
    );
    const lines: string[] = [];
    for (const m of this.metrics.values()) lines.push(...m.render());
    return `${lines.join('\n')}\n`;
  }
}

/** Histogram buckets in seconds for request-style latencies (1 ms .. 10 s). */
export const LATENCY_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
