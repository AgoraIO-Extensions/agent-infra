import { z } from "zod";

import {
	OpaqueIdV1Schema,
	RequestIdV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
	TraceIdV1Schema,
} from "../index.ts";

const selector = z.enum(["status", "commands", "skills"]);
const positiveSafeInteger = z.number().int().positive().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const metadataName = z.string().min(1).max(256);
const metadataVersion = z.string().min(1).max(128);

export const NativeMetadataSelectorV1Schema = selector;
export type NativeMetadataSelectorV1 = z.infer<
	typeof NativeMetadataSelectorV1Schema
>;

export const NativeMetadataObjectScopeV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	principal: z.strictObject({
		kind: z.enum(["user", "application"]),
		id: OpaqueIdV1Schema,
	}),
	agentId: OpaqueIdV1Schema,
	channelId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sessionGeneration: positiveSafeInteger,
	authorizationRevision: OpaqueIdV1Schema,
});
export type NativeMetadataObjectScopeV1 = z.infer<
	typeof NativeMetadataObjectScopeV1Schema
>;

const readIdentity = {
	schemaVersion: SchemaVersionV1Schema,
	readId: OpaqueIdV1Schema,
	selector,
	scope: NativeMetadataObjectScopeV1Schema,
	readStartedAt: positiveSafeInteger,
	expiresAt: positiveSafeInteger,
	requestId: RequestIdV1Schema,
	traceId: TraceIdV1Schema,
};

export const NativeMetadataRequestIdentityV1Schema = z
	.strictObject(readIdentity)
	.superRefine((value, context) => {
		if (
			value.readStartedAt > value.expiresAt ||
			value.expiresAt - value.readStartedAt > 30_000
		)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["expiresAt"],
				message: "Native metadata read lifetime is invalid",
			});
	});
export type NativeMetadataRequestIdentityV1 = z.infer<
	typeof NativeMetadataRequestIdentityV1Schema
>;

export const NativeMetadataCommandCapabilityV1Schema = z.strictObject({
	id: digest,
	kind: z.literal("command"),
	name: metadataName,
	description: z.string().max(4096),
	source: z.strictObject({ name: metadataName, version: metadataVersion }),
	parameters: z.tuple([]),
	effect: z.literal("read_only"),
	availability: z.literal("available"),
});
export type NativeMetadataCommandCapabilityV1 = z.infer<
	typeof NativeMetadataCommandCapabilityV1Schema
>;

export const NativeMetadataSkillCapabilityV1Schema = z.strictObject({
	id: digest,
	kind: z.literal("skill"),
	name: metadataName,
	description: z.string().max(4096),
	source: z.strictObject({ name: metadataName, version: metadataVersion }),
	availability: z.literal("discovered"),
});
export type NativeMetadataSkillCapabilityV1 = z.infer<
	typeof NativeMetadataSkillCapabilityV1Schema
>;

const uniqueCapabilityIds = <T extends { id: string }>(
	values: readonly T[],
): boolean => new Set(values.map((value) => value.id)).size === values.length;

export const NativeMetadataProjectionV1Schema = z.discriminatedUnion(
	"selector",
	[
		z.strictObject({
			selector: z.literal("status"),
			status: z.enum(["active", "idle", "not_loaded", "system_error"]),
			readAt: Rfc3339TimestampV1Schema,
		}),
		z
			.strictObject({
				selector: z.literal("commands"),
				revision: digest,
				capabilities: z.array(NativeMetadataCommandCapabilityV1Schema).max(128),
			})
			.superRefine((value, context) => {
				if (!uniqueCapabilityIds(value.capabilities))
					context.addIssue({
						code: z.ZodIssueCode.custom,
						path: ["capabilities"],
						message: "Capability ids must be unique",
					});
			}),
		z
			.strictObject({
				selector: z.literal("skills"),
				revision: digest,
				capabilities: z.array(NativeMetadataSkillCapabilityV1Schema).max(128),
			})
			.superRefine((value, context) => {
				if (!uniqueCapabilityIds(value.capabilities))
					context.addIssue({
						code: z.ZodIssueCode.custom,
						path: ["capabilities"],
						message: "Capability ids must be unique",
					});
			}),
	],
);
export type NativeMetadataProjectionV1 = z.infer<
	typeof NativeMetadataProjectionV1Schema
>;

