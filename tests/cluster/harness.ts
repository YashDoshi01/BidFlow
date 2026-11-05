/* eslint-disable @typescript-eslint/no-explicit-any -- test helper: readiness bodies are asserted field by field */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { TestSocket } from '../integration/realtime-helpers.ts';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const composeFile = path.join(root, 'infra', 'compose.cluster.yaml');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run: npm run test:cluster`);
  return value;
}

export const urls = {
  nginx: required('CLUSTER_NGINX_URL'),
  api1: required('CLUSTER_API1_URL'),
  api2: required('CLUSTER_API2_URL'),
};
export type InstanceName = 'api1' | 'api2';

/**
 * The host URL of one instance's published port. Docker may give a container a NEW host port
 * when it restarts (observed), so this asks every time instead of using the value from startup.
 */
export async function directUrl(name: InstanceName): Promise<string> {
  const out = (await compose('port', name, '3000')).trim();
  const match = /:(\d+)\s*$/m.exec(out);
  if (!match?.[1]) throw new Error(`no published port for ${name}`);
  return `http://127.0.0.1:${match[1]}`;
}
export const databaseUrl = required('TEST_DATABASE_URL');

/** `docker compose` for the cluster test project only. Variables come from the environment. */
export async function compose(...args: string[]): Promise<string> {
  const { stdout } = await run(
    'docker',
    ['compose', '-p', required('CLUSTER_PROJECT'), '-f', composeFile, ...args],
    { cwd: root, env: process.env, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

export interface LogLine {
  instance?: string;
  msg?: string;
  socketId?: string;
  source?: string;
  [key: string]: unknown;
}

/** Parsed JSON log lines of one service (non-JSON lines, such as Docker's own, are skipped). */
export async function logsOf(service: string): Promise<LogLine[]> {
  const out = await compose('logs', '--no-color', '--no-log-prefix', service);
  const lines: LogLine[] = [];
  for (const raw of out.split('\n')) {
    const text = raw.trim();
    if (!text.startsWith('{')) continue;
    try {
      lines.push(JSON.parse(text) as LogLine);
    } catch {
      // a partial line; ignore
    }
  }
  return lines;
}

/** Which API instance holds this socket? Answered from the instances' own logs. */
export async function instanceHolding(socketId: string): Promise<InstanceName | undefined> {
  const [one, two] = await Promise.all([logsOf('api1'), logsOf('api2')]);
  const onOne = one.some((l) => l.msg === 'socket connected' && l.socketId === socketId);
  const onTwo = two.some((l) => l.msg === 'socket connected' && l.socketId === socketId);
  if (onOne && onTwo) throw new Error('a socket id appears on both instances');
  return onOne ? 'api1' : onTwo ? 'api2' : undefined;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  ms = 30_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/**
 * Opens sockets through NGINX until one lives on each instance (the balancer decides where a
 * connection goes; the instance logs say where it went). Returns them keyed by instance.
 */
export async function socketsOnBothInstances(
  token?: string,
): Promise<{ api1: TestSocket; api2: TestSocket; spare: TestSocket[] }> {
  const found: Partial<Record<InstanceName, TestSocket>> = {};
  const spare: TestSocket[] = [];
  for (let attempt = 0; attempt < 12 && !(found.api1 && found.api2); attempt += 1) {
    const socket = await TestSocket.connect(urls.nginx, token);
    let where: InstanceName | undefined;
    await until(
      'the socket shows up in an instance log',
      async () => {
        where = await instanceHolding(socket.socket.id ?? '');
        return where !== undefined;
      },
      10_000,
    );
    if (where && !found[where]) found[where] = socket;
    else spare.push(socket);
  }
  if (!found.api1 || !found.api2) throw new Error('could not get a socket on each instance');
  return { api1: found.api1, api2: found.api2, spare };
}

/** When did this service's container last start? A changed value means the process was restarted. */
export async function startedAt(service: string): Promise<string> {
  const id = (await compose('ps', '-q', service)).trim();
  const { stdout } = await run('docker', ['inspect', '-f', '{{.State.StartedAt}}', id]);
  return stdout.trim();
}

/** Waits until the instance behind NGINX or directly answers readiness with this status. */
export async function readiness(url: string): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(8000) });
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: 0, body: undefined };
  }
}

/**
 * After a container restarts, NGINX keeps it out of rotation for a few seconds (passive failure
 * detection: max_fails=2 fail_timeout=5s in nginx.conf), so for a moment every NEW connection
 * lands on the other instance. Tests that need both instances wait for that window to pass.
 *
 * This deliberately does NOT probe "do both instances answer HTTP through NGINX": with
 * least_conn, short requests all go to the instance with FEWER open connections, so while
 * WebSockets are unevenly spread that probe can stay false forever (found the hard way: a
 * mutation that "failed" the suite for exactly that reason was a false kill).
 */
export async function bothInstancesInRotation(): Promise<void> {
  await until(
    'both instances answer readiness directly',
    async () => {
      for (const name of ['api1', 'api2'] as const) {
        const r = await readiness(await directUrl(name));
        if (r.status !== 200) return false;
      }
      return true;
    },
    60_000,
  );
  // nginx.conf: fail_timeout=5s. Wait it out (plus a margin) so no instance is still marked failed.
  await sleep(6500);
}
