FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS base
RUN npm install -g pnpm@11.20.0
WORKDIR /app

COPY . .
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/connection-api build

EXPOSE 3002
WORKDIR /app/apps/connection-api
USER node
CMD ["node", "dist/index.mjs"]
