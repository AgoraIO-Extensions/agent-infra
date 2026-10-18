import {
	RuntimeNativeMetadataBindingResponseV1Schema,
	runtimeNativeMetadataRequestSigningPayloadV1,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeNativeMetadataReaderV1 } from "./runtime-native-metadata-reader.js";
import { nativeMetadataTestContext } from "./runtime-native-metadata-test-context.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-native-metadata",
	displayName: "Native Metadata User",
	accountStatus: "active" as const,
	organizationIds: ["org-native-metadata"],
	roles: ["employee" as const],
	authorizationRevision: "auth-native-metadata",
};

const binding = RuntimeNativeMetadataBindingResponseV1Schema.parse({
	schemaVersion: 1,
	readId: "read-native-metadata",
	selector: "status",
	scope: {
		schemaVersion: 1,
		principal: { kind: "user", id: identity.userId },
		agentId: "agent-native-metadata",
		channelId: "web",
		conversationId: "conversation-native-metadata",
		executionId: "execution-native-metadata",
		sessionGeneration: 3,
		authorizationRevision: identity.authorizationRevision,
	},
	readStartedAt: 2_000,
	expiresAt: 20_000,
	requestId: "request-native-metadata",
	traceId: "trace-native-metadata",
	originalHostScopeRef: "host-scope-native-metadata",
});

const proof = {
	schemaVersion: 1 as const,
	format: "native-metadata-jws" as const,
	token: "header.payload.signature",
};

const response = {
	...binding,
	projection: {
		selector: "status" as const,
		status: "active" as const,
		readAt: "2026-10-13T00:00:00.000Z",
	},
};

function reader(transport = vi.fn().mockResolvedValue(response)) {
	const issue = vi.fn().mockResolvedValue(proof);
	return {
		issue,
		transport,
		value: createRuntimeNativeMetadataReaderV1({
			resolveRequest: async () => binding,
			proofIssuer: { issue },
			transport: { read: transport },
		}),
	};
}

describe("Runtime native metadata producer adapter", () => {
	it("issues a request-local proof and projects a bound status response", async () => {
		const fixture = reader();
		await expect(
			fixture.value.read(
				identity,
				binding.scope.conversationId,
				binding.scope.executionId,
				"status",
				nativeMetadataTestContext(identity, binding),
			),
		).resolves.toEqual(response.projection);
		expect(fixture.issue).toHaveBeenCalledWith(
			expect.objectContaining({ request: binding }),
		);
		expect(fixture.transport).toHaveBeenCalledWith(
			{ ...binding, proof },
			expect.any(AbortSignal),
		);
	});

	it.each([
		{
			scope: {
				...binding.scope,
				principal: { kind: "user", id: "foreign-user" },
			},
		},
		{ scope: { ...binding.scope, conversationId: "foreign-conversation" } },
		{ scope: { ...binding.scope, channelId: "api" } },
		{ scope: { ...binding.scope, executionId: "foreign-execution" } },
	])(
		"rejects a resolver binding outside the current request: %j",
		async (patch) => {
			const fixture = reader();
			const invalid = createRuntimeNativeMetadataReaderV1({
				resolveRequest: async () =>
					RuntimeNativeMetadataBindingResponseV1Schema.parse({
						...binding,
						...patch,
					}),
				proofIssuer: { issue: fixture.issue },
				transport: { read: fixture.transport },
			});
			await expect(
				invalid.read(
					identity,
					binding.scope.conversationId,
					binding.scope.executionId,
					"status",
					nativeMetadataTestContext(identity, binding),
				),
			).resolves.toBeNull();
			expect(fixture.issue).not.toHaveBeenCalled();
		},
	);

	it("fails closed when the Worker/Host response drifts from the original scope", async () => {
		const fixture = reader(
			vi.fn().mockResolvedValue({
				...response,
				scope: { ...response.scope, executionId: "foreign-execution" },
			}),
		);
		await expect(
			fixture.value.read(
				identity,
				binding.scope.conversationId,
				binding.scope.executionId,
				"status",
				nativeMetadataTestContext(identity, binding),
			),
		).resolves.toBeNull();
	});

	it("fails closed when proof issuance or transport rejects", async () => {
		const transport = vi.fn().mockRejectedValue(new Error("unavailable"));
		const issue = vi.fn().mockRejectedValue(new Error("proof unavailable"));
		const value = createRuntimeNativeMetadataReaderV1({
			resolveRequest: async () => binding,
			proofIssuer: { issue },
			transport: { read: transport },
		});
		await expect(
			value.read(
				identity,
				binding.scope.conversationId,
				binding.scope.executionId,
				"status",
				nativeMetadataTestContext(identity, binding),
			),
		).resolves.toBeNull();
		expect(transport).not.toHaveBeenCalled();
	});

	it("keeps request digest input canonical for deployment proof issuers", () => {
		expect(runtimeNativeMetadataRequestSigningPayloadV1(binding)).toContain(
			'"originalHostScopeRef":"host-scope-native-metadata"',
		);
	});
});
