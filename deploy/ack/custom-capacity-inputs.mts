import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseRuntimeManifestLabelV1 } from "../../packages/contracts/src/workload/registry.ts";

export const CUSTOM_CAPACITY_SCOPE =
	"isolated-custom-runtime-capacity" as const;
export const sha256 = (bytes: string | Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
export const evidenceBytes = (value: unknown) =>
	Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const capacityEvidenceHash = (bytes: Uint8Array) => sha256(bytes);

/** Capsule materialization changes local paths, but never the approved measurement tuple. */
export function customCapacityJobDefinitionHash(job: CustomCapacityJob) {
	const paths = new Set([
		"sourceWorktree",
		"childManifestFile",
		"imageConfigFile",
		"parentManifestFile",
		"recipeFile",
		"customEnvironmentFile",
		"kubeconfig",
		"outputDirectory",
	]);
	return sha256(
		JSON.stringify(
			Object.fromEntries(
				Object.entries(job)
					.filter(([key]) => !paths.has(key))
					.sort(([a], [b]) => a.localeCompare(b)),
			),
		),
	);
}
export type CustomCapacityResources = {
	requests: { cpu: string; memory: string };
	limits: { cpu: string; memory: string };
};
export type CustomCapacityJob = {
	schemaVersion: 1;
	scope: typeof CUSTOM_CAPACITY_SCOPE;
	sourceCommit: string;
	sourceWorktree: string;
	imageReference: string;
	imageDigest: string;
	parentImageReference: string;
	platform: "linux/amd64";
	childManifestFile: string;
	imageConfigFile: string;
	parentManifestFile: string;
	recipeFile: string;
	recipeSha256: string;
	runtimeModuleSha256: string;
	modelConfigurationSha256: string;
	modelConfigurationPath: string;
	customEnvironmentFile: string;
	kubeconfig: string;
	namespace: string;
	outputDirectory: string;
	operatorApprovalRef: string;
	resourceProfileRef: string;
	resources: CustomCapacityResources;
	modelOptionId: string;
	reasoningLevel: string;
	runtimeConfigVersion: string;
	expectedModelId: string;
	imagePullSecret?: string;
	timeoutSeconds: number;
	placement: {
		nodeSelector: Record<string, string>;
		tolerations: {
			key: string;
			operator: "Equal" | "Exists";
			value?: string;
			effect: "NoSchedule" | "NoExecute" | "PreferNoSchedule";
		}[];
	};
};

const fields = [
	"schemaVersion",
	"scope",
	"sourceCommit",
	"sourceWorktree",
	"imageReference",
	"imageDigest",
	"parentImageReference",
	"platform",
	"childManifestFile",
	"imageConfigFile",
	"parentManifestFile",
	"recipeFile",
	"recipeSha256",
	"runtimeModuleSha256",
	"modelConfigurationSha256",
	"modelConfigurationPath",
	"customEnvironmentFile",
	"kubeconfig",
	"namespace",
	"outputDirectory",
	"operatorApprovalRef",
	"resourceProfileRef",
	"resources",
	"modelOptionId",
	"reasoningLevel",
	"runtimeConfigVersion",
	"expectedModelId",
	"imagePullSecret",
	"timeoutSeconds",
	"placement",
];
const digest = /^sha256:[a-f0-9]{64}$/u;
const ref =
	/^[a-z0-9][a-z0-9.:-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[a-f0-9]{64}$/u;
const hex = /^[a-f0-9]{64}$/u;
const name = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
function record(value: any, keys: string[], error: string) {
	assert(value && typeof value === "object" && !Array.isArray(value), error);
	assert(
		Object.keys(value).every((k) => keys.includes(k)),
		error,
	);
}
export function validateCustomCapacityJob(value: any): CustomCapacityJob {
	record(value, fields, "CUSTOM_CAPACITY_JOB_INVALID");
	assert(
		value.schemaVersion === 1 &&
			value.scope === CUSTOM_CAPACITY_SCOPE &&
			value.platform === "linux/amd64",
		"CUSTOM_CAPACITY_JOB_INVALID",
	);
	assert(
		/^[a-f0-9]{40}$/u.test(value.sourceCommit),
		"CUSTOM_CAPACITY_SOURCE_INVALID",
	);
	assert(
		typeof value.imageDigest === "string" &&
			digest.test(value.imageDigest) &&
			ref.test(value.imageReference) &&
			value.imageReference.endsWith(`@${value.imageDigest}`) &&
			ref.test(value.parentImageReference),
		"CUSTOM_CAPACITY_IMAGE_INVALID",
	);
	for (const key of [
		"sourceWorktree",
		"childManifestFile",
		"imageConfigFile",
		"parentManifestFile",
		"recipeFile",
		"customEnvironmentFile",
		"kubeconfig",
		"outputDirectory",
		"modelConfigurationPath",
	])
		assert(
			typeof value[key] === "string" &&
				value[key].length <= 4096 &&
				isAbsolute(value[key]) &&
				!value[key].includes("\0") &&
				!value[key].split("/").includes(".."),
			"CUSTOM_CAPACITY_PATH_INVALID",
		);
	assert(
		value.modelConfigurationPath.startsWith("/opt/custom-agent/"),
		"CUSTOM_CAPACITY_CONFIGURATION_PATH_INVALID",
	);
	for (const key of [
		"recipeSha256",
		"runtimeModuleSha256",
		"modelConfigurationSha256",
	])
		assert(
			typeof value[key] === "string" && hex.test(value[key]),
			"CUSTOM_CAPACITY_HASH_INVALID",
		);
	for (const key of [
		"operatorApprovalRef",
		"resourceProfileRef",
		"modelOptionId",
		"runtimeConfigVersion",
		"expectedModelId",
	])
		assert(
			typeof value[key] === "string" &&
				/^[A-Za-z0-9._:/-]{1,256}$/u.test(value[key]),
			"CUSTOM_CAPACITY_ID_INVALID",
		);
	assert(
		["low", "medium", "high", "xhigh", "max"].includes(value.reasoningLevel),
		"CUSTOM_CAPACITY_REASONING_INVALID",
	);
	assert(
		typeof value.namespace === "string" &&
			name.test(value.namespace) &&
			(value.imagePullSecret === undefined ||
				(typeof value.imagePullSecret === "string" &&
					name.test(value.imagePullSecret))),
		"CUSTOM_CAPACITY_NAMESPACE_INVALID",
	);
	assert(
		Number.isSafeInteger(value.timeoutSeconds) &&
			value.timeoutSeconds >= 60 &&
			value.timeoutSeconds <= 1800,
		"CUSTOM_CAPACITY_TIMEOUT_INVALID",
	);
	assert.deepEqual(
		value.resources,
		{
			requests: { cpu: "100m", memory: "128Mi" },
			limits: { cpu: "1", memory: "2Gi" },
		},
		"CUSTOM_CAPACITY_RESOURCES_INVALID",
	);
	record(
		value.placement,
		["nodeSelector", "tolerations"],
		"CUSTOM_CAPACITY_PLACEMENT_INVALID",
	);
	const selector = value.placement.nodeSelector;
	assert(
		selector &&
			typeof selector === "object" &&
			!Array.isArray(selector) &&
			Object.keys(selector).length <= 12 &&
			selector["kubernetes.io/arch"] === "amd64",
		"CUSTOM_CAPACITY_PLACEMENT_INVALID",
	);
	for (const [key, val] of Object.entries(selector))
		assert(
			/^[A-Za-z0-9./_-]{1,253}$/u.test(key) &&
				typeof val === "string" &&
				/^[A-Za-z0-9._-]{1,63}$/u.test(val),
			"CUSTOM_CAPACITY_PLACEMENT_INVALID",
		);
	assert(
		Array.isArray(value.placement.tolerations) &&
			value.placement.tolerations.length <= 12,
		"CUSTOM_CAPACITY_PLACEMENT_INVALID",
	);
	for (const t of value.placement.tolerations) {
		record(
			t,
			["key", "operator", "value", "effect"],
			"CUSTOM_CAPACITY_PLACEMENT_INVALID",
		);
		assert(
			typeof t.key === "string" &&
				/^[A-Za-z0-9./_-]{1,253}$/u.test(t.key) &&
				["Equal", "Exists"].includes(t.operator) &&
				["NoSchedule", "NoExecute", "PreferNoSchedule"].includes(t.effect) &&
				(t.value === undefined ||
					(typeof t.value === "string" &&
						/^[A-Za-z0-9._-]{0,63}$/u.test(t.value))),
			"CUSTOM_CAPACITY_PLACEMENT_INVALID",
		);
	}
	return structuredClone(value);
}

export function validateCustomEnvironment(
	value: unknown,
): Record<string, string> {
	assert(
		value && typeof value === "object" && !Array.isArray(value),
		"CUSTOM_CAPACITY_ENV_INVALID",
	);
	const entries = Object.entries(value);
	assert(
		entries.length > 0 && entries.length <= 32,
		"CUSTOM_CAPACITY_ENV_INVALID",
	);
	for (const [key, v] of entries)
		assert(
			/^CUSTOM_[A-Z0-9_]{1,80}$/u.test(key) &&
				typeof v === "string" &&
				v.length > 0 &&
				v.length <= 8192 &&
				!v.includes("\0"),
			"CUSTOM_CAPACITY_ENV_INVALID",
		);
	return structuredClone(value) as Record<string, string>;
}

function manifest(bytes: Uint8Array) {
	const m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	assert(
		m.schemaVersion === 2 &&
			[
				"application/vnd.oci.image.manifest.v1+json",
				"application/vnd.docker.distribution.manifest.v2+json",
			].includes(m.mediaType) &&
			!m.manifests &&
			Array.isArray(m.layers) &&
			m.layers.length > 0 &&
			m.layers.length <= 256,
		"CUSTOM_CAPACITY_MANIFEST_INVALID",
	);
	for (const d of [m.config, ...m.layers])
		assert(
			digest.test(d?.digest) &&
				Number.isSafeInteger(d.size) &&
				d.size > 0 &&
				typeof d.mediaType === "string",
			"CUSTOM_CAPACITY_MANIFEST_INVALID",
		);
	return m;
}

/** Content-addressed child/config/parent bytes, not mutable tags or caller-supplied status. */
export function verifyCustomImageEvidence(
	job: CustomCapacityJob,
	input: {
		child: Uint8Array;
		config: Uint8Array;
		parent: Uint8Array;
		recipe: Uint8Array;
	},
) {
	assert(
		`sha256:${sha256(input.child)}` === job.imageDigest &&
			job.parentImageReference.endsWith(`@sha256:${sha256(input.parent)}`),
		"CUSTOM_CAPACITY_MANIFEST_DIGEST_MISMATCH",
	);
	const child = manifest(input.child),
		parent = manifest(input.parent);
	assert(
		child.config.digest === `sha256:${sha256(input.config)}` &&
			child.config.size === input.config.byteLength,
		"CUSTOM_CAPACITY_CONFIG_DIGEST_MISMATCH",
	);
	assert(
		sha256(input.recipe) === job.recipeSha256,
		"CUSTOM_CAPACITY_RECIPE_MISMATCH",
	);
	assert(
		parent.layers.length < child.layers.length,
		"CUSTOM_CAPACITY_PARENT_MISMATCH",
	);
	parent.layers.forEach((layer: any, i: number) => {
		for (const k of ["mediaType", "digest", "size"])
			assert(
				layer[k] === child.layers[i][k],
				"CUSTOM_CAPACITY_PARENT_MISMATCH",
			);
	});
	const config = JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(input.config),
	);
	assert(
		config.os === "linux" && config.architecture === "amd64" && !config.variant,
		"CUSTOM_CAPACITY_ARCHITECTURE_MISMATCH",
	);
	assert(
		["node", "1000", "1000:1000", "node:node"].includes(config.config?.User),
		"CUSTOM_CAPACITY_ROOT_IMAGE_REJECTED",
	);
	assert(
		config.config?.Labels?.["org.opencontainers.image.revision"] ===
			job.sourceCommit,
		"CUSTOM_CAPACITY_SOURCE_MISMATCH",
	);
	const { runtimeManifest: runtime } = parseRuntimeManifestLabelV1(
		config.config?.Labels?.["io.agora.agent.runtime.manifest"] ?? "null",
	);
	assert(
		runtime.interactionMode === "platform-adapter" &&
			runtime.protocol === "acp" &&
			runtime.service.port === 3003 &&
			runtime.health.path === "/healthz",
		"CUSTOM_CAPACITY_ROLE_MISMATCH",
	);
	assert(
		Array.isArray(config.config.Entrypoint) &&
			config.config.Entrypoint.length > 0 &&
			config.config.Entrypoint.every((s: unknown) => typeof s === "string"),
		"CUSTOM_CAPACITY_ENTRYPOINT_INVALID",
	);
	return {
		imageDigest: job.imageDigest,
		parentDigest: `sha256:${sha256(input.parent)}`,
		imageConfigDigest: child.config.digest,
		sourceCommit: config.config.Labels["org.opencontainers.image.revision"],
		platform: "linux/amd64" as const,
		entrypoint: config.config.Entrypoint,
		recipeSha256: job.recipeSha256,
	};
}

export function capacityProfile(job: CustomCapacityJob, bytes: Uint8Array) {
	return {
		schemaVersion: 1,
		imageDigest: job.imageDigest,
		resourceProfileRef: job.resourceProfileRef,
		resourceConfigurationHash: sha256(
			JSON.stringify({
				resourceProfileRef: job.resourceProfileRef,
				...job.resources,
			}),
		),
		maximumConcurrentExecutions: 1,
		conformanceEvidenceHash: capacityEvidenceHash(bytes),
	};
}
