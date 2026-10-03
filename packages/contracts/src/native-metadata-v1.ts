import { z } from "zod";
const SchemaVersionV1Schema = z.literal(1);
const OpaqueIdV1Schema = z.string().min(1);
const RequestIdV1Schema = z.string().min(1);
const TraceIdV1Schema = z.string().min(1);

const boundedText = (maximum: number) =>
	z.string().max(maximum).refine((value) => !value.includes("\0"));
const requiredText = (maximum: number) =>
	z.string().min(1).max(maximum).refine((value) => !value.includes("\0"));
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const NativeMetadataSelectorV1Schema = z.enum([
	"status",
	"commands",
	"skills",
]);
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
	sessionGeneration: z.number().int().min(1).safe(),
	authorizationRevision: OpaqueIdV1Schema,
});
export type NativeMetadataObjectScopeV1 = z.infer<
	typeof NativeMetadataObjectScopeV1Schema
>;
export type ConversationNativeMetadataObjectScopeV1 =
	NativeMetadataObjectScopeV1;

const readIdentityShape = {
	schemaVersion: SchemaVersionV1Schema,
	readId: OpaqueIdV1Schema,
	selector: NativeMetadataSelectorV1Schema,
	scope: NativeMetadataObjectScopeV1Schema,
	readStartedAt: z.number().int().nonnegative().safe(),
	expiresAt: z.number().int().nonnegative().safe(),
	requestId: RequestIdV1Schema,
	traceId: TraceIdV1Schema,
};

export const NativeMetadataRequestIdentityV1Schema = z
	.strictObject(readIdentityShape)
	.refine((value) => value.readStartedAt < value.expiresAt)
	.refine((value) => value.expiresAt <= value.readStartedAt + 30_000);
export type NativeMetadataRequestIdentityV1 = z.infer<
	typeof NativeMetadataRequestIdentityV1Schema
>;

export const PlatformNativeMetadataReadRequestV1Schema = z.strictObject({
	...readIdentityShape,
	apiRequestSourceRef: OpaqueIdV1Schema,
});
export type PlatformNativeMetadataReadRequestV1 = z.infer<
	typeof PlatformNativeMetadataReadRequestV1Schema
>;

export const NativeMetadataCurrentRequestV1Schema = z.strictObject({
	...readIdentityShape,
	phase: z.enum(["resolve_original_binding", "read_metadata"]),
	originalHostScopeRef: sha256.nullable(),
});
export type NativeMetadataCurrentRequestV1 = z.infer<
	typeof NativeMetadataCurrentRequestV1Schema
>;

export const NativeMetadataCurrentResponseV1Schema = z.union([
	z.strictObject({ outcome: z.literal("allowed"), request: NativeMetadataCurrentRequestV1Schema }),
	z.strictObject({ outcome: z.literal("denied") }),
	z.strictObject({ outcome: z.literal("unavailable") }),
]);
export type NativeMetadataCurrentResponseV1 = z.infer<
	typeof NativeMetadataCurrentResponseV1Schema
>;

const sourceShape = z.strictObject({
	name: requiredText(256),
	version: requiredText(128),
});
const commandCapability = z.strictObject({
	id: sha256,
	kind: z.literal("command"),
	name: requiredText(256),
	description: boundedText(4096),
	source: sourceShape,
	parameters: z.tuple([]),
	effect: z.literal("read_only"),
	availability: z.literal("available"),
});
const skillCapability = z.strictObject({
	id: sha256,
	kind: z.literal("skill"),
	name: requiredText(256),
	description: boundedText(4096),
	source: sourceShape,
	availability: z.literal("discovered"),
});
const boundedCapabilities = <T extends z.ZodTypeAny>(item: T) =>
	z.array(item).max(128).superRefine((items, context) => {
		const ids = new Set(items.map((value) => (value as { id: string }).id));
		if (ids.size !== items.length)
			context.addIssue({ code: "custom", message: "duplicate capability id" });
	});

export const NativeMetadataProjectionV1Schema = z.discriminatedUnion(
	"selector",
	[
		z.strictObject({
			selector: z.literal("status"),
			status: z.enum(["active", "idle", "not_loaded", "system_error"]),
			readAt: z.string().datetime({ offset: true }),
		}),
		z.strictObject({
			selector: z.literal("commands"),
			revision: sha256,
			capabilities: boundedCapabilities(commandCapability),
		}),
		z.strictObject({
			selector: z.literal("skills"),
			revision: sha256,
			capabilities: boundedCapabilities(skillCapability),
		}),
	],
);
export type NativeMetadataProjectionV1 = z.infer<
	typeof NativeMetadataProjectionV1Schema
>;

export const NativeMetadataCapabilitySourceV1Schema = sourceShape;
