FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS builder
RUN apk add --no-cache --upgrade 'libcrypto3=3.5.8-r0' 'libssl3=3.5.8-r0' \
	&& npm install --global npm@11.19.1 \
	&& npm install --global pnpm@11.20.0
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

FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS runner
RUN apk add --no-cache --upgrade 'libcrypto3=3.5.8-r0' 'libssl3=3.5.8-r0' \
	&& npm install --global npm@11.19.1
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /prod/platform-worker/ ./
USER node
CMD ["node", "dist/index.mjs"]
