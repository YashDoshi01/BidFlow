# BidFlow

A real-time auction platform built as a learning and portfolio project. **Bids are simulated; no
real money, payments or shipping.** PostgreSQL is the source of truth; WebSockets and Redis only
distribute committed changes.

The full plan is in `BidFlow_Implementation_and_Learning_Plan.md`. Working rules are in `CLAUDE.md`.

## Status

| Phase | State                                             |
| ----- | ------------------------------------------------- |
| 0     | Done - repo, tooling, infra                       |
| 1     | Done - users, sessions, auctions, REST foundation |
| 2-9   | Not started                                       |

Phase 1 adds: PostgreSQL migrations, registration/login/logout with server-side sessions, and
auctions you can create, edit (while draft), publish, list and fetch. **There is no bidding yet**
(Phase 2). API reference: `docs/API.md`. Data model: `docs/DATA_MODEL.md`.

## Requirements

- Node.js 24 (`.node-version`, enforced by `engines`) and npm 11
- Docker with Docker Compose v2 (Docker Desktop must be **running**)

## Setup from a clean checkout

```bash
npm install
cp .env.example .env        # then edit POSTGRES_PASSWORD and DATABASE_URL to match
npm run infra:up            # starts PostgreSQL 17 and Redis 7, waits until healthy
npm run check:infra         # connects to both with the credentials in .env
npm run db:migrate          # creates/updates the schema (safe to run again)
npm run dev:api             # API on http://127.0.0.1:3000
curl localhost:3000/health/live
curl localhost:3000/health/ready
```

`npm run infra:down` stops the containers and keeps the data. `npm run infra:reset` also deletes
the database volume.

## Commands

| Command                    | What it does                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | `tsc --noEmit`, strict mode                                                                    |
| `npm run lint`             | ESLint (typescript-eslint strict, type-checked)                                                |
| `npm run format:check`     | Prettier check (`npm run format` to fix)                                                       |
| `npm test`                 | Unit tests with the built-in `node:test` runner                                                |
| `npm run check:infra`      | Real connectivity check against Postgres and Redis                                             |
| `npm run db:migrate`       | Applies `db/migrations/*.sql` to `DATABASE_URL`                                                |
| `npm run test:integration` | Real-PostgreSQL tests in a throwaway container (needs Docker; never touches your dev database) |

The API runs TypeScript directly (Node 24 type stripping): there is no build step for the API.
Imports therefore use `.ts` extensions.

## Layout

```
apps/api/src/        app.ts, server.ts, config/, db/, http/, logging/, health/,
                     modules/auth/, modules/auctions/
db/migrations/       numbered SQL files
infra/               compose.yaml (dev PostgreSQL + Redis), compose.test.yaml (throwaway test DB)
scripts/             check-infra, migrate, test-integration
tests/integration/   real-PostgreSQL tests
docs/                decisions, architecture, product rules, learning log, bugs, teaching reports
```

`apps/web` and `apps/workers` are created in the phase that first needs them.

## Troubleshooting

- **`failed to connect to the docker API` / `dockerDesktopLinuxEngine`**: Docker Desktop is not
  running. Start it and retry `npm run infra:up`.
- **`Invalid environment configuration`**: a variable in `.env` is missing or malformed. The message
  names the variable, never its value.
- **Port already in use**: change `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` / `API_PORT` in `.env`
  (and `DATABASE_URL` / `REDIS_URL` to match), then `npm run infra:down` and `infra:up`.
- **Password change has no effect**: PostgreSQL only reads `POSTGRES_PASSWORD` when the volume is
  first created. Run `npm run infra:reset`.
- **`npm run infra:up` says a variable is not set**: you have not created `.env`.

## Known gaps

- Redis is only health-checked so far; no feature uses it until Phase 4.
- The development stack (`npm run infra:up`) was started by the owner; `docker ps` showed both
  containers running, but the agent did not run `check:infra` against it (it does not touch the
  owner's stack). The throwaway test database from `infra/compose.test.yaml` started healthy twice.
- No rate limiting yet (Phase 8): login and registration can be brute-forced.
- Password hashing uses scrypt N=16384 (Node default); see ADR-012.
- `docs/` is listed in `.gitignore` (owner's change), so the documentation is not committed unless that
  line is removed.
