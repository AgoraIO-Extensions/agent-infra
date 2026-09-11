#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == run ]]; then
  shift
  exec "${WORKLOAD_DOCKER_BIN:?}" run --label "ao.session=${AO_SESSION_ID:-workload-kind}" "$@"
fi
exec "${WORKLOAD_DOCKER_BIN:?}" "$@"
