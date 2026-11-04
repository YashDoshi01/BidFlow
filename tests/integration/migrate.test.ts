import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { migrate } from '../../apps/api/src/db/migrate.ts';
import { testDatabaseUrl } from './helpers.ts';

describe('migration runner (scratch database per test)', () => {
  const admin = new pg.Client({ connectionString: testDatabaseUrl() });
  const created: string[] = [];
  const dirs: string[] = [];

  before(async () => {
    await admin.connect();
  });
  after(async () => {
    for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function scratch(files: Record<string, string>): Promise<{ url: string; dir: string }> {
    const name = `mig_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    const u = new URL(testDatabaseUrl());
    u.pathname = `/${name}`;
    const dir = await mkdtemp(path.join(tmpdir(), 'bidflow-mig-'));
    dirs.push(dir);
    for (const [file, sql] of Object.entries(files)) await writeFile(path.join(dir, file), sql);
    return { url: u.toString(), dir };
  }

  async function tables(url: string): Promise<string[]> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const { rows } = await c.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
      );
      return rows.map((r) => r.table_name);
    } finally {
      await c.end();
    }
  }

  it('applies the real migrations, then a second run applies nothing', async () => {
    const { url } = await scratch({});
    const real = path.resolve(import.meta.dirname, '../../db/migrations');
    const first = await migrate(url, real);
    assert.deepEqual(first.applied, ['0001_users_and_sessions.sql', '0002_auctions.sql']);
    const second = await migrate(url, real);
    assert.deepEqual(second.applied, []);
    assert.equal(second.alreadyApplied.length, 2);
    assert.deepEqual(await tables(url), ['auctions', 'schema_migrations', 'sessions', 'users']);
  });

  it('refuses to run when an applied migration file was edited', async () => {
    const { url, dir } = await scratch({ '0001_a.sql': 'CREATE TABLE a (id int);' });
    await migrate(url, dir);
    await writeFile(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id int, extra int);');
    await assert.rejects(migrate(url, dir), /modified after it was applied/);
  });

  it('a failing migration rolls back completely and is not recorded', async () => {
    const { url, dir } = await scratch({
      '0001_ok.sql': 'CREATE TABLE ok_table (id int);',
      '0002_bad.sql': 'CREATE TABLE half_done (id int); SELECT 1/0;',
    });
    await assert.rejects(migrate(url, dir), /0002_bad.sql failed/);
    const names = await tables(url);
    assert.ok(names.includes('ok_table'));
    assert.ok(!names.includes('half_done'));
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const { rows } = await c.query<{ name: string }>('SELECT name FROM schema_migrations');
    await c.end();
    assert.deepEqual(
      rows.map((r) => r.name),
      ['0001_ok.sql'],
    );
  });

  it('two runners started together apply each file exactly once', async () => {
    const { url, dir } = await scratch({
      '0001_a.sql': 'CREATE TABLE a (id int);',
      '0002_b.sql': 'CREATE TABLE b (id int);',
    });
    const [r1, r2] = await Promise.all([migrate(url, dir), migrate(url, dir)]);
    assert.equal(r1.applied.length + r2.applied.length, 2);
    assert.deepEqual(await tables(url), ['a', 'b', 'schema_migrations']);
  });
});
