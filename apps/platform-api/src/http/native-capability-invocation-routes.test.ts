import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import {
	type NativeCapabilityInvocationRouteDependenciesV1,
	registerNativeCapabilityInvocationRoutesV1,
} from "./native-capability-invocation-routes.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-native-capability",
	displayName: "Native Capability User",
	accountStatus: "active" as const,
	organizationIds: [],
	roles: ["employee" as const],
	authorizationRevision: "authorization-native-capability",
};

const body = {
	capabilityId: "a".repeat(64),
	directoryRevision: "b".repeat(64),
	parameters: "",
	idempotencyKey: "invoke-1",
	requestId: "request-native-capability",
	traceId: "trace-native-capability",
};

function app(
	overrides: Partial<NativeCapabilityInvocationRouteDependenciesV1> = {},
) {
	const dependencies: NativeCapabilityInvocationRouteDependenciesV1 = {
		identity: {
			resolve: async () => identity,
			hydrateUsers: async () => undefined,
		},
		buildRequest: async ({ conversationId }) =>
			({
				schemaVersion: 1,
				conversationId,
				capabilityId: body.capabilityId,
				directoryRevision: body.directoryRevision,
				parameters: body.parameters,
				idempotencyKey: body.idempotencyKey,
				requestId: body.requestId,
				traceId: body.traceId,
			}) as never,
		admit: async () =>
			({
				outcome: "accepted",
				result: {
					schemaVersion: 1,
					status: "submitted",
					conversationId: "conversation-native-capability",
					executionId: "execution-native-capability",
					capabilityId: body.capabilityId,
					capabilityKind: "skill",
					directoryRevision: body.directoryRevision,
				},
			}) as never,
		...overrides,
	};
	const hono = new Hono();
	registerNativeCapabilityInvocationRoutesV1(hono, dependencies);
	return hono;
}

it("resolves identity server-side and returns only the sanitized admission receipt", async () => {
	const response = await app({
		buildRequest: async (input) => {
			expect(input.identity.userId).toBe(identity.userId);
			expect(input.conversationId).toBe("conversation-native-capability");
			expect(input.body).toEqual(body);
			return {
				schemaVersion: 1,
				conversationId: input.conversationId,
				capabilityId: body.capabilityId,
				directoryRevision: body.directoryRevision,
				parameters: body.parameters,
				idempotencyKey: body.idempotencyKey,
				requestId: body.requestId,
				traceId: body.traceId,
			} as never;
		},
	}).request(
		"/api/v2/conversations/conversation-native-capability/native-capability/invoke",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	expect(response.status).toBe(202);
	expect(await response.json()).toEqual({
		outcome: "accepted",
		result: expect.objectContaining({ status: "submitted" }),
	});
});

it("rejects malformed input before admission", async () => {
	const admit = vi.fn();
	const response = await app({ admit }).request(
		"/api/v2/conversations/conversation/native-capability/invoke",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...body, capabilityId: "bad" }),
		},
	);
	expect(response.status).toBe(400);
	expect(admit).not.toHaveBeenCalled();
});
