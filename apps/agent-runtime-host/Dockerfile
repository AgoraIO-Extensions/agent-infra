FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS builder
RUN npm install -g pnpm@11.20.0
WORKDIR /app

COPY . .
ARG PNPM_STORE_DIR=/pnpm-store
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --store-dir "$PNPM_STORE_DIR"

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/agent-runtime-host... build
RUN pnpm --config.inject-workspace-packages=true --filter @agent-infra/agent-runtime-host deploy --prod /prod/agent-runtime-host
RUN rm /prod/agent-runtime-host/node_modules/.modules.yaml /prod/agent-runtime-host/node_modules/.pnpm-workspace-state-v1.json
RUN find /prod/agent-runtime-host -type f \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.d.mts' -o -name '*.d.mts.map' -o -name '*.d.cts' -o -name '*.d.cts.map' \) -delete
RUN cp -R /prod/agent-runtime-host /prod/agent-runtime-host-normalized \
    && rm -r /prod/agent-runtime-host \
    && mv /prod/agent-runtime-host-normalized /prod/agent-runtime-host

FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runner
ENV NODE_ENV=production
ENV AGENT_INFRA_RUNTIME_DATA_DIR=/var/lib/agent-runtime
WORKDIR /app
COPY --from=builder --chown=node:node /prod/agent-runtime-host/ ./
RUN mkdir -p /var/lib/agent-runtime && chown node:node /var/lib/agent-runtime
VOLUME ["/var/lib/agent-runtime"]
USER node
CMD ["node", "dist/index.mjs"]
