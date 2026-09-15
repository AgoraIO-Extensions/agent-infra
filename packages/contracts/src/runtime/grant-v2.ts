import { z } from "zod";

import { OpaqueCursorV1Schema, OpaqueIdV1Schema } from "../index.ts";

export const RuntimePrincipalV1Schema = z.strictObject({
	kind: z.enum(["user", "application"]),
	id: OpaqueIdV1Schema,
});

export const RuntimeOperationBindingV2Schema = z.strictObject({
	kind: z.enum(["execution", "message", "stop", "generation"]),
	id: OpaqueIdV1Schema,
	deliveryFence: z.number().int().positive().safe(),
	executionDeliveryFence: z.number().int().positive().safe(),
});

export const RuntimeExecutionGrantV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	format: z.literal("runtime-execution-jws"),
	token: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
});

export const RuntimeBusinessCommandV2Schema = z.enum([
	"turn.submit",
	"turn.supplement",
	"turn.stop",
	"session.status",
	"execution.renew",
	"events.persist",
	"events.ack",
]);

export const RuntimeControlCommandV2Schema = z.enum([
	"turn.stop",
	"session.status",
	"generation.cancel",
	"events.persist",
	"events.ack",
]);

export const RuntimeControlReasonV2Schema = z.enum([
	"stop",
	"authorization_revoked",
	"recovery",
	"generation_isolation",
]);

const commonClaims = {
	schemaVersion: z.literal(2),
	issuer: OpaqueIdV1Schema,
	audience: z.literal("runtime_host"),
	issuedAt: z.number().int().nonnegative().safe(),
	expiresAt: z.number().int().positive().safe(),
	grantId: OpaqueIdV1Schema,
	workerId: OpaqueIdV1Schema,
	principal: RuntimePrincipalV1Schema,
	agentId: OpaqueIdV1Schema,
	channelId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	turnId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
	traceId: OpaqueIdV1Schema,
	hostSessionRef: OpaqueIdV1Schema.nullable(),
	operation: RuntimeOperationBindingV2Schema,
	requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
	eventAccess: z
		.discriminatedUnion("command", [
			z.strictObject({
				command: z.literal("events.persist"),
				consumer: z.literal("platform_worker_persistence"),
				afterCursor: OpaqueCursorV1Schema.nullable(),
			}),
			z.strictObject({
				command: z.literal("events.ack"),
				consumer: z.literal("platform_worker_persistence"),
				confirmedCursor: OpaqueCursorV1Schema,
			}),
		])
		.optional(),
};

export const RuntimeBusinessGrantClaimsV2Schema = z.strictObject({
	...commonClaims,
	purpose: z.literal("business"),
	authorizationRecordId: OpaqueIdV1Schema,
	allowedCommands: z.tuple([RuntimeBusinessCommandV2Schema]),
	attachments: z.array(
		z.strictObject({
			attachmentId: OpaqueIdV1Schema,
			operations: z.tuple([z.literal("read")]),
		}),
	),
});

export const RuntimeControlGrantClaimsV2Schema = z.strictObject({
	...commonClaims,
	purpose: z.literal("control"),
	controlRecordId: OpaqueIdV1Schema,
	reason: RuntimeControlReasonV2Schema,
	allowedCommands: z.tuple([RuntimeControlCommandV2Schema]),
});

export const RuntimeExecutionGrantClaimsV2Schema = z.discriminatedUnion(
	"purpose",
	[RuntimeBusinessGrantClaimsV2Schema, RuntimeControlGrantClaimsV2Schema],
);

export const VerifiedRuntimeExecutionGrantV2Schema = z.strictObject({
	token: RuntimeExecutionGrantV2Schema.shape.token,
	claims: RuntimeExecutionGrantClaimsV2Schema,
});

export const RuntimeExecutionGrantMaximumLifetimeMsV2 = 30_000;

// Cryptographic verification and request/binding checks are the Host's responsibility.
export function validateVerifiedRuntimeExecutionGrantClaimsV2(
	input: unknown,
	context: { expectedIssuer: string; expectedWorkerId: string; now: number },
) {
	const claims = RuntimeExecutionGrantClaimsV2Schema.parse(input);
	const command = claims.allowedCommands[0];
	const isEvent = command === "events.persist" || command === "events.ack";
	if (
		claims.issuer !== context.expectedIssuer ||
		claims.workerId !== context.expectedWorkerId ||
		!Number.isSafeInteger(context.now) ||
		claims.issuedAt > context.now ||
		claims.expiresAt <= context.now ||
		claims.expiresAt <= claims.issuedAt ||
		claims.expiresAt - claims.issuedAt >
			RuntimeExecutionGrantMaximumLifetimeMsV2 ||
		(isEvent
			? claims.eventAccess?.command !== command
			: claims.eventAccess !== undefined) ||
		(claims.purpose === "business" &&
			command !== "turn.submit" &&
			command !== "turn.supplement" &&
			claims.attachments.length !== 0) ||
		(claims.operation.kind === "execution" &&
			claims.operation.deliveryFence !==
				claims.operation.executionDeliveryFence)
	) {
		throw new Error("Runtime Execution Grant claims are inconsistent");
	}
	return claims;
}

export type RuntimePrincipalV1 = z.infer<typeof RuntimePrincipalV1Schema>;
export type RuntimeOperationBindingV2 = z.infer<
	typeof RuntimeOperationBindingV2Schema
>;
export type RuntimeExecutionGrantV2 = z.infer<
	typeof RuntimeExecutionGrantV2Schema
>;
export type RuntimeBusinessCommandV2 = z.infer<
	typeof RuntimeBusinessCommandV2Schema
>;
export type RuntimeControlCommandV2 = z.infer<
	typeof RuntimeControlCommandV2Schema
>;
export type RuntimeControlReasonV2 = z.infer<
	typeof RuntimeControlReasonV2Schema
>;
export type RuntimeBusinessGrantClaimsV2 = z.infer<
	typeof RuntimeBusinessGrantClaimsV2Schema
>;
export type RuntimeControlGrantClaimsV2 = z.infer<
	typeof RuntimeControlGrantClaimsV2Schema
>;
export type RuntimeExecutionGrantClaimsV2 = z.infer<
	typeof RuntimeExecutionGrantClaimsV2Schema
>;
export type VerifiedRuntimeExecutionGrantV2 = z.infer<
	typeof VerifiedRuntimeExecutionGrantV2Schema
>;
