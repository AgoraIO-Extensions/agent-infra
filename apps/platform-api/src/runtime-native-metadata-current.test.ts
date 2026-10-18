import { describe, expect, it, vi } from "vitest";
import {
	createRuntimeNativeMetadataCurrentCheckerV1,
	createRuntimeNativeMetadataRequestRegistryV1,
} from "./runtime-native-metadata-current.js";
import { nativeMetadataTestContext } from "./runtime-native-metadata-test-context.js";

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
	readStartedAt: 10_000,
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
		const sourceRef = registry.register({
			binding,
			identity,
			requestContext: nativeMetadataTestContext(
				identity,
				binding,
				() => 10_000,
			),
			revalidate: async () => identity,
		});
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
		expect(registry.lookup(sourceRef, currentRequest)).toBeUndefined();
		registry.release(sourceRef);
		expect(registry.lookup(sourceRef, currentRequest)).toBeUndefined();
	});

	it("fails closed when the source expires or the current authorization changes", async () => {
		let now = 10_000;
		const registry = createRuntimeNativeMetadataRequestRegistryV1({
			now: () => now,
		});
		const sourceRef = registry.register({
			binding,
			identity,
			requestContext: nativeMetadataTestContext(
				identity,
				binding,
				() => 10_000,
			),
			revalidate: async () => identity,
		});
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
		authorize.mockResolvedValue({
			outcome: "allowed" as const,
			authority: {
				actorId: identity.userId,
				agentId: binding.scope.agentId,
				channelId: "web",
				authorizationRevision: identity.authorizationRevision,
			},
		});
		expect(
			await checker.check({
				request: currentRequest,
				apiRequestSourceRef: sourceRef,
				signal: new AbortController().signal,
			}),
		).toEqual({ outcome: "unavailable" });
		expect(authorize).toHaveBeenCalledTimes(2);
		now = 20_000;
		expect(
			await checker.check({
				request: currentRequest,
				apiRequestSourceRef: sourceRef,
				signal: new AbortController().signal,
			}),
		).toEqual({ outcome: "unavailable" });
	});

	it("bounds capacity and rejects a source routed to another API instance", () => {
		const registry = createRuntimeNativeMetadataRequestRegistryV1({
			now: () => 10_000,
			maximumEntries: 1,
		});
		const other = createRuntimeNativeMetadataRequestRegistryV1({
			now: () => 10_000,
		});
		const entry = () => ({
			binding,
			identity,
			requestContext: nativeMetadataTestContext(identity, binding),
			revalidate: async () => identity,
		});
		const source = registry.register(entry());
		expect(() => registry.register(entry())).toThrow(
			"NATIVE_METADATA_REQUEST_CAPACITY",
		);
		expect(other.lookup(source, currentRequest)).toBeUndefined();
		expect(registry.lookup(source, currentRequest)).toBeDefined();
		registry.clear();
		expect(registry.lookup(source, currentRequest)).toBeUndefined();
	});

	it("request completion interrupts pending current work that ignores cancellation", async () => {
		const registry = createRuntimeNativeMetadataRequestRegistryV1({
			now: () => 10_000,
		});
		const requestContext = nativeMetadataTestContext(identity, binding);
		const source = registry.register({
			binding,
			identity,
			requestContext,
			revalidate: async () => identity,
		});
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const checker = createRuntimeNativeMetadataCurrentCheckerV1({
			registry,
			authorize: async () => {
				entered();
				await hold;
				return {
					outcome: "allowed",
					authority: {
						actorId: identity.userId,
						agentId: binding.scope.agentId,
						channelId: "web",
						authorizationRevision: identity.authorizationRevision,
					},
				};
			},
		});
		const pending = checker.check({
			request: currentRequest,
			apiRequestSourceRef: source,
			signal: new AbortController().signal,
		});
		await started;
		requestContext.close();
		try {
			expect(await pending).toEqual({ outcome: "unavailable" });
			expect(registry.lookup(source, currentRequest)).toBeUndefined();
		} finally {
			release();
		}
	});

	it("a cancelled current callback permanently invalidates its parent read", async () => {
		const registry = createRuntimeNativeMetadataRequestRegistryV1({
			now: () => 10_000,
		});
		const requestContext = nativeMetadataTestContext(identity, binding);
		const source = registry.register({
			binding,
			identity,
			requestContext,
			revalidate: async () => identity,
		});
		const authorize = vi.fn();
		const checker = createRuntimeNativeMetadataCurrentCheckerV1({
			registry,
			authorize,
		});
		expect(
			await checker.check({
				request: currentRequest,
				apiRequestSourceRef: source,
				signal: AbortSignal.abort(),
			}),
		).toEqual({ outcome: "unavailable" });
		expect(requestContext.signal.aborted).toBe(true);
		expect(registry.lookup(source, currentRequest)).toBeUndefined();
		expect(authorize).not.toHaveBeenCalled();
	});
});
