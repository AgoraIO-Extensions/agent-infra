import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeSubmitTurnRequestV1 } from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CodexAppServerFrame } from "./codex-app-server-bridge.js";
import { openCodexRuntimeDriverForTest } from "./codex-runtime-driver.test-support.js";
import type { RuntimeDriver } from "./driver.js";
import {
	ingressVerifiedRuntimeHost,
	runtimeGrantFixture,
} from "./grant-fixture.test-support.js";
import { FakeRuntimeDriver, FileRuntimeStore, RuntimeHost } from "./index.js";

const directories: string[] = [];
const driverClosers: (() => Promise<void>)[] = [];
const driverNames = ["Fake", "Codex"] as const;

interface ConformanceEffects {
	codexTurnStarts: number;
}

interface ConformanceDriverOptions {
	loseTurnStartResponse?: boolean;
}

type ConformanceTurnStatus =
	| "inProgress"
	| "completed"
	| "failed"
	| "interrupted";

/** Narrow transport fixture for the shared Driver seam; protocol faults stay in Codex's own suite. */
class ConformanceCodexBridge {
	readonly nativeThreadId = "thread-opaque";
	readonly nativeTurnId = "turn-opaque";
	readonly responses: CodexAppServerFrame[] = [];
	private readonly queuedFrames: CodexAppServerFrame[] = [];
	private wake?: () => void;
	private closed = false;
	private turnStatus: ConformanceTurnStatus = "inProgress";
	private terminalOnInterrupt?: Exclude<ConformanceTurnStatus, "inProgress">;
	private holdTurnStartResponse = false;
	private heldTurnStart?: { id: number; resolve: () => void };
	private turnStartHeld?: Promise<void>;
	private signalTurnStartHeld?: () => void;

	constructor(
		private readonly effects: ConformanceEffects,
		private readonly options: ConformanceDriverOptions = {},
	) {}

	async send(frame: CodexAppServerFrame) {
		if (!("method" in frame) && "error" in frame) {
			this.responses.push(frame);
			return;
		}
		if ("method" in frame && typeof frame.id === "number") {
			switch (frame.method) {
				case "initialize":
					this.respond(frame.id, {});
					return;
				case "config/read":
					this.respond(frame.id, {
						config: {
							model: "gpt-5.3-codex",
							model_reasoning_effort: "high",
							mcp_servers: {},
							plugins: {},
							marketplaces: {},
							features: { plugins: false },
						},
						origins: {
							model: { name: { type: "sessionFlags" }, version: "1" },
							model_reasoning_effort: {
								name: { type: "sessionFlags" },
								version: "1",
							},
							"features.plugins": {
								name: { type: "sessionFlags" },
								version: "1",
							},
						},
					});
					return;
				case "thread/start":
				case "thread/resume":
					this.respond(frame.id, { thread: { id: this.nativeThreadId } });
					return;
				case "turn/start":
					this.effects.codexTurnStarts += 1;
					if (this.options.loseTurnStartResponse) {
						await this.close();
						return;
					}
					if (this.holdTurnStartResponse) {
						const id = frame.id;
						this.signalTurnStartHeld?.();
						this.signalTurnStartHeld = undefined;
						await new Promise<void>((resolve) => {
							this.heldTurnStart = { id, resolve };
						});
						return;
					}
					this.respond(frame.id, {
						turn: { id: this.nativeTurnId, status: "inProgress" },
					});
					return;
				case "turn/interrupt":
					if (this.terminalOnInterrupt) {
						this.turnStatus = this.terminalOnInterrupt;
					}
					this.respond(frame.id, {});
					return;
				case "thread/turns/list":
					this.respond(frame.id, {
						data: [
							{ id: this.nativeTurnId, status: this.turnStatus, items: [] },
						],
					});
					return;
				case "thread/items/list":
					this.respond(frame.id, { data: [] });
					return;
			}
		}
		throw new Error("Unexpected Codex conformance frame");
	}

	frames(): AsyncIterable<CodexAppServerFrame> {
		const bridge = this;
		return (async function* () {
			while (true) {
				const frame = await bridge.nextFrame();
				if (!frame) return;
				yield frame;
			}
		})();
	}

	async close() {
		this.closed = true;
		this.heldTurnStart?.resolve();
		this.heldTurnStart = undefined;
		this.wake?.();
		this.wake = undefined;
	}

	holdTurnStart() {
		this.holdTurnStartResponse = true;
		this.turnStartHeld = new Promise<void>((resolve) => {
			this.signalTurnStartHeld = resolve;
		});
	}

	async waitForHeldTurnStart() {
		if (!this.turnStartHeld) throw new Error("Turn start is not held");
		await this.turnStartHeld;
	}

