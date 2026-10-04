# Experimental derived runtime. It is not used by the workflow until its digest,
# provenance attestation, and native receipts are accepted.
FROM pragent/pr-agent@sha256:548b760b81ab4b3f729182428695ccc1194bbf87528c2b1e2b2b07e5223af7b6

ARG SOURCE_COMMIT=8e5a9295973b24af4b70cafd0b660a230811ef9e
ARG PATCH_SHA256=2c104ce92d670705e9fb2910660dba040f29ca98d4f7b25853b6294ba02e5cae

LABEL org.opencontainers.image.title="agent-infra PR-Agent plain-diff derived runtime" \
      org.opencontainers.image.description="Preserves parsed plain-diff files for lockfile review" \
      org.opencontainers.image.source="https://github.com/The-PR-Agent/pr-agent" \
      org.opencontainers.image.revision="$SOURCE_COMMIT" \
      io.agora.agent-infra.runtime-kind="derived" \
      io.agora.agent-infra.provider="plain-diff-derived" \
      io.agora.agent-infra.source-commit="$SOURCE_COMMIT" \
      io.agora.agent-infra.patch-sha256="$PATCH_SHA256"

COPY patches/pr-agent-v0.47.0-preserve-plain-diff.patch /tmp/pr-agent-v0.47.0-preserve-plain-diff.patch
RUN set -eux; \
    test "$(sha256sum /app/pr_agent/algo/language_handler.py | cut -d ' ' -f 1)" = "738f6f000a42f20834afa25a0d933457b21ef56415ea84c8ad589e175f671710"; \
    test "$(sha256sum /app/pr_agent/algo/pr_processing.py | cut -d ' ' -f 1)" = "519006cf43479d8d6570d1e7333e9f61b19ada30b21c3a435baff6081a5e4b5e"; \
    test "$(sha256sum /app/pr_agent/git_providers/plain_diff_provider.py | cut -d ' ' -f 1)" = "b52c64e91bdf4cadc862e088dc1598371dd3b2f8131dbfb408d97b52c2e7e2b7"; \
    test "$(sha256sum /tmp/pr-agent-v0.47.0-preserve-plain-diff.patch | cut -d ' ' -f 1)" = "$PATCH_SHA256"; \
    apt-get update; \
    apt-get install --no-install-recommends -y patch; \
    cd /app; \
    patch --batch --forward --fuzz=0 -p1 < /tmp/pr-agent-v0.47.0-preserve-plain-diff.patch; \
    python -m py_compile pr_agent/algo/language_handler.py pr_agent/algo/pr_processing.py pr_agent/git_providers/plain_diff_provider.py; \
    apt-get purge -y patch; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/* /tmp/pr-agent-v0.47.0-preserve-plain-diff.patch
