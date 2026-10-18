import { describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "./http/identity.js";
import { createNativeCapabilityMetadataRevalidationV1 } from "./native-capability-metadata.js";
import { nativeMetadataTestContext } from "./runtime-native-metadata-test-context.js";

const revision = "a".repeat(64);
const capabilityId = "b".repeat(64);
const identity: IdentityContext = {
	schemaVersion: 1,
	userId: "native-user",
	displayName: "Native User",
	accountStatus: "active",
	organizationIds: [],
	roles: ["employee"],
	authorizationRevision: "authorization-current",
};
const authority = {
	schemaVersion: 1 as const,
	actorId: identity.userId,
	agentId: "native-agent",
	channelId: "web",
	authorizationRevision: identity.authorizationRevision,
	supportsSupplementaryInstruction: false,
};
const request = {
	schemaVersion: 1 as const,
	conversationId: "native-conversation",
	capabilityId,
	directoryRevision: revision,
	parameters: JSON.stringify({ value: 1 }),
	idempotencyKey: "native-idempotency",
	requestId: "native-request",
	traceId: "native-trace",
};
const current = {
	agentId: authority.agentId,
	actorId: authority.actorId,
	channelId: authority.channelId,
	conversationId: request.conversationId,
	executionId: "native-execution",
	sessionGeneration: 3,
	authorizationRevision: authority.authorizationRevision,
	currentHostScopeRef: "native-host",
};
const scope = {
	agentId: current.agentId,
	actorId: current.actorId,
	channelId: current.channelId,
	conversationId: current.conversationId,
	sessionGeneration: current.sessionGeneration,
	authorizationRevision: current.authorizationRevision,
	hostScopeRef: current.currentHostScopeRef,
};

function fixture(
	options: {
		now?: () => number;
		cacheTtlMs?: number;
		identity?: IdentityContext;
	} = {},
) {
	const requestIdentity = options.identity ?? identity;
	const query = {
		readNativeCapabilityCurrentScopeV1: vi.fn().mockResolvedValue(current),
	};
	const reader = {
		read: vi.fn(
			async (
				_identity: IdentityContext,
				_conversation: string,
				_execution: string,
				selector: "status" | "commands" | "skills",
			) =>
				selector === "commands"
					? {
							selector: "commands" as const,
							revision,
							capabilities: [
								{
									id: capabilityId,
									kind: "command" as const,
									name: "read_native",
									description: "Read native metadata",
									source: { name: "runtime", version: "1" },
									parameters: [],
									effect: "read_only" as const,
									availability: "available" as const,
								},
							],
						}
					: { selector: "skills" as const, revision, capabilities: [] },
		),
	};
	const adapter = createNativeCapabilityMetadataRevalidationV1({
		requestContext: nativeMetadataTestContext(
			requestIdentity,
			undefined,
			options.now,
		),
		query,
		reader,
		identity: requestIdentity,
		...(options.now ? { now: options.now } : {}),
		...(options.cacheTtlMs ? { cacheTtlMs: options.cacheTtlMs } : {}),
	});
	return { adapter, query, reader };
}

describe("native capability metadata revalidation", () => {
	it("keeps shared-user Identity revision separate from Agent admission scope", async () => {
		const sharedIdentity = {
			...identity,
			authorizationRevision: "different-ldap-identity-revision",
		};
		const f = fixture({ identity: sharedIdentity });
		const result = await f.adapter.revalidate({
			request,
			authority,
			sessionGeneration: 3,
		});
		expect(result.outcome).toBe("allowed");
		if (result.outcome !== "allowed")
			throw new Error("Expected authorized shared metadata");
		expect(
			f.adapter.isCurrent({
				request,
				capability: result.capability,
				scope: result.scope,
			}),
		).toBe(true);
	});

	it("binds the current Store execution and projects the selected command", async () => {
		const f = fixture();
		await expect(
			f.adapter.revalidate({ request, authority, sessionGeneration: 3 }),
		).resolves.toMatchObject({
			outcome: "allowed",
			capability: {
				id: capabilityId,
				kind: "command",
				directoryRevision: revision,
				availability: "available",
			},
			scope: {
				agentId: current.agentId,
				actorId: current.actorId,
				channelId: current.channelId,
				conversationId: current.conversationId,
				sessionGeneration: current.sessionGeneration,
				authorizationRevision: current.authorizationRevision,
			},
		});
		expect(f.query.readNativeCapabilityCurrentScopeV1).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: request.conversationId,
				agentId: authority.agentId,
				scope: expect.objectContaining({
					actorId: authority.actorId,
					channelId: "web",
					principal: { kind: "user", id: authority.actorId },
				}),
			}),
		);
		expect(f.reader.read).toHaveBeenCalledTimes(2);
		expect(
			f.adapter.isCurrent({
				request,
				capability: {
					id: capabilityId,
					kind: "command",
					name: "read_native",
					description: "Read native metadata",
					source: { name: "runtime", version: "1" },
					availability: "available",
					directoryRevision: revision,
				},
				scope,
			}),
		).toBe(true);
	});

	it("fails closed on current generation or authorization drift", async () => {
		const f = fixture();
		f.query.readNativeCapabilityCurrentScopeV1.mockResolvedValueOnce({
			...current,
			sessionGeneration: 2,
		});
		await expect(
			f.adapter.revalidate({ request, authority, sessionGeneration: 3 }),
		).resolves.toEqual({ outcome: "stale" });
		expect(f.reader.read).not.toHaveBeenCalled();
	});

	it("does not synthesize a reader identity for a different actor", async () => {
		const f = createNativeCapabilityMetadataRevalidationV1({
			requestContext: nativeMetadataTestContext(identity),
			query: {
				readNativeCapabilityCurrentScopeV1: vi.fn().mockResolvedValue(current),
			},
			reader: { read: vi.fn() },
			identity: { ...identity, userId: "different-user" },
		});
		await expect(
			f.revalidate({ request, authority, sessionGeneration: 3 }),
		).resolves.toEqual({ outcome: "unavailable" });
	});

	it("fails closed when the authenticated identity revision drifts", async () => {
		const adapter = createNativeCapabilityMetadataRevalidationV1({
			requestContext: nativeMetadataTestContext(identity),
			query: {
				readNativeCapabilityCurrentScopeV1: vi.fn().mockResolvedValue(current),
			},
			reader: { read: vi.fn() },
			identity: { ...identity, authorizationRevision: "identity-revision" },
		});
		await expect(
			adapter.revalidate({ request, authority, sessionGeneration: 3 }),
		).resolves.toEqual({ outcome: "unavailable" });
	});

	it("rejects a mixed directory revision across command and skill projections", async () => {
		const f = fixture();
		f.reader.read.mockImplementation(
			async (
				_identity: IdentityContext,
				_conversation: string,
				_execution: string,
				selector: "status" | "commands" | "skills",
			) =>
				selector === "commands"
					? {
							selector: "commands" as const,
							revision,
							capabilities: [],
						}
					: {
							selector: "skills" as const,
							revision: "c".repeat(64),
							capabilities: [],
						},
		);
		await expect(
			f.adapter.revalidate({ request, authority, sessionGeneration: 3 }),
		).resolves.toEqual({ outcome: "stale" });
	});

	it("fails closed when either required projection is unavailable", async () => {
		const f = fixture();
		f.reader.read.mockImplementation(
			async (
				_identity: IdentityContext,
				_conversation: string,
				_execution: string,
				selector: "status" | "commands" | "skills",
			) =>
				selector === "commands"
					? {
							selector: "commands" as const,
							revision,
							capabilities: [],
						}
					: (null as never),
		);
		await expect(
			f.adapter.revalidate({ request, authority, sessionGeneration: 3 }),
		).resolves.toEqual({ outcome: "unavailable" });
	});

	it("expires the synchronous cache without a network recheck", async () => {
		let now = 1000;
		const f = fixture({ now: () => now, cacheTtlMs: 10 });
		const allowed = await f.adapter.revalidate({
			request,
			authority,
			sessionGeneration: 3,
		});
		if (allowed.outcome !== "allowed") throw new Error("expected allowed");
		now = 1010;
		expect(
			f.adapter.isCurrent({
				request,
				capability: allowed.capability,
				scope,
			}),
		).toBe(false);
		expect(f.query.readNativeCapabilityCurrentScopeV1).toHaveBeenCalledTimes(1);
	});

	it("invalidates the synchronous cache when the identity revision changes", async () => {
		const currentIdentity = { ...identity };
		const f = fixture();
		const adapter = createNativeCapabilityMetadataRevalidationV1({
			requestContext: nativeMetadataTestContext(identity),
			query: f.query,
			reader: f.reader,
			identity: currentIdentity,
		});
		const allowed = await adapter.revalidate({
			request,
			authority,
			sessionGeneration: 3,
		});
		if (allowed.outcome !== "allowed") throw new Error("expected allowed");
		Object.assign(currentIdentity, { authorizationRevision: "revoked" });
		expect(
			adapter.isCurrent({
				request,
				capability: allowed.capability,
				scope,
			}),
		).toBe(false);
	});

	it("rejects a Host binding drift at the synchronous commit check", async () => {
		const f = fixture();
		const allowed = await f.adapter.revalidate({
			request,
			authority,
			sessionGeneration: 3,
		});
		if (allowed.outcome !== "allowed") throw new Error("expected allowed");
		expect(
			f.adapter.isCurrent({
				request,
				capability: allowed.capability,
				scope: { ...scope, hostScopeRef: "rebound-host" },
			}),
		).toBe(false);
	});
});