export const PlatformNativeMetadataReadRequestV1Schema = z.strictObject({
	...readIdentity,
	apiRequestSourceRef: OpaqueIdV1Schema,
});
export type PlatformNativeMetadataReadRequestV1 = z.infer<
	typeof PlatformNativeMetadataReadRequestV1Schema
>;

export const NativeMetadataCurrentRequestV1Schema = z.discriminatedUnion(
	"phase",
	[
		z.strictObject({
			...readIdentity,
			phase: z.literal("resolve_original_binding"),
			originalHostScopeRef: z.null(),
		}),
		z.strictObject({
			...readIdentity,
			phase: z.literal("read_metadata"),
			originalHostScopeRef: OpaqueIdV1Schema,
		}),
	],
);
export type NativeMetadataCurrentRequestV1 = z.infer<
	typeof NativeMetadataCurrentRequestV1Schema
>;

export const NativeMetadataCurrentResponseV1Schema = z.discriminatedUnion(
	"outcome",
	[
		z.strictObject({
			outcome: z.literal("allowed"),
			request: NativeMetadataCurrentRequestV1Schema,
		}),
		z.strictObject({ outcome: z.literal("denied") }),
		z.strictObject({ outcome: z.literal("unavailable") }),
	],
);
export type NativeMetadataCurrentResponseV1 = z.infer<
	typeof NativeMetadataCurrentResponseV1Schema
>;

export const RuntimeNativeMetadataBindingRequestV1Schema = z.strictObject({
	...readIdentity,
});
export type RuntimeNativeMetadataBindingRequestV1 = z.infer<
	typeof RuntimeNativeMetadataBindingRequestV1Schema
>;

export const RuntimeNativeMetadataBindingResponseV1Schema = z.strictObject({
	...readIdentity,
	originalHostScopeRef: OpaqueIdV1Schema,
});
export type RuntimeNativeMetadataBindingResponseV1 = z.infer<
	typeof RuntimeNativeMetadataBindingResponseV1Schema
>;

export const RuntimeNativeMetadataProofV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	format: z.literal("native-metadata-jws"),
	token: z.string().min(1).max(16384),
});
export type RuntimeNativeMetadataProofV1 = z.infer<
	typeof RuntimeNativeMetadataProofV1Schema
>;

export const RuntimeNativeMetadataReadRequestV1Schema = z.strictObject({
	...readIdentity,
	originalHostScopeRef: OpaqueIdV1Schema,
	proof: RuntimeNativeMetadataProofV1Schema,
});
export type RuntimeNativeMetadataReadRequestV1 = z.infer<
	typeof RuntimeNativeMetadataReadRequestV1Schema
>;

export const RuntimeNativeMetadataReadResponseV1Schema = z.strictObject({
	...readIdentity,
	originalHostScopeRef: OpaqueIdV1Schema,
	projection: NativeMetadataProjectionV1Schema,
});
export type RuntimeNativeMetadataReadResponseV1 = z.infer<
	typeof RuntimeNativeMetadataReadResponseV1Schema
>;

export const RuntimeNativeMetadataV1SchemaDefinitions = {
	NativeMetadataSelectorV1: NativeMetadataSelectorV1Schema,
	NativeMetadataObjectScopeV1: NativeMetadataObjectScopeV1Schema,
	NativeMetadataRequestIdentityV1: NativeMetadataRequestIdentityV1Schema,
	NativeMetadataCommandCapabilityV1: NativeMetadataCommandCapabilityV1Schema,
	NativeMetadataSkillCapabilityV1: NativeMetadataSkillCapabilityV1Schema,
	NativeMetadataProjectionV1: NativeMetadataProjectionV1Schema,
	PlatformNativeMetadataReadRequestV1:
		PlatformNativeMetadataReadRequestV1Schema,
	NativeMetadataCurrentRequestV1: NativeMetadataCurrentRequestV1Schema,
	NativeMetadataCurrentResponseV1: NativeMetadataCurrentResponseV1Schema,
	RuntimeNativeMetadataBindingRequestV1:
		RuntimeNativeMetadataBindingRequestV1Schema,
	RuntimeNativeMetadataBindingResponseV1:
		RuntimeNativeMetadataBindingResponseV1Schema,
	RuntimeNativeMetadataProofV1: RuntimeNativeMetadataProofV1Schema,
	RuntimeNativeMetadataReadRequestV1: RuntimeNativeMetadataReadRequestV1Schema,
	RuntimeNativeMetadataReadResponseV1:
		RuntimeNativeMetadataReadResponseV1Schema,
};
