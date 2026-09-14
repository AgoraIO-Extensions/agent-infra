#!/usr/bin/env bash
set -euo pipefail

# Keep orchestration, process-group cancellation and JSON handling in Python.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "${script_dir}/build-linux-aarch64.py" "$@"
