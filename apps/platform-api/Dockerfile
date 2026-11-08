FROM clamav/clamav@sha256:ce80e97855d937e93009bb47eb5ecb410b514b844b03d0ecf00e8eeec92810cc AS skill-scanner
FROM dappros/minio@sha256:624bad2fe79a8613aa3c5c9b765ebcab365080b8445cf1b05c357cc7753725f0 AS skill-object-storage

FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS builder
RUN apk add --no-cache --upgrade 'libcrypto3=3.5.9-r0' 'libssl3=3.5.9-r0' \
	&& npm install --global npm@11.19.1 \
	&& npm install --global pnpm@11.20.0
WORKDIR /app

COPY . .
RUN pnpm install --filter @agent-infra/platform-api... --frozen-lockfile --store-dir /pnpm-store --child-concurrency=1 --network-concurrency=8

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/platform-api... build
RUN pnpm --config.inject-workspace-packages=true --filter @agent-infra/platform-api deploy --prod /prod/platform-api
RUN rm /prod/platform-api/pnpm-lock.yaml \
    /prod/platform-api/pnpm-workspace.yaml \
    /prod/platform-api/node_modules/.modules.yaml \
    /prod/platform-api/node_modules/.package-map.json \
    /prod/platform-api/node_modules/.pnpm-workspace-state-v1.json
RUN find /prod/platform-api -type f \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.d.mts' -o -name '*.d.mts.map' -o -name '*.d.cts' -o -name '*.d.cts.map' \) -delete
RUN cp -R /prod/platform-api /prod/platform-api-normalized \
    && rm -r /prod/platform-api \
    && mv /prod/platform-api-normalized /prod/platform-api

FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS runner
RUN apk add --no-cache --upgrade 'libcrypto3=3.5.9-r0' 'libssl3=3.5.9-r0' 'clamav-scanner=1.4.6-r0' \
	&& rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /var/log/apk.log
COPY --from=skill-scanner /var/lib/clamav/ /var/lib/clamav/
COPY --from=skill-object-storage /usr/bin/minio /usr/bin/minio
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /prod/platform-api/ ./

ARG SOURCE_COMMIT
# Refresh upstream seed signatures for each source build, then require a warning-free native scan.
# Complete signed CVD archives are byte-stable; locally reconstructed CLD archives are not.
RUN printf '%s\n' 'DatabaseMirror database.clamav.net' 'DatabaseDirectory /var/lib/clamav' \
    'DatabaseOwner clamav' 'ConnectTimeout 15' 'ReceiveTimeout 60' 'MaxAttempts 2' \
    'ScriptedUpdates no' 'TestDatabases yes' > /tmp/skill-freshclam.conf \
    && printf 'Updating Skill signatures for source %s\n' "$SOURCE_COMMIT" \
    && freshclam --config-file=/tmp/skill-freshclam.conf --stdout \
    && scan_result="$(clamscan --stdout --no-summary /etc/alpine-release 2>&1)" \
    && printf '%s\n' "$scan_result" \
    && test "$scan_result" = '/etc/alpine-release: OK' \
    && rm -f /tmp/skill-freshclam.conf /var/lib/clamav/freshclam.dat

USER node
CMD ["node", "dist/index.mjs"]