	releaseTurnStart() {
		const held = this.heldTurnStart;
		if (!held) throw new Error("No held turn start");
		this.heldTurnStart = undefined;
		this.holdTurnStartResponse = false;
		this.respond(held.id, {
			turn: { id: this.nativeTurnId, status: "inProgress" },
		});
		held.resolve();
	}

	emitRunningEvent() {
		this.push({
			method: "turn/started",
			params: {
				threadId: this.nativeThreadId,
				turn: { id: this.nativeTurnId, status: "inProgress", items: [] },
			},
		});
	}

	emitDelegatedToolRequest() {
		this.push({
			id: "request-opaque",
			method: "item/tool/call",
			params: { privateInput: "redacted-input" },
		});
	}

	completeStopAsCancelled() {
		this.terminalOnInterrupt = "interrupted";
	}

	completeStopAsCompleted() {
		this.terminalOnInterrupt = "completed";
	}

	private respond(id: number, result: unknown) {
		this.push({ id, result });
	}

	private push(frame: CodexAppServerFrame) {
		this.queuedFrames.push(frame);
		this.wake?.();
		this.wake = undefined;
	}

	private async nextFrame() {
		while (true) {
			const frame = this.queuedFrames.shift();
			if (frame) return frame;
			if (this.closed) return undefined;
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}
}

async function directory() {
	const path = await mkdtemp(
		join(tmpdir(), "agent-runtime-driver-conformance-"),
	);
	directories.push(path);
	return path;
}

interface ConformanceDriverFixture {
	driver: RuntimeDriver;
	emitRunningEvent(): Promise<void>;
	completeStopAsCancelled(): void;
	completeStopAsCompleted(operationId: string): Promise<void>;
	createdTurnCount(): Promise<number>;
	restart(): Promise<ConformanceDriverFixture>;
	makeOperationUnknown(operationId: string): Promise<void>;
	holdTurnStart(): void;
	waitForHeldTurnStart(): Promise<void>;
	releaseTurnStart(): void;
	emitDelegatedToolRequest(): void;
	delegatedToolResponses(): unknown[];
}

async function openConformanceDriver(
	name: (typeof driverNames)[number],
	path: string,
	effects: ConformanceEffects = { codexTurnStarts: 0 },
	options: ConformanceDriverOptions = {},
): Promise<ConformanceDriverFixture> {
	if (name === "Fake") {
		const driver = await FakeRuntimeDriver.open(path);
		return {
			driver,
			emitRunningEvent: async () => undefined,
			completeStopAsCancelled: () => undefined,
			completeStopAsCompleted: (operationId) =>
				driver.setOperationStatus(operationId, "completed"),
			createdTurnCount: () => driver.sideEffectCount(),
			restart: () => openConformanceDriver(name, path, effects),
			makeOperationUnknown: (operationId) =>
				driver.makeOperationUnknown(operationId),
			holdTurnStart: () => undefined,
			waitForHeldTurnStart: async () => undefined,
			releaseTurnStart: () => undefined,
			emitDelegatedToolRequest: () => undefined,
			delegatedToolResponses: () => [],
		};
	}
	const bridge = new ConformanceCodexBridge(effects, options);
	const driver = await openCodexRuntimeDriverForTest(
		{
			path,
			model: "gpt-5.3-codex",
			reasoningEffort: "high",
		},
		async () => bridge,
	);
	driverClosers.push(() => driver.close());
	return {
		driver,
		emitRunningEvent: async () => bridge.emitRunningEvent(),
		completeStopAsCancelled: () => bridge.completeStopAsCancelled(),
		completeStopAsCompleted: async () => bridge.completeStopAsCompleted(),
		createdTurnCount: async () => effects.codexTurnStarts,
		restart: () => openConformanceDriver(name, path, effects),
		makeOperationUnknown: async () => undefined,
		holdTurnStart: () => bridge.holdTurnStart(),
		waitForHeldTurnStart: () => bridge.waitForHeldTurnStart(),
		releaseTurnStart: () => bridge.releaseTurnStart(),
		emitDelegatedToolRequest: () => bridge.emitDelegatedToolRequest(),
		delegatedToolResponses: () => bridge.responses,
	};
}

function submitRequest(): RuntimeSubmitTurnRequestV1 {
	const binding = {
		agentId: "agent-conformance",
		actorId: "actor-conformance",
		channelId: "web",
		conversationId: "conversation-conformance",
		executionId: "execution-conformance",
		turnId: "turn-conformance",
		sessionGeneration: 1,
		traceId: "trace-conformance",
	};
	return {
		schemaVersion: 1,
		requestId: "request-conformance",
		...binding,
		deliveryFence: 1,
		grant: runtimeGrantFixture(binding, ["turn.submit"]),
		input: { text: "synthetic-conformance", attachments: [] },
	};
}

afterEach(async () => {
	await Promise.all(driverClosers.splice(0).map((close) => close()));
	await Promise.all(
		directories.splice(0).map((path) => rm(path, { recursive: true })),
	);
});

describe("Runtime Driver shared conformance", () => {
	it.each(driverNames)(
		"runs the Session, Turn, status, and capability scenario through %s",
		async (name) => {
			const path = await directory();
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const host = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(join(path, "host.json")),
					driver: fixture.driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
				}),
			);

			const request = submitRequest();
			const submitted = await host.submitTurn(request);
			expect(submitted.result).toEqual({
				outcome: "accepted",
				status: "running",
			});
			const context = {
				schemaVersion: 1 as const,
				requestId: "request-conformance-status",
				actorId: request.actorId,
				channelId: request.channelId,
				traceId: request.traceId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				deliveryFence: 1,
				hostSessionRef: submitted.hostSessionRef,
			};

			expect(
				await host.status({
					...context,
					grant: runtimeGrantFixture(context, ["session.status"]),
				}),
			).toMatchObject({ status: "running" });
			const capabilities = await host.capabilities({
				...context,
				requestId: "request-conformance-capabilities",
				grant: runtimeGrantFixture(context, ["capabilities.read"]),
			});
			expect(capabilities.capabilities).toMatchObject({ modelSelection: true });
			for (const capability of Object.values(capabilities.capabilities)) {
				expect(typeof capability).toBe("boolean");
			}

			await fixture.emitRunningEvent();
			const replay = await vi.waitFor(async () => {
				const result = await host.replay({
					...context,
					requestId: "request-conformance-replay",
					grant: runtimeGrantFixture(context, ["events.replay"]),
				});
				expect(result.events).toContainEqual(
					expect.objectContaining({
						type: "status",
						payload: { status: "running" },
					}),
				);
				return result;
			});

			fixture.completeStopAsCancelled();
			expect(
				await host.stop({
					...context,
					requestId: "request-conformance-stop",
					executionDeliveryFence: 1,
					stopRequestId: "stop-conformance",
					grant: runtimeGrantFixture(context, ["turn.stop"]),
				}),
			).toMatchObject({ result: { outcome: "accepted", status: "cancelled" } });
			expect(replay.events).not.toEqual([]);
		},
	);

	it.each(driverNames)(
		"recovers one durable Session without a second Turn through %s",
		async (name) => {
			const path = await directory();
			const hostPath = join(path, "host.json");
			const first = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const firstHost = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(hostPath),
					driver: first.driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
				}),
			);
			const request = submitRequest();
			const submitted = await firstHost.submitTurn(request);
			expect(await first.createdTurnCount()).toBe(1);

			const restarted = await first.restart();
			const restartedHost = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(hostPath),
					driver: restarted.driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
				}),
			);
			const context = {
				schemaVersion: 1 as const,
				requestId: "request-conformance-recovered-status",
				actorId: request.actorId,
				channelId: request.channelId,
				traceId: request.traceId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				deliveryFence: 1,
				hostSessionRef: submitted.hostSessionRef,
			};
			expect(
				await restartedHost.status({
					...context,
					grant: runtimeGrantFixture(context, ["session.status"]),
				}),
			).toMatchObject({ status: "running" });
			expect(await restarted.createdTurnCount()).toBe(1);
		},
	);

	it.each(driverNames)(
		"replays duplicate delivery and fence takeover without a second Turn through %s",
		async (name) => {
			const path = await directory();
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const host = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(join(path, "host.json")),
					driver: fixture.driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
				}),
			);
			const request = submitRequest();
			const accepted = await host.submitTurn(request);
			const duplicate = await host.submitTurn({
				...request,
				requestId: "request-conformance-duplicate",
			});
			const takeover = await host.submitTurn({
				...request,
				requestId: "request-conformance-takeover",
				deliveryFence: 2,
				hostSessionRef: accepted.hostSessionRef,
			});

			expect(duplicate).toEqual(accepted);
			expect(takeover).toEqual(accepted);
			expect(await fixture.createdTurnCount()).toBe(1);
		},
	);

	it.each(driverNames)(
		"recovers a crash after durable prepare through %s",
		async (name) => {
			const path = await directory();
			const hostPath = join(path, "host.json");
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const crashingHost = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(hostPath),
					driver: fixture.driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
					afterOperationPrepared: () => {
						throw new Error("simulated crash after durable prepare");
					},
				}),
			);

			const request = submitRequest();
			await expect(crashingHost.submitTurn(request)).rejects.toThrow(
				"simulated crash after durable prepare",
			);
			expect(await fixture.createdTurnCount()).toBe(0);

			const restarted = await fixture.restart();
			const recoveredHost = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(hostPath),
					driver: restarted.driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
				}),
			);
			expect((await recoveredHost.submitTurn(request)).result).toEqual({
				outcome: "accepted",
				status: "running",
			});
			expect(await restarted.createdTurnCount()).toBe(1);
		},
	);

	it.each(driverNames)(
		"recovers a crash after Driver acceptance through %s",
		async (name) => {
			const path = await directory();
			const hostPath = join(path, "host.json");
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const crashingHost = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(hostPath),
					driver: fixture.driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
					afterDriverResult: () => {
						throw new Error("simulated crash after Driver acceptance");
					},
				}),
			);

			const request = submitRequest();
			await expect(crashingHost.submitTurn(request)).rejects.toThrow(
				"simulated crash after Driver acceptance",
			);
			expect(await fixture.createdTurnCount()).toBe(1);

			const restarted = await fixture.restart();
			const recoveredHost = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(hostPath),
					driver: restarted.driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
				}),
			);
			expect((await recoveredHost.submitTurn(request)).result).toEqual({
				outcome: "accepted",
				status: "running",
			});
			expect(await restarted.createdTurnCount()).toBe(1);
		},
	);

	it.each(driverNames)(
		"keeps an unqueryable accepted Turn unknown through %s",
		async (name) => {
			const path = await directory();
			const hostPath = join(path, "host.json");
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
				undefined,
				{ loseTurnStartResponse: name === "Codex" },
			);
			const crashingHost = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(hostPath),
					driver: fixture.driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
					afterDriverResult: () => {
						if (name === "Fake") {
							throw new Error("simulated lost Driver response");
						}
					},
				}),
			);
			const request = submitRequest();

			await expect(crashingHost.submitTurn(request)).rejects.toThrow();
			await fixture.makeOperationUnknown(request.executionId);

			const restarted = await fixture.restart();
			const recoveredHost = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(hostPath),
					driver: restarted.driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
				}),
			);
			expect((await recoveredHost.submitTurn(request)).result).toMatchObject({
				outcome: "unknown",
				code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			});
			expect(await restarted.createdTurnCount()).toBe(1);
		},
	);

	it.each(driverNames)(
		"preserves a pre-start event race through %s",
		async (name) => {
			const path = await directory();
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const host = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(join(path, "host.json")),
					driver: fixture.driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
				}),
			);
			const request = submitRequest();
			fixture.holdTurnStart();
			const submission = host.submitTurn(request);
			await fixture.waitForHeldTurnStart();
			await fixture.emitRunningEvent();
			fixture.releaseTurnStart();
			const submitted = await submission;
			const context = {
				schemaVersion: 1 as const,
				requestId: "request-conformance-pre-start-replay",
				actorId: request.actorId,
				channelId: request.channelId,
				traceId: request.traceId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				deliveryFence: 1,
				hostSessionRef: submitted.hostSessionRef,
			};
			expect(
				(
					await host.replay({
						...context,
						grant: runtimeGrantFixture(context, ["events.replay"]),
					})
				).events,
			).toContainEqual(
				expect.objectContaining({
					executionId: request.executionId,
					type: "status",
					payload: { status: "running" },
				}),
			);
		},
	);

	it.each(driverNames)(
		"preserves the actual terminal completion during a stop race through %s",
		async (name) => {
			const path = await directory();
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const host = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(join(path, "host.json")),
					driver: fixture.driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
				}),
			);
			const request = submitRequest();
			const submitted = await host.submitTurn(request);
			await fixture.completeStopAsCompleted(request.executionId);
			const context = {
				schemaVersion: 1 as const,
				requestId: "request-conformance-terminal-stop",
				actorId: request.actorId,
				channelId: request.channelId,
				traceId: request.traceId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				deliveryFence: 1,
				hostSessionRef: submitted.hostSessionRef,
			};
			expect(
				await host.stop({
					...context,
					executionDeliveryFence: 1,
					stopRequestId: "stop-conformance-terminal",
					grant: runtimeGrantFixture(context, ["turn.stop"]),
				}),
			).toMatchObject({ result: { outcome: "accepted", status: "completed" } });
			expect(await fixture.createdTurnCount()).toBe(1);
		},
	);

	it("denies a Codex delegated Tool request without retaining its parameters", async () => {
		const path = await directory();
		const driverPath = join(path, "driver.json");
		const fixture = await openConformanceDriver("Codex", driverPath);
		fixture.emitDelegatedToolRequest();

		await vi.waitFor(() => {
			expect(fixture.delegatedToolResponses()).toContainEqual({
				id: "request-opaque",
				error: {
					code: -32_001,
					message: "Platform delegated tools are unavailable",
				},
			});
		});
		expect(JSON.stringify(fixture.delegatedToolResponses())).not.toContain(
			"redacted-input",
		);
		expect(await readFile(driverPath, "utf8")).not.toContain("redacted-input");
		expect(await fixture.driver.getCapabilities()).toMatchObject({
			connection: false,
		});
	});
});
