import { describe, expect, it } from "vitest";
import { createRuntimeNativeMetadataRequestRegistryV1 } from "./runtime-native-metadata-current.js";
import { createRuntimeNativeMetadataWorkerReaderV1 } from "./runtime-native-metadata-reader.js";
import { nativeMetadataTestContext } from "./runtime-native-metadata-test-context.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-reader",
	displayName: "Reader User",
	accountStatus: "active" as const,
	organizationIds: [],
	roles: ["employee" as const],
	authorizationRevision: "auth-reader",
};

const binding = {
	schemaVersion: 1 as const,
	readId: "read-reader",
	selector: "skills" as const,
	scope: {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: identity.userId },
		agentId: "agent-reader",
		channelId: "web",
		conversationId: "conversation-reader",
		executionId: "execution-reader",
		sessionGeneration: 1,
		authorizationRevision: identity.authorizationRevision,
	},
	readStartedAt: 1_000,
	expiresAt: 20_000,
	requestId: "request-reader",
	traceId: "trace-reader",
	originalHostScopeRef: "host-reader",
};

const response = {
	...binding,
	projection: {
		selector: "skills" as const,
		revision: "a".repeat(64),
		capabilities: [],
	},
};

describe("Platform API Worker native metadata reader", () => {
	it("uses the Worker gateway without an API proof issuer", async () => {
		let request: unknown;
		const registry = createRuntimeNativeMetadataRequestRegistryV1({
			now: () => 10_000,
		});
		const reader = createRuntimeNativeMetadataWorkerReaderV1({
			resolveRequest: async () => binding,
			requestRegistry: registry,
			gateway: {
				read: async (value) => {
					request = value;
					return response;
				},
			},
		});
		await expect(
			reader.read(
				identity,
				binding.scope.conversationId,
				binding.scope.executionId,
				"skills",
				nativeMetadataTestContext(identity, binding),
			),
		).resolves.toEqual(response.projection);
		expect(request).toMatchObject({ apiRequestSourceRef: expect.any(String) });
		expect(request).not.toHaveProperty("proof");
		const sourceRef = (request as { apiRequestSourceRef: string })
			.apiRequestSourceRef;
		expect(
			registry.lookup(sourceRef, {
				...binding,
				phase: "read_metadata",
			}),
		).toBeUndefined();
	});

	it("fails closed when Worker response crosses the binding", async () => {
		const reader = createRuntimeNativeMetadataWorkerReaderV1({
			requestRegistry: createRuntimeNativeMetadataRequestRegistryV1({
				now: () => binding.readStartedAt,
			}),
			resolveRequest: async () => binding,
			gateway: {
				read: async () => ({
					...response,
					scope: { ...response.scope, executionId: "foreign-execution" },
				}),
			},
		});
		await expect(
			reader.read(
				identity,
				binding.scope.conversationId,
				binding.scope.executionId,
				"skills",
				nativeMetadataTestContext(identity, binding),
			),
		).resolves.toBeNull();
	});
});
