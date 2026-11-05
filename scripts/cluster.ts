// A local two-instance stack for you to look at: NGINX -> api1 + api2 -> PostgreSQL + Redis.
//   npm run cluster:up      builds the image, starts everything, prints the URL
//   npm run cluster:down    stops it (keeps the database volume); add --volumes to delete it
// It uses its own PostgreSQL and Redis (project "bidflow-cluster"): it never touches the
// development stack. POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB come from .env (loaded
// by `node --env-file-if-exists`); this script does not print them.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { root, startCluster, stopCluster } from './cluster-lib.ts';

const command = process.argv[2];
const project = 'bidflow-cluster';
const env: Record<string, string> = {
  API_IMAGE: 'bidflow-api:local',
  POSTGRES_USER: process.env['POSTGRES_USER'] ?? '',
  POSTGRES_PASSWORD: process.env['POSTGRES_PASSWORD'] ?? '',
  POSTGRES_DB: process.env['POSTGRES_DB'] ?? '',
  NGINX_PORT: process.env['CLUSTER_NGINX_PORT'] ?? '8080',
};

if (command === 'up') {
  if (!env['POSTGRES_PASSWORD'] || !env['POSTGRES_USER'] || !env['POSTGRES_DB']) {
    console.error(
      'POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB must be set (see .env.example).',
    );
    process.exit(2);
  }
  if (!existsSync(path.join(root, 'apps/web/dist/index.html'))) {
    console.error('apps/web/dist is missing: run `npm run build:web` first (NGINX serves it).');
    process.exit(2);
  }
  const cluster = await startCluster({ project, env });
  console.log(
    `cluster is up: ${cluster.urls.nginx}   (api1 ${cluster.urls.api1}, api2 ${cluster.urls.api2})`,
  );
} else if (command === 'down') {
  await stopCluster(project, env, process.argv.includes('--volumes'));
  console.log('cluster is down');
} else {
  console.error('usage: node scripts/cluster.ts up | down [--volumes]');
  process.exit(2);
}
