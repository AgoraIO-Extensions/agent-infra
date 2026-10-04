# Experimental derived runtime. It is not used by the workflow until its digest,
# provenance attestation, and native receipts are accepted.
FROM pragent/pr-agent@sha256:548b760b81ab4b3f729182428695ccc1194bbf87528c2b1e2b2b07e5223af7b6

ARG SOURCE_COMMIT=46d7ee02b77bc1f323c327e32be4ee70e4cd306a
ARG PATCH_SHA256=2c0befeb4194fd4f866c1b7123cc7c66d5b81f7711d0ac9c512f7fff60895803

LABEL org.opencontainers.image.title="agent-infra PR-Agent plain-diff derived runtime" \
      org.opencontainers.image.description="Preserves parsed plain-diff files for lockfile review" \
      org.opencontainers.image.source="https://github.com/The-PR-Agent/pr-agent/tree/$SOURCE_COMMIT" \
      org.opencontainers.image.revision="$SOURCE_COMMIT" \
      io.agora.agent-infra.runtime-kind="derived" \
      io.agora.agent-infra.provider="plain-diff-derived" \
      io.agora.agent-infra.source-commit="$SOURCE_COMMIT" \
      io.agora.agent-infra.patch-sha256="$PATCH_SHA256"

COPY patches/pr-agent-46d7ee02-preserve-plain-diff.patch /tmp/pr-agent-46d7ee02-preserve-plain-diff.patch
RUN set -eux; \
    test "$(sha256sum /app/pr_agent/algo/language_handler.py | cut -d ' ' -f 1)" = "37453385f735cc3e14cbe531a5768e82ad0ce9bd583e97652adbe32cb4d94637"; \
    test "$(sha256sum /app/pr_agent/algo/pr_processing.py | cut -d ' ' -f 1)" = "7e13b6f7073f3eeb1d0c135f4f5fe91934cdc0732e036eecb71c6bcbd3d798f"; \
    test "$(sha256sum /app/pr_agent/git_providers/plain_diff_provider.py | cut -d ' ' -f 1)" = "b9a4f6e81fc591dd9dc157d15492fe26e4c0ca3fcd63b78b9a15b4dc9b84cb53"; \
    test "$(sha256sum /tmp/pr-agent-46d7ee02-preserve-plain-diff.patch | cut -d ' ' -f 1)" = "$PATCH_SHA256"; \
    apt-get update; \
    apt-get install --no-install-recommends -y patch; \
    cd /app; \
    patch --batch --forward --fuzz=0 -p1 < /tmp/pr-agent-46d7ee02-preserve-plain-diff.patch; \
    python -m py_compile pr_agent/algo/language_handler.py pr_agent/algo/pr_processing.py pr_agent/git_providers/plain_diff_provider.py; \
    apt-get purge -y patch; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/* /tmp/pr-agent-46d7ee02-preserve-plain-diff.patch
