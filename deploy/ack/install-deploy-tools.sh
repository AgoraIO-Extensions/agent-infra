#!/usr/bin/env bash
# Pinned client tools for the in-cluster deploy executor (workflow Spec §10.3): Helm with the
# helm-diff plugin, kubectl and pnpm. Every download is checked against a fixed SHA-256 before use.
# kubectl comes from the Aliyun mirror of pkgs.k8s.io because dl.k8s.io is slow from the cluster;
# the extracted binary must also match the official dl.k8s.io checksum.
set -euo pipefail

tools="${RUNNER_TEMP:?}/deploy-tools"
mkdir -p "$tools/bin" "$tools/helm-plugins" "$tools/download"

fetch() {
	local url=$1 sha256=$2 output=$3 actual
	curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
		--connect-timeout 10 --max-time 300 --retry 3 --retry-all-errors "$url" --output "$output"
	actual=$(sha256sum "$output" | awk '{print $1}')
	if [[ "$actual" != "$sha256" ]]; then
		printf 'checksum mismatch for %s: expected %s, got %s\n' "$url" "$sha256" "$actual" >&2
		exit 1
	fi
}

fetch https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.tar.gz \
	4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d "$tools/download/gh.tgz"
tar -xzf "$tools/download/gh.tgz" -C "$tools/bin" --strip-components=2 gh_2.103.3_linux_amd64/bin/gh

fetch https://get.helm.sh/helm-v3.18.5-linux-amd64.tar.gz \
	9879bf9c471cdecbbee5ee17cf1de1849b0ffd12871ea01f17ede6861d7134f5 "$tools/download/helm.tgz"
tar -xzf "$tools/download/helm.tgz" -C "$tools/bin" --strip-components=1 linux-amd64/helm

fetch https://github.com/databus23/helm-diff/releases/download/v3.15.15/helm-diff-linux-amd64.tgz \
	504e99410611daa70702362e1b10dc74929df8a912cb3f6b5d21d1ee9d0cb7d9 "$tools/download/helm-diff.tgz"
tar -xzf "$tools/download/helm-diff.tgz" -C "$tools/helm-plugins" diff/plugin.yaml diff/bin/diff

fetch https://mirrors.aliyun.com/kubernetes-new/core/stable/v1.36/deb/amd64/kubectl_1.36.6-1.1_amd64.deb \
	0588c400146c5287c40deaa007bdff8aecdf8a93d5ae0e374a99c61b76b8d83a "$tools/download/kubectl.deb"
dpkg-deb --fsys-tarfile "$tools/download/kubectl.deb" | tar -x -C "$tools/download" ./usr/bin/kubectl
if [[ "$(sha256sum "$tools/download/usr/bin/kubectl" | awk '{print $1}')" != 29818b6729dc9262b692307470d0558d027725e738be5dd47c760261868a2634 ]]; then
	echo "kubectl differs from the official v1.36.6 binary" >&2
	exit 1
fi
install -m 0755 "$tools/download/usr/bin/kubectl" "$tools/bin/kubectl"

fetch https://registry.npmmirror.com/pnpm/-/pnpm-11.20.0.tgz \
	34e198cb1e43237517ecedfd31f9ae26a6c0a3e5366ce58a2d05f4b21fb5f19a "$tools/download/pnpm.tgz"
mkdir -p "$tools/pnpm"
tar -xzf "$tools/download/pnpm.tgz" -C "$tools/pnpm" --strip-components=1
printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$tools/pnpm/bin/pnpm.mjs" > "$tools/bin/pnpm"
chmod 0755 "$tools/bin/pnpm"

rm -rf "$tools/download"
echo "$tools/bin" >> "${GITHUB_PATH:?}"
echo "HELM_PLUGINS=$tools/helm-plugins" >> "${GITHUB_ENV:?}"
