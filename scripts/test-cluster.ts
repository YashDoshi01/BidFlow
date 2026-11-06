// Runs the multi-instance tests against REAL containers:
//   1. builds the web app (NGINX serves it) and the API image,
//   2. starts NGINX + api1 + api2 + PostgreSQL + Redis as project "bidflow-cluster-test"
//      (random password, free host ports, its own subnet; never reads .env),
//   3. runs the tests in tests/cluster against them,
//   4. ALWAYS tears everything down, including the database volume.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { startCluster, stopCluster, root } from './cluster-lib.ts';

const PROJECT = 'bidflow-cluster-test';
const password = randomBytes(18).toString('base64url');
const env: Record<string, string> = {
  API_IMAGE: 'bidflow-api:cluster-test',
  POSTGRES_USER: 'bidflow_test',
  POSTGRES_PASSWORD: password,
  POSTGRES_DB: 'bidflow_test',
  NGINX_PORT: '',
  // Short lease so a killed worker's events are taken over within seconds in the tests
  // (production default: 30).
  OUTBOX_LEASE_SECONDS: '3',
  // Tight lifecycle polling so tests that wait for an auction to end do not wait a full second.
  LIFECYCLE_POLL_INTERVAL_MS: '200',
};

function runToCompletion(
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  // `npm` is npm.cmd on Windows and needs a shell; node.exe (a path with spaces) must not use one.
  shell = false,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell,
      env: { ...process.env, ...extraEnv },
    });
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

let exitCode = 1;
try {
  console.log('building the web app ...');
  if (
    (await runToCompletion(
      'npm',
      ['run', 'build:web', '--silent'],
      {},
      process.platform === 'win32',
    )) !== 0
  ) {
    throw new Error('web build failed');
  }
  console.log(`building the API image and starting ${PROJECT} ...`);
  const cluster = await startCluster({ project: PROJECT, env });
  console.log(
    `cluster up: nginx ${cluster.urls.nginx}, api1 ${cluster.urls.api1}, api2 ${cluster.urls.api2}`,
  );
  const databaseUrl = `postgres://${env['POSTGRES_USER'] ?? ''}:${password}@${cluster.urls.postgres}/${env['POSTGRES_DB'] ?? ''}`;
  exitCode = await runToCompletion(
    process.execPath,
    [
      '--test',
      '--test-reporter=spec',
      '--test-concurrency=1',
      ...process.argv.slice(2),
      'tests/cluster/**/*.test.ts',
    ],
    {
      ...env,
      CLUSTER_PROJECT: PROJECT,
      CLUSTER_NGINX_URL: cluster.urls.nginx,
      CLUSTER_API1_URL: cluster.urls.api1,
      CLUSTER_API2_URL: cluster.urls.api2,
      TEST_DATABASE_URL: databaseUrl,
    },
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'cluster test run failed');
} finally {
  try {
    await stopCluster(PROJECT, env, true);
    console.log(`${PROJECT} torn down`);
  } catch (error) {
    console.error(
      'TEARDOWN FAILED, remove manually: docker compose -p bidflow-cluster-test down -v',
    );
    console.error(error instanceof Error ? error.message : '');
  }
}
process.exitCode = exitCode;
