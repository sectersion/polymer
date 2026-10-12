# Polymer server image: built dist + production deps only (pnpm deploy).
# Needs the repo root as build context (workspace install).
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/cli/package.json apps/cli/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/skill/package.json packages/skill/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @polymer/server build \
  && pnpm --filter @polymer/server --prod deploy /deploy/server

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
  POLYMER_PORT=8080 \
  POLYMER_DATABASE_PATH=/data/polymer.db
WORKDIR /app
COPY --from=build /deploy/server/dist ./dist
COPY --from=build /deploy/server/package.json ./
COPY --from=build /deploy/server/node_modules ./node_modules
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/index.js"]
