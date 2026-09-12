import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { safeRuntimeProbeFailure } from "../../tests/support/runtime-probe-diagnostics.mjs";
export { safeRuntimeProbeFailure } from "../../tests/support/runtime-probe-diagnostics.mjs";

import { runCommand } from "./run-command.mjs";

const root = resolve(import.meta.dirname, "../..");
const digestPattern = /^sha256:[a-f0-9]{64}$/;
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
	"native-sandboxed-tool-execution",
	"native-sibling-conversation-denied",
	"recursive-native-storage-redacted",
	"personal-configuration-isolated",
];

export function validateRuntimeProbe(result) {
	if (
		result?.schemaVersion !== 1 ||
		result.status !== "passed" ||
		Object.keys(result).sort().join(",") !==
			"checks,codexVersion,configVersion,configurationSchemaVersion,schemaVersion,status" ||
		result.codexVersion !== "0.153.0" ||
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
		result = validateRuntimeProbe(JSON.parse(run()));
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
	if (inspect().Id !== inspection.Id) {
		throw new Error("Codex runtime image changed during probe");
	}
	return {
		schemaVersion: 1,
		...source,
		imageId: inspection.Id,
		...(imageDigest
			? { imageDigest }
			: digestPattern.test(inspection.Descriptor?.digest)
				? { imageDigest: inspection.Descriptor.digest }
				: {}),
		probe: result,
		provenanceRejection: "passed",
	};
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
