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
} from "./runtime-manifest.ts";

export const ImmutableOciDigestV1Schema = z
	.string()
	.regex(/^sha256:[a-f0-9]{64}$/);

export const OciImageConfigV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	configDigest: ImmutableOciDigestV1Schema,
	operatingSystem: z.string().min(1),
	architecture: z.string().min(1),
	entrypoint: z.array(z.string()).optional(),
	command: z.array(z.string()).optional(),
	workingDirectory: z.string().min(1).optional(),
	user: z.string().min(1).optional(),
	declaredEnvKeys: z.array(z.string().min(1)).optional(),
});

export const ImageAdmissionPolicyEvidenceV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	policyRef: WorkloadOpaqueIdV1Schema,
	decisionRef: WorkloadOpaqueIdV1Schema,
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
	imageReference: z.string().min(1),
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
	runtimeManifestLabel: z.string().min(1),
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

export function validateImageRegistryAdmissionResultV1(
	requestInput: unknown,
	resultInput: unknown,
): ImageRegistryAdmissionResultV1 {
	const request = ImageRegistryAdmissionRequestV1Schema.parse(requestInput);
	const result = ImageRegistryAdmissionResultV1Schema.parse(resultInput);
	if (
		result.requestId !== request.requestId ||
		result.traceId !== request.traceId ||
		(result.status === "admitted" &&
			(result.policyEvidence.policyRef !== request.admissionPolicyRef ||
				result.policyEvidence.imageDigest !== result.immutableDigest ||
				result.runtimeManifestParsingEvidence.utf8ByteLength !==
					Buffer.byteLength(result.runtimeManifestLabel, "utf8"))) ||
		(result.status === "rejected" && result.error.traceId !== request.traceId)
	) {
		throw new Error("Image registry result correlation mismatch");
	}
	if (result.status === "admitted") {
		let labelManifest: RuntimeManifestV1;
		try {
			labelManifest = RuntimeManifestV1Schema.parse(
				JSON.parse(result.runtimeManifestLabel),
			);
		} catch {
			throw new Error("Image registry Runtime Manifest mismatch");
		}
		if (
			JSON.stringify(labelManifest) !== JSON.stringify(result.runtimeManifest)
		) {
			throw new Error("Image registry Runtime Manifest mismatch");
		}
	}
	return result;
}
