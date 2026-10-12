# Polymer web image: Next.js standalone runner.
# Needs the repo root as build context (workspace install).
FROM node:22-slim AS build
RUN corepack enable
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/cli/package.json apps/cli/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/skill/package.json packages/skill/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @polymer/web build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
  PORT=3000 \
  HOSTNAME=0.0.0.0 \
  POLYMER_API_URL=http://server:8080
WORKDIR /app
# Monorepo standalone layout nests the runner one level deep.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
