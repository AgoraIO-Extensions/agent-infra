// Deployment-owned Runtime material for the fixed local E2E Harness.
// Worker -> Runtime is in-cluster plaintext (ADR-0020), so no Runtime CA or
// server leaf is issued here. Pure helpers are exported for tests.

import { createHash, X509Certificate } from "node:crypto";

export const harnessOwner = "agent-infra-e2e-harness";
export const ownerLabel = "app.kubernetes.io/managed-by";

const ociIndex = "application/vnd.oci.image.index.v1+json";
const ociManifest = "application/vnd.oci.image.manifest.v1+json";
const dockerList = "application/vnd.docker.distribution.manifest.list.v2+json";
const dockerManifest =
	"application/vnd.docker.distribution.manifest.v2+json";
const beginDns = "# BEGIN agent-infra-e2e-harness dns-forward";
const endDns = "# END agent-infra-e2e-harness dns-forward";
const day = 24 * 60 * 60 * 1000;

/** Parses `zone=ip,ip;zone=ip` from private env. */
export function parseDnsForward(value) {
	if (!value?.trim()) return [];
	return value
		.split(";")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const [zone, upstreams = ""] = entry.split("=");
			const servers = upstreams.split(",").map((server) => server.trim());
			if (
				!/^(?:[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
					zone ?? "",
				) ||
				!servers.length ||
				!servers.every((server) => /^[0-9a-f.:]+$/i.test(server))
			)
				throw new Error(`Invalid cluster DNS forward entry: ${entry}`);
			return { zone, upstreams: servers };
		});
}

/** Replaces only the Harness-marked block; other Corefile content is kept. */
export function corefileWithForwardZones(corefile, zones) {
	const pattern = new RegExp(`${beginDns}[\\s\\S]*?${endDns}\\n?`, "g");
	const base = corefile.replace(pattern, "");
	if (!zones.length) return base;
	const blocks = zones
		.map(
			({ zone, upstreams }) =>
				`${zone}:53 {\n    errors\n    cache 30\n    forward . ${upstreams.join(" ")} {\n        policy sequential\n    }\n}\n`,
		)
		.join("");
	return `${beginDns}\n${blocks}${endDns}\n${base}`;
}

/**
 * Returns the single current-platform manifest Digest for an index, or null
 * when the document is already an image manifest. Ambiguity fails closed.
 */
export function selectPlatformManifest(document, platform) {
	const mediaType = document?.mediaType;
	if (mediaType === ociManifest || mediaType === dockerManifest) return null;
	if (mediaType !== ociIndex && mediaType !== dockerList)
		throw new Error("Runtime image binding is not an OCI manifest or index");
	const [os, architecture, variant] = platform.split("/");
	const matches = (document.manifests ?? []).filter(
		(entry) =>
			[ociManifest, dockerManifest].includes(entry?.mediaType) &&
			entry.platform?.os === os &&
			entry.platform?.architecture === architecture &&
			(!variant || entry.platform?.variant === variant),
	);
	if (matches.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest))
		throw new Error(`Runtime image index has no unique ${platform} manifest`);
	return matches[0].digest;
}

function certificates(pem) {
	const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
	const blocks = pem.match(pattern);
	if (!blocks?.length || pem.replace(pattern, "").trim())
		throw new Error("Invalid certificate bundle");
	return blocks.map((block) => new X509Certificate(block));
}

/** True when every certificate is a currently valid CA certificate. */
export function isUsableCa(caPem, { now = Date.now(), minRemainingMs = 30 * day } = {}) {
	try {
		return certificates(caPem).every(
			(certificate) =>
				certificate.ca &&
				now >= certificate.validFromDate.getTime() &&
				certificate.validToDate.getTime() - now > minRemainingMs,
		);
	} catch {
		return false;
	}
}

export function fingerprint(parts) {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(String(part.length)).update(":").update(part);
	return hash.digest("hex");
}
