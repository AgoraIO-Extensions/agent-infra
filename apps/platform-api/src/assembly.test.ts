import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";

import type { NativeCapabilityInvocationRequestV1 } from "@agent-infra/contracts/pilot";
import * as telemetryModule from "@agent-infra/observability";
import {
	PostgresAgentManagementQueryV1,
	PostgresConversationQueryV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assemblePlatformApi } from "./assembly.js";
import {
	deploymentDiagnosticV1,
	platformApiStartupFailureMessageV1,
} from "./deployment-diagnostic.js";
import {
	createPlatformApiShutdown,
	loadPlatformApiAssembly,
	startPlatformApi,
	startPlatformApiFromDeployment,
} from "./index.js";
import { createRuntimeNativeMetadataRequestRegistryV1 } from "./runtime-native-metadata-current.js";

const servers: { close(callback?: (error?: Error) => void): void }[] = [];

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			),
	);
	vi.restoreAllMocks();
});

describe("Platform API production assembly", () => {
	it("requires a deployment module with the assembly-input factory", async () => {
		await expect(loadPlatformApiAssembly("")).rejects.toThrow(
			"PLATFORM_API_DEPLOYMENT_MODULE is required",
		);
		await expect(
			loadPlatformApiAssembly(
				"data:text/javascript,export const invalid = true",
			),
		).rejects.toThrow("Platform API deployment module is invalid");
		await expect(
			loadPlatformApiAssembly(
				"data:text/javascript,export function createPlatformApiAssemblyInput() {}; export const browserAuth = { handleRequest: true }",
			),
		).rejects.toThrow("Platform API deployment module is invalid");
		await expect(
			loadPlatformApiAssembly(
				"data:text/javascript,export function createPlatformApiAssemblyInput() { return {}; }; export const standardTemplateReleaseApp = { fetch: true }",
			),
		).rejects.toThrow("Platform API deployment module is invalid");
	});

	it("accepts the deployment-owned wrapped release app contract", async () => {
		const fixture = new URL(
			"../../../tests/fixtures/platform-api-deployment.mjs",
			import.meta.url,
		).href;
		const source = `
			import { createPlatformApiAssemblyInput } from ${JSON.stringify(fixture)};
			export { createPlatformApiAssemblyInput };
			export let closeCalls = 0;
			export const standardTemplateReleaseApp = {
				app: {
					fetch() { return new Response(String(this === standardTemplateReleaseApp.app), { status: 202 }); }
				},
				async close() { if (this !== standardTemplateReleaseApp) throw new Error(); closeCalls++; }
			};
		`;
		const moduleSpecifier = `data:text/javascript,${encodeURIComponent(source)}`;
		const deployment = await import(moduleSpecifier);

		const running = await startPlatformApiFromDeployment({
			moduleSpecifier,
			port: 0,
			log: () => {},
		});
		const address = running.server.address();
		if (!address || typeof address === "string")
			throw new Error("Platform API did not bind a TCP port");
		const response = await fetch(
			`http://127.0.0.1:${address.port}/internal/ops/standard-template-releases/test`,
		);
		expect(response.status).toBe(202);
		expect(await response.text()).toBe("true");
		await createPlatformApiShutdown(running)();
		expect(deployment.closeCalls).toBe(1);
	});

	it.each([
		["factory", false],
		["factory", true],
		["assembly", false],
		["assembly", true],
	] as const)(
		"closes browser resources on %s failure when cleanup rejects=%s",
		async (stage, cleanupRejects) => {
			const source = `
				export let closeCalls = 0;
				export const browserAuth = {
					handleRequest() { return null; },
					async close() {
						closeCalls++;
						${cleanupRejects ? 'throw new Error("private cleanup sentinel");' : ""}
					}
				};
				export function createPlatformApiAssemblyInput() {
					${stage === "factory" ? 'throw new Error("private dependency sentinel");' : "return { wecomApplicationSetup: {} };"}
				}
			`;
			const moduleSpecifier = `data:text/javascript,${encodeURIComponent(source)}`;
			const deployment = await import(moduleSpecifier);
			const log = vi.fn();

			await expect(
				startPlatformApiFromDeployment({ moduleSpecifier, port: 0, log }),
			).rejects.toMatchObject({
				message:
					stage === "factory"
						? "Platform API deployment dependencies are unavailable"
						: "WeCom application setup requires encryption keys",
			});
			expect(deployment.closeCalls).toBe(1);
			expect(log).not.toHaveBeenCalled();
		},
	);

	it("forwards only a validated deployment diagnostic from a failing factory (#2382)", async () => {
		const source = `
			const key = Symbol.for("agent-infra.platform-api.deployment-diagnostic.v1");
			export function createPlatformApiAssemblyInput() {
				const error = new Error("private dependency sentinel");
				Object.defineProperty(error, key, {
					value: { reason: "codex_model_profiles_missing", templateId: "codex", extra: "private" },
				});
				throw error;
			}
		`;
		const error = await loadPlatformApiAssembly(
			`data:text/javascript,${encodeURIComponent(source)}`,
		).catch((caught: unknown) => caught);
		expect((error as Error).message).toBe(
			"Platform API deployment dependencies are unavailable",
		);
		expect((error as Error).cause).toBeUndefined();
		expect(deploymentDiagnosticV1(error)).toEqual({
			reason: "codex_model_profiles_missing",
			templateId: "codex",
		});
		expect(platformApiStartupFailureMessageV1(error)).toBe(
			"Platform API failed to start: codex_model_profiles_missing (template codex); see deploy/platform-api/README.md",
		);
	});
	it("wires deployment-owned Runtime model and native metadata transports", async () => {
		const modelSelection = { read: vi.fn() };
		const identity = {
			schemaVersion: 1 as const,
			userId: "user-1",
			displayName: "Ada",
			accountStatus: "active" as const,
			organizationIds: ["org-1"],
			roles: ["employee" as const],
			authorizationRevision: "authorization-1",
		};
		const unavailable = async () => {
			throw new Error("unused test adapter");
		};
		const baseInput = {
			taskAdmissionPolicy: {
				maximumWaitingTasksPerAgent: 2,
				waitingTimeoutMs: 60_000,
			},
			databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/invalid",
			identity: {
				resolve: vi.fn().mockResolvedValue(identity),
				hydrateUsers: vi.fn().mockResolvedValue([]),
				resolveUser: vi.fn().mockResolvedValue({
					schemaVersion: 1,
					userId: identity.userId,
					accountStatus: "active",
					organizationIds: identity.organizationIds,
					authorizationRevision: "directory-1",
				}),
			},
			admissions: {
				authorizationAdmission: { authorize: unavailable },
				imageAdmission: { admitImage: unavailable },
				modelAdmission: { admitModels: unavailable },
				secretAdmission: { admitSecrets: unavailable },
				channelAdmission: { admitChannels: unavailable },
			},
			allocateApplicationIds: unavailable,
			prepareApplicationSecrets: unavailable,
			prepareConfigurationSecrets: unavailable,
			presentAgent: unavailable,
			modelSelection,
			nativeMetadataWorker: {
				baseUrl: "http://worker.example.test",
				serviceToken: "worker-service-token",
			},
		};
		const assembly = assemblePlatformApi(baseInput);
		expect(assembly.dependencies.conversation.modelSelection).toBe(
			modelSelection,
		);
		expect(assembly.dependencies.nativeMetadata?.reader).toBeDefined();
		expect(assembly.dependencies.nativeMetadataCurrent).toMatchObject({
			serviceToken: "worker-service-token",
		});
		expect(assembly.dependencies.nativeMetadataCurrent?.check).toBeDefined();
		expect(assembly.dependencies.nativeCapabilityInvocation).toBeDefined();
		await assembly.close();
		let override: ReturnType<typeof assemblePlatformApi> | undefined;
		try {
			expect(() => {
				override = assemblePlatformApi({
					...baseInput,
					nativeMetadataCurrent: {
						serviceToken: "worker-service-token",
						check: async () => ({ outcome: "unavailable" as const }),
					},
				});
			}).toThrow("PLATFORM_NATIVE_METADATA_REQUEST_REGISTRY_REQUIRED");
		} finally {
			await override?.close();
		}
		const requestRegistry = createRuntimeNativeMetadataRequestRegistryV1();
		const clear = vi.spyOn(requestRegistry, "clear");
		const current = {
			serviceToken: "worker-service-token",
			check: async () => ({ outcome: "unavailable" as const }),
		};
		const shared = assemblePlatformApi({
			...baseInput,
			nativeMetadataWorker: {
				...baseInput.nativeMetadataWorker,
				requestRegistry,
			},
			nativeMetadataCurrent: current,
		});
		expect(shared.dependencies.nativeMetadataCurrent).toBe(current);
		await shared.close();
		expect(clear).toHaveBeenCalledOnce();
	});

	it("rejects a duplicate explicit native capability authority", () => {
		const unavailable = async () => {
			throw new Error("unused test adapter");
		};
		const identity = {
			schemaVersion: 1 as const,
			userId: "user-duplicate",
			displayName: "Duplicate User",
			accountStatus: "active" as const,
			organizationIds: [],
			roles: ["employee" as const],
			authorizationRevision: "authorization-duplicate",
		};
		const nativeCapabilityMetadata = {
			revalidate: async () => ({ outcome: "unavailable" as const }),
			isCurrent: () => false,
		};
		const nativeCapabilityInvocation = {
			identity: {
				resolve: vi.fn().mockResolvedValue(identity),
				hydrateUsers: vi.fn().mockResolvedValue([]),
			},
			buildRequest: async (input: {
				readonly conversationId: string;
				readonly body: NativeCapabilityInvocationRequestV1;
			}) => ({
				...input.body,
				schemaVersion: 1 as const,
				conversationId: input.conversationId,
			}),
			admit: async () => ({ outcome: "unavailable" as const }),
		};
		expect(() =>
			assemblePlatformApi({
				taskAdmissionPolicy: {
					maximumWaitingTasksPerAgent: 2,
					waitingTimeoutMs: 60_000,
				},
				databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/invalid",
				identity: nativeCapabilityInvocation.identity,
				admissions: {
					authorizationAdmission: { authorize: unavailable },
					imageAdmission: { admitImage: unavailable },
					modelAdmission: { admitModels: unavailable },
					secretAdmission: { admitSecrets: unavailable },
					channelAdmission: { admitChannels: unavailable },
				},
				allocateApplicationIds: unavailable,
				prepareApplicationSecrets: unavailable,
				prepareConfigurationSecrets: unavailable,
				presentAgent: unavailable,
				nativeMetadataWorker: {
					baseUrl: "http://worker.example.test",
					serviceToken: "worker-service-token",
				},
				nativeCapabilityInvocation,
				nativeCapabilityMetadata,
			}),
		).toThrow("PLATFORM_NATIVE_CAPABILITY_METADATA_DUPLICATE");
	});

	it("passes a deployment-owned custom Agent gateway into PlatformAppDependencies", async () => {
		const identity = {
			schemaVersion: 1 as const,
			userId: "user-1",
			displayName: "Ada",
			accountStatus: "active" as const,
			organizationIds: ["org-1"],
			roles: ["employee" as const],
			authorizationRevision: "authorization-1",
		};
		const unavailable = async () => {
			throw new Error("unused test adapter");
		};
		const gateway = {
			path: "/api/v1/custom-agent",
			resolveDeployment: vi.fn().mockResolvedValue({
				agentId: "agent-1",
				serviceOrigin: "https://agent.example/",
			}),
			issuer: "platform-api",
			keyVersion: "test-key-v1",
			privateKey: generateKeyPairSync("ed25519").privateKey,
		};
		const assembly = assemblePlatformApi({
			taskAdmissionPolicy: {
				maximumWaitingTasksPerAgent: 2,
				waitingTimeoutMs: 60_000,
			},
			databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/invalid",
			identity: {
				resolve: vi.fn().mockResolvedValue(identity),
				hydrateUsers: vi.fn().mockResolvedValue([]),
				resolveUser: vi.fn().mockResolvedValue({
					schemaVersion: 1,
					userId: identity.userId,
					accountStatus: "active",
					organizationIds: identity.organizationIds,
					authorizationRevision: "directory-1",
				}),
			},
			admissions: {
				authorizationAdmission: { authorize: unavailable },
				imageAdmission: { admitImage: unavailable },
				modelAdmission: { admitModels: unavailable },
				secretAdmission: { admitSecrets: unavailable },
				channelAdmission: { admitChannels: unavailable },
			},
			allocateApplicationIds: unavailable,
			prepareApplicationSecrets: unavailable,
			prepareConfigurationSecrets: unavailable,
			presentAgent: unavailable,
			customAgentGateway: gateway,
		});

		expect(assembly.dependencies.customAgentGateway).toMatchObject(gateway);
		expect(assembly.dependencies.customAgentGateway?.identity).toBe(
			assembly.dependencies.conversation.identity,
		);
		expect(
			await assembly.dependencies.customAgentGateway?.authorizeAgent({
				identity,
				agentId: "agent-1",
			}),
		).toBe(false);
		await assembly.close();
	});

	it("registers the complete app before starting the Node server", async () => {
		const identity = {
			schemaVersion: 1 as const,
			userId: "user-1",
			displayName: "Ada",
			accountStatus: "active" as const,
			organizationIds: ["org-1"],
			roles: ["employee" as const],
			authorizationRevision: "authorization-1",
		};
		const unavailable = async () => {
			throw new Error("unused test adapter");
		};
		const getAgent = vi.spyOn(
			PostgresAgentManagementQueryV1.prototype,
			"getAgent",
		);
		const closeTaskAuthorization = vi.spyOn(
			PostgresTaskAuthorizationStoreV1.prototype,
			"close",
		);
		const assembly = assemblePlatformApi({
			// Controlled fixture policy; not a production default.
			taskAdmissionPolicy: {
				maximumWaitingTasksPerAgent: 2,
				waitingTimeoutMs: 60_000,
			},
			databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/invalid",
			identity: {
				resolve: vi.fn().mockResolvedValue(identity),
				hydrateUsers: vi.fn().mockResolvedValue([]),
				resolveUser: vi.fn().mockResolvedValue({
					schemaVersion: 1,
					userId: identity.userId,
					accountStatus: "active",
					organizationIds: identity.organizationIds,
					authorizationRevision: "directory-1",
				}),
			},
			admissions: {
				authorizationAdmission: { authorize: unavailable },
				imageAdmission: { admitImage: unavailable },
				modelAdmission: { admitModels: unavailable },
				secretAdmission: { admitSecrets: unavailable },
				channelAdmission: { admitChannels: unavailable },
			},
			allocateApplicationIds: unavailable,
			prepareApplicationSecrets: unavailable,
			prepareConfigurationSecrets: unavailable,
			presentAgent: unavailable,
		});
		const browserAuth = {
			handleRequest: vi.fn(async () => new Response(null, { status: 204 })),
		};
		const standardTemplateReleaseApp = {
			fetch: vi.fn(
				async () =>
					new Response(JSON.stringify({ status: "release-app" }), {
						status: 202,
						headers: { "content-type": "application/json" },
					}),
			),
		};
		const server = startPlatformApi({
			dependencies: assembly.dependencies,
			browserAuth,
			standardTemplateReleaseApp,
			log: () => {},
			port: 0,
		});
		servers.push(server);
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Platform API did not bind a TCP port");
		}

		try {
			const login = await fetch(`http://127.0.0.1:${address.port}/auth/login`, {
				method: "POST",
			});
			expect(login.status).toBe(204);
			expect(browserAuth.handleRequest).toHaveBeenCalledOnce();
			const release = await fetch(
				`http://127.0.0.1:${address.port}/internal/ops/standard-template-releases/release/apply`,
				{ method: "POST" },
			);
			expect(release.status).toBe(202);
			expect(standardTemplateReleaseApp.fetch).toHaveBeenCalledOnce();
			// 未装配 release app 时保留命名空间显式 404，不回落到普通 API。
			const withoutReleaseApp = startPlatformApi({
				dependencies: assembly.dependencies,
				log: () => {},
				port: 0,
			});
			servers.push(withoutReleaseApp);
			const withoutAddress = withoutReleaseApp.address();
			if (!withoutAddress || typeof withoutAddress === "string") {
				throw new Error("Platform API without release app did not bind");
			}
			for (const path of [
				"/internal/ops/standard-template-releases",
				"/internal/ops/standard-template-releases/",
				"/internal/ops/standard-template-releases/release/apply",
			]) {
				const unreleased = await fetch(
					`http://127.0.0.1:${withoutAddress.port}${path}`,
					{ method: "POST" },
				);
				expect(unreleased.status).toBe(404);
				expect(unreleased.headers.get("cache-control")).toBe("no-store");
				expect(await unreleased.text()).toBe("");
			}
			browserAuth.handleRequest.mockRejectedValueOnce(
				new Error("private directory failure"),
			);
			const failedLogout = await fetch(
				`http://127.0.0.1:${address.port}/auth/logout`,
				{ method: "POST" },
			);
			expect(failedLogout.status).toBe(503);
			expect(await failedLogout.text()).toBe("");
			for (const serviceAvailability of [
				"starting",
				"updating",
				"unavailable",
			] as const) {
				getAgent.mockResolvedValueOnce({
					schemaVersion: 1,
					agentId: "agent-1",
					applicationId: "application-1",
					name: "Agent",
					description: "Agent fixture",
					sourceReference: "source-1",
					management: {
						schemaVersion: 1,
						applicationId: "application-1",
						agentId: "agent-1",
						applicantId: identity.userId,
						status: "available",
						revision: 1,
						approvalRevision: 1,
						decisionReason: null,
						serviceAvailability,
						desiredState: "running",
						workloadRevision: 1,
						fence: 1,
						ownerIds: [identity.userId],
						availability: [],
						failureCode:
							serviceAvailability === "unavailable"
								? "workload_unavailable"
								: null,
					},
				});
				await expect(
					assembly.dependencies.conversation.authorization.authorize(identity, {
						schemaVersion: 1,
						operation: "conversation.create",
						agentId: "agent-1",
					}),
				).resolves.toEqual({ outcome: "unavailable" });
			}
			const response = await fetch(
				`http://127.0.0.1:${address.port}/api/v1/session`,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				schemaVersion: 1,
				user: { userId: "user-1" },
			});
			expect(browserAuth.handleRequest).toHaveBeenCalledTimes(2);
		} finally {
			await assembly.close();
			expect(closeTaskAuthorization).toHaveBeenCalledOnce();
		}
	});

	it("closes deployment assembly when the Node server cannot bind", async () => {
		const calls: string[] = [];
		const queryClose = PostgresConversationQueryV1.prototype.close;
		const closeQuery = vi
			.spyOn(PostgresConversationQueryV1.prototype, "close")
			.mockImplementation(async function (this: PostgresConversationQueryV1) {
				await queryClose.call(this);
				calls.push("query");
			});
		const closeAuthorization = vi.spyOn(
			PostgresTaskAuthorizationStoreV1.prototype,
			"close",
		);
		const readSnapshot = vi.spyOn(
			PostgresConversationQueryV1.prototype,
			"readResourceSnapshot",
		);
		const startObserver = telemetryModule.startObservability;
		const observers: ReturnType<typeof startObserver>[] = [];
		vi.spyOn(telemetryModule, "startObservability").mockImplementation(
			(options) => {
				const observer = startObserver(options);
				observers.push(observer);
				const close = observer.close;
				vi.spyOn(observer, "close").mockImplementation(async () => {
					await close();
					calls.push("observer");
				});
				return observer;
			},
		);
		const fixture = new URL(
			"../../../tests/fixtures/platform-api-deployment.mjs",
			import.meta.url,
		).href;
		const moduleSpecifier = `data:text/javascript,${encodeURIComponent(`
			import { createPlatformApiAssemblyInput } from ${JSON.stringify(fixture)};
			export { createPlatformApiAssemblyInput };
			export const browserAuth = {
				handleRequest() { return null; },
				async close() {}
			};
		`)}`;
		const deployment = await import(moduleSpecifier);
		const closeBrowser = vi
			.spyOn(deployment.browserAuth, "close")
			.mockImplementation(async () => {
				calls.push("browser");
			});
		const output = new PassThrough();
		const blocker = createServer();
		blocker.listen(0);
		await once(blocker, "listening");
		const address = blocker.address();
		if (!address || typeof address === "string") {
			throw new Error("Port blocker did not bind");
		}

		try {
			await expect(
				startPlatformApiFromDeployment({
					log: () => {},
					moduleSpecifier,
					observabilityOptions: { output },
					port: address.port,
				}),
			).rejects.toMatchObject({ code: "EADDRINUSE" });
			expect(closeQuery).toHaveBeenCalledOnce();
			expect(closeAuthorization).toHaveBeenCalledOnce();
			expect(closeBrowser).toHaveBeenCalledOnce();
			expect(observers).toHaveLength(1);
			expect(observers[0]?.close).toHaveBeenCalledOnce();
			expect(observers[0]?.status().state).toBe("closed");
			expect(calls).toEqual(["query", "browser", "observer"]);
			expect(readSnapshot).not.toHaveBeenCalled();
			expect(output.listenerCount("drain")).toBe(0);
			expect(output.listenerCount("error")).toBe(0);
		} finally {
			blocker.close();
			await once(blocker, "close");
		}
	});

	it("mounts browser auth from the same deployment module as the API assembly", async () => {
		const running = await startPlatformApiFromDeployment({
			log: () => {},
			moduleSpecifier: new URL(
				"../../../tests/fixtures/platform-api-deployment.mjs",
				import.meta.url,
			).href,
			port: 0,
		});
		const address = running.server.address();
		if (!address || typeof address === "string") {
			throw new Error("Platform API did not bind a TCP port");
		}
		try {
			const origin = `http://127.0.0.1:${address.port}`;
			expect(
				(await fetch(`${origin}/auth/login`, { method: "POST" })).status,
			).toBe(204);
			expect((await fetch(`${origin}/healthz`)).status).toBe(200);
		} finally {
			await createPlatformApiShutdown(running)();
		}
	});

	it("owns observability for the deployed API process", async () => {
		const readSnapshot = vi.spyOn(
			PostgresConversationQueryV1.prototype,
			"readResourceSnapshot",
		);
		const output = new PassThrough();
		const lines: string[] = [];
		output.on("data", (chunk) => lines.push(String(chunk)));
		const running = await startPlatformApiFromDeployment({
			log: () => {},
			moduleSpecifier: new URL(
				"../../../tests/fixtures/platform-api-deployment.mjs",
				import.meta.url,
			).href,
			observabilityOptions: { output },
			port: 0,
		});
		const address = running.server.address();
		if (!address || typeof address === "string")
			throw new Error("Platform API did not bind a TCP port");
		try {
			const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				status: "ok",
				observability: { enabled: false, state: "active" },
			});
		} finally {
			await createPlatformApiShutdown(running)();
		}
		expect(running.observability.status().state).toBe("closed");
		expect(readSnapshot).not.toHaveBeenCalled();
		expect(lines.some((line) => line.includes('"stage":"http"'))).toBe(true);
	});

	it("automatically publishes fresh snapshots from each deployed query after an API assembly restart", async () => {
		let complete: (snapshot: {
			taskWaiting: number;
			outboxPending: number;
		}) => void = () => {};
		const read = vi
			.spyOn(PostgresConversationQueryV1.prototype, "readResourceSnapshot")
			.mockImplementation(
				() =>
					new Promise((resolve) => {
						complete = resolve;
					}),
			);
		for (const snapshot of [
			{ taskWaiting: 4, outboxPending: 9 },
			{ taskWaiting: 1, outboxPending: 2 },
		]) {
			read.mockClear();
			const running = await startPlatformApiFromDeployment({
				moduleSpecifier: new URL(
					"../../../tests/fixtures/platform-api-deployment.mjs",
					import.meta.url,
				).href,
				port: 0,
				log: () => {},
				observabilityOptions: {
					output: new PassThrough(),
					otlpEndpoint: "http://127.0.0.1:1",
					metricIntervalMs: 1000,
				},
			});
			try {
				const observe = vi.spyOn(running.observability, "observeResource");
				complete(snapshot);
				await Promise.resolve();
				expect(read).toHaveBeenCalledOnce();
				expect(read.mock.instances[0]).toBe(
					running.assembly.dependencies.conversation?.query,
				);
				expect(observe.mock.calls).toEqual([
					[{ kind: "task_waiting", value: snapshot.taskWaiting }],
					[{ kind: "outbox_pending", value: snapshot.outboxPending }],
					[{ kind: "sse_connections", value: 0 }],
					[{ kind: "sse_pending_events", value: 0 }],
				]);
			} finally {
				await createPlatformApiShutdown(running)();
			}
			expect(running.observability.status().state).toBe("closed");
		}
	});

	it("automatically samples the existing deployed query and contains snapshot failures", async () => {
		const read = vi
			.spyOn(PostgresConversationQueryV1.prototype, "readResourceSnapshot")
			.mockRejectedValue(new Error("private DB sentinel"));
		const output = new PassThrough();
		const running = await startPlatformApiFromDeployment({
			moduleSpecifier: new URL(
				"../../../tests/fixtures/platform-api-deployment.mjs",
				import.meta.url,
			).href,
			port: 0,
			log: () => {},
			observabilityOptions: {
				output,
				otlpEndpoint: "http://127.0.0.1:1",
				metricIntervalMs: 1000,
			},
		});
		try {
			expect(read).toHaveBeenCalledOnce();
			expect(read.mock.instances[0]).toBe(
				running.assembly.dependencies.conversation?.query,
			);
			const address = running.server.address();
			if (!address || typeof address === "string")
				throw new Error("Missing server address");
			const response = await fetch(
				`http://127.0.0.1:${address.port}/api/v1/session`,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				user: { userId: "smoke-user" },
			});
			const listAgents = vi.spyOn(
				PostgresAgentManagementQueryV1.prototype,
				"listAgents",
			);
			const administratorRead = await fetch(
				`http://127.0.0.1:${address.port}/api/v2/admin/agents`,
				{ headers: { "X-User-Id": "administrator", "X-Role": "system_admin" } },
			);
			expect(administratorRead.status).toBe(403);
			expect(await administratorRead.json()).toMatchObject({
				code: "RESOURCE_UNAVAILABLE",
				retryable: false,
			});
			expect(listAgents).not.toHaveBeenCalled();
			vi.spyOn(
				running.assembly.dependencies.management.identity,
				"resolve",
			).mockResolvedValueOnce(null);
			const anonymousSession = await fetch(
				`http://127.0.0.1:${address.port}/api/v1/session`,
			);
			expect(anonymousSession.status).toBe(401);
			expect(await anonymousSession.json()).toMatchObject({
				code: "AUTHENTICATION_REQUIRED",
				retryable: false,
			});
		} finally {
			await createPlatformApiShutdown(running)();
		}
		expect(read.mock.calls[0]?.[0].aborted).toBe(false);
		expect(running.observability.status().state).toBe("closed");
	});

	it("settles the aborted sampler before closing the pool even when server close fails", async () => {
		const calls: string[] = [];
		let finish: () => void = () => {};
		const close = vi.fn(async () => {
			calls.push("assembly");
		});
		const shutdown = createPlatformApiShutdown({
			assembly: { close } as unknown as Awaited<
				ReturnType<typeof startPlatformApiFromDeployment>
			>["assembly"],
			server: {
				close(callback: (error: Error) => void) {
					calls.push("server");
					callback(new Error("server close failed"));
				},
			} as ReturnType<typeof startPlatformApi>,
			stopResourceSampling: () => {
				calls.push("abort");
				return new Promise<void>((resolve) => {
					finish = () => {
						calls.push("settled");
						resolve();
					};
				});
			},
		});
		const stopped = shutdown();
		expect(close).not.toHaveBeenCalled();
		finish();
		await expect(stopped).rejects.toThrow("server close failed");
		expect(calls).toEqual(["server", "abort", "settled", "assembly"]);
	});

	it("closes deployment resources once in server-first order", async () => {
		const calls: string[] = [];
		const assembly = {
			close: vi.fn(async () => {
				calls.push("assembly");
			}),
		} as unknown as Awaited<
			ReturnType<typeof startPlatformApiFromDeployment>
		>["assembly"];
		const server = {
			close(callback: (error?: Error) => void) {
				calls.push("server");
				callback();
			},
		} as ReturnType<typeof startPlatformApi>;
		const shutdown = createPlatformApiShutdown({ assembly, server });

		await Promise.all([shutdown(), shutdown()]);

		expect(calls).toEqual(["server", "assembly"]);
		expect(assembly.close).toHaveBeenCalledOnce();
	});
});
