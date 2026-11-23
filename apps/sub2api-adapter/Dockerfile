FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS builder
RUN apk add --no-cache --upgrade 'libcrypto3=3.5.9-r1' 'libssl3=3.5.9-r1' \
    && npm install --global npm@11.19.1 pnpm@11.20.0
WORKDIR /app
COPY . .
RUN pnpm install --filter @agent-infra/sub2api-adapter... --frozen-lockfile --store-dir /pnpm-store --child-concurrency=1 --network-concurrency=8
ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/sub2api-adapter build
RUN pnpm --config.inject-workspace-packages=true --filter @agent-infra/sub2api-adapter deploy --prod /prod/sub2api-adapter
RUN cp -R apps/sub2api-adapter/dist /prod/sub2api-adapter/dist

FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS runner
RUN apk add --no-cache --upgrade 'libcrypto3=3.5.9-r1' 'libssl3=3.5.9-r1' \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /var/log/apk.log
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /prod/sub2api-adapter/ ./
USER node
CMD ["node", "dist/serve.mjs", "/etc/agent-infra/adapter/config.json"]
