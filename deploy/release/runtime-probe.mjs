import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { safeRuntimeProbeFailure } from "../../tests/support/runtime-probe-diagnostics.mjs";
export { safeRuntimeProbeFailure } from "../../tests/support/runtime-probe-diagnostics.mjs";

import { runCommand } from "./run-command.mjs";

const root = resolve(import.meta.dirname, "../..");
const digestPattern = /^sha256:(?!0{64}$)[a-f0-9]{64}$/;
const releasePath = "packages/agent-runtime/src/codex-release.json";
const sha256 = (bytes) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hasKeys = (value, keys) =>
	value &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.keys(value).sort().join(",") === keys;

async function createRuntimeHostTlsFixture() {
	const directory = await mkdtemp(join(tmpdir(), "runtime-host-tls-probe-"));
	const agentId = "synthetic-agent";
	const namespace = "default";
	const serviceName = `agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}`;
	const serviceDnsNames = [
		`${serviceName}.${namespace}.svc`,
		`${serviceName}-probe.${namespace}.svc`,
	];
	const run = (...args) =>
		execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
	try {
		await writeFile(
			join(directory, "ca.cnf"),
			"[req]\ndistinguished_name=dn\nx509_extensions=ca_extensions\n[dn]\n[ca_extensions]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n",
		);
		run(
			"req",
			"-x509",
			"-config",
			"ca.cnf",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"2",
			"-subj",
			"/CN=Runtime probe CA",
			"-keyout",
			"ca.key",
			"-out",
			"ca.crt",
		);
		run(
			"req",
			"-new",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-subj",
			`/CN=${serviceDnsNames[0]}`,
			"-keyout",
			"tls.key",
			"-out",
			"tls.csr",
		);
		await writeFile(
			join(directory, "extensions.cnf"),
			[
				"basicConstraints=critical,CA:FALSE",
				"keyUsage=critical,digitalSignature,keyEncipherment",
				"extendedKeyUsage=serverAuth",
				`subjectAltName=${serviceDnsNames.map((name) => `DNS:${name}`).join(",")}`,
			].join("\n"),
		);
		run(
			"x509",
			"-req",
			"-in",
			"tls.csr",
			"-CA",
			"ca.crt",
			"-CAkey",
			"ca.key",
			"-CAcreateserial",
			"-days",
			"1",
			"-extfile",
			"extensions.cnf",
			"-out",
			"tls.crt",
		);
		await chmod(directory, 0o755);
		await chmod(join(directory, "tls.crt"), 0o444);
		await chmod(join(directory, "tls.key"), 0o444);
		return {
			directory,
			cleanup: () => rm(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

function officialRelease(bytes) {
	const release = JSON.parse(bytes);
	if (
		!hasKeys(release, "artifacts,legal,provenance") ||
		!hasKeys(
			release.provenance,
			"codexVersion,protocolVersion,schemaSha256,upstreamCommit,upstreamTag",
		) ||
		release.provenance.protocolVersion !== 2 ||
		!/^\d+\.\d+\.\d+$/.test(release.provenance.codexVersion) ||
		release.provenance.upstreamTag !==
			`rust-v${release.provenance.codexVersion}` ||
		!/^([a-f0-9]{40})$/.test(release.provenance.upstreamCommit) ||
		!digestPattern.test(release.provenance.schemaSha256) ||
		!hasKeys(release.artifacts, "amd64,arm64") ||
		!hasKeys(release.legal, "LICENSE,NOTICE") ||
		!Object.values(release.legal).every((digest) => digestPattern.test(digest))
	)
		throw new Error();
	for (const [architecture, target] of [
		["amd64", "x86_64"],
		["arm64", "aarch64"],
	]) {
		const artifact = release.artifacts[architecture];
		if (
			!hasKeys(artifact, "archiveSha256,executableSha256,name") ||
			artifact.name !== `codex-${target}-unknown-linux-musl` ||
			!digestPattern.test(artifact.archiveSha256) ||
			!digestPattern.test(artifact.executableSha256)
		)
			throw new Error();
	}
	return release;
}
const requiredChecks = [
	"configuration-fail-closed",
	"native-active-default-model",
	"native-execution-selection",
	"submit-idempotency",
	"selection-conflict",
	"grant-and-agent-binding",
	"persistent-runtime-restart",
	"http-failures-redacted",
	"stream-failures-redacted",
	"cancellation-aborts-upstream",
	"native-shell-rejected-without-side-effects",
	"native-apply-patch-rejected-without-side-effects",
	"recursive-native-storage-redacted",
	"personal-configuration-isolated",
];

export function validateRuntimeProbe(result, releaseBytes, architecture) {
	let release;
	try {
		release = officialRelease(releaseBytes);
		if (!["amd64", "arm64"].includes(architecture)) throw new Error();
	} catch {
		throw new Error("Codex runtime image probe evidence is invalid");
	}
	const artifact = release.artifacts[architecture];
	if (
		result?.schemaVersion !== 1 ||
		result.status !== "passed" ||
		result.capability !== "official-model-only" ||
		Object.keys(result).sort().join(",") !==
			"capability,checks,codexVersion,configVersion,configurationSchemaVersion,installation,schemaVersion,status" ||
		result.codexVersion !== release.provenance.codexVersion ||
		!hasKeys(
			result.installation,
			"architecture,archiveSha256,executableSha256,platform,releaseSha256",
		) ||
		result.installation.platform !== "linux" ||
		result.installation.architecture !== architecture ||
		result.installation.releaseSha256 !== sha256(releaseBytes) ||
		result.installation.archiveSha256 !== artifact.archiveSha256 ||
		result.installation.executableSha256 !== artifact.executableSha256 ||
		result.configurationSchemaVersion !== 2 ||
		result.configVersion !== "synthetic-active-v2" ||
		!Array.isArray(result.checks) ||
		result.checks.length !== requiredChecks.length ||
		!requiredChecks.every((check) => result.checks.includes(check))
	) {
		throw new Error("Codex runtime image probe evidence is invalid");
	}
	return result;
}

export function runtimeImageFromScanBuild(manifest, commitSha) {
	const images = Array.isArray(manifest?.images)
		? manifest.images.filter((image) => image?.name === "agent-runtime-host")
		: [];
	if (
		manifest?.schemaVersion !== 1 ||
		manifest.source?.commit !== commitSha ||
		!Array.isArray(images) ||
		images.length !== 1 ||
		!digestPattern.test(images[0].imageId)
	) {
		throw new Error("Runtime image scanner build reference is invalid");
	}
	return images[0].imageId;
}

export function assertCleanRuntimeProbeSource(status, commitSha) {
	if (status.trim()) {
		throw new Error("Codex runtime image probe requires a clean checkout");
	}
	if (!/^[a-f0-9]{40}$/.test(commitSha)) {
		throw new Error("Codex runtime image probe source is invalid");
	}
	return { commitSha, sourceDirty: false };
}

class RuntimeProbeFailure extends Error {}

export async function probeRuntimeImage({
	image,
	source,
	imageDigest,
	contextPath = root,
}) {
	if (
		!source ||
		!/^[a-f0-9]{40}$/.test(source.commitSha) ||
		source.sourceDirty !== false ||
		Object.keys(source).sort().join(",") !== "commitSha,sourceDirty" ||
		(imageDigest && !digestPattern.test(imageDigest))
	) {
		throw new Error("Codex runtime image probe source is invalid");
	}
	const { commitSha } = source;
	const git = process.env.GIT_BIN ?? "git";
	const gitOptions = {
		cwd: root,
		name: "Runtime probe source identity",
		timeoutMs: 30_000,
	};
	const sourceTree = runCommand(
		git,
		["rev-parse", `${commitSha}^{tree}`],
		gitOptions,
	);
	if (!/^[a-f0-9]{40}$/.test(sourceTree))
		throw new Error("Codex runtime image probe source is invalid");
	const releaseBytes = await readFile(join(contextPath, releasePath));
	const sourceReleaseBytes = runCommand(
		git,
		["show", `${commitSha}:${releasePath}`],
		{ ...gitOptions, trimOutput: false },
	);
	try {
		officialRelease(releaseBytes);
		if (sha256(releaseBytes) !== sha256(sourceReleaseBytes)) throw new Error();
	} catch {
		throw new Error("Codex runtime image release does not match source");
	}
	const docker = process.env.DOCKER_BIN ?? "docker";
	const command = (args, name, timeoutMs = 30_000, onFailure) =>
		runCommand(docker, args, { cwd: root, name, timeoutMs, onFailure });
	const inspect = () => {
		try {
			const inspection = JSON.parse(
				command(
					["image", "inspect", "--format", "{{json .}}", image],
					"Runtime image inspection",
				),
			);
			if (!digestPattern.test(inspection.Id)) throw new Error();
			return inspection;
		} catch {
			throw new Error("Codex runtime image identity is unavailable");
		}
	};
	const inspection = inspect();
	if (
		inspection.Os !== "linux" ||
		!["amd64", "arm64"].includes(inspection.Architecture)
	) {
		throw new Error("Codex runtime image platform is invalid");
	}
	if (
		inspection.Config?.Labels?.["org.opencontainers.image.revision"] !==
		commitSha
	) {
		throw new Error(
			"Codex runtime image source commit does not match checkout",
		);
	}
	if (imageDigest && imageDigest !== inspection.Descriptor?.digest) {
		throw new Error("Codex runtime image digest does not match verified build");
	}
	const labels = process.env.AO_SESSION_ID
		? ["--label", `ao.session=${process.env.AO_SESSION_ID}`]
		: [];
	const tlsFixture = await createRuntimeHostTlsFixture();
	try {
	const run = (mounts = [], args = []) =>
		command(
			[
				"run",
				"--rm",
				...labels,
				"--pull=never",
				"--network=none",
				"--read-only",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--tmpfs",
				"/tmp:size=128m,mode=1777",
				"--tmpfs",
				"/var/lib/agent-runtime:size=128m,uid=1000,gid=1000,mode=0700",
				"--mount",
				`type=bind,src=${tlsFixture.directory},dst=/var/run/agent-infra/runtime-tls,readonly`,
				"--mount",
				`type=bind,src=${join(contextPath, "tests/runtime-image-probe.mjs")},dst=/probe/runtime-image-probe.mjs,readonly`,
				"--mount",
				`type=bind,src=${join(contextPath, "tests/support/runtime-probe-diagnostics.mjs")},dst=/probe/support/runtime-probe-diagnostics.mjs,readonly`,
				...mounts,
				inspection.Id,
				"node",
				"/probe/runtime-image-probe.mjs",
				...args,
			],
			"Native Codex HTTP/SSE image probe",
			180_000,
			(stderr) => {
				const detail = safeRuntimeProbeFailure(stderr);
				if (detail)
					throw new RuntimeProbeFailure(
						`Native Codex HTTP/SSE image probe failed: ${detail}`,
					);
			},
		);
	let result;
	try {
		result = validateRuntimeProbe(
			JSON.parse(run()),
			releaseBytes,
			inspection.Architecture,
		);
	} catch (error) {
		if (error instanceof RuntimeProbeFailure) throw error;
		throw new Error("Native Codex HTTP/SSE image probe failed");
	}
	try {
		const rejection = JSON.parse(
			run(
				[
					"--mount",
					`type=bind,src=${join(contextPath, "tests/runtime-image-probe.mjs")},dst=/opt/codex/bin/codex,readonly`,
				],
				["--provenance-rejection"],
			),
		);
		if (
			rejection?.status !== "passed" ||
			rejection.check !== "provenance-fail-closed"
		) {
			throw new Error();
		}
	} catch {
		throw new Error("Codex image provenance rejection probe failed");
	}
	if (
		sha256(await readFile(join(contextPath, releasePath))) !==
		sha256(releaseBytes)
	) {
		throw new Error("Codex runtime image release changed during probe");
	}
	const after = inspect();
	if (
		after.Id !== inspection.Id ||
		after.Architecture !== inspection.Architecture ||
		after.Os !== inspection.Os ||
		after.Config?.Labels?.["org.opencontainers.image.revision"] !== commitSha ||
		after.Descriptor?.digest !== inspection.Descriptor?.digest
	) {
		throw new Error("Codex runtime image changed during probe");
	}
	return {
		schemaVersion: 1,
		...source,
		sourceTree,
		imageId: inspection.Id,
		...(imageDigest
			? { imageDigest }
			: digestPattern.test(inspection.Descriptor?.digest)
				? { imageDigest: inspection.Descriptor.digest }
				: {}),
		probe: result,
		provenanceRejection: "passed",
	};
	} finally {
		await tlsFixture.cleanup();
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		let [image, output, ...extra] = process.argv.slice(2);
		if (!image || !output) {
			throw new Error("usage: runtime-probe.mjs <image> <evidence.json>");
		}
		const commitSha = runCommand("git", ["rev-parse", "HEAD"], {
			cwd: root,
			name: "Runtime probe source",
			timeoutMs: 30_000,
		});
		if (image === "--scan-build") {
			image = runtimeImageFromScanBuild(
				JSON.parse(await readFile(output, "utf8")),
				commitSha,
			);
			[output, ...extra] = extra;
		}
		if (!output || extra.length) {
			throw new Error("Runtime image probe arguments are invalid");
		}
		const status = runCommand("git", ["status", "--porcelain"], {
			cwd: root,
			name: "Runtime probe checkout",
			timeoutMs: 30_000,
		});
		const source = assertCleanRuntimeProbeSource(status, commitSha);
		const evidence = await probeRuntimeImage({ image, source });
		await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, {
			flag: "wx",
		});
		console.info("Codex runtime image probe passed");
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
