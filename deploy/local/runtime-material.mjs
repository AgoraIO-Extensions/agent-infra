// Deployment-owned Runtime material for the fixed local E2E Harness.
// Pure helpers are exported for tests; the issuer shells out to openssl with
// files in a private temporary directory, never argv or logs.

import { execFileSync } from "node:child_process";
import {
	createHash,
	createPrivateKey,
	randomBytes,
	X509Certificate,
} from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const harnessOwner = "agent-infra-e2e-harness";
export const ownerLabel = "app.kubernetes.io/managed-by";
export const bindingsKey = "runtime-tls-bindings.json";

const serverAuth = "1.3.6.1.5.5.7.3.1";
const ociIndex = "application/vnd.oci.image.index.v1+json";
const ociManifest = "application/vnd.oci.image.manifest.v1+json";
const dockerList = "application/vnd.docker.distribution.manifest.list.v2+json";
const dockerManifest =
	"application/vnd.docker.distribution.manifest.v2+json";
const beginDns = "# BEGIN agent-infra-e2e-harness dns-forward";
const endDns = "# END agent-infra-e2e-harness dns-forward";
const day = 24 * 60 * 60 * 1000;

/** Mirrors workloadResourceNameV1 in apps/platform-worker. */
export function workloadResourceName(agentId) {
	return `agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}`;
}

/** Runtime HLD §4.1: one leaf covers the business and `-probe` Services. */
export function runtimeTlsBinding(agentId, namespace) {
	const name = workloadResourceName(agentId);
	return {
		agentId,
		namespace,
		serviceDnsNames: [`${name}.${namespace}.svc`, `${name}-probe.${namespace}.svc`],
		serverSecretRef: { name: `${name}-runtime-tls` },
	};
}

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

/** Mirrors the Worker Secret checks and requires the current Harness CA. */
export function isUsableLeaf(
	{ cert, key },
	serviceDnsNames,
	caPem,
	{ now = Date.now(), minRemainingMs = 7 * day } = {},
) {
	try {
		const chain = certificates(cert);
		const [ca] = certificates(caPem);
		const [leaf] = chain;
		return (
			chain.length >= 2 &&
			!leaf.ca &&
			leaf.keyUsage?.includes(serverAuth) &&
			leaf.checkPrivateKey(createPrivateKey(key)) &&
			chain[1].fingerprint256 === ca.fingerprint256 &&
			leaf.checkIssued(ca) &&
			leaf.verify(ca.publicKey) &&
			now >= leaf.validFromDate.getTime() &&
			leaf.validToDate.getTime() - now > minRemainingMs &&
			ca.validToDate.getTime() - now > minRemainingMs &&
			serviceDnsNames.every(
				(dns) =>
					leaf.checkHost(dns, { subject: "never", wildcards: false }) === dns,
			)
		);
	} catch {
		return false;
	}
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

function openssl(args, cwd) {
	execFileSync(process.env.OPENSSL_BIN ?? "openssl", args, {
		cwd,
		stdio: ["ignore", "ignore", "pipe"],
	});
}

async function withPrivateDirectory(parent, task) {
	const directory = await mkdtemp(join(parent, "issue-"));
	try {
		return await task(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Issues a local E2E Runtime CA into a private working directory. */
export async function issueCa(parent, { days = 365 } = {}) {
	return withPrivateDirectory(parent, async (directory) => {
		await writeFile(
			join(directory, "ca.cnf"),
			"[req]\ndistinguished_name = dn\nprompt = no\nx509_extensions = v3\n[dn]\nCN = agent-infra-e2e Runtime CA\n[v3]\nbasicConstraints = critical, CA:TRUE, pathlen:0\nkeyUsage = critical, keyCertSign, cRLSign\nsubjectKeyIdentifier = hash\n",
		);
		openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", "ca.key"], directory);
		openssl(["req", "-x509", "-new", "-key", "ca.key", "-config", "ca.cnf", "-days", String(days), "-sha256", "-out", "ca.crt"], directory);
		return {
			cert: await readFile(join(directory, "ca.crt"), "utf8"),
			key: await readFile(join(directory, "ca.key"), "utf8"),
		};
	});
}

/** Issues one server leaf; tls.crt is leaf followed by the issuing CA. */
export async function issueLeaf(parent, ca, serviceDnsNames, { days = 30 } = {}) {
	return withPrivateDirectory(parent, async (directory) => {
		await writeFile(join(directory, "ca.crt"), ca.cert);
		await writeFile(join(directory, "ca.key"), ca.key, { mode: 0o600 });
		await writeFile(
			join(directory, "leaf.cnf"),
			`[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = ${serviceDnsNames[0]}\n[v3]\nbasicConstraints = critical, CA:FALSE\nkeyUsage = critical, digitalSignature\nextendedKeyUsage = serverAuth\nsubjectAltName = ${serviceDnsNames.map((dns) => `DNS:${dns}`).join(", ")}\nauthorityKeyIdentifier = keyid\nsubjectKeyIdentifier = hash\n`,
		);
		openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", "leaf.key"], directory);
		openssl(["req", "-new", "-key", "leaf.key", "-config", "leaf.cnf", "-out", "leaf.csr"], directory);
		openssl(
			["x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-set_serial", `0x${randomBytes(16).toString("hex")}`, "-days", String(days), "-sha256", "-extfile", "leaf.cnf", "-extensions", "v3", "-out", "leaf.crt"],
			directory,
		);
		const leaf = await readFile(join(directory, "leaf.crt"), "utf8");
		return {
			cert: `${leaf.trim()}\n${ca.cert.trim()}\n`,
			key: await readFile(join(directory, "leaf.key"), "utf8"),
		};
	});
}

export function fingerprint(parts) {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(String(part.length)).update(":").update(part);
	return hash.digest("hex");
}
