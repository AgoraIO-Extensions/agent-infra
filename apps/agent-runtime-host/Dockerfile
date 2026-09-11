FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS builder
ARG TARGETARCH
RUN apk add --no-cache --upgrade 'libcrypto3=3.5.8-r0' 'libssl3=3.5.8-r0' \
	&& npm install --global npm@11.19.1 \
	&& npm install --global pnpm@11.20.0
WORKDIR /app

COPY deploy/runtime/install-codex.mjs ./deploy/runtime/install-codex.mjs
COPY packages/agent-runtime/src/codex-release.json ./packages/agent-runtime/src/codex-release.json
RUN node --use-env-proxy deploy/runtime/install-codex.mjs "$TARGETARCH" /opt/codex
RUN apk add --no-cache 'setpriv=2.42.3-r1'
COPY . .
RUN pnpm install --frozen-lockfile --store-dir /pnpm-store

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/agent-runtime-host... build
RUN pnpm --config.inject-workspace-packages=true --filter @agent-infra/agent-runtime-host deploy --prod /prod/agent-runtime-host
RUN rm /prod/agent-runtime-host/pnpm-lock.yaml \
    /prod/agent-runtime-host/pnpm-workspace.yaml \
    /prod/agent-runtime-host/node_modules/.modules.yaml \
    /prod/agent-runtime-host/node_modules/.package-map.json \
    /prod/agent-runtime-host/node_modules/.pnpm-workspace-state-v1.json
RUN find /prod/agent-runtime-host -type f \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.d.mts' -o -name '*.d.mts.map' -o -name '*.d.cts' -o -name '*.d.cts.map' \) -delete
RUN cp -R /prod/agent-runtime-host /prod/agent-runtime-host-normalized \
    && rm -r /prod/agent-runtime-host \
    && mv /prod/agent-runtime-host-normalized /prod/agent-runtime-host

FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS runner
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
RUN apk add --no-cache --upgrade 'libcrypto3=3.5.8-r0' 'libssl3=3.5.8-r0' 'setpriv=2.42.3-r1' \
	&& npm install --global npm@11.19.1
ENV NODE_ENV=production
ENV AGENT_INFRA_RUNTIME_DATA_DIR=/var/lib/agent-runtime
ENV PATH=/opt/codex/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /app
COPY --from=builder /opt/codex/ /opt/codex/
COPY --from=builder --chown=node:node /prod/agent-runtime-host/ ./
RUN mkdir -p /var/lib/agent-runtime && chown node:node /var/lib/agent-runtime
VOLUME ["/var/lib/agent-runtime"]
USER node
CMD ["node", "dist/index.mjs"]
