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
const boundedIdentity = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => !value.includes("\0"));
const metadataName = z.string().min(1).max(256);
const metadataVersion = z.string().min(1).max(128);

export const RuntimeNativeMetadataProofMaximumLifetimeMsV1 = 30_000;

function validateReadLifetime(
	value: { readStartedAt: number; expiresAt: number },
	context: z.RefinementCtx,
) {
	if (
		value.readStartedAt > value.expiresAt ||
		value.expiresAt - value.readStartedAt >
			RuntimeNativeMetadataProofMaximumLifetimeMsV1
	)
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["expiresAt"],
			message: "Native metadata read lifetime is invalid",
		});
}

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
	.superRefine(validateReadLifetime);
export type NativeMetadataRequestIdentityV1 = z.infer<
	typeof NativeMetadataRequestIdentityV1Schema
>;

export const NativeMetadataCommandCapabilityV1Schema = z.strictObject({
	id: digest,
	kind: z.literal("command"),
	name: metadataName,
	description: z.string().max(4096),
	source: z.strictObject({ name: metadataName, version: metadataVersion }),
	parameters: z.array(z.never()).max(0),
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

const nativeMetadataStatusProjectionV1Schema = z.strictObject({
	selector: z.literal("status"),
	status: z.enum(["active", "idle", "not_loaded", "system_error"]),
	readAt: Rfc3339TimestampV1Schema,
});
const nativeMetadataCommandsProjectionV1Schema = z
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
	});
const nativeMetadataSkillsProjectionV1Schema = z
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
	});

export const NativeMetadataProjectionV1Schema = z.discriminatedUnion(
	"selector",
	[
		nativeMetadataStatusProjectionV1Schema,
		nativeMetadataCommandsProjectionV1Schema,
		nativeMetadataSkillsProjectionV1Schema,
	],
);
export type NativeMetadataProjectionV1 = z.infer<
	typeof NativeMetadataProjectionV1Schema
>;

export const PlatformNativeMetadataReadRequestV1Schema = z
	.strictObject({
		...readIdentity,
		apiRequestSourceRef: OpaqueIdV1Schema,
	})
	.superRefine(validateReadLifetime);
export type PlatformNativeMetadataReadRequestV1 = z.infer<
	typeof PlatformNativeMetadataReadRequestV1Schema
>;

export const NativeMetadataCurrentRequestV1Schema = z.discriminatedUnion(
	"phase",
	[
		z
			.strictObject({
				...readIdentity,
				phase: z.literal("resolve_original_binding"),
				originalHostScopeRef: z.null(),
			})
			.superRefine(validateReadLifetime),
		z
			.strictObject({
				...readIdentity,
				phase: z.literal("read_metadata"),
				originalHostScopeRef: OpaqueIdV1Schema,
			})
			.superRefine(validateReadLifetime),
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

export const RuntimeNativeMetadataBindingRequestV1Schema = z
	.strictObject({
		...readIdentity,
	})
	.superRefine(validateReadLifetime);
export type RuntimeNativeMetadataBindingRequestV1 = z.infer<
	typeof RuntimeNativeMetadataBindingRequestV1Schema
>;

export const RuntimeNativeMetadataBindingResponseV1Schema = z
	.strictObject({
		...readIdentity,
		originalHostScopeRef: OpaqueIdV1Schema,
	})
	.superRefine(validateReadLifetime);
export type RuntimeNativeMetadataBindingResponseV1 = z.infer<
	typeof RuntimeNativeMetadataBindingResponseV1Schema
>;

const runtimeNativeMetadataProofClaimsShape = {
	...readIdentity,
	purpose: z.literal("native_metadata_read"),
	issuedAt: z.number().int().nonnegative().safe().meta({ minimum: 0 }),
	issuer: boundedIdentity,
	audience: z.literal("runtime_host.native_metadata_read"),
	workerId: boundedIdentity,
	keyVersion: boundedIdentity,
	originalHostScopeRef: boundedIdentity,
	requestDigest: digest,
};

/**
 * Signed payload claims for one native metadata read.
 *
 * The `purpose` and `audience` literals are intentional discriminators: this
 * proof can never be interpreted as a Runtime Execution Grant or another
 * metadata operation.  The request identity and object scope are repeated in
 * the signed payload so a verifier can compare every field without casts.
 */
export const RuntimeNativeMetadataProofClaimsV1Schema = z
	.strictObject(runtimeNativeMetadataProofClaimsShape)
	.superRefine((value, context) => {
		if (
			value.readStartedAt > value.issuedAt ||
			value.issuedAt >= value.expiresAt ||
			value.expiresAt - value.readStartedAt >
				RuntimeNativeMetadataProofMaximumLifetimeMsV1
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["issuedAt"],
				message: "Native metadata proof lifetime is invalid",
			});
		}
	});
export type RuntimeNativeMetadataProofClaimsV1 = z.infer<
	typeof RuntimeNativeMetadataProofClaimsV1Schema
>;

export const RuntimeNativeMetadataProofV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	format: z.literal("native-metadata-jws"),
	token: z.string().min(1).max(16384),
});
export type RuntimeNativeMetadataProofV1 = z.infer<
	typeof RuntimeNativeMetadataProofV1Schema
>;

export const RuntimeNativeMetadataReadRequestV1Schema = z
	.strictObject({
		...readIdentity,
		originalHostScopeRef: OpaqueIdV1Schema,
		proof: RuntimeNativeMetadataProofV1Schema,
	})
	.superRefine(validateReadLifetime);
export type RuntimeNativeMetadataReadRequestV1 = z.infer<
	typeof RuntimeNativeMetadataReadRequestV1Schema
