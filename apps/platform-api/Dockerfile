FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS builder
RUN npm install -g pnpm@11.20.0
WORKDIR /app

COPY . .
ARG PNPM_STORE_DIR=/pnpm-store
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --store-dir "$PNPM_STORE_DIR"

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/platform-api... build
RUN pnpm --config.inject-workspace-packages=true --filter @agent-infra/platform-api deploy --prod /prod/platform-api
RUN rm /prod/platform-api/node_modules/.modules.yaml /prod/platform-api/node_modules/.pnpm-workspace-state-v1.json
RUN cp -R /prod/platform-api /prod/platform-api-normalized \
    && rm -r /prod/platform-api \
    && mv /prod/platform-api-normalized /prod/platform-api

FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /prod/platform-api/ ./

USER node
CMD ["node", "dist/index.mjs"]
