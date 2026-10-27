import type {
	RuntimeNativeMetadataBindingResponseV1,
	RuntimeNativeMetadataReadRequestV1,
	RuntimeNativeMetadataReadResponseV1,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import {
	createPlatformNativeMetadataBindingResolverV1,
	createPlatformNativeMetadataGatewayAssemblyV1,
	createPlatformNativeMetadataRuntimeTargetResolverV1,
	createPlatformNativeMetadataSandboxCredentialResolverV1,
	createPlatformNativeMetadataTransportResolverV1,
} from "./native-metadata-deployment-assembly.js";
import { sessionSandboxServiceTokenV1 } from "./session-workload-adapter.js";

const bindingNow = Date.now();

const ports = {
	binding: { resolve: vi.fn(async () => null) },
	current: { check: vi.fn(async () => ({ outcome: "unavailable" as const })) },
	proofIssuer: {
		issue: vi.fn(async () => ({
			schemaVersion: 1 as const,
			format: "native-metadata-jws" as const,
			token: "proof",
		})),
	},
	transport: { resolve: vi.fn(async () => null) },
	port: 3010,
};

const bindingRequest = {
	schemaVersion: 1 as const,
	readId: "read-default-binding",
	selector: "commands" as const,
	scope: {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: "user-default-binding" },
		agentId: "agent-default-binding",
		channelId: "web",
		conversationId: "conversation-default-binding",
		executionId: "execution-default-binding",
		sessionGeneration: 3,
		authorizationRevision: "authorization-default-binding",
	},
	readStartedAt: bindingNow,
	expiresAt: bindingNow + 30_000,
	requestId: "request-default-binding",
	traceId: "trace-default-binding",
	apiRequestSourceRef: "api-default-binding",
};

