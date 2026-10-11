import { createHash } from "node:crypto";
import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import type { TimedOutUnknownStopResolutionInputV1 } from "@agent-infra/platform-core";
import type {
	PostgresTaskAuthorizationStoreV1,
	TimedOutUnknownStopResolutionResultV1,
} from "@agent-infra/platform-store";
import type { Hono } from "hono";
import { z } from "zod";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { type IdentityAdapter, resolveIdentity } from "./identity.js";

const requestSchema = z
	.object({
		schemaVersion: z.literal(1),
		sessionGeneration: z.number().int().safe().min(1),
	})
	.strict();

export interface UnknownStopOperationsRouteDependencies {
	readonly identity: IdentityAdapter;
	readonly resolveTimedOutUnknownStop: PostgresTaskAuthorizationStoreV1["resolveTimedOutUnknownStop"];
}

function id(value: string | undefined, traceId: string): string {
	const parsed = OpaqueIdV1Schema.safeParse(value);
	if (!parsed.success) throw new HttpProtocolError("INVALID_REQUEST", traceId);
	return parsed.data;
}

function response(result: TimedOutUnknownStopResolutionResultV1) {
	return {
		schemaVersion: 1,
		status: result.status,
		conversationId: result.conversationId,
		executionId: result.executionId,
		stopRequestId: result.stopRequestId,
		controlRecordId: result.controlRecordId,
		replayed: result.replayed,
	};
}

export function registerUnknownStopOperationsRoutes(
	app: Hono,
	dependencies: UnknownStopOperationsRouteDependencies,
): void {
	app.post(
		"/internal/platform/v1/conversations/:conversationId/executions/:executionId/stops/:stopRequestId/resolve-unknown",
		async (context) => {
			const metadata = requestMetadata(context.req.raw);
			try {
				const identity = await resolveIdentity(
					dependencies.identity,
					context.req.raw,
					metadata.traceId,
				);
				if (!identity.roles.includes("system_admin"))
					throw new HttpProtocolError("FORBIDDEN", metadata.traceId);
				const { value: body } = await parseJson(
					context.req.raw,
					requestSchema,
					metadata.traceId,
				);
				const conversationId = id(
					context.req.param("conversationId"),
					metadata.traceId,
				);
				const executionId = id(
					context.req.param("executionId"),
					metadata.traceId,
				);
				const stopRequestId = id(
					context.req.param("stopRequestId"),
					metadata.traceId,
				);
				const input: TimedOutUnknownStopResolutionInputV1 = {
					conversationId,
					executionId,
					stopRequestId,
					sessionGeneration: body.sessionGeneration,
					operatorId: identity.userId,
					idempotencyKey: parseIdempotencyKey(
						context.req.raw,
						metadata.traceId,
					),
					requestDigest: createHash("sha256")
						.update(
							JSON.stringify({
								schemaVersion: 1,
								conversationId,
								executionId,
								stopRequestId,
								sessionGeneration: body.sessionGeneration,
							}),
						)
						.digest("hex"),
					traceId: metadata.traceId,
					requestId: metadata.requestId,
				};
				return context.json(
					response(await dependencies.resolveTimedOutUnknownStop(input)),
					200,
				);
			} catch (error) {
				if (error instanceof HttpProtocolError)
					return context.json(error.body, error.status);
				return context.json(
					new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId)
						.body,
					503,
				);
			}
		},
	);
}
