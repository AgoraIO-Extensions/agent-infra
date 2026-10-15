import { describe, expect, it, vi } from "vitest";
import {
	createRuntimeNativeMetadataCurrentCheckerV1,
	createRuntimeNativeMetadataRequestRegistryV1,
} from "./runtime-native-metadata-current.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "current-user",
	displayName: "Current User",
	accountStatus: "active" as const,
	organizationIds: ["current-org"],
	roles: ["employee" as const],
	authorizationRevision: "current-revision",
};

const binding = {
	schemaVersion: 1 as const,
	readId: "read-current",
	selector: "commands" as const,
	scope: {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: identity.userId },
		agentId: "current-agent",
		channelId: "web",
		conversationId: "current-conversation",
		executionId: "current-execution",
		sessionGeneration: 3,
		authorizationRevision: identity.authorizationRevision,
	},
	readStartedAt: 1_000,
	expiresAt: 20_000,
	requestId: "request-current",
	traceId: "trace-current",
	originalHostScopeRef: "host-current",
};

const currentRequest = {
	...binding,
	phase: "read_metadata" as const,
};

describe("native metadata current registry", () => {
	it("matches the registered binding and releases it after the read", () => {
		const registry = createRuntimeNativeMetadataRequestRegistryV1({
			now: () => 10_000,
		});
		const sourceRef = registry.register({ binding, identity });
		expect(registry.lookup(sourceRef, currentRequest)).toMatchObject({
			binding,
			identity,
		});
		expect(
			registry.lookup(sourceRef, {
				...currentRequest,
				scope: { ...currentRequest.scope, executionId: "other-execution" },
			}),
		).toBeUndefined();
		registry.release(sourceRef);
		expect(registry.lookup(sourceRef, currentRequest)).toBeUndefined();
	});

	it("fails closed when the source expires or the current authorization changes", async () => {
		let now = 10_000;
		const registry = createRuntimeNativeMetadataRequestRegistryV1({
			now: () => now,
		});
		const sourceRef = registry.register({ binding, identity });
		const authorize = vi.fn().mockResolvedValue({
			outcome: "allowed" as const,
			authority: {
				actorId: identity.userId,
				agentId: binding.scope.agentId,
				channelId: "web",
				authorizationRevision: identity.authorizationRevision,
			},
		});
		const checker = createRuntimeNativeMetadataCurrentCheckerV1({
			registry,
			authorize,
		});
		expect(
			await checker.check({
				request: currentRequest,
				apiRequestSourceRef: sourceRef,
				signal: new AbortController().signal,
			}),
		).toEqual({ outcome: "allowed", request: currentRequest });
		authorize.mockResolvedValue({ outcome: "denied" as const });
		expect(
			await checker.check({
				request: currentRequest,
				apiRequestSourceRef: sourceRef,
				signal: new AbortController().signal,
			}),
		).toEqual({ outcome: "denied" });
		now = 20_000;
		expect(
			await checker.check({
				request: currentRequest,
				apiRequestSourceRef: sourceRef,
				signal: new AbortController().signal,
			}),
		).toEqual({ outcome: "unavailable" });
	});
});
