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
	imageReference: z.string().min(1),
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
	error: WorkloadBoundaryErrorV1Schema,
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
		result.imageReference !== request.imageReference ||
		(result.status === "admitted" &&
			(result.policyEvidence.policyRef !== request.admissionPolicyRef ||
				result.runtimeManifestParsingEvidence.utf8ByteLength !==
					Buffer.byteLength(result.runtimeManifestLabel, "utf8")))
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