>;

export const RuntimeNativeMetadataReadResponseV1Schema = z.discriminatedUnion(
	"selector",
	[
		z
			.strictObject({
				...readIdentity,
				selector: z.literal("status"),
				originalHostScopeRef: OpaqueIdV1Schema,
				projection: nativeMetadataStatusProjectionV1Schema,
			})
			.superRefine(validateReadLifetime),
		z
			.strictObject({
				...readIdentity,
				selector: z.literal("commands"),
				originalHostScopeRef: OpaqueIdV1Schema,
				projection: nativeMetadataCommandsProjectionV1Schema,
			})
			.superRefine(validateReadLifetime),
		z
			.strictObject({
				...readIdentity,
				selector: z.literal("skills"),
				originalHostScopeRef: OpaqueIdV1Schema,
				projection: nativeMetadataSkillsProjectionV1Schema,
			})
			.superRefine(validateReadLifetime),
	],
);
export type RuntimeNativeMetadataReadResponseV1 = z.infer<
	typeof RuntimeNativeMetadataReadResponseV1Schema
>;

export interface RuntimeNativeMetadataProofClaimsValidationContextV1 {
	readonly request: RuntimeNativeMetadataBindingResponseV1;
	readonly expectedIssuer: string;
	readonly expectedWorkerId: string;
	readonly expectedRequestDigest: string;
	readonly now: number;
}

/**
 * Validate a parsed proof payload against the exact request it authorizes.
 *
 * Signature and deployment-key verification remain the RuntimeHost's job.
 * This helper owns the shared, non-cryptographic claim checks so consumers
 * receive the typed claims only after purpose, lifetime, identity, scope and
 * digest equality have all passed.
 */
export function validateRuntimeNativeMetadataProofClaimsV1(
	input: unknown,
	context: RuntimeNativeMetadataProofClaimsValidationContextV1,
): RuntimeNativeMetadataProofClaimsV1 {
	const claims = RuntimeNativeMetadataProofClaimsV1Schema.parse(input);
	const request = RuntimeNativeMetadataBindingResponseV1Schema.parse(
		context.request,
	);
	if (
		!Number.isSafeInteger(context.now) ||
		claims.issuer !== context.expectedIssuer ||
		claims.workerId !== context.expectedWorkerId ||
		claims.readStartedAt !== request.readStartedAt ||
		claims.issuedAt > context.now ||
		claims.expiresAt <= context.now ||
		claims.expiresAt !== request.expiresAt ||
		claims.readId !== request.readId ||
		claims.selector !== request.selector ||
		claims.requestId !== request.requestId ||
		claims.traceId !== request.traceId ||
		claims.originalHostScopeRef !== request.originalHostScopeRef ||
		claims.scope.schemaVersion !== request.scope.schemaVersion ||
		claims.scope.principal.kind !== request.scope.principal.kind ||
		claims.scope.principal.id !== request.scope.principal.id ||
		claims.scope.agentId !== request.scope.agentId ||
		claims.scope.channelId !== request.scope.channelId ||
		claims.scope.conversationId !== request.scope.conversationId ||
		claims.scope.executionId !== request.scope.executionId ||
		claims.scope.sessionGeneration !== request.scope.sessionGeneration ||
		claims.scope.authorizationRevision !==
			request.scope.authorizationRevision ||
		claims.requestDigest !== context.expectedRequestDigest
	) {
		throw new Error("Native metadata proof claims are inconsistent");
	}
	return claims;
}

/** Fixed canonical field order for the digest input; proof is excluded. */
export function runtimeNativeMetadataRequestSigningPayloadV1(
	value: RuntimeNativeMetadataBindingResponseV1,
): string {
	const request = RuntimeNativeMetadataBindingResponseV1Schema.parse(value);
	const scope = request.scope;
	return JSON.stringify({
		schemaVersion: request.schemaVersion,
		readId: request.readId,
		selector: request.selector,
		scope: {
			schemaVersion: scope.schemaVersion,
			principal: { kind: scope.principal.kind, id: scope.principal.id },
			agentId: scope.agentId,
			channelId: scope.channelId,
			conversationId: scope.conversationId,
			executionId: scope.executionId,
			sessionGeneration: scope.sessionGeneration,
			authorizationRevision: scope.authorizationRevision,
		},
		readStartedAt: request.readStartedAt,
		expiresAt: request.expiresAt,
		requestId: request.requestId,
		traceId: request.traceId,
		originalHostScopeRef: request.originalHostScopeRef,
	});
}

/** Fixed canonical field order for the complete signed claims payload. */
export function runtimeNativeMetadataProofSigningPayloadV1(
	value: RuntimeNativeMetadataProofClaimsV1,
): string {
	const claims = RuntimeNativeMetadataProofClaimsV1Schema.parse(value);
	const {
		purpose,
		issuedAt,
		issuer,
		audience,
		workerId,
		keyVersion,
		requestDigest,
		...binding
	} = claims;
	return JSON.stringify({
		...JSON.parse(runtimeNativeMetadataRequestSigningPayloadV1(binding)),
		purpose,
		issuedAt,
		issuer,
		audience,
		workerId,
		keyVersion,
		requestDigest,
	});
}

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
	RuntimeNativeMetadataProofClaimsV1: RuntimeNativeMetadataProofClaimsV1Schema,
	RuntimeNativeMetadataProofV1: RuntimeNativeMetadataProofV1Schema,
	RuntimeNativeMetadataReadRequestV1: RuntimeNativeMetadataReadRequestV1Schema,
	RuntimeNativeMetadataReadResponseV1:
		RuntimeNativeMetadataReadResponseV1Schema,
};
