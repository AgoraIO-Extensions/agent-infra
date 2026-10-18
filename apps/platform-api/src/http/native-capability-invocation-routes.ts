import { NativeCapabilityInvocationRequestV1Schema } from "@agent-infra/contracts/pilot";
import type {
	NativeCapabilityAdmissionDecisionV1,
	NativeCapabilityAdmissionRequestV1,
} from "@agent-infra/platform-core";
import type { Hono } from "hono";
import type { z } from "zod";
import {
	createRuntimeNativeMetadataRequestContextV1,
	type RuntimeNativeMetadataRequestContextV1,
} from "../runtime-native-metadata-request-context.js";
import { requestMetadata } from "./common.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity,
} from "./identity.js";

const path = "/api/v2/conversations/:conversationId/native-capability/invoke";
const requestSchema = NativeCapabilityInvocationRequestV1Schema;
type HttpRequest = z.infer<typeof requestSchema>;

export interface NativeCapabilityInvocationRouteDependenciesV1 {
	readonly identity: IdentityAdapter;
	buildRequest(input: {
		readonly identity: IdentityContext;
		readonly conversationId: string;
		readonly body: HttpRequest;
	}): Promise<NativeCapabilityAdmissionRequestV1>;
	readonly admit?: (
		request: NativeCapabilityAdmissionRequestV1,
	) => Promise<NativeCapabilityAdmissionDecisionV1>;
	readonly admitWithIdentity?: (input: {
		readonly identity: IdentityContext;
		readonly request: NativeCapabilityAdmissionRequestV1;
		readonly requestContext: RuntimeNativeMetadataRequestContextV1;
	}) => Promise<NativeCapabilityAdmissionDecisionV1>;
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
	if (
		typeof dependencies.admit !== "function" &&
		typeof dependencies.admitWithIdentity !== "function"
	)
		throw new TypeError("Native capability invocation admission is invalid");
	app.post(path, async (context) => {
		const metadata = requestMetadata(context.req.raw);
		const requestContext = createRuntimeNativeMetadataRequestContextV1({
			signal: context.req.raw.signal,
			authenticate: () =>
				resolveIdentity(
					dependencies.identity,
					context.req.raw,
					metadata.traceId,
				),
		});
		try {
			const identity = await requestContext.authenticate();
			let body: HttpRequest;
			try {
				const parsed = await requestContext.run(async () => {
					try {
						return { valid: true as const, value: await context.req.json() };
					} catch {
						return { valid: false as const };
					}
				});
				if (!parsed.valid)
					return context.json({ outcome: "invalid_parameters" }, 400);
				body = requestSchema.parse(parsed.value);
			} catch {
				if (requestContext.signal.aborted)
					return context.json({ outcome: "unavailable" }, 503);
				return context.json({ outcome: "invalid_parameters" }, 400);
			}
			const request = await requestContext.run(() =>
				dependencies.buildRequest({
					identity,
					conversationId: context.req.param("conversationId"),
					body,
				}),
			);
			const decision = await requestContext.run(() =>
				dependencies.admitWithIdentity
					? dependencies.admitWithIdentity({
							identity,
							request,
							requestContext,
						})
					: dependencies.admit
						? dependencies.admit(request)
						: Promise.resolve(undefined),
			);
			if (!decision) throw new Error("Native capability admission unavailable");
			await requestContext.verifyDelivery(identity);
			return context.json(
				sanitizedDecision(decision),
				outcomeStatus(decision.outcome),
			);
		} catch {
			return context.json({ outcome: "unavailable" }, 503);
		} finally {
			requestContext.close();
		}
	});
}
