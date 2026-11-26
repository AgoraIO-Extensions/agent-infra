#!/usr/bin/env bash
# Only public, pinned client tools. Registry credentials belong to the later copy step.
set -euo pipefail
trap 'echo MIRROR_TOOL_INSTALL_FAILED >&2' ERR

tools="${RUNNER_TEMP:?}/mirror-tools"
mkdir -p "$tools/bin"

fetch() {
	local url=$1 expected=$2 output=$3 actual
	# At 100 KiB/s the larger pinned archive takes 162 seconds, plus connection time.
	if ! curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
		--connect-timeout 10 --max-time 240 --speed-limit 102400 --speed-time 20 \
		--retry 3 --retry-all-errors --header 'Accept: application/octet-stream' \
		"$url" --output "$output"; then
		echo MIRROR_TOOL_DOWNLOAD_FAILED >&2
		exit 1
	fi
	actual=$(sha256sum "$output" | awk '{print $1}')
	if [[ "$actual" != "$expected" ]]; then
		echo MIRROR_TOOL_CHECKSUM_MISMATCH >&2
		exit 1
	fi
}

fetch https://api.github.com/repos/google/go-containerregistry/releases/assets/543544389 \
	0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0 "$tools/crane.tgz"
tar -xzf "$tools/crane.tgz" -C "$tools/bin" crane

fetch https://api.github.com/repos/cli/cli/releases/assets/761188566 \
	79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f "$tools/gh.tgz"
tar -xzf "$tools/gh.tgz" -C "$tools/bin" --strip-components=2 gh_2.105.0_linux_amd64/bin/gh

echo "$tools/bin" >> "${GITHUB_PATH:?}"
