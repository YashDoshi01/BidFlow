import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

// A deliberately small migration runner (ADR-010): forward-only, one
// transaction per file, checksum-verified, serialised with an advisory lock.

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
// Arbitrary constant; all runners must agree on it.
const ADVISORY_LOCK_KEY = 726_001;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(connectionString: string, dir: string): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Two runners starting together (two API instances at deploy) must not
    // both apply the same file: the second waits here, then sees it applied.
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map(
      (
        await client.query<{ name: string; checksum: string }>(
          'SELECT name, checksum FROM schema_migrations',
        )
      ).rows.map((r) => [r.name, r.checksum]),
    );

    const result: MigrationResult = { applied: [], alreadyApplied: [] };
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous !== undefined) {
        // Editing an applied migration silently diverges environments. Refuse.
        if (previous !== checksum) {
          throw new Error(`migration ${file} was modified after it was applied`);
        }
        result.alreadyApplied.push(file);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed`, { cause: error });
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.end();
  }
}
