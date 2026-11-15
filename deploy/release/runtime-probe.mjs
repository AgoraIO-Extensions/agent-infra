import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	fileBridgeProbeDrivers,
	fileBridgeProbeIsolation,
	fileBridgeProbeOrigin,
	fileBridgeProbeRequiredChecks,
} from "../../tests/support/runtime-file-bridge-probe.mjs";
import { safeRuntimeProbeFailure } from "../../tests/support/runtime-probe-diagnostics.mjs";
export { safeRuntimeProbeFailure } from "../../tests/support/runtime-probe-diagnostics.mjs";

import { runCommand } from "./run-command.mjs";

const root = resolve(import.meta.dirname, "../..");
const digestPattern = /^sha256:(?!0{64}$)[a-f0-9]{64}$/;
const releasePath = "packages/agent-runtime/src/codex-release.json";
/** Synthetic namespace of the formal in-cluster origin used on the release path. */
export const fileBridgeProbeNamespace = "agent-infra-probe";
const namespacePattern = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const sourceRepository = "https://github.com/AgoraIO-Extensions/agent-infra";
// Worker template bindings select the Driver; opencode runs through ACP.
const standardTemplateDrivers = Object.freeze({
	codex: "codex",
	claude: "claude",
	opencode: "acp",
	pi: "pi",
});
const sha256 = (bytes) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hasKeys = (value, keys) =>
	value &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.keys(value).sort().join(",") === keys;

