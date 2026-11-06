// Starting and stopping the NGINX + 2 x API + PostgreSQL + Redis stack (infra/compose.cluster.yaml).
// Used by `npm run cluster:up|down` and by the cluster tests. Nothing here reads .env.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const root = path.resolve(import.meta.dirname, '..');
export const composeFile = path.join(root, 'infra', 'compose.cluster.yaml');

export interface Cluster {
  project: string;
  env: Record<string, string>;
  /** Host URLs, all on 127.0.0.1 with free ports chosen by Docker. */
  urls: { nginx: string; api1: string; api2: string; postgres: string };
  compose: (...args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

function composeRunner(project: string, env: Record<string, string>): Cluster['compose'] {
  return (...args) =>
    run('docker', ['compose', '-p', project, '-f', composeFile, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
}

async function hostPort(
  compose: Cluster['compose'],
  service: string,
  port: string,
): Promise<string> {
  const { stdout } = await compose('port', service, port);
  const match = /:(\d+)\s*$/m.exec(stdout.trim());
  if (!match?.[1]) throw new Error(`no published port for ${service}:${port}`);
  return `127.0.0.1:${match[1]}`;
}

export async function buildApiImage(image: string): Promise<void> {
  await run('docker', ['build', '-f', 'infra/docker/api.Dockerfile', '-t', image, '.'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
}

export async function startCluster(options: {
  project: string;
  env: Record<string, string>;
  /** Build the image first (default true). */
  build?: boolean;
}): Promise<Cluster> {
  const { project, env } = options;
  const image = env['API_IMAGE'];
  if (!image) throw new Error('API_IMAGE is required');
  if (options.build ?? true) await buildApiImage(image);
  const compose = composeRunner(project, env);
  // 1. the databases, 2. migrations (one-shot), 3. the API containers and the outbox workers, then NGINX.
  await compose('up', '-d', '--wait', 'postgres', 'redis');
  await compose('run', '--rm', 'migrate');
  await compose(
    'up',
    '-d',
    '--wait',
    'api1',
    'api2',
    'worker1',
    'worker2',
    'scheduler1',
    'scheduler2',
    'nginx',
  );
  const [nginx, api1, api2, postgres] = await Promise.all([
    hostPort(compose, 'nginx', '80'),
    hostPort(compose, 'api1', '3000'),
    hostPort(compose, 'api2', '3000'),
    hostPort(compose, 'postgres', '5432'),
  ]);
  return {
    project,
    env,
    compose,
    urls: {
      nginx: `http://${nginx}`,
      api1: `http://${api1}`,
      api2: `http://${api2}`,
      postgres,
    },
  };
}

/** Removes the containers and the network; with `volumes` also the database volume. */
export async function stopCluster(
  project: string,
  env: Record<string, string>,
  volumes: boolean,
): Promise<void> {
  const compose = composeRunner(project, env);
  await compose('down', '--remove-orphans', ...(volumes ? ['--volumes'] : []));
}
