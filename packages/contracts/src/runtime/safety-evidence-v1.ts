import { z } from "zod";

import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
} from "../common.ts";

/**
 * Runtime safety acceptance evidence (Engineering Spec §18.5). Fixed results only: never a
 * business fact, authorization source or generic native output channel.
 */
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const positive = z.number().int().positive().safe();
const nonNegative = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Platform-owned opaque values (authorization revision, executor epoch), not producer refs. */
const platformOpaque = OpaqueIdV1Schema.max(256);
const podUid = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const RuntimeSafetyEvidenceKindV1Schema = z.enum([
	"isolation_observation",
	"control_observation",
	"original_admission_check",
]);
export type RuntimeSafetyEvidenceKindV1 = z.infer<
	typeof RuntimeSafetyEvidenceKindV1Schema
>;

/**
 * §18.5.1 common binding, resolved and fixed by the server when the evidence is produced.
 * Absent optional fields do not apply; producers never invent them (only an independent
 * executor carries an epoch). Native session/Turn/item references stay inside the Host.
 */
export const RuntimeSafetyEvidenceBindingV1Schema = z.strictObject({
	evidenceId: reference,
	scenario: z.strictObject({ id: reference, version: positive }),
	windowRef: reference,
	challengeRef: reference,
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	operation: z.strictObject({ ref: reference, attemptRef: reference }),
	principalRef: reference,
	purposeRef: reference,
	/** The execution's authorization record and its opaque revision, as the Platform stores them. */
	authorization: z
		.strictObject({ recordId: OpaqueIdV1Schema, revision: platformOpaque })
		.optional(),
	sessionGeneration: positive,
	executionDeliveryFence: positive,
	sandbox: z.strictObject({
		ref: reference,
		podUid,
		resourceFence: positive,
		/** The independent executor's opaque epoch (§11.2.1); never a counter invented here. */
		executorEpoch: platformOpaque.optional(),
	}),
	host: z.strictObject({
		instanceRef: reference,
		startRef: reference,
		configurationRevision: reference,
		imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	}),
	producer: z.strictObject({
		kind: z.enum(["native_helper", "model_transport"]),
		version: reference,
	}),
	observedAt: Rfc3339TimestampV1Schema,
	clockId: reference,
	sequence: nonNegative,
});
export type RuntimeSafetyEvidenceBindingV1 = z.infer<
	typeof RuntimeSafetyEvidenceBindingV1Schema
>;

export const RuntimeIsolationResourceClassV1Schema = z.enum([
	"file",
	"env",
	"proc",
	"workspace",
	"memory_file",
	"model_context",
]);
export const RuntimeIsolationActionClassV1Schema = z.enum([
	"open",
	"read",
	"write",
	"stat",
	"list",
	"signal",
	"model_request",
]);
export const RuntimeIsolationResultClassV1Schema = z.enum([
	"allowed",
	"denied",
	"unproven",
	"isolation_violation",
]);
export const RuntimeIsolationFailureClassV1Schema = z.enum([
	"permission_denied",
	"not_found",
	"policy_denied",
	"io_unavailable",
	"unsupported",
	"unknown",
]);

const fileResources = new Set(["file", "workspace", "memory_file"]);
const deniedFailures = new Set([
	"permission_denied",
	"not_found",
	"policy_denied",
]);
const unprovenFailures = new Set(["io_unavailable", "unsupported", "unknown"]);

const isolationFields = {
	resourceClass: RuntimeIsolationResourceClassV1Schema,
	actionClass: RuntimeIsolationActionClassV1Schema,
	/** `self`: the original subject's own synthetic fixture; `foreign`: another legal sample's. */
	targetScope: z.enum(["self", "foreign"]),
	resultClass: RuntimeIsolationResultClassV1Schema,
	nativeObserved: z.boolean(),
	failureClass: RuntimeIsolationFailureClassV1Schema.optional(),
	syntheticFile: z
		.strictObject({ byteLength: nonNegative, sha256: digest })
		.optional(),
	modelContext: z
		.strictObject({
			selfMarkerPresent: z.boolean(),
			foreignMarkerAbsent: z.boolean(),
			observationComplete: z.boolean(),
		})
		.optional(),
	/** Monotonic duration of the leaf I/O, in its own clock domain. */
	durationMonoMs: nonNegative.optional(),
};

