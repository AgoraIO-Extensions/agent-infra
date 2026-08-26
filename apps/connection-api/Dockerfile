FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS builder
RUN npm install -g pnpm@11.20.0
WORKDIR /app

# Keep the dependency layer independent from application source changes. This works
# with both legacy Docker builds and BuildKit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/connection-api/package.json apps/connection-api/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/connection-contracts/package.json packages/connection-contracts/package.json
COPY packages/connection-core/package.json packages/connection-core/package.json
COPY packages/connection-identity/package.json packages/connection-identity/package.json
COPY packages/connection-store/package.json packages/connection-store/package.json
COPY packages/openconnector-adapter/package.json packages/openconnector-adapter/package.json
COPY packages/openconnector-kernel/package.json packages/openconnector-kernel/package.json
RUN pnpm install --frozen-lockfile

COPY apps/connection-api/src/bootstrap-production.ts apps/connection-api/src/bootstrap-production.ts
COPY apps/connection-api/src/bootstrap-admin.ts apps/connection-api/src/bootstrap-admin.ts
COPY apps/connection-api/src/index.ts apps/connection-api/src/index.ts
COPY apps/connection-api/src/app.ts apps/connection-api/src/app.ts
COPY apps/connection-api/src/oauth-routes.ts apps/connection-api/src/oauth-routes.ts
COPY apps/connection-api/src/production-app.ts apps/connection-api/src/production-app.ts
COPY apps/connection-api/src/runtime-config.ts apps/connection-api/src/runtime-config.ts
COPY apps/connection-api/tsconfig.json apps/connection-api/tsconfig.json
COPY apps/connection-api/tsdown.config.ts apps/connection-api/tsdown.config.ts
COPY packages/config/tsconfig.base.json packages/config/tsconfig.base.json
COPY packages/connection-contracts/openapi.json packages/connection-contracts/openapi.json
COPY packages/connection-contracts/src packages/connection-contracts/src
COPY packages/connection-contracts/tsconfig.json packages/connection-contracts/tsconfig.json
COPY packages/connection-contracts/tsdown.config.ts packages/connection-contracts/tsdown.config.ts
COPY packages/connection-core/src packages/connection-core/src
COPY packages/connection-core/tsconfig.json packages/connection-core/tsconfig.json
COPY packages/connection-core/tsdown.config.ts packages/connection-core/tsdown.config.ts
COPY packages/connection-identity/src packages/connection-identity/src
COPY packages/connection-identity/tsconfig.json packages/connection-identity/tsconfig.json
COPY packages/connection-identity/tsdown.config.ts packages/connection-identity/tsdown.config.ts
COPY packages/connection-store/src packages/connection-store/src
COPY packages/connection-store/tsconfig.json packages/connection-store/tsconfig.json
COPY packages/connection-store/tsdown.config.ts packages/connection-store/tsdown.config.ts
COPY packages/openconnector-adapter/src packages/openconnector-adapter/src
COPY packages/openconnector-adapter/tsconfig.json packages/openconnector-adapter/tsconfig.json
COPY packages/openconnector-kernel/src packages/openconnector-kernel/src
COPY packages/openconnector-kernel/tsconfig.json packages/openconnector-kernel/tsconfig.json
COPY packages/openconnector-kernel/PROVENANCE.json packages/openconnector-kernel/PROVENANCE.json
COPY packages/openconnector-kernel/LICENSE.txt packages/openconnector-kernel/LICENSE.txt
COPY packages/openconnector-kernel/NOTICE.md packages/openconnector-kernel/NOTICE.md
COPY packages/openconnector-kernel/scripts packages/openconnector-kernel/scripts
COPY migrations/connection migrations/connection

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/connection-api build
RUN pnpm --filter @agent-infra/connection-api deploy --prod --legacy /prod/connection-api
RUN mkdir -p /prod/connection-api/migrations && cp -R migrations/connection /prod/connection-api/migrations/connection

FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /prod/connection-api/ ./
EXPOSE 3002
USER node
CMD ["node", "dist/index.mjs"]
