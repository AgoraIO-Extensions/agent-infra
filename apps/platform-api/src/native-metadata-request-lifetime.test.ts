import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { RuntimeNativeMetadataBindingResponseV1 } from "@agent-infra/contracts/runtime";
import { resolveLdapPrincipal } from "@agent-infra/identity";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "./http/identity.js";
import { registerNativeMetadataRoutes } from "./http/native-metadata-routes.js";
import {
	createRuntimeNativeMetadataCurrentCheckerV1,
	createRuntimeNativeMetadataRequestRegistryV1,
} from "./runtime-native-metadata-current.js";
import { createRuntimeNativeMetadataWorkerReaderV1 } from "./runtime-native-metadata-reader.js";
import { createRuntimeNativeMetadataScopeResolverV1 } from "./runtime-native-metadata-scope-resolver.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "lifetime-user",
	displayName: "Lifetime User",
	accountStatus: "active" as const,
	organizationIds: [],
	roles: ["employee" as const],
	authorizationRevision: "lifetime-revision",
};
const initialScope = {
	schemaVersion: 1 as const,
	principal: { kind: "user" as const, id: identity.userId },
	agentId: "lifetime-agent",
	channelId: "web",
	conversationId: "lifetime-conversation",
	executionId: "lifetime-execution",
	sessionGeneration: 1,
	authorizationRevision: identity.authorizationRevision,
	originalHostScopeRef: "lifetime-host",
};
const path =
	"/api/v2/conversations/lifetime-conversation/executions/lifetime-execution/native-metadata?selector=status";
const projection = {
	selector: "status" as const,
	status: "idle" as const,
	readAt: "2026-10-18T00:00:00.000Z",
};
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function fixture(
	options: {
		holdIdentity?: boolean;
		holdQuery?: boolean;
		holdResult?: boolean;
		revokeAfterReader?: boolean;
		driftAfterReader?: boolean;
		identityOverride?: IdentityContext;
		separateRevisions?: boolean;
	} = {},
) {
	const requestIdentity = options.identityOverride ?? identity;
	const state = {
		clock: 10_000,
		sessionActive: true,
		policyAllowed: true,
		scope: {
			...initialScope,
			principal: { kind: "user" as const, id: requestIdentity.userId },
			authorizationRevision: options.separateRevisions
				? "original-execution-revision"
				: initialScope.authorizationRevision,
		},
		policyRevision: options.separateRevisions
			? "current-agent-policy-revision"
			: identity.authorizationRevision,
		identityCalls: 0,
		queryCalls: 0,
		gatewayCalls: 0,
		querySignal: undefined as AbortSignal | undefined,
		sourceRef: "",
		lastBinding: undefined as
			| RuntimeNativeMetadataBindingResponseV1
			| undefined,
		currentOutcomes: [] as string[],
	};
	vi.spyOn(Date, "now").mockImplementation(() => state.clock);
	const identityEntered = gate();
	const identityRelease = gate();
	const queryEntered = gate();
	const queryRelease = gate();
	const resultEntered = gate();
	const resultRelease = gate();
	const authorize = vi.fn(async () =>
		state.policyAllowed
			? {
					outcome: "allowed" as const,
					authority: {
						schemaVersion: 1 as const,
						supportsSupplementaryInstruction: false,
						actorId: requestIdentity.userId,
						agentId: initialScope.agentId,
						channelId: "web",
						authorizationRevision: state.policyRevision,
					},
				}
			: { outcome: "denied" as const },
	);
	const registry = createRuntimeNativeMetadataRequestRegistryV1({
		now: () => state.clock,
	});
	const checker = createRuntimeNativeMetadataCurrentCheckerV1({
		registry,
		...{ authorize },
	});
	const resolveRequest = createRuntimeNativeMetadataScopeResolverV1({
		now: () => state.clock,
		...{ authorize },
		query: {
			readNativeMetadataObjectScopeV1: async (input) => {
				state.queryCalls++;
				state.querySignal = "signal" in input ? input.signal : undefined;
				queryEntered.resolve();
				if (options.holdQuery) await queryRelease.promise;
				return structuredClone(state.scope);
			},
		},
	});
	const reader = createRuntimeNativeMetadataWorkerReaderV1({
		resolveRequest,
		requestRegistry: registry,
		gateway: {
			read: async (request, signal) => {
				state.gatewayCalls++;
				signal.throwIfAborted();
				const { apiRequestSourceRef, ...bindingIdentity } = request;
				const binding = {
					...bindingIdentity,
					originalHostScopeRef: initialScope.originalHostScopeRef,
				};
				state.sourceRef = apiRequestSourceRef;
				state.lastBinding = binding;
				const check = () =>
					checker.check({
						request: { ...binding, phase: "read_metadata" },
						apiRequestSourceRef,
						signal,
					});
				const current = await check();
				state.currentOutcomes.push(current.outcome);
				if (current.outcome !== "allowed") return null;
				resultEntered.resolve();
				if (options.holdResult) await resultRelease.promise;
				const final = await check();
				state.currentOutcomes.push(final.outcome);
				return final.outcome === "allowed" ? { ...binding, projection } : null;
			},
		},
	});
	const app = new Hono();
	registerNativeMetadataRoutes(app, {
		identity: {
			resolve: async () => {
				state.identityCalls++;
				identityEntered.resolve();
				if (options.holdIdentity) await identityRelease.promise;
				return state.sessionActive ? requestIdentity : null;
			},
			hydrateUsers: async () => [],
		},
		reader: {
			async read(...args: Parameters<typeof reader.read>) {
				const value = await reader.read(...args);
				if (options.revokeAfterReader) state.sessionActive = false;
				if (options.driftAfterReader)
					state.scope = {
						...initialScope,
						sessionGeneration: 2,
						originalHostScopeRef: "replaced-host",
					};
				return value;
			},
		},
	});
	return {
		app,
		state,
		registry,
		checker,
		authorize,
		identityEntered,
		identityRelease,
		queryEntered,
		queryRelease,
		resultEntered,
		resultRelease,
		currentRequest: () => {
			if (!state.lastBinding)
				throw new Error("Expected the actual registered binding");
			return { ...state.lastBinding, phase: "read_metadata" as const };
		},
	};
}
afterEach(() => vi.restoreAllMocks());

