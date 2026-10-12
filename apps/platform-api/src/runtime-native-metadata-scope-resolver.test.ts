import { describe, expect, it, vi } from "vitest";
import { createRuntimeNativeMetadataScopeResolverV1 } from "./runtime-native-metadata-scope-resolver.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "scope-user",
	displayName: "Scope User",
	accountStatus: "active" as const,
	organizationIds: ["scope-org"],
	roles: ["employee" as const],
	authorizationRevision: "current-revision",
};

const persistedScope = {
	schemaVersion: 1 as const,
	principal: { kind: "user" as const, id: identity.userId },
	agentId: "scope-agent",
	channelId: "web",
	conversationId: "scope-conversation",
	executionId: "scope-execution",
	sessionGeneration: 4,
	authorizationRevision: "execution-revision",
};

describe("native metadata Store scope resolver", () => {
	it("uses persisted Execution generation/revision and binds the original Host scope", async () => {
		const query = {
			readNativeMetadataObjectScopeV1: vi
				.fn()
				.mockResolvedValue(persistedScope),
		};
		const resolver = createRuntimeNativeMetadataScopeResolverV1({
			query,
			execution: {
				resolve: async () => ({
					executionId: persistedScope.executionId,
					originalHostScopeRef: "host-scope",
				}),
			},
			now: () => 10_000,
		});
		const result = await resolver({
			identity,
			conversationId: persistedScope.conversationId,
			selector: "status",
			signal: new AbortController().signal,
		});
		expect(result).toMatchObject({
			scope: persistedScope,
			originalHostScopeRef: "host-scope",
			readStartedAt: 10_000,
			expiresAt: 40_000,
		});
		expect(query.readNativeMetadataObjectScopeV1).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: persistedScope.conversationId,
				executionId: persistedScope.executionId,
			}),
		);
	});

	it.each([
		{ accountStatus: "disabled" as const },
		{ accountStatus: "suspended" as const },
	])("rejects an inactive current identity: %j", async (patch) => {
		const query = { readNativeMetadataObjectScopeV1: vi.fn() };
		const execution = { resolve: vi.fn() };
		const resolver = createRuntimeNativeMetadataScopeResolverV1({
			query,
			execution,
		});
		await expect(
			resolver({
				identity: { ...identity, ...patch },
				conversationId: persistedScope.conversationId,
				selector: "status",
				signal: new AbortController().signal,
			}),
		).resolves.toBeNull();
		expect(execution.resolve).not.toHaveBeenCalled();
		expect(query.readNativeMetadataObjectScopeV1).not.toHaveBeenCalled();
	});

	it("fails closed when the execution or Store scope is unavailable", async () => {
		const query = { readNativeMetadataObjectScopeV1: vi.fn() };
		const resolver = createRuntimeNativeMetadataScopeResolverV1({
			query,
			execution: { resolve: async () => null },
		});
		await expect(
			resolver({
				identity,
				conversationId: persistedScope.conversationId,
				selector: "status",
				signal: new AbortController().signal,
			}),
		).resolves.toBeNull();
		expect(query.readNativeMetadataObjectScopeV1).not.toHaveBeenCalled();
	});
});
