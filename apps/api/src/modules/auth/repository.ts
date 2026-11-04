import type { Db } from '../../db/pool.ts';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  created_at: Date;
}

export interface SessionPrincipal {
  sessionId: string;
  userId: string;
}

export async function insertUser(
  db: Db,
  user: { email: string; passwordHash: string; displayName: string },
): Promise<UserRow> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, password_hash, display_name, created_at`,
    [user.email, user.passwordHash, user.displayName],
  );
  return rows[0] as UserRow;
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  const { rows } = await db.query<UserRow>(
    'SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = $1',
    [email],
  );
  return rows[0];
}

export async function findUserById(db: Db, id: string): Promise<UserRow | undefined> {
  const { rows } = await db.query<UserRow>(
    'SELECT id, email, password_hash, display_name, created_at FROM users WHERE id = $1',
    [id],
  );
  return rows[0];
}

export async function insertSession(
  db: Db,
  session: { userId: string; tokenHash: string; ttlSeconds: number },
): Promise<{ id: string; expiresAt: Date }> {
  // Expiry is computed by the database clock, the same clock that later checks it.
  const { rows } = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, clock_timestamp() + make_interval(secs => $3))
     RETURNING id, expires_at`,
    [session.userId, session.tokenHash, session.ttlSeconds],
  );
  const row = rows[0] as { id: string; expires_at: Date };
  return { id: row.id, expiresAt: row.expires_at };
}

/** A session is valid only if it exists, is not revoked, and has not expired. */
export async function findActiveSession(
  db: Db,
  tokenHash: string,
): Promise<SessionPrincipal | undefined> {
  const { rows } = await db.query<{ id: string; user_id: string }>(
    `SELECT id, user_id
       FROM sessions
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > clock_timestamp()`,
    [tokenHash],
  );
  const row = rows[0];
  return row ? { sessionId: row.id, userId: row.user_id } : undefined;
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query(
    'UPDATE sessions SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId],
  );
}
