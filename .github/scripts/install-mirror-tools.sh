#!/usr/bin/env bash
# Only public, pinned client tools. Registry credentials belong to the later copy step.
set -euo pipefail
trap 'echo MIRROR_TOOL_INSTALL_FAILED >&2' ERR

tools="${RUNNER_TEMP:?}/mirror-tools"
mkdir -p "$tools/bin"

source "$(dirname "${BASH_SOURCE[0]}")/../../deploy/ack/fetch-deploy-tool.sh"

mirror_fetch() {
	local status
	if fetch "$1" "$2" "$3" 240 1024 20 4 65; then
		return 0
	else
		status=$?
	fi
	if [[ "$status" == 65 ]]; then
		echo MIRROR_TOOL_CHECKSUM_MISMATCH >&2
	else
		echo MIRROR_TOOL_DOWNLOAD_FAILED >&2
	fi
	return 1
}

mirror_fetch https://api.github.com/repos/google/go-containerregistry/releases/assets/543544389 \
	0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0 "$tools/crane.tgz"
tar -xzf "$tools/crane.tgz" -C "$tools/bin" crane

mirror_fetch https://api.github.com/repos/cli/cli/releases/assets/761188566 \
	79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f "$tools/gh.tgz"
tar -xzf "$tools/gh.tgz" -C "$tools/bin" --strip-components=2 gh_2.105.0_linux_amd64/bin/gh

echo "$tools/bin" >> "${GITHUB_PATH:?}"