type IsolationFields = {
	resourceClass: z.infer<typeof RuntimeIsolationResourceClassV1Schema>;
	actionClass: z.infer<typeof RuntimeIsolationActionClassV1Schema>;
	targetScope: "self" | "foreign";
	resultClass: z.infer<typeof RuntimeIsolationResultClassV1Schema>;
	nativeObserved: boolean;
	failureClass?: z.infer<typeof RuntimeIsolationFailureClassV1Schema>;
	syntheticFile?: { byteLength: number; sha256: string };
	modelContext?: {
		selfMarkerPresent: boolean;
		foreignMarkerAbsent: boolean;
		observationComplete: boolean;
	};
};

/** One fixed rule set shared by the record and both projections (§18.5.2 字段). */
function isolationIssue(value: IsolationFields): string | undefined {
	const context = value.resourceClass === "model_context";
	if (context !== (value.actionClass === "model_request"))
		return "model_context uses model_request only";
	if (context !== (value.modelContext !== undefined))
		return "only model_context carries the three context booleans";
	if (context && value.targetScope !== "self")
		return "model_context observes the execution's own outbound context";
	if (value.syntheticFile !== undefined) {
		if (
			value.targetScope !== "self" ||
			value.resultClass !== "allowed" ||
			!fileResources.has(value.resourceClass) ||
			(value.actionClass !== "read" && value.actionClass !== "write") ||
			!value.nativeObserved
		)
			return "byteLength/sha256 only for the subject's own observed synthetic file read or write";
	} else if (
		value.targetScope === "self" &&
		value.resultClass === "allowed" &&
		fileResources.has(value.resourceClass) &&
		(value.actionClass === "read" || value.actionClass === "write")
	)
		// The subject projection cannot omit them (§18.5.1 投影); unconfirmed is UNPROVEN.
		return "the subject's own synthetic file read or write positive carries byteLength/sha256";
	if (value.targetScope === "foreign" && value.resultClass === "allowed")
		return "a foreign access that succeeded is an isolation_violation";
	if (
		value.targetScope === "self" &&
		value.resultClass === "isolation_violation" &&
		!context
	)
		return "isolation_violation needs a foreign target";
	switch (value.resultClass) {
		case "allowed":
		case "isolation_violation":
			if (value.failureClass !== undefined) return "no failureClass on success";
			if (!value.nativeObserved)
				return "a fixed result needs an observed native action";
			break;
		case "denied":
			if (!value.failureClass || !deniedFailures.has(value.failureClass))
				return "denied needs permission_denied, not_found or policy_denied";
			if (!value.nativeObserved)
				return "a fixed result needs an observed native action";
			if (context) return "model_context is never denied";
			break;
		case "unproven":
			if (!value.failureClass || !unprovenFailures.has(value.failureClass))
				return "unproven needs io_unavailable, unsupported or unknown";
			break;
	}
	if (context && value.modelContext) {
		const { selfMarkerPresent, foreignMarkerAbsent, observationComplete } =
			value.modelContext;
		const expected = !observationComplete
			? "unproven"
			: !foreignMarkerAbsent
				? "isolation_violation"
				: selfMarkerPresent
					? "allowed"
					: "unproven";
		if (value.resultClass !== expected)
			return "model_context resultClass follows its three booleans";
	}
	return undefined;
}

const refineIsolation = (value: IsolationFields, context: z.RefinementCtx) => {
	const issue = isolationIssue(value);
	if (issue) context.addIssue({ code: "custom", message: issue });
};

/** §18.5.2: one immutable isolation observation produced by a protected producer. */
export const RuntimeIsolationEvidenceV1Schema = z
	.strictObject({
		schemaVersion: z.literal(1),
		code: z.literal("RUNTIME_ISOLATION_EVIDENCE_V1"),
		kind: z.literal("isolation_observation"),
		binding: RuntimeSafetyEvidenceBindingV1Schema,
		...isolationFields,
	})
	.superRefine((value, context) => {
		refineIsolation(value, context);
		const helper = value.binding.producer.kind === "native_helper";
		if (helper === (value.resourceClass === "model_context"))
			context.addIssue({
				code: "custom",
				message:
					"files, env and proc come from the native helper; context from the model transport",
			});
	});
export type RuntimeIsolationEvidenceV1 = z.infer<
	typeof RuntimeIsolationEvidenceV1Schema
>;

/**
 * Persisted evidence kinds this reader understands. An unknown kind is an explicit rejection
 * (the reader must be upgraded first), never a silently dropped field (§18.5.1 载体与版本).
 */
export const RuntimePersistedSafetyEvidenceV1Schema = z.discriminatedUnion(
	"kind",
	[RuntimeIsolationEvidenceV1Schema],
);
export type RuntimePersistedSafetyEvidenceV1 = z.infer<
	typeof RuntimePersistedSafetyEvidenceV1Schema
