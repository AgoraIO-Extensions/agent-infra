import { getNodeValue, type Node as JsonNode, parseTree } from "jsonc-parser";
import { z } from "zod";

import {
	WorkloadBoundaryErrorV1Schema,
	WorkloadOpaqueIdV1Schema,
	WorkloadSchemaVersionV1Schema,
	WorkloadTimestampV1Schema,
} from "./common.ts";
import {
	type RuntimeManifestV1,
	RuntimeManifestV1Schema,
	resolveRuntimeManifestCapabilitiesV1,
} from "./runtime-manifest.ts";

export const ImmutableOciDigestV1Schema = z
	.string()
	.regex(/^sha256:[a-f0-9]{64}(?![\s\S])/);

const ociDomainComponent = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const ociPort =
	"(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";
const ipv6Hextet = "[A-Fa-f0-9]{1,4}";
const ipv6Address = [
	`(?:${ipv6Hextet}:){7}${ipv6Hextet}`,
	`(?:${ipv6Hextet}:){1,7}:`,
	`(?:${ipv6Hextet}:){1,6}:${ipv6Hextet}`,
	`(?:${ipv6Hextet}:){1,5}(?::${ipv6Hextet}){1,2}`,
	`(?:${ipv6Hextet}:){1,4}(?::${ipv6Hextet}){1,3}`,
	`(?:${ipv6Hextet}:){1,3}(?::${ipv6Hextet}){1,4}`,
	`(?:${ipv6Hextet}:){1,2}(?::${ipv6Hextet}){1,5}`,
	`${ipv6Hextet}:(?:(?::${ipv6Hextet}){1,6})`,
	`:(?:(?::${ipv6Hextet}){1,7}|:)`,
].join("|");
const ociDomain = `(?:${ociDomainComponent}(?:\\.${ociDomainComponent})*|\\[(?:${ipv6Address})\\])(?::${ociPort})?`;
const ociPathComponent = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const ociImageReferencePattern = new RegExp(
	`^(?=.{1,512}(?![\\s\\S]))(?:${ociDomain}/)?${ociPathComponent}(?:/${ociPathComponent})*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?(?![\\s\\S])`,
);

export const OciImageReferenceV1Schema = z
	.string()
	.regex(ociImageReferencePattern);

export const OciDeclaredEnvironmentKeyV1Schema = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/);

export const OciImageConfigV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	configDigest: ImmutableOciDigestV1Schema,
	operatingSystem: z.string().min(1),
	architecture: z.string().min(1),
	entrypoint: z.array(z.string()).optional(),
	command: z.array(z.string()).optional(),
	workingDirectory: z.string().min(1).optional(),
	user: z.string().min(1).optional(),
	declaredEnvKeys: z.array(OciDeclaredEnvironmentKeyV1Schema).optional(),
});

export const ImageAdmissionPolicyEvidenceV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	policyRef: WorkloadOpaqueIdV1Schema,
	decisionRef: WorkloadOpaqueIdV1Schema,
	subjectRef: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	imageDigest: ImmutableOciDigestV1Schema,
	evaluatedAt: WorkloadTimestampV1Schema,
});

export const RuntimeManifestParsingEvidenceV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	labelName: z.literal("io.agora.agent.runtime.manifest"),
	utf8ByteLength: z.number().int().positive().max(65_536),
	maxDepth: z.number().int().positive().max(8),
	duplicateKeysDetected: z.literal(false),
	unknownFieldsDetected: z.literal(false),
});

const imageRegistryAdmissionErrorV1Schema = <
	const Code extends string,
	const Message extends string,
	const Retryable extends boolean,
>(
	code: Code,
	message: Message,
	retryable: Retryable,
) =>
	WorkloadBoundaryErrorV1Schema.extend({
		code: z.literal(code),
		message: z.literal(message),
		retryable: z.literal(retryable),
	});

export const ImageRegistryAdmissionErrorV1Schema = z.discriminatedUnion(
	"code",
	[
		imageRegistryAdmissionErrorV1Schema(
			"IMAGE_REFERENCE_INVALID",
			"Image reference is invalid",
			false,
		),
		imageRegistryAdmissionErrorV1Schema(
			"IMAGE_NOT_FOUND",
			"Image was not found",
			false,
		),
		imageRegistryAdmissionErrorV1Schema(
			"IMAGE_NOT_ADMITTED",
			"The image is not admitted by deployment policy",
			false,
		),
		imageRegistryAdmissionErrorV1Schema(
			"OCI_CONFIG_INVALID",
			"OCI image config is invalid",
			false,
		),
		imageRegistryAdmissionErrorV1Schema(
			"RUNTIME_MANIFEST_MISSING",
			"Runtime Manifest is missing",
			false,
		),
		imageRegistryAdmissionErrorV1Schema(
			"RUNTIME_MANIFEST_INVALID",
			"Runtime Manifest is invalid",
			false,
		),
		imageRegistryAdmissionErrorV1Schema(
			"IMAGE_REGISTRY_UNAVAILABLE",
			"Image registry is unavailable",
			true,
		),
		imageRegistryAdmissionErrorV1Schema(
			"IMAGE_ADMISSION_POLICY_UNAVAILABLE",
			"Image admission policy is unavailable",
			true,
		),
	],
);

export const ImageRegistryAdmissionRequestV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	requestId: WorkloadOpaqueIdV1Schema,
	traceId: WorkloadOpaqueIdV1Schema,
	subjectRef: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	imageReference: OciImageReferenceV1Schema,
	usage: z.enum(["standard-template", "custom-agent"]),
	admissionPolicyRef: WorkloadOpaqueIdV1Schema,
});

