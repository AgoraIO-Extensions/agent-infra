FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS builder
RUN npm install -g pnpm@11.20.0
WORKDIR /app

COPY . .
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/agent-runtime-host... build
RUN pnpm --config.inject-workspace-packages=true --filter @agent-infra/agent-runtime-host deploy --prod /prod/agent-runtime-host
RUN rm /prod/agent-runtime-host/node_modules/.modules.yaml /prod/agent-runtime-host/node_modules/.pnpm-workspace-state-v1.json

FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runner
ENV NODE_ENV=production
ENV AGENT_INFRA_RUNTIME_DATA_DIR=/var/lib/agent-runtime
WORKDIR /app
COPY --from=builder --chown=node:node /prod/agent-runtime-host/ ./
RUN mkdir -p /var/lib/agent-runtime && chown node:node /var/lib/agent-runtime
VOLUME ["/var/lib/agent-runtime"]
USER node
CMD ["node", "dist/index.mjs"]
