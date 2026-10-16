import { z } from "zod";
import { OpaqueIdV1Schema, SchemaVersionV1Schema } from "../index.ts";

export const AgentApiFailureCodeV1Schema = z.enum([
	"creation_not_ready",
	"health_check_failed",
	"workload_unavailable",
	"reconciliation_failed",
]);

export const AgentApiFailureReasonV1Schema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9 .,:'-]+$/);

export const AgentApiLifecycleRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	command: z.enum(["start", "stop", "restart"]),
});

export const AgentApiLifecycleResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	status: z.enum(["available", "stopped"]),
	revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	replayed: z.boolean(),
});

/** A committed lifecycle command whose full projection is temporarily unavailable. */
export const AgentApiLifecycleAcceptedResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	accepted: z.literal(true),
	agentId: OpaqueIdV1Schema,
	status: z
		.enum([
			"pending_approval",
			"withdrawn",
			"rejected",
			"creating",
			"available",
			"stopped",
			"creation_failed",
			"disabled",
		])
		.optional(),
	revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
	replayed: z.boolean(),
});

export const AgentApiStateResponseV1Schema = z
	.strictObject({
		schemaVersion: SchemaVersionV1Schema,
		agentId: OpaqueIdV1Schema,
		status: z.enum([
			"pending_approval",
			"withdrawn",
			"rejected",
			"creating",
			"available",
			"stopped",
			"creation_failed",
			"disabled",
		]),
		serviceAvailability: z
			.enum(["ready", "starting", "updating", "unavailable"])
			.nullable(),
		revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
		failureCode: AgentApiFailureCodeV1Schema.optional(),
		failureReason: AgentApiFailureReasonV1Schema.optional(),
	})
	.superRefine((value, context) => {
		const isFailureState =
			value.status === "creation_failed" ||
			(value.status === "available" &&
				value.serviceAvailability === "unavailable");
		const hasFailureCode = value.failureCode !== undefined;
		const hasFailureReason = value.failureReason !== undefined;
		if (
			hasFailureCode === isFailureState &&
			hasFailureReason === isFailureState
		)
			return;
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: [hasFailureCode ? "failureReason" : "failureCode"],
			message: "failure details are only valid for a failed Agent state",
		});
	});
