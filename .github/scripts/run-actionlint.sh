#!/usr/bin/env bash
set -euo pipefail

version="1.7.12"
platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
machine="$(uname -m)"

case "${platform}/${machine}" in
  darwin/x86_64)
    target="darwin_amd64"
    expected_sha256="5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644"
    ;;
  darwin/arm64)
    target="darwin_arm64"
    expected_sha256="aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f"
    ;;
  linux/x86_64)
    target="linux_amd64"
    expected_sha256="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
    ;;
  linux/aarch64 | linux/arm64)
    target="linux_arm64"
    expected_sha256="325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6"
    ;;
  *)
    printf 'Unsupported actionlint platform: %s/%s\n' "$platform" "$machine" >&2
    exit 1
    ;;
esac

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT

archive="actionlint_${version}_${target}.tar.gz"
url="https://github.com/rhysd/actionlint/releases/download/v${version}/${archive}"
curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
  --connect-timeout 10 --max-time 120 --retry 3 --retry-all-errors \
  "$url" --output "${temporary_directory}/${archive}"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "${temporary_directory}/${archive}" | awk '{print $1}')"
else
  actual_sha256="$(shasum -a 256 "${temporary_directory}/${archive}" | awk '{print $1}')"
fi

if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  printf 'actionlint checksum mismatch: expected %s, got %s\n' \
    "$expected_sha256" "$actual_sha256" >&2
  exit 1
fi

tar -xzf "${temporary_directory}/${archive}" -C "$temporary_directory" actionlint
"${temporary_directory}/actionlint" -color
