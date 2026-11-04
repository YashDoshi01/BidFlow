# BidFlow

A real-time auction platform built as a learning and portfolio project. **Bids are simulated; no
real money, payments or shipping.** PostgreSQL is the source of truth; WebSockets and Redis only
distribute committed changes.

The full plan is in `BidFlow_Implementation_and_Learning_Plan.md`. Working rules are in `CLAUDE.md`.

## Status

| Phase | State                                                |
| ----- | ---------------------------------------------------- |
| 0     | Done (see "Known gaps" below) - repo, tooling, infra |
| 1-9   | Not started                                          |

Phase 0 contains no auction features: a typed, validated configuration, a minimal API with health
endpoints, and PostgreSQL + Redis in Docker Compose.

## Requirements

- Node.js 24 (`.node-version`, enforced by `engines`) and npm 11
- Docker with Docker Compose v2 (Docker Desktop must be **running**)

## Setup from a clean checkout

```bash
npm install
cp .env.example .env        # then edit POSTGRES_PASSWORD and DATABASE_URL to match
npm run infra:up            # starts PostgreSQL 17 and Redis 7, waits until healthy
npm run check:infra         # connects to both with the credentials in .env
npm run dev:api             # API on http://127.0.0.1:3000
curl localhost:3000/health/live
curl localhost:3000/health/ready
```

`npm run infra:down` stops the containers and keeps the data. `npm run infra:reset` also deletes
the database volume.

## Commands

| Command                | What it does                                       |
| ---------------------- | -------------------------------------------------- |
| `npm run typecheck`    | `tsc --noEmit`, strict mode                        |
| `npm run lint`         | ESLint (typescript-eslint strict, type-checked)    |
| `npm run format:check` | Prettier check (`npm run format` to fix)           |
| `npm test`             | Unit tests with the built-in `node:test` runner    |
| `npm run check:infra`  | Real connectivity check against Postgres and Redis |

The API runs TypeScript directly (Node 24 type stripping): there is no build step for the API.
Imports therefore use `.ts` extensions.

## Layout

```
apps/api/src/        config/ (env validation), health/ (dependency checks), app.ts, server.ts
infra/compose.yaml   PostgreSQL + Redis
scripts/             check-infra.ts
docs/                decisions, architecture, product rules, learning log, bugs, teaching reports
```

`apps/web`, `apps/workers`, `db/` and `tests/` are created in the phase that first needs them.

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

## Known gaps (Phase 0)

- `npm run infra:up` and the compose health checks were **not run** on the authoring machine
  (Docker daemon was not running). Only `docker compose config` was validated. Run the setup steps
  above once and report any failure.
- The "ready" (200) path of `/health/ready` is tested with stubs; against real Postgres and Redis it
  is verified only by `npm run check:infra` once the containers run.
