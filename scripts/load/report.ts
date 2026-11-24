// Prints markdown tables from bench/results/*: the ONLY source of the numbers quoted in the docs.
//   npm run load:report                 every results folder
//   npm run load:report -- base pool20  only folders whose name contains one of these words
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', 'bench', 'results');
const filters = process.argv.slice(2);

interface Latency {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  count: number;
}
interface Result {
  scenario: string;
  measured: Record<string, unknown>;
  violations: string[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] ?? Number.NaN;
};
const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);
const show = (v: unknown): string => (typeof v === 'number' ? String(v) : '-');
const lat = (v: unknown): Latency => v as Latency;

for (const folder of readdirSync(root).sort()) {
  if (filters.length > 0 && !filters.some((f) => folder.includes(f))) continue;
  const files = readdirSync(path.join(root, folder)).filter(
    (f) =>
      f.endsWith('.json') &&
      !f.endsWith('.raw.json') &&
      f !== 'environment.json' &&
      f !== 'summary.json',
  );
  if (files.length === 0) continue;
  const results: Result[] = files.map(
    (f) => JSON.parse(readFileSync(path.join(root, folder, f), 'utf8')) as Result,
  );
  console.log(`\n### ${folder}\n`);
  console.log(
    '| scenario | req/s | accepted/s | p50 ms | p95 ms | p99 ms | max ms | accepted p50 / p95 / p99 ms | violations |',
  );
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |');
  for (const r of results) {
    const m = r.measured;
    const all = (m['latencyAllMs'] ?? m['latencyMs']) as Latency | undefined;
    const acc = m['latencyAcceptedMs'] as Latency | undefined;
    if (all === undefined) continue;
    console.log(
      `| ${r.scenario} | ${String(num(m['requestsPerSecond']))} | ${m['acceptedPerSecond'] === undefined ? '-' : String(num(m['acceptedPerSecond']))} | ${String(all.p50)} | ${String(all.p95)} | ${String(all.p99)} | ${String(all.max)} | ${acc === undefined ? '-' : `${String(acc.p50)} / ${String(acc.p95)} / ${String(acc.p99)}`} | ${String(r.violations.length)} |`,
    );
  }
  // Repeated runs: the median of each metric over `-runN` results of the same scenario.
  const groups = new Map<string, Result[]>();
  for (const r of results) {
    const base = r.scenario.replace(/-run\d+$/, '');
    if (base !== r.scenario) groups.set(base, [...(groups.get(base) ?? []), r]);
  }
  for (const [base, runs] of groups) {
    const rps = runs.map((r) => num(r.measured['requestsPerSecond']));
    const aps = runs.map((r) => num(r.measured['acceptedPerSecond']));
    const p99 = runs.map((r) => lat(r.measured['latencyAllMs'] ?? r.measured['latencyMs']).p99);
    console.log(
      `\n${base}: ${String(runs.length)} runs; req/s min ${String(Math.min(...rps))} median ${String(median(rps))} max ${String(Math.max(...rps))}` +
        (Number.isNaN(aps[0])
          ? ''
          : `; accepted/s min ${String(Math.min(...aps))} median ${String(median(aps))} max ${String(Math.max(...aps))}`) +
        `; p99 ms median ${String(median(p99))}`,
    );
  }
  // Fault scenarios: the fields that show what happened.
  for (const r of results) {
    const m = r.measured;
    if (m['totalRetryAttempts'] === undefined && m['clientsThatReconnected'] === undefined)
      continue;
    const backlog = (m['outboxBacklogTimeline'] as { pending: number }[] | undefined)?.map(
      (p) => p.pending,
    );
    console.log(
      `\n${r.scenario}: accepted ${String(m['acceptedBids'])} = database ${String(m['bidsInDatabase'])}; ` +
        `requests needing a retry ${show(m['requestsThatNeededARetry'])}, retry attempts ${show(m['totalRetryAttempts'])}, gave up ${show(m['requestsThatGaveUp'])}; ` +
        `slowest ${show(m['slowestRequestMs'])} ms; max outbox backlog ${backlog === undefined ? '-' : String(Math.max(...backlog))}; ` +
        `all events published ${show(m['msFromEndOfLoadUntilEveryEventPublished'])} ms after the load ended; ` +
        `publication delay p50/p99/max ${JSON.stringify([lat(m['outboxPublicationDelayMs'] ?? {}).p50, lat(m['outboxPublicationDelayMs'] ?? {}).p99, lat(m['outboxPublicationDelayMs'] ?? {}).max])}; ` +
        `violations ${String(r.violations.length)}`,
    );
  }
}
