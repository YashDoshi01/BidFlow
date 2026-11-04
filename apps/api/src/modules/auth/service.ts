import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../http/errors.ts';
import { PG_UNIQUE_VIOLATION, pgCode, type Db } from '../../db/pool.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import * as repo from './repository.ts';
import type { LoginInput, RegisterInput } from './schemas.ts';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

function toPublicUser(row: repo.UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
  };
}

/** The token is 256 random bits; its SHA-256 is what the database stores. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Verified against when the email is unknown, so "no such user" and "wrong
// password" take about the same time (no account enumeration by timing).
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

export interface AuthService {
  register: (input: RegisterInput) => Promise<PublicUser>;
  login: (input: LoginInput) => Promise<{ token: string; expiresAt: string; user: PublicUser }>;
  logout: (sessionId: string) => Promise<void>;
  authenticate: (token: string) => Promise<repo.SessionPrincipal | undefined>;
  getUser: (userId: string) => Promise<PublicUser | undefined>;
}

export function createAuthService(db: Db, options: { sessionTtlSeconds: number }): AuthService {
  return {
    async register(input) {
      const passwordHash = await hashPassword(input.password);
      try {
        const row = await repo.insertUser(db, {
          email: input.email,
          passwordHash,
          displayName: input.displayName,
        });
        return toPublicUser(row);
      } catch (error) {
        // The UNIQUE constraint, not a prior SELECT, decides: two simultaneous
        // registrations cannot both pass a check-then-insert.
        if (pgCode(error) === PG_UNIQUE_VIOLATION) {
          throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
        }
        throw error;
      }
    },

    async login(input) {
      const user = await repo.findUserByEmail(db, input.email);
      const ok = await verifyPassword(
        input.password,
        user?.password_hash ?? (await getDummyHash()),
      );
      if (!user || !ok) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }
      const token = randomBytes(32).toString('base64url');
      const session = await repo.insertSession(db, {
        userId: user.id,
        tokenHash: hashToken(token),
        ttlSeconds: options.sessionTtlSeconds,
      });
      return { token, expiresAt: session.expiresAt.toISOString(), user: toPublicUser(user) };
    },

    async logout(sessionId) {
      await repo.revokeSession(db, sessionId);
    },

    authenticate(token) {
      return repo.findActiveSession(db, hashToken(token));
    },

    async getUser(userId) {
      const row = await repo.findUserById(db, userId);
      return row ? toPublicUser(row) : undefined;
    },
  };
}