const registryResultCorrelationV1Schema = {
	schemaVersion: WorkloadSchemaVersionV1Schema,
	requestId: WorkloadOpaqueIdV1Schema,
	traceId: WorkloadOpaqueIdV1Schema,
} as const;

const imageRegistryAdmittedV1Schema = z.strictObject({
	...registryResultCorrelationV1Schema,
	status: z.literal("admitted"),
	immutableDigest: ImmutableOciDigestV1Schema,
	ociConfig: OciImageConfigV1Schema,
	runtimeManifestLabel: z.string().min(1).max(65_536),
	runtimeManifest: RuntimeManifestV1Schema,
	runtimeManifestParsingEvidence: RuntimeManifestParsingEvidenceV1Schema,
	policyEvidence: ImageAdmissionPolicyEvidenceV1Schema,
});

const imageRegistryRejectedV1Schema = z.strictObject({
	...registryResultCorrelationV1Schema,
	status: z.literal("rejected"),
	error: ImageRegistryAdmissionErrorV1Schema,
});

export const ImageRegistryAdmissionResultV1Schema = z.discriminatedUnion(
	"status",
	[imageRegistryAdmittedV1Schema, imageRegistryRejectedV1Schema],
);

export type ImageRegistryAdmissionRequestV1 = z.infer<
	typeof ImageRegistryAdmissionRequestV1Schema
>;
export type ImageRegistryAdmissionResultV1 = z.infer<
	typeof ImageRegistryAdmissionResultV1Schema
>;
export type OciImageConfigV1 = z.infer<typeof OciImageConfigV1Schema>;

function inspectJsonNode(
	node: JsonNode,
	depth: number,
): { duplicateKeys: boolean; maxDepth: number } {
	if (depth > 8) return { duplicateKeys: false, maxDepth: depth };
	let duplicateKeys = false;
	let maxDepth = depth;
	if (node.type === "object") {
		const keys = new Set<string>();
		for (const property of node.children ?? []) {
			const [key, value] = property.children ?? [];
			if (typeof key?.value !== "string" || !value) continue;
			if (keys.has(key.value)) duplicateKeys = true;
			keys.add(key.value);
			const inspected = inspectJsonNode(value, depth + 1);
			duplicateKeys ||= inspected.duplicateKeys;
			maxDepth = Math.max(maxDepth, inspected.maxDepth);
		}
	} else if (node.type === "array") {
		for (const value of node.children ?? []) {
			const inspected = inspectJsonNode(value, depth + 1);
			duplicateKeys ||= inspected.duplicateKeys;
			maxDepth = Math.max(maxDepth, inspected.maxDepth);
		}
	}
	return { duplicateKeys, maxDepth };
}

function parseRuntimeManifestLabel(
	label: string,
	evidence: z.infer<typeof RuntimeManifestParsingEvidenceV1Schema>,
) {
	const errors: { error: number; offset: number; length: number }[] = [];
	const root = parseTree(label, errors, {
		allowTrailingComma: false,
		disallowComments: true,
	});
	if (!root || errors.length > 0) {
		throw new Error("Image registry Runtime Manifest mismatch");
	}
	const inspected = inspectJsonNode(root, 1);
	if (
		inspected.duplicateKeys ||
		inspected.maxDepth > 8 ||
		inspected.maxDepth !== evidence.maxDepth
	) {
		throw new Error("Image registry Runtime Manifest mismatch");
	}
	return getNodeValue(root);
}

function canonicalRuntimeManifest(manifestInput: unknown) {
	const manifest = RuntimeManifestV1Schema.parse(manifestInput);
	return {
		...manifest,
		capabilities: resolveRuntimeManifestCapabilitiesV1(manifest),
	};
}

export function validateImageRegistryAdmissionResultV1(
	requestInput: unknown,
	resultInput: unknown,
): ImageRegistryAdmissionResultV1 {
	const request = ImageRegistryAdmissionRequestV1Schema.parse(requestInput);
	const result = ImageRegistryAdmissionResultV1Schema.parse(resultInput);
	const digestSeparator = request.imageReference.lastIndexOf("@");
	const requestedDigest =
		digestSeparator === -1
			? undefined
			: request.imageReference.slice(digestSeparator + 1);
	if (
		result.requestId !== request.requestId ||
		result.traceId !== request.traceId ||
		(result.status === "admitted" &&
			(result.policyEvidence.policyRef !== request.admissionPolicyRef ||
				result.policyEvidence.subjectRef !== request.subjectRef ||
				result.policyEvidence.agentId !== request.agentId ||
				result.policyEvidence.imageDigest !== result.immutableDigest ||
				(requestedDigest !== undefined &&
					result.immutableDigest !== requestedDigest) ||
				result.runtimeManifestParsingEvidence.utf8ByteLength !==
					Buffer.byteLength(result.runtimeManifestLabel, "utf8"))) ||
		(result.status === "rejected" && result.error.traceId !== request.traceId)
	) {
		throw new Error("Image registry result correlation mismatch");
	}
	if (result.status === "admitted") {
		let labelManifest: RuntimeManifestV1;
		try {
			labelManifest = canonicalRuntimeManifest(
				parseRuntimeManifestLabel(
					result.runtimeManifestLabel,
					result.runtimeManifestParsingEvidence,
				),
			);
		} catch {
			throw new Error("Image registry Runtime Manifest mismatch");
		}
		const resultManifest = canonicalRuntimeManifest(result.runtimeManifest);
		if (JSON.stringify(labelManifest) !== JSON.stringify(resultManifest)) {
			throw new Error("Image registry Runtime Manifest mismatch");
		}
		return { ...result, runtimeManifest: resultManifest };
	}
	return result;
}
