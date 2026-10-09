#!/usr/bin/env bash
set -euo pipefail
for option in "$@"; do
  if [[ "$option" == "--deploy" ]]; then
    echo "GZ3 is retired. Use pnpm connection:release with an explicit Shanghai kubeconfig." >&2
    exit 2
  fi
done
echo "Deprecated alias: use pnpm connection:release." >&2
exec bash "$(dirname "$0")/connection-release.sh" "$@"
