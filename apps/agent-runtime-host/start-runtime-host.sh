#!/bin/sh
set -eu

# Refuse diagnostic preloads before Node can load any runtime configuration.
if [ -n "${NODE_OPTIONS:-}${NODE_DEBUG:-}${NODE_DEBUG_NATIVE:-}${NODE_V8_COVERAGE:-}${NODE_PATH:-}${LD_PRELOAD:-}${LD_AUDIT:-}${LD_LIBRARY_PATH:-}${DYLD_INSERT_LIBRARIES:-}${DYLD_LIBRARY_PATH:-}${DYLD_FRAMEWORK_PATH:-}" ]; then
  printf '%s\n' '{"service":"agent-runtime-host","code":"RUNTIME_PROCESS_PROTECTION_INVALID"}' >&2
  exit 1
fi
ulimit -S -c 0
ulimit -H -c 0
unset AGENT_INFRA_RUNTIME_DEV
case "$#:${1:-}" in
  0:) exec node --disable-sigusr1 dist/index.mjs ;;
  # Development watches compiled output; run pnpm build --watch separately.
  1:--dev) exec node --disable-sigusr1 --watch dist/index.mjs ;;
  *) exit 1 ;;
esac
