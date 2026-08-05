FROM node:24-slim AS base
RUN npm install -g pnpm@11.20.0
WORKDIR /app

COPY . .
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/platform-api build

EXPOSE 3000

WORKDIR /app/apps/platform-api
CMD ["node", "dist/index.mjs"]
