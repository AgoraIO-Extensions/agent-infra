# Preserve the proven Landlock helper; Bookworm's setpriv lacks required rights.
FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 AS isolation-tools
RUN apk add --no-cache 'setpriv=2.42.3-r1'

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS builder
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates unzip util-linux \
	&& rm -rf /var/lib/apt/lists/* /var/log/* \
	&& npm install --global npm@11.19.1 \
	&& npm install --global pnpm@11.20.0
WORKDIR /app
COPY --from=isolation-tools /bin/setpriv /usr/bin/setpriv
COPY --from=isolation-tools /lib/ld-musl-*.so.1 /usr/lib/
COPY --from=isolation-tools /usr/lib/libcap-ng.so.0* /usr/lib/libeconf.so.0* /usr/lib/

COPY deploy/runtime/install-codex.mjs ./deploy/runtime/install-codex.mjs
COPY packages/agent-runtime/src/codex-release.json ./packages/agent-runtime/src/codex-release.json
RUN node --use-env-proxy deploy/runtime/install-codex.mjs "$TARGETARCH" /opt/codex
COPY deploy/runtime/install-opencode.mjs ./deploy/runtime/install-opencode.mjs
COPY packages/agent-runtime/src/opencode-release.json ./packages/agent-runtime/src/opencode-release.json
COPY packages/agent-runtime/third-party/opencode-LICENSE ./packages/agent-runtime/third-party/opencode-LICENSE
RUN node --use-env-proxy deploy/runtime/install-opencode.mjs "$TARGETARCH" /opt/opencode gnu
COPY deploy/runtime/install-chromium.mjs ./deploy/runtime/install-chromium.mjs
COPY packages/agent-runtime/src/browser-release.json ./packages/agent-runtime/src/browser-release.json
RUN node --use-env-proxy deploy/runtime/install-chromium.mjs "$TARGETARCH" /opt/agent-infra/browser
COPY . .
RUN pnpm --fetch-timeout=300000 install --frozen-lockfile --store-dir /pnpm-store

ENV NODE_ENV=production
RUN pnpm --filter @agent-infra/agent-runtime-host... build
RUN pnpm --config.store-dir=/pnpm-store --config.inject-workspace-packages=true --filter @agent-infra/agent-runtime-host deploy --prod /prod/agent-runtime-host
RUN rm /prod/agent-runtime-host/pnpm-lock.yaml \
    /prod/agent-runtime-host/pnpm-workspace.yaml \
    /prod/agent-runtime-host/node_modules/.modules.yaml \
    /prod/agent-runtime-host/node_modules/.package-map.json \
    /prod/agent-runtime-host/node_modules/.pnpm-workspace-state-v1.json
RUN find /prod/agent-runtime-host -type f \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.d.mts' -o -name '*.d.mts.map' -o -name '*.d.cts' -o -name '*.d.cts.map' \) -delete
RUN cp -R /prod/agent-runtime-host /prod/agent-runtime-host-normalized \
    && rm -r /prod/agent-runtime-host \
    && mv /prod/agent-runtime-host-normalized /prod/agent-runtime-host

RUN cd /prod/agent-runtime-host && node --input-type=module -e 'import {verifyClaudeInstallation} from "@agent-infra/agent-runtime"; import {execFileSync} from "node:child_process"; const p = await verifyClaudeInstallation(); if (execFileSync(p.executable, ["--version"], {encoding:"utf8"}).trim() !== `${p.nativeVersion} (Claude Code)`) throw new Error("RUNTIME_CLAUDE_PROVENANCE_MISMATCH");'

RUN cd /prod/agent-runtime-host && node --input-type=module -e 'import {verifyPiInstallation} from "@agent-infra/agent-runtime"; import {execFileSync} from "node:child_process"; const p = await verifyPiInstallation(); if (execFileSync(p.executable, [p.cli, "--version"], {encoding:"utf8"}).trim() !== p.nativeVersion) throw new Error("RUNTIME_PI_PROVENANCE_MISMATCH");'

RUN cd /prod/agent-runtime-host && node --input-type=module -e 'import {verifyOpenCodeInstallation} from "@agent-infra/agent-runtime"; import {execFileSync} from "node:child_process"; const p = await verifyOpenCodeInstallation("/opt/opencode/bin/opencode"); if (execFileSync(p.executable, ["--version"], {encoding:"utf8"}).trim() !== p.nativeVersion) throw new Error("RUNTIME_OPENCODE_PROVENANCE_MISMATCH");'

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
LABEL io.agora.agent.runtime.manifest='{"schemaVersion":1,"interactionMode":"platform-adapter","protocol":"acp","service":{"port":3003},"health":{"path":"/healthz"}}'
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux \
	&& rm -rf /var/lib/apt/lists/* /var/log/* \
	&& npm install --global npm@11.19.1 --logs-max=0 \
	&& rm -rf /root/.npm /tmp/node-compile-cache
ENV NODE_ENV=production
ENV AGENT_INFRA_RUNTIME_DATA_DIR=/var/lib/agent-runtime
ENV PATH=/opt/codex/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /app
COPY --from=builder /opt/codex/ /opt/codex/
COPY --from=builder /opt/opencode/ /opt/opencode/
COPY --from=builder /opt/agent-infra/browser/ /opt/agent-infra/browser/
COPY --from=builder --chown=0:0 /app/deploy/runtime/skills/workspace-summary/ /opt/codex/agent-infra-skills/workspace-summary/
COPY --from=builder --chown=0:0 /app/deploy/runtime/skills/workspace-summary.manifest.json /opt/codex/agent-infra-skills/workspace-summary.manifest.json
RUN SOURCE_COMMIT="$SOURCE_COMMIT" node --input-type=module -e '\
  import {readFileSync, readdirSync, writeFileSync} from "node:fs"; \
  import {createHash} from "node:crypto"; \
  const hash = bytes => createHash("sha256").update(bytes).digest("hex"); \
  const sourceRevision = process.env.SOURCE_COMMIT; \
  if (!/^[a-f0-9]{40}$/.test(sourceRevision) || sourceRevision === "0".repeat(40)) throw new Error("RUNTIME_IMAGE_SOURCE_INVALID"); \
  const root = "/opt/codex/agent-infra-skills"; \
  const bytes = readFileSync(`${root}/workspace-summary.manifest.json`); \
  const manifest = JSON.parse(bytes); \
  const entry = readFileSync(`${root}/workspace-summary/SKILL.md`); \
  const file = {path:"SKILL.md", sizeBytes:entry.length, sha256:hash(entry)}; \
  const inventory = JSON.stringify({domain:"agent-infra.skill-package.v1", files:[[file.path, file.sizeBytes, file.sha256]]}) + "\n"; \
  if (JSON.stringify(readdirSync(`${root}/workspace-summary`)) !== JSON.stringify(["SKILL.md"]) \
      || JSON.stringify(manifest.files) !== JSON.stringify([file]) \
      || manifest.packageDigest.sha256 !== hash(inventory)) throw new Error("RUNTIME_SKILL_PACKAGE_INVALID"); \
  writeFileSync("/opt/codex/share/workspace-summary-build.json", JSON.stringify({schemaVersion:1, sourceRevision, manifestSha256:hash(bytes), packageSha256:hash(inventory)}) + "\n");'
RUN chown -R 0:0 /opt/codex/agent-infra-skills \
    && chown 0:0 /opt/codex/share/workspace-summary-build.json \
    && chmod 0555 /opt/codex /opt/codex/bin /opt/codex/share \
       /opt/codex/agent-infra-skills /opt/codex/agent-infra-skills/workspace-summary \
    && chmod 0444 /opt/codex/agent-infra-skills/workspace-summary/SKILL.md \
       /opt/codex/agent-infra-skills/workspace-summary.manifest.json /opt/codex/share/workspace-summary-build.json
ENV AGENT_INFRA_RUNTIME_INSTALLED_SKILL=workspace-summary-v1
COPY --from=builder --chown=node:node /prod/agent-runtime-host/ ./
RUN node node_modules/@agent-infra/agent-runtime/node_modules/playwright-core/cli.js install-deps chromium \
    && rm -rf /var/lib/apt/lists/* /var/log/*
COPY --from=isolation-tools /bin/setpriv /usr/bin/setpriv
COPY --from=isolation-tools /lib/ld-musl-*.so.1 /usr/lib/
COPY --from=isolation-tools /usr/lib/libcap-ng.so.0* /usr/lib/libeconf.so.0* /usr/lib/
RUN setpriv --version | grep -Fx 'setpriv from util-linux 2.42.3' \
    && setpriv --help | grep -q -- '--landlock-access'
COPY --from=builder /app/deploy/runtime/browser-launch-probe.mjs ./browser-launch-probe.mjs
COPY --from=builder --chown=node:node /app/apps/agent-runtime-host/start-runtime-host.sh ./start-runtime-host.sh
RUN chmod 0755 ./start-runtime-host.sh
RUN mkdir -p /var/lib/agent-runtime && chown node:node /var/lib/agent-runtime
RUN mkdir -p /etc/agent-infra/legacy-migration \
    && chown root:root /etc/agent-infra /etc/agent-infra/legacy-migration \
    && chmod 0555 /etc/agent-infra /etc/agent-infra/legacy-migration
VOLUME ["/var/lib/agent-runtime"]
USER node
CMD ["/bin/sh", "./start-runtime-host.sh"]

# Test tools and source stay outside the default production image. The fixed
# installation is copied from this same production stage, never installed twice.
FROM builder AS installed-skill-test
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
LABEL org.agora.agent-infra.runtime-stage=installed-skill-test
COPY --from=runtime /opt/codex/ /opt/codex/
ENV AGENT_INFRA_RUNTIME_INSTALLED_SKILL=workspace-summary-v1
USER node

# Template images share the verified RuntimeHost installation. Registry/Worker
# supplies the required Driver; these artifact labels do not select a Driver.
FROM runtime AS codex
LABEL io.agora.agent.standard-template=codex

FROM runtime AS claude
LABEL io.agora.agent.standard-template=claude

FROM runtime AS opencode
LABEL io.agora.agent.standard-template=opencode

FROM runtime AS pi
LABEL io.agora.agent.standard-template=pi

FROM runtime AS runner