>;

/** Capability the Worker declares before a Host produces persisted safety evidence. */
export const RuntimeSafetyEvidenceCapabilityV1 = "runtime-safety-evidence-v1";

/** Host evidence log, separate from the business journal: own cursor and ACK. */
export const RuntimeSafetyEvidenceLogReadRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	capability: z.literal(RuntimeSafetyEvidenceCapabilityV1),
	after: OpaqueCursorV1Schema.nullable(),
	limit: z.number().int().min(1).max(100),
});
export const RuntimeSafetyEvidenceLogEntryV1Schema = z.strictObject({
	cursor: OpaqueCursorV1Schema,
	/** Parsed by the reader with RuntimePersistedSafetyEvidenceV1Schema. */
	record: z.unknown(),
});
export const RuntimeSafetyEvidenceLogReadResponseV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	entries: z.array(RuntimeSafetyEvidenceLogEntryV1Schema).max(100),
});
export const RuntimeSafetyEvidenceLogAckRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	capability: z.literal(RuntimeSafetyEvidenceCapabilityV1),
	cursor: OpaqueCursorV1Schema,
});
export type RuntimeSafetyEvidenceLogEntryV1 = z.infer<
	typeof RuntimeSafetyEvidenceLogEntryV1Schema
>;

const principalFields = {
	schemaVersion: z.literal(1),
	code: z.literal("RUNTIME_ISOLATION_EVIDENCE_V1"),
	kind: z.literal("isolation_observation"),
	evidenceRef: reference,
	scenario: z.strictObject({ id: reference, version: positive }),
	windowRef: reference,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	...isolationFields,
	observedAt: Rfc3339TimestampV1Schema,
	clockId: reference,
	sequence: nonNegative,
};

/**
 * The original subject's projection (§18.5.1 投影): fixed results including nativeObserved,
 * the own synthetic file length/hash and the three context booleans; no technical binding.
 */
export const RuntimeIsolationEvidencePrincipalProjectionV1Schema = z
	.strictObject(principalFields)
	.superRefine(refineIsolation);
export type RuntimeIsolationEvidencePrincipalProjectionV1 = z.infer<
	typeof RuntimeIsolationEvidencePrincipalProjectionV1Schema
>;

/** The approved operator projection adds the technical binding. */
export const RuntimeIsolationEvidenceOperatorProjectionV1Schema = z
	.strictObject({
		...principalFields,
		binding: RuntimeSafetyEvidenceBindingV1Schema,
	})
	.superRefine(refineIsolation);
export type RuntimeIsolationEvidenceOperatorProjectionV1 = z.infer<
	typeof RuntimeIsolationEvidenceOperatorProjectionV1Schema
>;

function resultFields(record: RuntimeIsolationEvidenceV1) {
	return {
		resourceClass: record.resourceClass,
		actionClass: record.actionClass,
		targetScope: record.targetScope,
		resultClass: record.resultClass,
		nativeObserved: record.nativeObserved,
		...(record.failureClass === undefined
			? {}
			: { failureClass: record.failureClass }),
		...(record.syntheticFile === undefined
			? {}
			: { syntheticFile: { ...record.syntheticFile } }),
		...(record.modelContext === undefined
			? {}
			: { modelContext: { ...record.modelContext } }),
		...(record.durationMonoMs === undefined
			? {}
			: { durationMonoMs: record.durationMonoMs }),
	};
}

export function projectIsolationEvidenceForPrincipalV1(
	record: RuntimeIsolationEvidenceV1,
): RuntimeIsolationEvidencePrincipalProjectionV1 {
	const { binding } = record;
	return RuntimeIsolationEvidencePrincipalProjectionV1Schema.parse({
		schemaVersion: 1,
		code: record.code,
		kind: record.kind,
		evidenceRef: binding.evidenceId,
		scenario: { ...binding.scenario },
		windowRef: binding.windowRef,
		conversationId: binding.conversationId,
		executionId: binding.executionId,
		...resultFields(record),
		observedAt: binding.observedAt,
		clockId: binding.clockId,
		sequence: binding.sequence,
	});
}

export function projectIsolationEvidenceForOperatorV1(
	record: RuntimeIsolationEvidenceV1,
): RuntimeIsolationEvidenceOperatorProjectionV1 {
	return RuntimeIsolationEvidenceOperatorProjectionV1Schema.parse({
		...projectIsolationEvidenceForPrincipalV1(record),
		binding: structuredClone(record.binding),
	});
}
