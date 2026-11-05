# One image for every backend process (plan section 3.6: the API and, later, the workers are
# different ENTRYPOINTS of the same image). No compile step: Node 24 runs the TypeScript directly.
#
# Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t bidflow-api:local .
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so the layer is reused while only source files change.
# --omit=dev: no compiler, linter, test tools or browser drivers in the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY apps/api apps/api
COPY scripts/migrate.ts scripts/migrate.ts
COPY db db

# Do not run as root.
USER node
EXPOSE 3000

# Default entrypoint: the API + WebSocket server. Other commands: `node scripts/migrate.ts`.
CMD ["node", "apps/api/src/server.ts"]
