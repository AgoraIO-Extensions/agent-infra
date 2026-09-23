#!/bin/sh
set -eu

# The image entrypoint must never resolve executables from Workload input.
PATH=/opt/codex/bin:/usr/local/bin:/usr/bin:/bin
export PATH
runtime_node=/usr/local/bin/node

# Refuse diagnostic preloads before Node can load any runtime configuration.
# Presence is the security boundary: an explicitly empty loader variable must
# be rejected just like a non-empty one, before the Node process starts.
if [ -n "${NODE_OPTIONS+x}${NODE_DEBUG+x}${NODE_DEBUG_NATIVE+x}${NODE_V8_COVERAGE+x}${NODE_PATH+x}${LD_PRELOAD+x}${LD_AUDIT+x}${LD_LIBRARY_PATH+x}${DYLD_INSERT_LIBRARIES+x}${DYLD_LIBRARY_PATH+x}${DYLD_FRAMEWORK_PATH+x}" ] ||
  /usr/bin/env | grep -Eq '^(LD_|DYLD_)'; then
  printf '%s\n' '{"service":"agent-runtime-host","code":"RUNTIME_PROCESS_PROTECTION_INVALID"}' >&2
  exit 1
fi
ulimit -S -c 0
ulimit -H -c 0
unset AGENT_INFRA_RUNTIME_DEV
case "$#:${1:-}" in
  0:) ;;
  # Local development explicitly supplies its installed Node; image startup
  # never reads npm_node_execpath or another caller-provided executable path.
  2:--dev)
    case "$2" in
      /*) runtime_node=$2 ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
exec "$runtime_node" --disable-sigusr1 dist/index.mjs
