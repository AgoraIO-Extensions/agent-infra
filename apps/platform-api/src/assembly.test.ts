import { once } from "node:events";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";

import {
	PostgresAgentManagementQueryV1,
	PostgresConversationQueryV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assemblePlatformApi } from "./assembly.js";
import {
	createPlatformApiShutdown,
	loadPlatformApiAssembly,
	startPlatformApi,
	startPlatformApiFromDeployment,
} from "./index.js";

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
		const server = startPlatformApi({
			dependencies: assembly.dependencies,
			browserAuth,
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
					moduleSpecifier: new URL(
						"../../../tests/fixtures/platform-api-deployment.mjs",
						import.meta.url,
					).href,
					port: address.port,
				}),
			).rejects.toMatchObject({ code: "EADDRINUSE" });
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
