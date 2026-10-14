import type {
	NativeCapabilityAdmissionDecisionV1,
	NativeCapabilityAdmissionRequestV1,
} from "@agent-infra/platform-core";
import type { Hono } from "hono";
import { z } from "zod";
import { requestMetadata } from "./common.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity,
} from "./identity.js";

const path = "/api/v2/conversations/:conversationId/native-capability/invoke";
const requestSchema = z.strictObject({
	capabilityId: z.string().regex(/^[a-f0-9]{64}$/),
	directoryRevision: z.string().regex(/^[a-f0-9]{64}$/),
	parameters: z.string().max(16 * 1024),
	idempotencyKey: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/),
	requestId: z.string().min(1).max(256),
	traceId: z.string().min(1).max(256),
});

type HttpRequest = z.infer<typeof requestSchema>;

export interface NativeCapabilityInvocationRouteDependenciesV1 {
	readonly identity: IdentityAdapter;
	buildRequest(input: {
		readonly identity: IdentityContext;
		readonly conversationId: string;
		readonly body: HttpRequest;
	}): Promise<NativeCapabilityAdmissionRequestV1>;
	admit(
		request: NativeCapabilityAdmissionRequestV1,
	): Promise<NativeCapabilityAdmissionDecisionV1>;
}

function outcomeStatus(
	outcome: Extract<
		NativeCapabilityAdmissionDecisionV1,
		{ outcome: string }
	>["outcome"],
) {
	if (outcome === "accepted" || outcome === "replayed") return 202;
	if (outcome === "denied" || outcome === "disabled") return 403;
	if (outcome === "busy" || outcome === "conflict" || outcome === "stale")
		return 409;
	if (outcome === "invalid_parameters") return 400;
	return 503;
}

function sanitizedDecision(decision: NativeCapabilityAdmissionDecisionV1) {
	if (decision.outcome === "accepted" || decision.outcome === "replayed")
		return {
			outcome: decision.outcome,
			result: decision.result,
		};
	return {
		outcome: decision.outcome,
		...("reason" in decision && decision.reason
			? { reason: decision.reason }
			: {}),
	};
}

export function registerNativeCapabilityInvocationRoutesV1(
	app: Hono,
	dependencies: NativeCapabilityInvocationRouteDependenciesV1,
) {
	app.post(path, async (context) => {
		const metadata = requestMetadata(context.req.raw);
		let identity: IdentityContext;
		try {
			identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
		} catch {
			return context.json({ outcome: "unavailable" }, 503);
		}
		let body: HttpRequest;
		try {
			body = requestSchema.parse(await context.req.json());
		} catch {
			return context.json({ outcome: "invalid_parameters" }, 400);
		}
		try {
			const request = await dependencies.buildRequest({
				identity,
				conversationId: context.req.param("conversationId"),
				body,
			});
			const decision = await dependencies.admit(request);
			return context.json(
				sanitizedDecision(decision),
				outcomeStatus(decision.outcome),
			);
		} catch {
			return context.json({ outcome: "unavailable" }, 503);
		}
	});
}
