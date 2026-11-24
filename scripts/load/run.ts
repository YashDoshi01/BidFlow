// Load tests and fault injection against a THROWAWAY cluster (NGINX + 2 API + 2 outbox workers +
// 2 lifecycle workers + PostgreSQL + Redis), the same stack the cluster tests use.
//
//   npm run load                      every scenario, 15 s of load each
//   npm run load -- hot-auction       only the named scenarios
//   npm run load -- --seconds 30 --concurrency 100 --tag pool20 --env DB_POOL_MAX=20
//
// It uses its own Docker project ("bidflow-load"), its own random password and free host ports,
// never reads .env, and removes everything (including the database volume) when it ends.
// It cannot run at the same time as `npm run test:cluster` (both use the fixed subnet of
// infra/compose.cluster.yaml). Raw results go to bench/results/<timestamp>-<tag>/.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { composeRunner, root, startCluster, stopCluster } from '../cluster-lib.ts';
import { writeResult, sleep, type ScenarioResult } from './lib.ts';
import { scenarios, type Ctx } from './scenarios.ts';

const PROJECT = 'bidflow-load';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}`) out.push(process.argv[i + 1] ?? '');
  });
  return out;
}

const seconds = Number(arg('seconds') ?? 15);
const concurrency = Number(arg('concurrency') ?? 50);
const tag = arg('tag') ?? 'base';
const repeat = Number(arg('repeat') ?? 1);
const userEnv = Object.fromEntries(
  args('env').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
);
const wanted = process.argv.slice(2).filter((a, i, all) => {
  if (a.startsWith('--')) return false;
  const before = all[i - 1];
  return before === undefined || !before.startsWith('--');
});
const selected = wanted.length === 0 ? scenarios : scenarios.filter((s) => wanted.includes(s.name));
if (selected.length === 0) {
  console.error(`no such scenario. Available: ${scenarios.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

const password = randomBytes(18).toString('base64url');
const baseEnv: Record<string, string> = {
  API_IMAGE: 'bidflow-api:load-test',
  POSTGRES_USER: 'bidflow_load',
  POSTGRES_PASSWORD: password,
  POSTGRES_DB: 'bidflow_load',
  NGINX_PORT: '',
  // Production defaults for the workers (30 s lease), except the poll interval compose already sets.
  ...userEnv,
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(root, 'bench', 'results', `${stamp}-${tag}`);
mkdirSync(outDir, { recursive: true });

function sh(cmd: string, a: string[]): string {
  try {
    return execFileSync(cmd, a, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

let current: Record<string, string> = { ...baseEnv };
const compose = (...a: string[]): ReturnType<ReturnType<typeof composeRunner>> =>
  composeRunner(PROJECT, current)(...a);

let exitCode = 1;
try {
  console.log('building the API image and starting the load cluster ...');
  const cluster = await startCluster({ project: PROJECT, env: current });
  const nginx = cluster.urls.nginx;
  const getPool = async (): Promise<Pool> => {
    const out = (await compose('port', 'postgres', '5432')).stdout.trim();
    const port = /:(\d+)\s*$/m.exec(out)?.[1];
    if (port === undefined) throw new Error('no published PostgreSQL port');
    const p = new Pool({
      connectionString: `postgres://${baseEnv['POSTGRES_USER'] ?? ''}:${password}@127.0.0.1:${port}/${baseEnv['POSTGRES_DB'] ?? ''}`,
      max: 4,
    });
    p.on('error', () => undefined);
    return p;
  };
  const reconfigure = async (extra: Record<string, string>): Promise<void> => {
    current = { ...baseEnv, ...extra, ...userEnv };
    await compose('up', '-d', '--force-recreate', '--wait', 'api1', 'api2');
    await sleep(7000); // NGINX keeps a restarted instance out of rotation for fail_timeout=5 s
  };

  const info = JSON.parse(sh('docker', ['info', '--format', '{{json .}}']) || '{}') as {
    NCPU?: number;
    MemTotal?: number;
    ServerVersion?: string;
    OperatingSystem?: string;
    KernelVersion?: string;
  };
  writeFileSync(
    path.join(outDir, 'environment.json'),
    JSON.stringify(
      {
        when: new Date().toISOString(),
        gitCommit: sh('git', ['rev-parse', 'HEAD']),
        gitWorkingTreeDirty: sh('git', ['status', '--porcelain']) !== '',
        node: process.version,
        hostOs: `${os.type()} ${os.release()} ${os.arch()}`,
        hostCpu: os.cpus()[0]?.model,
        hostLogicalCpus: os.cpus().length,
        hostMemoryGB: Math.round(os.totalmem() / 2 ** 30),
        docker: {
          server: info.ServerVersion,
          cpus: info.NCPU,
          memBytes: info.MemTotal,
          os: info.OperatingSystem,
          kernel: info.KernelVersion,
        },
        images: {
          postgres: 'postgres:17-alpine',
          redis: 'redis:7-alpine',
          nginx: 'nginx:1.28-alpine',
          api: 'built from this repository (infra/docker/api.Dockerfile)',
        },
        topology:
          'load generator (this process, on the host) -> NGINX -> api1, api2 -> PostgreSQL, Redis; worker1/2 (outbox), scheduler1/2 (lifecycle). No CPU or memory limits on any container.',
        run: {
          seconds,
          concurrency,
          tag,
          repeat,
          scenarios: selected.map((s) => s.name),
          extraEnv: userEnv,
        },
        note: 'The load generator shares the machine with the cluster: results are for THIS machine and workload only.',
      },
      null,
      2,
    ),
  );

  const summary: { scenario: string; run: number; violations: number }[] = [];
  let lastApiEnv = '';
  for (let r = 1; r <= repeat; r += 1) {
    for (const scenario of selected) {
      const wantedEnv = JSON.stringify(scenario.apiEnv);
      if (wantedEnv !== lastApiEnv) {
        console.log(`reconfiguring the API instances for ${scenario.name} ...`);
        await reconfigure(scenario.apiEnv);
        lastApiEnv = wantedEnv;
      }
      const name = repeat > 1 ? `${scenario.name}-run${String(r)}` : scenario.name;
      console.log(`\n=== ${name} (${String(seconds)} s, ${String(concurrency)} clients) ===`);
      const ctx: Ctx = {
        api: `${nginx}/api`,
        nginx,
        seconds,
        concurrency,
        tag: `${tag}${String(r)}`,
        getPool,
        compose,
        reconfigure,
      };
      let result: ScenarioResult;
      try {
        result = await scenario.run(ctx, name);
      } catch (error) {
        result = {
          scenario: name,
          workload: {},
          measured: {},
          violations: [
            `scenario crashed: ${error instanceof Error ? error.message : String(error)}`,
          ],
        };
      }
      // Every error-level log line of the API instances (logs carry ids only, never secrets): an
      // unexpected 5xx in the results must be explainable from here.
      try {
        const lines: string[] = [];
        for (const svc of ['api1', 'api2']) {
          const out = (await compose('logs', '--no-color', '--no-log-prefix', svc)).stdout;
          for (const line of out.split('\n'))
            if (line.includes('"level":"error"')) lines.push(`${svc} ${line}`);
        }
        if (lines.length > 0)
          writeFileSync(path.join(outDir, `${name}.errors.log`), lines.join('\n'));
      } catch {
        // logs unavailable: not fatal
      }
      // Whatever a fault did, the next scenario starts with everything running.
      await compose('start', 'postgres', 'redis', 'api1', 'api2', 'worker1', 'worker2').catch(
        () => undefined,
      );
      await sleep(1500);
      writeResult(outDir, result);
      console.log(
        JSON.stringify(
          { workload: result.workload, measured: stripTimelines(result.measured) },
          null,
          2,
        ),
      );
      console.log(
        result.violations.length === 0
          ? 'INVARIANTS: all held'
          : `INVARIANT VIOLATIONS:\n  ${result.violations.slice(0, 10).join('\n  ')}`,
      );
      summary.push({ scenario: name, run: r, violations: result.violations.length });
    }
  }
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nresults: ${outDir}`);
  exitCode = summary.every((s) => s.violations === 0) ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'load run failed');
} finally {
  try {
    await stopCluster(PROJECT, current, true);
    console.log(`${PROJECT} torn down`);
  } catch (error) {
    console.error(`TEARDOWN FAILED, remove manually: docker compose -p ${PROJECT} down -v`);
    console.error(error instanceof Error ? error.message : '');
  }
}
process.exitCode = exitCode;

/** The console output stays readable: long per-second timelines live in the result files only. */
function stripTimelines(measured: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...measured };
  delete copy['perSecond'];
  delete copy['outboxBacklogTimeline'];
  return copy;
}