describe("native metadata original HTTP request lifetime", () => {
	it("allows a granted shared user with independent LDAP, current Agent and original Execution revisions", async () => {
		const shared = await resolveLdapPrincipal(
			{
				uid: "shared-b",
				userId: "shared-b",
				email: "b@example.invalid",
				displayName: "Shared B",
				accountStatus: "active",
				roles: ["employee"],
				authorizationRevision: "ldap-b-revision",
			},
			{
				isPlatformDisabled: async () => false,
				organizationIds: async () => ["shared-org"],
			},
		);
		if (shared.accountStatus !== "active")
			throw new Error("Expected active synthetic shared subject");
		const f = fixture({
			identityOverride: { ...shared, accountStatus: "active" },
			separateRevisions: true,
		});
		expect(shared.authorizationRevision).not.toBe(
			f.state.scope.authorizationRevision,
		);
		expect(shared.authorizationRevision).not.toBe(f.state.policyRevision);
		const response = await f.app.fetch(
			new Request(`http://lifetime.invalid${path}`),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(projection);
	});

	it("invalidates an in-flight read when current policy revision changes even if still allowed", async () => {
		const f = fixture({ holdResult: true });
		const pending = f.app.fetch(new Request(`http://lifetime.invalid${path}`));
		await f.resultEntered.promise;
		f.state.policyRevision = "new-agent-policy-revision";
		f.resultRelease.resolve();
		expect((await pending).status).not.toBe(200);
	});

	it("delivers a lawful projection and removes its request-local association", async () => {
		const f = fixture();
		const response = await f.app.fetch(
			new Request(`http://lifetime.invalid${path}`),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(projection);
		expect(f.state.currentOutcomes).toEqual(["allowed", "allowed"]);
		expect(
			f.registry.lookup(f.state.sourceRef, f.currentRequest()),
		).toBeUndefined();
	});

	it.each(["identity", "scope"] as const)(
		"bounds an ignored cancellation during the first %s await",
		async (stage) => {
			const f = fixture(
				stage === "identity" ? { holdIdentity: true } : { holdQuery: true },
			);
			const controller = new AbortController();
			const pending = f.app.fetch(
				new Request(`http://lifetime.invalid${path}`, {
					signal: controller.signal,
				}),
			);
			await (stage === "identity" ? f.identityEntered : f.queryEntered).promise;
			controller.abort();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const observed = await Promise.race([
				pending,
				new Promise<null>((resolve) => {
					timeout = setTimeout(() => resolve(null), 200);
				}),
			]);
			if (timeout) clearTimeout(timeout);
			f.identityRelease.resolve();
			f.queryRelease.resolve();
			const response = observed ?? (await pending);
			expect(
				observed,
				"request must settle even if its dependency ignores abort",
			).not.toBeNull();
			expect(response.status).not.toBe(200);
			expect(f.state.gatewayCalls).toBe(0);
			if (stage === "scope") expect(f.state.querySignal?.aborted).toBe(true);
		},
	);

	it.each([
		"session",
		"policy",
		"original scope",
		"original revision",
	] as const)(
		"rejects %s changes while the gateway is pending",
		async (fault) => {
			const f = fixture({ holdResult: true });
			const pending = f.app.fetch(
				new Request(`http://lifetime.invalid${path}`),
			);
			await f.resultEntered.promise;
			if (fault === "session") f.state.sessionActive = false;
			if (fault === "policy") f.state.policyAllowed = false;
			if (fault === "original scope")
				f.state.scope = {
					...initialScope,
					sessionGeneration: 2,
					originalHostScopeRef: "replaced-host",
				};
			if (fault === "original revision")
				f.state.scope = {
					...initialScope,
					authorizationRevision: "changed-original-execution-revision",
				};
			f.resultRelease.resolve();
			const response = await pending;
			expect(response.status).not.toBe(200);
			expect(f.state.currentOutcomes.at(-1)).not.toBe("allowed");
			// A failed context cannot be revived by restoring the old facts.
			f.state.sessionActive = true;
			f.state.policyAllowed = true;
			f.state.scope = { ...initialScope };
			expect(
				f.registry.lookup(f.state.sourceRef, f.currentRequest()),
			).toBeUndefined();
		},
	);

	it.each(["session", "original scope"] as const)(
		"revalidates %s after the reader returns before response bytes",
		async (fault) => {
			const f = fixture(
				fault === "session"
					? { revokeAfterReader: true }
					: { driftAfterReader: true },
			);
			const response = await f.app.fetch(
				new Request(`http://lifetime.invalid${path}`),
			);
			expect(response.status).not.toBe(200);
			expect(await response.json()).not.toHaveProperty("selector");
		},
	);

	it.each(["identity", "scope"] as const)(
		"does not renew the deadline after slow %s work",
		async (stage) => {
			const f = fixture(
				stage === "identity" ? { holdIdentity: true } : { holdQuery: true },
			);
			const pending = f.app.fetch(
				new Request(`http://lifetime.invalid${path}`),
			);
			await (stage === "identity" ? f.identityEntered : f.queryEntered).promise;
			f.state.clock += 30_001;
			f.identityRelease.resolve();
			f.queryRelease.resolve();
			expect((await pending).status).not.toBe(200);
			expect(f.state.gatewayCalls).toBe(0);
		},
	);

	it("propagates a real TCP disconnect from the production Hono adapter", async () => {
		const f = fixture({ holdQuery: true });
		const server = serve({
			fetch: f.app.fetch,
			hostname: "127.0.0.1",
			port: 0,
		});
		if (!server.listening) await once(server, "listening");
		const req = httpRequest({
			hostname: "127.0.0.1",
			port: (server.address() as AddressInfo).port,
			path,
		});
		req.on("error", () => {});
		req.end();
		try {
			await f.queryEntered.promise;
			req.destroy();
			for (let i = 0; i < 50 && !f.state.querySignal?.aborted; i++)
				await new Promise((resolve) => setTimeout(resolve, 10));
			expect(f.state.querySignal?.aborted).toBe(true);
			expect(f.state.gatewayCalls).toBe(0);
		} finally {
			f.queryRelease.resolve();
			if ("closeAllConnections" in server) server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it.each(["session", "policy"] as const)(
		"withholds projection bytes after %s revocation over real HTTP",
		async (fault) => {
			const f = fixture({ holdResult: true });
			const server = serve({
				fetch: f.app.fetch,
				hostname: "127.0.0.1",
				port: 0,
			});
			if (!server.listening) await once(server, "listening");
			const pending = new Promise<{ status: number; body: string }>(
				(resolve, reject) => {
					const request = httpRequest(
						{
							hostname: "127.0.0.1",
							port: (server.address() as AddressInfo).port,
							path,
						},
						(response) => {
							const chunks: Buffer[] = [];
							response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
							response.on("end", () =>
								resolve({
									status: response.statusCode ?? 0,
									body: Buffer.concat(chunks).toString("utf8"),
								}),
							);
							response.on("error", reject);
						},
					);
					request.on("error", reject);
					request.end();
				},
			);
			try {
				await f.resultEntered.promise;
				if (fault === "session") f.state.sessionActive = false;
				else f.state.policyAllowed = false;
				f.resultRelease.resolve();
				const response = await pending;
				expect(response.status).not.toBe(200);
				expect(JSON.parse(response.body)).not.toHaveProperty("selector");
				expect(response.body).not.toContain('"status":"idle"');
				expect(f.state.identityCalls).toBeGreaterThan(1);
			} finally {
				f.resultRelease.resolve();
				if ("closeAllConnections" in server) server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
	);
});