function officialRelease(bytes) {
	const release = JSON.parse(bytes);
	if (
		!hasKeys(release, "artifacts,codeModeHostArtifacts,legal,provenance") ||
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
		!hasKeys(release.codeModeHostArtifacts, "amd64,arm64") ||
		!hasKeys(release.legal, "LICENSE,NOTICE") ||
		!Object.values(release.legal).every((digest) => digestPattern.test(digest))
	)
		throw new Error();
	for (const [architecture, target] of [
		["amd64", "x86_64"],
		["arm64", "aarch64"],
	]) {
		for (const [artifact, name] of [
			[release.artifacts[architecture], "codex"],
			[release.codeModeHostArtifacts[architecture], "codex-code-mode-host"],
		])
			if (
				!hasKeys(artifact, "archiveSha256,assetId,executableSha256,name") ||
				artifact.name !== `${name}-${target}-unknown-linux-musl` ||
				!Number.isSafeInteger(artifact.assetId) ||
				artifact.assetId <= 0 ||
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
	"native-shell-sandboxed-within-conversation",
	"native-code-mode-sandboxed-within-conversation",
	"native-apply-patch-no-outside-effects",
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

export function runtimeImageFromBuildManifest(manifest, commitSha) {
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
		throw new Error("Runtime image build manifest reference is invalid");
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

/**
 * #3230：从被检镜像自身的标签确定 FileBridge 消费角色，不依据仓库名。
 * - 标准模板镜像带 `io.agora.agent.standard-template`，Worker 模板绑定据此选择 Driver。
 * - 共享 RuntimeHost 镜像没有模板标签，但同一安装承载四个固定原生 Runtime。
 * - 只有 `platform-adapter` 且声明附件与结果文件的镜像消费平台 FileBridge 注入；
 *   self-managed 镜像使用自己的入口，不是消费者，拒绝把它当作资格对象。
 */
export function runtimeImageRole(labels) {
	let manifest;
	try {
		manifest = JSON.parse(labels?.["io.agora.agent.runtime.manifest"]);
	} catch {
		throw new Error("Runtime image manifest label is invalid");
	}
	if (
		manifest?.schemaVersion !== 1 ||
		manifest.interactionMode !== "platform-adapter"
	)
		throw new Error("Runtime image is not a platform FileBridge consumer");
	if (
		manifest.capabilities?.attachments !== true ||
		manifest.capabilities?.resultFiles !== true
	)
		throw new Error("Runtime image does not declare file capabilities");
	const template = labels["io.agora.agent.standard-template"];
	if (template === undefined) return "runtimeHost";
	if (
		typeof template !== "string" ||
		!Object.hasOwn(standardTemplateDrivers, template)
	)
		throw new Error("Runtime image template role is invalid");
	return template;
}

export function fileBridgeDriversForRole(role) {
	if (role === "runtimeHost") return [...fileBridgeProbeDrivers];
	if (!Object.hasOwn(standardTemplateDrivers, role))
		throw new Error("Runtime image template role is invalid");
	return [standardTemplateDrivers[role]];
}

export function validateFileBridgeProbe(result, driver, namespace, architecture) {
	const origin = fileBridgeProbeOrigin(namespace);
	const digests = [
		"codexReleaseSha256",
		"runtimeHostEntrySha256",
		"startScriptSha256",
	];
	if (
		!hasKeys(
			result,
			"assemblies,capability,checks,driver,exchange,externalModelRequests,installation,isolation,localModelRequests,origin,schemaVersion,status,stopExitCodes",
		) ||
		result.schemaVersion !== 1 ||
		result.status !== "passed" ||
		result.capability !== "file-bridge-origin" ||
		result.driver !== driver ||
		result.origin !== origin ||
		JSON.stringify(result.assemblies) !==
			JSON.stringify(["session-sandbox", "agent-workload"]) ||
		JSON.stringify(result.isolation) !==
			JSON.stringify(fileBridgeProbeIsolation(driver)) ||
		JSON.stringify(result.checks) !==
			JSON.stringify(fileBridgeProbeRequiredChecks(driver)) ||
		!hasKeys(
			result.exchange,
			"completes,contentReads,contentWrites,reads,results,violations",
		) ||
		Object.values(result.exchange).some(
			(value) => !Number.isSafeInteger(value) || value < 0 || value > 1000,
		) ||
		result.exchange.violations !== 0 ||
		// Two positive round trips; five rejected inputs each reach the exchange,
		// three of them also the data plane, and none publishes a result.
		result.exchange.reads < 7 ||
		result.exchange.contentReads < 5 ||
		result.exchange.results !== 2 ||
		result.exchange.contentWrites !== 2 ||
		result.exchange.completes !== 2 ||
		result.externalModelRequests !== 0 ||
		!Number.isSafeInteger(result.localModelRequests) ||
		result.localModelRequests < 2 ||
		result.localModelRequests > 1000 ||
		!hasKeys(result.stopExitCodes, "agentWorkload,sessionSandbox") ||
		!Object.values(result.stopExitCodes).every((code) =>
			[0, 143].includes(code),
		) ||
		!hasKeys(
			result.installation,
			"architecture,codexReleaseSha256,platform,runtimeHostEntrySha256,startScriptSha256",
		) ||
		result.installation.platform !== "linux" ||
		result.installation.architecture !== architecture ||
		!digests.every((key) => digestPattern.test(result.installation[key]))
	)
		throw new Error("FileBridge origin probe evidence is invalid");
	return result;
}

function probeMounts(contextPath) {
	return [
		["tests/runtime-image-probe.mjs", "/probe/runtime-image-probe.mjs"],
		[
			"tests/support/runtime-probe-diagnostics.mjs",
			"/probe/support/runtime-probe-diagnostics.mjs",
		],
		[
			"tests/support/runtime-file-bridge-probe.mjs",
			"/probe/support/runtime-file-bridge-probe.mjs",
		],
	].flatMap(([source, target]) => [
		"--mount",
		`type=bind,src=${join(contextPath, source)},dst=${target},readonly`,
	]);
}

const sessionLabels = () =>
	process.env.AO_SESSION_ID
		? ["--label", `ao.session=${process.env.AO_SESSION_ID}`]
		: [];

/**
 * Runs the in-image qualification once per Driver of the image's role. The
 * container has no network: the formal Service DNS origin resolves only to the
 * container loopback, where the isolated Platform file fixture listens.
 */
export function runFileBridgeOriginQualification({
	docker,
	imageId,
	platform,
	contextPath,
	role,
	namespace,
	imageReference,
	architecture,
	expectedCodexReleaseSha256,
}) {
	if (
		!namespacePattern.test(namespace ?? "") ||
		!digestPattern.test(imageId ?? "") ||
		!/^[a-z0-9][a-z0-9.:/-]*@sha256:[a-f0-9]{64}$/.test(imageReference ?? "") ||
		!digestPattern.test(imageReference.split("@")[1]) ||
		!digestPattern.test(expectedCodexReleaseSha256 ?? "")
	)
		throw new Error("FileBridge origin qualification input is invalid");
	const origin = fileBridgeProbeOrigin(namespace);
	const host = new URL(origin).hostname;
	const drivers = fileBridgeDriversForRole(role).map((driver) => {
		const output = runCommand(
			docker,
			[
				"run",
				"--rm",
				...sessionLabels(),
				"--pull=never",
				...(platform ? ["--platform", platform] : []),
				"--network=none",
				"--read-only",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--add-host",
				`${host}:127.0.0.1`,
				"--tmpfs",
				"/tmp:size=128m,mode=1777",
				"--tmpfs",
				"/var/lib/agent-runtime:size=256m,uid=1000,gid=1000,mode=0700",
				// The Session Sandbox workspace volume; Codex init/executor share it.
				"--tmpfs",
				"/workspace:size=256m,uid=1000,gid=1000,mode=0700",
				...probeMounts(contextPath),
				imageId,
				"node",
				"/probe/runtime-image-probe.mjs",
				"--file-bridge-origin",
				driver,
				namespace,
				imageReference,
			],
			{
				cwd: root,
				name: `FileBridge origin ${driver} image probe`,
				timeoutMs: 600_000,
				onFailure: (stderr) => {
					if (/exec format error/i.test(stderr))
						throw new RuntimeProbeFailure(
							`FileBridge origin ${driver} image probe cannot execute ${architecture} on this Docker daemon`,
						);
					const detail = safeRuntimeProbeFailure(stderr);
					if (detail)
						throw new RuntimeProbeFailure(
							`FileBridge origin ${driver} image probe failed: ${detail}`,
						);
				},
			},
		);
		let result;
		try {
			result = validateFileBridgeProbe(
				JSON.parse(output),
				driver,
				namespace,
				architecture,
			);
		} catch {
			throw new Error(`FileBridge origin ${driver} image probe failed`);
		}
		if (result.installation.codexReleaseSha256 !== expectedCodexReleaseSha256)
			throw new Error(
				"FileBridge origin image release does not match its source",
			);
		return result;
	});
	// Every Driver of one image exercised the same shared Host installation.
	if (
		new Set(
			drivers.map(({ installation }) =>
				JSON.stringify([
					installation.runtimeHostEntrySha256,
					installation.startScriptSha256,
				]),
			),
		).size !== 1
	)
		throw new Error("FileBridge origin image Host installation is inconsistent");
	return {
		schemaVersion: 1,
		role,
		consumer: "runtime-host",
		// Only Codex Session Sandboxes add these containers (same image). The Worker
		// never injects FileBridge variables there, and the executor rejects any
		// AGENT_INFRA_* input outside its own allowlist.
		nonConsumers: drivers.some(({ driver }) => driver === "codex")
			? ["codex-session-workspace-init", "codex-session-executor"]
			: [],
		namespace,
		origin,
		imageReference,
		drivers,
	};
}

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
	const role = runtimeImageRole(inspection.Config?.Labels);
	const labels = sessionLabels();
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
				...probeMounts(contextPath),
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
	const fileBridgeOrigin = runFileBridgeOriginQualification({
		docker,
		imageId: inspection.Id,
		contextPath,
		role,
		namespace: fileBridgeProbeNamespace,
		// A locally built release candidate has no registry repository yet; the
		// executor binding only needs the exact digest in reference form.
		imageReference: `localhost/agent-runtime-release-candidate@${
			digestPattern.test(imageDigest ?? "")
				? imageDigest
				: digestPattern.test(inspection.Descriptor?.digest ?? "")
					? inspection.Descriptor.digest
					: inspection.Id
		}`,
		architecture: inspection.Architecture,
		expectedCodexReleaseSha256: sha256(releaseBytes),
	});
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
		fileBridgeOrigin,
	};
}

const imageReferencePattern =
	/^((?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@(sha256:[a-f0-9]{64})$/;
const fileBridgeRoles = ["runtimeHost", ...Object.keys(standardTemplateDrivers)];

/**
 * #3230：已发布不可变镜像的 FileBridge origin 资格。探针工具来源（本 clean checkout）
 * 与镜像来源（OCI revision 标签）分别证明，可以是不同提交；普通发布路径仍由
 * `probeRuntimeImage` 要求两者相同，这里不放宽它。
 * - 镜像只按 `<repository>@sha256:<digest>` 指定，并且必须已在本地，探针不拉取；
 *   Docker 回读的 manifest digest 或 RepoDigest 必须等于该 digest，平台必须等于输入。
 * - 角色来自镜像标签并必须等于批准输入；仓库名只记录，不决定角色。
 * - 镜像来源必须是本工具来源历史中的提交；镜像内 Codex release pin 必须等于该来源
 *   提交中的 pin，从而把被检内容绑定到它自己的来源，而不是工具来源。
 */
export async function qualifyRuntimeImageFileBridge({
	reference,
	role,
	imageSource,
	platform,
	namespace = fileBridgeProbeNamespace,
	source,
	contextPath = root,
}) {
	const match = imageReferencePattern.exec(reference ?? "");
	const architecture = /^linux\/(amd64|arm64)$/.exec(platform ?? "")?.[1];
	if (
		!match ||
		!architecture ||
		!fileBridgeRoles.includes(role) ||
		!/^[a-f0-9]{40}$/.test(imageSource ?? "") ||
		!namespacePattern.test(namespace ?? "") ||
		!source ||
		!/^[a-f0-9]{40}$/.test(source.commitSha) ||
		source.sourceDirty !== false ||
		Object.keys(source).sort().join(",") !== "commitSha,sourceDirty"
	)
		throw new Error("FileBridge origin qualification input is invalid");
	const [, repository, digest] = match;
	const git = process.env.GIT_BIN ?? "git";
	const gitOptions = {
		cwd: root,
		name: "FileBridge origin qualification source identity",
		timeoutMs: 30_000,
	};
	const sourceTree = runCommand(
		git,
		["rev-parse", `${source.commitSha}^{tree}`],
		gitOptions,
	);
	if (!/^[a-f0-9]{40}$/.test(sourceTree))
		throw new Error("FileBridge origin qualification source is invalid");
	let imageSourceRelease;
	try {
		runCommand(git, ["cat-file", "-e", `${imageSource}^{commit}`], gitOptions);
		runCommand(
			git,
			["merge-base", "--is-ancestor", imageSource, source.commitSha],
			gitOptions,
		);
		imageSourceRelease = runCommand(
			git,
			["show", `${imageSource}:${releasePath}`],
			{ ...gitOptions, trimOutput: false },
		);
		officialRelease(imageSourceRelease);
	} catch {
		throw new Error(
			"FileBridge origin image source is not in the probe source history",
		);
	}
	const docker = process.env.DOCKER_BIN ?? "docker";
	const inspect = () => {
		try {
			const inspection = JSON.parse(
				runCommand(
					docker,
					["image", "inspect", "--format", "{{json .}}", reference],
					{
						cwd: root,
						name: "FileBridge origin image inspection",
						timeoutMs: 30_000,
					},
				),
			);
			if (!digestPattern.test(inspection.Id)) throw new Error();
			return inspection;
		} catch {
			throw new Error("FileBridge origin image identity is unavailable");
		}
	};
	const identity = (inspection) =>
		JSON.stringify([
			inspection.Id,
			inspection.Os,
			inspection.Architecture,
			inspection.Descriptor?.digest ?? null,
			[...(inspection.RepoDigests ?? [])].sort(),
			inspection.Config?.Labels ?? null,
		]);
	const inspection = inspect();
	const labels = inspection.Config?.Labels;
	if (
		inspection.Descriptor?.digest !== digest &&
		!(inspection.RepoDigests ?? []).includes(`${repository}@${digest}`)
	)
		throw new Error("FileBridge origin image digest does not match the input");
	if (inspection.Os !== "linux" || inspection.Architecture !== architecture)
		throw new Error("FileBridge origin image platform does not match the input");
	if (
		labels?.["org.opencontainers.image.revision"] !== imageSource ||
		labels?.["org.opencontainers.image.source"] !== sourceRepository
	)
		throw new Error("FileBridge origin image source does not match the input");
	if (runtimeImageRole(labels) !== role)
		throw new Error("FileBridge origin image role does not match the input");
	const fileBridgeOrigin = runFileBridgeOriginQualification({
		docker,
		imageId: inspection.Id,
		platform,
		contextPath,
		role,
		namespace,
		imageReference: reference,
		architecture,
		expectedCodexReleaseSha256: sha256(imageSourceRelease),
	});
	if (identity(inspect()) !== identity(inspection))
		throw new Error("FileBridge origin image changed during qualification");
	return {
		schemaVersion: 1,
		kind: "runtime-image-file-bridge-qualification",
		status: "passed",
		tool: { ...source, sourceTree },
		image: {
			reference,
			repository,
			digest,
			imageId: inspection.Id,
			platform,
			role,
			sourceCommit: imageSource,
			sourceRepository,
			codexReleaseSha256: sha256(imageSourceRelease),
		},
		sourceRelation: {
			imageSourceInToolHistory: true,
			sameSource: imageSource === source.commitSha,
		},
		fileBridgeOrigin,
		boundary: {
			network: "none",
			imagePulled: false,
			externalModelRequests: 0,
			registryWrites: 0,
			clusterWorkloads: 0,
		},
	};
}

/** Exported for argument contract tests; the CLI uses the same parser. */
export function fileBridgeQualificationArguments(argv) {
	return qualificationArguments(argv);
}

function qualificationArguments(argv) {
	const options = {};
	const positional = [];
	for (let index = 0; index < argv.length; index++) {
		const name = argv[index];
		if (
			["--role", "--image-source", "--platform", "--namespace"].includes(name)
		) {
			if (Object.hasOwn(options, name) || index + 1 >= argv.length)
				throw new Error("FileBridge origin qualification arguments are invalid");
			options[name] = argv[++index];
		} else if (name.startsWith("--"))
			throw new Error("FileBridge origin qualification arguments are invalid");
		else positional.push(name);
	}
	if (positional.length !== 2)
		throw new Error(
			"usage: runtime-probe.mjs --file-bridge-qualification --role <role> --image-source <commit> --platform linux/<arch> [--namespace <namespace>] <repository@sha256:digest> <evidence.json>",
		);
	return {
		role: options["--role"],
		imageSource: options["--image-source"],
		platform: options["--platform"],
		namespace: options["--namespace"] ?? fileBridgeProbeNamespace,
		reference: positional[0],
		output: positional[1],
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
		const status = () =>
			runCommand("git", ["status", "--porcelain"], {
				cwd: root,
				name: "Runtime probe checkout",
				timeoutMs: 30_000,
			});
		if (image === "--file-bridge-qualification") {
			const input = qualificationArguments(process.argv.slice(3));
			const evidence = await qualifyRuntimeImageFileBridge({
				...input,
				source: assertCleanRuntimeProbeSource(status(), commitSha),
			});
			assertCleanRuntimeProbeSource(status(), commitSha);
			await writeFile(input.output, `${JSON.stringify(evidence, null, 2)}\n`, {
				flag: "wx",
			});
			console.info("FileBridge origin image qualification passed");
		} else {
			if (image === "--build-manifest") {
				image = runtimeImageFromBuildManifest(
					JSON.parse(await readFile(output, "utf8")),
					commitSha,
				);
				[output, ...extra] = extra;
			}
			if (!output || extra.length) {
				throw new Error("Runtime image probe arguments are invalid");
			}
			const source = assertCleanRuntimeProbeSource(status(), commitSha);
			const evidence = await probeRuntimeImage({ image, source });
			await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, {
				flag: "wx",
			});
			console.info("Codex runtime image probe passed");
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
