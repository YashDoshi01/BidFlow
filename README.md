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
| 2     | Done - bid engine, idempotency                    |
| 3     | Done - WebSocket rooms, live bids, React client   |
| 4     | Done - Redis adapter, NGINX, two instances        |
| 5-9   | Not started                                       |

Phase 1 added PostgreSQL migrations, registration/login/logout with server-side sessions, and auctions you
can create, edit (while draft), publish, list and fetch. Phase 2 adds `POST /auctions/:id/bids` with
idempotency keys and bid history. Phase 3 adds live delivery: Socket.IO rooms, `bid.accepted` events published after the commit, and a minimal React
client (`apps/web`). Nothing ends an auction automatically yet (Phase 6) and events are best effort until the outbox
(Phase 5): see `docs/EVENTS.md`. API reference: `docs/API.md`. Data model: `docs/DATA_MODEL.md`.

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
npm run dev:api             # API + WebSocket on http://127.0.0.1:3000
curl localhost:3000/health/live
curl localhost:3000/health/ready
npm run dev:web             # React app on http://127.0.0.1:5173 (proxies /api and /socket.io to the API)
```

Open http://127.0.0.1:5173, register, start an auction, and open the same auction in a second browser (or a private
window with another account): bids appear in both without a reload. The browser talks to one origin; the
dev server forwards `/api/*` (prefix removed) and `/socket.io` to the API. Optional shell variables for the dev
server: `API_URL` (default `http://127.0.0.1:3000`) and `WEB_PORT` (default 5173).

`npm run infra:down` stops the containers and keeps the data. `npm run infra:reset` also deletes
the database volume.

## Commands

| Command                               | What it does                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                   | `tsc --noEmit`, strict mode                                                                                                                                                               |
| `npm run lint`                        | ESLint (typescript-eslint strict, type-checked)                                                                                                                                           |
| `npm run format:check`                | Prettier check (`npm run format` to fix)                                                                                                                                                  |
| `npm test`                            | Unit tests with the built-in `node:test` runner                                                                                                                                           |
| `npm run check:infra`                 | Real connectivity check against Postgres and Redis                                                                                                                                        |
| `npm run db:migrate`                  | Applies `db/migrations/*.sql` to `DATABASE_URL`                                                                                                                                           |
| `npm run test:integration`            | Real PostgreSQL + real WebSocket tests in a throwaway container (needs Docker; never touches your dev database)                                                                           |
| `npm run test:e2e`                    | Real-browser tests (Microsoft Edge via playwright-core) against the same kind of throwaway stack. Set `E2E_SCREENSHOT_DIR` to keep the screenshots                                        |
| `npm run test:cluster`                | Builds the API image and runs NGINX + 2 API containers + PostgreSQL + Redis (a throwaway project), then topology, browser, restart and outage tests (about 1 minute plus the image build) |
| `npm run cluster:up` / `cluster:down` | A local two-instance stack for you to look at (run `npm run build:web` first); see `docs/OPERATIONS.md`                                                                                   |
| `npm run dev:web` / `build:web`       | Vite dev server / production build of `apps/web`                                                                                                                                          |

The API runs TypeScript directly (Node 24 type stripping): there is no build step for the API.
Imports therefore use `.ts` extensions.

## Layout

```
apps/api/src/        app.ts, createServer.ts, server.ts, services.ts, config/, db/, http/, logging/,
                     health/, events/ (event contract), modules/auth|auctions|bids|realtime
infra/docker/, nginx/  API image, NGINX config; compose.cluster.yaml = NGINX + api1 + api2 + PostgreSQL + Redis
apps/web/            React + Vite client (src/room = room state + socket hook, src/pages)
db/migrations/       numbered SQL files
infra/               compose.yaml (dev PostgreSQL + Redis), compose.test.yaml (throwaway test DB)
scripts/             check-infra, migrate, test-integration
tests/integration/   real-PostgreSQL and WebSocket tests
tests/e2e/           real-browser tests
docs/                decisions, architecture, product rules, learning log, bugs, teaching reports
```

`apps/workers` is created in the phase that first needs it (Phase 5).

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

- Live events are best effort (published right after the commit, not durable, concurrent bids may arrive out of
  order); clients recover with the snapshot (`docs/EVENTS.md`). With two instances, a Redis outage loses events for
  sockets on the other instance until they re-join (`docs/OPERATIONS.md`). No Content-Security-Policy, no TLS and no
  rate limiting yet (Phase 8). The browser tests need Microsoft Edge.
- The development stack (`npm run infra:up`) was started by the owner; `docker ps` showed both
  containers running, but the agent did not run `check:infra` against it (it does not touch the
  owner's stack). The throwaway test database from `infra/compose.test.yaml` started healthy twice.
- No rate limiting yet (Phase 8): login and registration can be brute-forced.
- Password hashing uses scrypt N=16384 (Node default); see ADR-012.
- `docs/` is listed in `.gitignore` (owner's change), so the documentation is not committed unless that
  line is removed.