describe("native metadata deployment assembly", () => {
	it.each([
		["Agent", null, false],
		[
			"Session Sandbox",
			{
				status: "ready",
				desiredState: "running",
				sandbox: {
					sessionId: bindingRequest.scope.conversationId,
					agentId: bindingRequest.scope.agentId,
					generation: bindingRequest.scope.sessionGeneration,
				},
			},
			true,
		],
	] as const)(
		"resolves the current %s route through Conversation",
		async (_label, sandboxResource, sessionRoute) => {
			const resolveConversationRuntimeHost = vi.fn(async () => ({
				baseUrl: sessionRoute
					? "http://sandbox-runtime"
					: "http://agent-runtime-probe",
				serviceToken: sessionRoute ? "sandbox-token" : "worker-token",
				workerId: "worker",
			}));
			const query = {
				readNativeMetadataRuntimeTargetScopeV1: vi.fn(async () => ({
					agentId: bindingRequest.scope.agentId,
					actorId: bindingRequest.scope.principal.id,
					channelId: bindingRequest.scope.channelId,
					principal: bindingRequest.scope.principal,
					conversationId: bindingRequest.scope.conversationId,
					executionId: bindingRequest.scope.executionId,
					sessionGeneration: bindingRequest.scope.sessionGeneration,
					authorizationRevision: bindingRequest.scope.authorizationRevision,
					originalHostScopeRef: "host-runtime-target",
					workloadState: { verified: {} } as never,
					sandboxResource: sandboxResource as never,
				})),
			};
			const resolver = createPlatformNativeMetadataRuntimeTargetResolverV1({
				query,
				workload: {
					policy: {
						namespace: "fixture",
						resourceProfileRef: "profile",
						resources: {
							requests: { cpu: "1", memory: "1Gi" },
							limits: { cpu: "1", memory: "1Gi" },
						},
					},
				} as never,
				resolveConversationRuntimeHost,
			});
			await expect(
				resolver.resolve({
					binding: {
						schemaVersion: 1 as const,
						readId: bindingRequest.readId,
						selector: bindingRequest.selector,
						scope: bindingRequest.scope,
						readStartedAt: bindingRequest.readStartedAt,
						expiresAt: bindingRequest.expiresAt,
						requestId: bindingRequest.requestId,
						traceId: bindingRequest.traceId,
						originalHostScopeRef: "host-runtime-target",
					},
					signal: new AbortController().signal,
				}),
			).resolves.toMatchObject({
				baseUrl: sessionRoute
					? "http://sandbox-runtime"
					: "http://agent-runtime-probe",
			});
			expect(resolveConversationRuntimeHost).toHaveBeenCalledWith(
				expect.objectContaining({
					purpose: "control",
					command: "session.status",
					...(sessionRoute
						? {
								conversationId: bindingRequest.scope.conversationId,
								sandboxResource,
								requireSandboxObservation: true,
							}
						: {}),
				}),
			);
		},
	);

	it("fails closed for missing current scope, Host drift, and transport abort", async () => {
		const resolveConversationRuntimeHost = vi.fn();
		const resolver = createPlatformNativeMetadataRuntimeTargetResolverV1({
			query: {
				readNativeMetadataRuntimeTargetScopeV1: vi
					.fn()
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce({
						agentId: bindingRequest.scope.agentId,
						actorId: bindingRequest.scope.principal.id,
						channelId: bindingRequest.scope.channelId,
						principal: bindingRequest.scope.principal,
						conversationId: bindingRequest.scope.conversationId,
						executionId: bindingRequest.scope.executionId,
						sessionGeneration: bindingRequest.scope.sessionGeneration,
						authorizationRevision: bindingRequest.scope.authorizationRevision,
						originalHostScopeRef: "new-host",
						workloadState: { verified: {} } as never,
						sandboxResource: null,
					}),
			},
			workload: {
				policy: {
					namespace: "fixture",
					resourceProfileRef: "profile",
					resources: {
						requests: { cpu: "1", memory: "1Gi" },
						limits: { cpu: "1", memory: "1Gi" },
					},
				},
			} as never,
			resolveConversationRuntimeHost,
		});
		const input = {
			binding: {
				schemaVersion: 1 as const,
				readId: bindingRequest.readId,
				selector: bindingRequest.selector,
				scope: bindingRequest.scope,
				readStartedAt: bindingRequest.readStartedAt,
				expiresAt: bindingRequest.expiresAt,
				requestId: bindingRequest.requestId,
				traceId: bindingRequest.traceId,
				originalHostScopeRef: "old-host",
			},
			signal: new AbortController().signal,
		};
		await expect(resolver.resolve(input)).resolves.toBeNull();
		await expect(resolver.resolve(input)).resolves.toBeNull();
		expect(resolveConversationRuntimeHost).not.toHaveBeenCalled();
		const controller = new AbortController();
		controller.abort();
		await expect(
			resolver.resolve({ ...input, signal: controller.signal }),
		).resolves.toBeNull();
	});

	it("resolves the original Host scope from the persisted Execution", async () => {
		const read = vi.fn(async () => ({
			...bindingRequest.scope,
			originalHostScopeRef: "host-default-binding",
		}));
		const resolver = createPlatformNativeMetadataBindingResolverV1({
			query: { readNativeMetadataObjectScopeV1: read },
		});
		await expect(
			resolver.resolve({
				request: bindingRequest,
				signal: new AbortController().signal,
			}),
		).resolves.toMatchObject({
			originalHostScopeRef: "host-default-binding",
			scope: bindingRequest.scope,
		});
		expect(read).toHaveBeenCalledWith({
			scope: {
				actorId: "user-default-binding",
				channelId: "web",
				principal: bindingRequest.scope.principal,
			},
			conversationId: "conversation-default-binding",
			executionId: "execution-default-binding",
			signal: expect.any(AbortSignal),
		});
	});

	it("derives a Sandbox callback token only from the Store allocation", async () => {
		const query = {
			readNativeMetadataCallbackCredentialScopeV1: vi.fn().mockResolvedValue({
				sandboxId: "11111111-1111-1111-1111-111111111111",
				namespace: "fixture-sandboxes",
				originalHostScopeRef: "host-callback-credential",
			}),
		};
		const resolver = createPlatformNativeMetadataSandboxCredentialResolverV1({
			query,
			deploymentServiceToken: "worker-service-token",
			namespace: "fixture-sandboxes",
		});
		await expect(
			resolver.resolve({
				binding: {
					...bindingRequest,
					originalHostScopeRef: "host-callback-credential",
				},
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({
			kind: "sandbox",
			token: sessionSandboxServiceTokenV1(
				"worker-service-token",
				"fixture-sandboxes",
				"11111111-1111-1111-1111-111111111111",
			),
		});
	});

	it("keeps the deployment token for an unbound Agent execution", async () => {
		const resolver = createPlatformNativeMetadataSandboxCredentialResolverV1({
			query: {
				readNativeMetadataCallbackCredentialScopeV1: vi.fn(async () => ({
					sandboxId: null,
					namespace: null,
					originalHostScopeRef: "host-deployment-credential",
				})),
			},
			deploymentServiceToken: "worker-service-token",
			namespace: "fixture-sandboxes",
		});
		await expect(
			resolver.resolve({
				binding: {
					...bindingRequest,
					originalHostScopeRef: "host-deployment-credential",
				},
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({
			kind: "deployment",
			token: "worker-service-token",
		});
	});

	it("rejects a credential scope whose Host binding drifted", async () => {
		const resolver = createPlatformNativeMetadataSandboxCredentialResolverV1({
			query: {
				readNativeMetadataCallbackCredentialScopeV1: vi.fn(async () => ({
					sandboxId: "11111111-1111-1111-1111-111111111111",
					namespace: "fixture-sandboxes",
					originalHostScopeRef: "new-host",
				})),
			},
			deploymentServiceToken: "worker-service-token",
			namespace: "fixture-sandboxes",
		});
		await expect(
			resolver.resolve({
				binding: {
					...bindingRequest,
					originalHostScopeRef: "old-host",
				},
				signal: new AbortController().signal,
			}),
		).resolves.toBeNull();
	});

	it.each([
		["missing original Host scope", { originalHostScopeRef: null }],
		["cross-Conversation scope", { conversationId: "foreign-conversation" }],
	] as const)("fails closed on %s", async (_label, change) => {
		const read = vi.fn(async () => ({
			...bindingRequest.scope,
			originalHostScopeRef: "host-default-binding",
			...change,
		}));
		const resolver = createPlatformNativeMetadataBindingResolverV1({
			query: { readNativeMetadataObjectScopeV1: read },
		});
		await expect(
			resolver.resolve({
				request: bindingRequest,
				signal: new AbortController().signal,
			}),
		).resolves.toBeNull();
	});

	it("builds the real Worker gateway app from deployment ports", async () => {
		const options = createPlatformNativeMetadataGatewayAssemblyV1({
			serviceToken: "worker-service-token",
			ports,
		});
		expect(options.port).toBe(3010);
		const response = await options.app.fetch(
			new Request("http://worker/internal/platform-worker/v1/native-metadata", {
				method: "POST",
				headers: {
					authorization: "Bearer worker-service-token",
					"content-type": "application/json",
				},
				body: "{}",
			}),
		);
		expect(response.status).toBe(400);
	});

	it("uses the Store binding resolver when deployment omits one", async () => {
		const options = createPlatformNativeMetadataGatewayAssemblyV1({
			serviceToken: "worker-service-token",
			databaseUrl: "postgres://worker:worker@127.0.0.1:5432/platform",
			ports: { ...ports, binding: undefined },
		});
		expect(options.close).toEqual(expect.any(Function));
		await options.close?.();
	});

	it("assembles the optional Platform API current checker", async () => {
		const requestNow = Date.now();
		const request = {
			schemaVersion: 1 as const,
			readId: "read-assembly-client",
			selector: "status" as const,
			scope: {
				schemaVersion: 1 as const,
				principal: { kind: "user" as const, id: "user-assembly-client" },
				agentId: "agent-assembly-client",
				channelId: "web",
				conversationId: "conversation-assembly-client",
				executionId: "execution-assembly-client",
				sessionGeneration: 1,
				authorizationRevision: "authorization-assembly-client",
			},
			readStartedAt: requestNow,
			expiresAt: requestNow + 30_000,
			requestId: "request-assembly-client",
			traceId: "trace-assembly-client",
			apiRequestSourceRef: "api-assembly-client",
		};
		const { apiRequestSourceRef: _source, ...identity } = request;
		const binding = {
			...identity,
			originalHostScopeRef: "host-assembly-client",
		};
		const currentCalls: unknown[] = [];
		const options = createPlatformNativeMetadataGatewayAssemblyV1({
			serviceToken: "worker-service-token",
			ports: {
				...ports,
				current: undefined,
				binding: { resolve: async () => binding },
				proofIssuer: {
					issue: async () => ({
						schemaVersion: 1 as const,
						format: "native-metadata-jws" as const,
						token: "proof-assembly-client",
					}),
				},
				transport: {
					resolve: async () => ({
						read: async () => ({
							...binding,
							projection: {
								selector: "status" as const,
								status: "active" as const,
								readAt: "2026-10-14T00:00:00.000Z",
							},
						}),
					}),
				},
				platformApiCurrent: {
					baseUrl: "http://platform-api.internal",
					serviceToken: "platform-api-service-token",
					fetch: async (_input, init) => {
						currentCalls.push({ input: _input, init });
						return new Response(
							JSON.stringify({
								outcome: "allowed",
								request: { ...binding, phase: "read_metadata" },
							}),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						);
					},
				},
			},
		});
		const response = await options.app.fetch(
			new Request("http://worker/internal/platform-worker/v1/native-metadata", {
				method: "POST",
				headers: {
					authorization: "Bearer worker-service-token",
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
			}),
		);
		expect(response.status).toBe(200);
		expect(currentCalls).toHaveLength(2);
		expect(
			(currentCalls[0] as { init: RequestInit }).init.headers,
		).toMatchObject({ authorization: "Bearer platform-api-service-token" });
	});

	it("keeps the gateway fail-closed when no current checker is configured", async () => {
		const options = createPlatformNativeMetadataGatewayAssemblyV1({
			serviceToken: "worker-service-token",
			ports: { ...ports, current: undefined },
		});
		const response = await options.app.fetch(
			new Request("http://worker/internal/platform-worker/v1/native-metadata", {
				method: "POST",
				headers: {
					authorization: "Bearer worker-service-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					schemaVersion: 1,
					readId: "read-assembly",
					selector: "status",
					scope: {
						schemaVersion: 1,
						principal: { kind: "user", id: "user-assembly" },
						agentId: "agent-assembly",
						channelId: "web",
						conversationId: "conversation-assembly",
						executionId: "execution-assembly",
						sessionGeneration: 1,
						authorizationRevision: "authorization-assembly",
					},
					readStartedAt: Date.now(),
					expiresAt: Date.now() + 30_000,
					requestId: "request-assembly",
					traceId: "trace-assembly",
					apiRequestSourceRef: "api-assembly",
				}),
			}),
		);
		expect(response.status).toBe(503);
	});

	it("rejects an invalid deployment service token", () => {
		expect(() =>
			createPlatformNativeMetadataGatewayAssemblyV1({
				serviceToken: "",
				ports,
			}),
		).toThrow("Platform Worker service token is invalid");
	});

	it("builds a fixed Runtime client from the verified binding", async () => {
		const { apiRequestSourceRef: _source, ...bindingIdentity } = bindingRequest;
		const binding = {
			...bindingIdentity,
			originalHostScopeRef: "host-assembly-transport",
		} as const satisfies RuntimeNativeMetadataBindingResponseV1;
		const request = {
			...binding,
			proof: {
				schemaVersion: 1 as const,
				format: "native-metadata-jws" as const,
				token: "proof-assembly-transport",
			},
		} satisfies RuntimeNativeMetadataReadRequestV1;
		const response: RuntimeNativeMetadataReadResponseV1 = {
			...binding,
			projection: {
				selector: "commands",
				revision: "a".repeat(64),
				capabilities: [],
			},
		};
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify(response), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const resolveTarget = vi.fn(
			async (input: {
				readonly binding: RuntimeNativeMetadataBindingResponseV1;
				readonly signal: AbortSignal;
			}) => {
				expect(input.binding).toEqual(binding);
				return {
					baseUrl: "http://runtime.fixed.internal/",
					serviceToken: "runtime-fixed-token",
				};
			},
		);
		const transport = createPlatformNativeMetadataTransportResolverV1({
			resolveTarget,
			fetch: fetcher,
		});
		const client = await transport.resolve({
			binding,
			signal: new AbortController().signal,
		});
		await expect(
			client?.read(request, new AbortController().signal),
		).resolves.toEqual(response);
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"http://runtime.fixed.internal/internal/runtime/v1/native-metadata",
		);
		expect(init?.headers).toMatchObject({
			authorization: "Bearer runtime-fixed-token",
		});
		const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
		expect(sent).toMatchObject(request);
		expect(sent).not.toHaveProperty("baseUrl");
		expect(sent).not.toHaveProperty("serviceToken");
	});

	it.each([
		["missing target", null],
		[
			"invalid URL",
			{ baseUrl: "https://runtime.fixed.internal", serviceToken: "token" },
		],
		[
			"invalid token",
			{ baseUrl: "http://runtime.fixed.internal", serviceToken: "" },
		],
	] as const)("fails closed for a %s", async (_label, target) => {
		const transport = createPlatformNativeMetadataTransportResolverV1({
			resolveTarget: async () => target,
		});
		await expect(
			transport.resolve({
				binding: {
					...bindingRequest,
					originalHostScopeRef: "host-invalid-target",
				},
				signal: new AbortController().signal,
			}),
		).resolves.toBeNull();
	});

	it("keeps an explicit transport override authoritative", () => {
		const transport = { resolve: vi.fn(async () => null) };
		const runtimeTarget = {
			resolve: vi.fn(async () => ({
				baseUrl: "http://runtime.fixed.internal",
				serviceToken: "runtime-fixed-token",
			})),
		};
		const options = createPlatformNativeMetadataGatewayAssemblyV1({
			serviceToken: "worker-service-token",
			ports: { ...ports, transport, runtimeTarget },
		});
		expect(options.app).toBeDefined();
		expect(runtimeTarget.resolve).not.toHaveBeenCalled();
	});
});
