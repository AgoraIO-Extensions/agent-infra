FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS builder
RUN apk add --no-cache --upgrade 'libcrypto3=3.5.9-r0' 'libssl3=3.5.9-r0' \
	&& npm install --global npm@11.19.1 \
	&& npm install --global pnpm@11.20.0
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile --store-dir /pnpm-store

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/enterprise-directory-sync... build
RUN pnpm --config.inject-workspace-packages=true --filter @agent-infra/enterprise-directory-sync deploy --prod /prod/enterprise-directory-sync
RUN rm /prod/enterprise-directory-sync/pnpm-lock.yaml \
    /prod/enterprise-directory-sync/pnpm-workspace.yaml \
    /prod/enterprise-directory-sync/node_modules/.modules.yaml \
    /prod/enterprise-directory-sync/node_modules/.package-map.json \
    /prod/enterprise-directory-sync/node_modules/.pnpm-workspace-state-v1.json
RUN find /prod/enterprise-directory-sync -type f \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.d.mts' -o -name '*.d.mts.map' \) -delete
RUN cp -R /prod/enterprise-directory-sync /prod/enterprise-directory-sync-normalized \
    && rm -r /prod/enterprise-directory-sync \
    && mv /prod/enterprise-directory-sync-normalized /prod/enterprise-directory-sync

FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS runner
RUN apk add --no-cache --upgrade 'libcrypto3=3.5.9-r0' 'libssl3=3.5.9-r0' \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /prod/enterprise-directory-sync/ ./
COPY --chown=node:node apps/enterprise-directory-sync/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --chown=node:node migrations/enterprise-directory/ ./migrations/enterprise-directory/
USER node
CMD ["node", "dist/index.mjs"]
