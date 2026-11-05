// Runs the PostgreSQL integration tests against a throwaway database:
//   1. picks a free host port and a random password,
//   2. starts infra/compose.test.yaml as project "bidflow-test",
//   3. runs the migrations, then the tests in tests/integration,
//   4. ALWAYS tears the containers down (and their tmpfs data).
// It never reads .env and never touches the development stack.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { migrate } from '../apps/api/src/db/migrate.ts';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const PROJECT = 'bidflow-test';
const composeFile = path.join(root, 'infra', 'compose.test.yaml');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

const port = await freePort();
const password = randomBytes(18).toString('base64url');
const composeEnv = {
  ...process.env,
  TEST_POSTGRES_PASSWORD: password,
  TEST_POSTGRES_PORT: String(port),
};
const compose = (...args: string[]): Promise<{ stdout: string }> =>
  run('docker', ['compose', '-p', PROJECT, '-f', composeFile, ...args], { env: composeEnv });

let exitCode = 1;
try {
  console.log(`starting ${PROJECT} on 127.0.0.1:${String(port)}`);
  await compose('up', '-d', '--wait');
  const url = `postgres://bidflow_test:${password}@127.0.0.1:${String(port)}/bidflow_test`;
  const result = await migrate(url, path.join(root, 'db', 'migrations'));
  console.log(`migrations applied: ${result.applied.join(', ')}`);

  // `--e2e` runs the real-browser tests in tests/e2e instead of tests/integration.
  const args = process.argv.slice(2);
  const e2e = args.includes('--e2e');
  const extra = args.filter((a) => a !== '--e2e');
  exitCode = await new Promise<number>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--test',
        '--test-reporter=spec',
        '--test-concurrency=1',
        ...extra,
        e2e ? 'tests/e2e/**/*.test.ts' : 'tests/integration/**/*.test.ts',
      ],
      { cwd: root, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url } },
    );
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'integration run failed');
} finally {
  try {
    await compose('down', '--volumes', '--remove-orphans');
    console.log(`${PROJECT} torn down`);
  } catch (error) {
    console.error('TEARDOWN FAILED, remove manually: docker compose -p bidflow-test down -v');
    console.error(error instanceof Error ? error.message : '');
  }
}
process.exitCode = exitCode;
