FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS builder
RUN npm install -g pnpm@11.20.0
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile --store-dir /pnpm-store

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/platform-worker... build
RUN pnpm --config.inject-workspace-packages=true --filter @agent-infra/platform-worker deploy --prod /prod/platform-worker
RUN rm /prod/platform-worker/pnpm-lock.yaml \
    /prod/platform-worker/pnpm-workspace.yaml \
    /prod/platform-worker/node_modules/.modules.yaml \
    /prod/platform-worker/node_modules/.package-map.json \
    /prod/platform-worker/node_modules/.pnpm-workspace-state-v1.json
RUN find /prod/platform-worker -type f \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.d.mts' -o -name '*.d.mts.map' -o -name '*.d.cts' -o -name '*.d.cts.map' \) -delete
RUN cp -R /prod/platform-worker /prod/platform-worker-normalized \
    && rm -r /prod/platform-worker \
    && mv /prod/platform-worker-normalized /prod/platform-worker

FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /prod/platform-worker/ ./
USER node
CMD ["node", "dist/index.mjs"]
