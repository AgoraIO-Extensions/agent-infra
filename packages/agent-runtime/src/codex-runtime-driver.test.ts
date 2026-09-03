import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	RuntimeDriverCommandV1,
	RuntimeSubmitTurnRequestV1,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	CODEX_APP_SERVER_V2_PROVENANCE,
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
} from "./codex-app-server-bridge.js";
import { CodexRuntimeDriver } from "./codex-runtime-driver.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import {
	ingressVerifiedRuntimeHost,
	runtimeGrantFixture,
} from "./grant-fixture.test-support.js";
import { RuntimeHost } from "./runtime-host.js";

const directories: string[] = [];
const drivers: CodexRuntimeDriver[] = [];

type CodexTurnStatus = "inProgress" | "completed" | "failed" | "interrupted";

async function runtimeDirectory() {
	const directory = await mkdtemp(
		join(tmpdir(), "agent-runtime-codex-driver-"),
	);
	directories.push(directory);
	return directory;
}

function submitRequest(): RuntimeSubmitTurnRequestV1 {
	const binding = {
		agentId: "agent-codex",
		actorId: "actor-codex",
		channelId: "web",
		conversationId: "conversation-codex",
		executionId: "execution-codex",
		turnId: "turn-codex",
		sessionGeneration: 1,
		traceId: "trace-codex",
	};
	return {
		schemaVersion: 1,
		requestId: "request-codex",
		...binding,
		deliveryFence: 1,
		grant: runtimeGrantFixture(binding, ["turn.submit"]),
		input: { text: "synthetic-input", attachments: [] },
	};
}

function submitCommand(
	overrides: Partial<
		Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }>
	> = {},
): Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }> {
	return {
		schemaVersion: 1,
		kind: "submit-turn",
		operationId: "execution-codex",
		agentId: "agent-codex",
		conversationId: "conversation-codex",
		executionId: "execution-codex",
		turnId: "turn-codex",
		sessionGeneration: 1,
		input: { text: "synthetic-input", attachments: [] },
		...overrides,
	};
}

class TestCodexBridge {
	readonly requests: { method: string; params: unknown }[] = [];

	private readonly queuedFrames: CodexAppServerFrame[] = [];
	private readonly heldTurnsListRequestIds: number[] = [];
	private wake?: () => void;
	private closed = false;
	private turnStatus: CodexTurnStatus = "inProgress";
	private holdTurnsListResponses = false;

	constructor(
		readonly nativeThreadId = "codex-native-thread-private",
		readonly nativeTurnId = "codex-native-turn-private",
		private readonly closeOnTurnStart = false,
	) {}

	async send(frame: CodexAppServerFrame) {
		const { id, method, params } = frame;
		if (
			typeof id !== "number" ||
			!Number.isSafeInteger(id) ||
			typeof method !== "string"
		) {
			throw new Error("Expected a Codex JSON-RPC request");
		}
		this.requests.push({ method, params });
		if (method === "initialize") {
			this.respond(id, {});
			return;
		}
		if (method === "thread/start") {
			this.respond(id, { thread: { id: this.nativeThreadId } });
			return;
		}
		if (method === "thread/resume") {
			this.respond(id, { thread: { id: this.nativeThreadId } });
			return;
		}
		if (method === "thread/turns/list") {
			if (this.holdTurnsListResponses) {
				this.heldTurnsListRequestIds.push(id);
				return;
			}
			this.respondTurnsList(id);
			return;
		}
		if (method === "turn/start") {
			if (this.closeOnTurnStart) {
				await this.close();
				return;
			}
			this.respond(id, {
				turn: { id: this.nativeTurnId, status: "inProgress" },
			});
			return;
		}
		throw new Error(`Unexpected Codex JSON-RPC method: ${method}`);
	}

	setTurnStatus(status: CodexTurnStatus) {
		this.turnStatus = status;
	}

	holdTurnsList() {
		this.holdTurnsListResponses = true;
	}

	pendingTurnsListCount() {
		return this.heldTurnsListRequestIds.length;
	}

	respondToHeldTurnsList(kind: "error" | "missing-result") {
		const id = this.heldTurnsListRequestIds.shift();
		if (id === undefined) throw new Error("No held turns-list request");
		if (kind === "error") {
			this.push({
				id,
				error: { code: -32_000, message: "synthetic protocol error" },
			});
			return;
		}
		this.push({ id });
	}

	emitNotification() {
		this.push({
			method: "turn/started",
			params: {
				threadId: this.nativeThreadId,
				turnId: this.nativeTurnId,
			},
		});
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
		const wake = this.wake;
		this.wake = undefined;
		wake?.();
	}

	private respond(id: number, result: unknown) {
		this.push({ id, result });
	}

	private respondTurnsList(id: number) {
		this.respond(id, {
			data: [
				{
					id: this.nativeTurnId,
					status: this.turnStatus,
					items: [],
				},
			],
		});
	}

	private push(frame: CodexAppServerFrame) {
		this.queuedFrames.push(frame);
		const wake = this.wake;
		this.wake = undefined;
		wake?.();
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

afterEach(async () => {
	await Promise.all(drivers.splice(0).map((driver) => driver.close()));
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true })),
	);
});

describe("Codex Runtime Driver", () => {
	it("initializes one bounded Codex Session and Turn without leaking native references", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		let openedWith: CodexAppServerBridgeOptions | undefined;
		const driver = await CodexRuntimeDriver.open({
			path: join(directory, "driver.json"),
			bridgeOptions: {
				model: "gpt-5.3-codex",
				reasoningEffort: "high",
				provenance: CODEX_APP_SERVER_V2_PROVENANCE,
			},
			openBridge: async (options) => {
				openedWith = options;
				return bridge;
			},
		});
		drivers.push(driver);
		const runtimeHost = ingressVerifiedRuntimeHost(
			await RuntimeHost.open({
				store: await FileRuntimeStore.open(join(directory, "host.json")),
				driver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			}),
		);
		const request = submitRequest();

		const response = await runtimeHost.submitTurn(request);

		expect(openedWith).toEqual({
			model: "gpt-5.3-codex",
			reasoningEffort: "high",
			provenance: CODEX_APP_SERVER_V2_PROVENANCE,
		});
		expect(bridge.requests.map(({ method }) => method)).toEqual([
			"initialize",
			"thread/start",
			"turn/start",
			"thread/turns/list",
		]);
		expect(bridge.requests[3]?.params).toEqual({
			threadId: bridge.nativeThreadId,
			itemsView: "notLoaded",
			limit: 1,
		});
		expect(response).toMatchObject({
			operationId: request.executionId,
			result: { outcome: "accepted", status: "running" },
		});
		expect(response.hostSessionRef).not.toBe(bridge.nativeThreadId);
		expect(JSON.stringify(response)).not.toContain(bridge.nativeThreadId);
		expect(JSON.stringify(response)).not.toContain(bridge.nativeTurnId);
		expect(await driver.getCapabilities()).toMatchObject({
			modelSelection: true,
			connection: false,
		});
	});

	it("resumes the persisted Codex Session without starting a replacement", async () => {
		const directory = await runtimeDirectory();
		const firstBridge = new TestCodexBridge();
		const firstDriver = await CodexRuntimeDriver.open({
			path: join(directory, "driver.json"),
			bridgeOptions: {
				model: "gpt-5.3-codex",
				reasoningEffort: "high",
				provenance: CODEX_APP_SERVER_V2_PROVENANCE,
			},
			openBridge: async () => firstBridge,
		});
		drivers.push(firstDriver);
		const command = submitCommand();
		const firstResult = await firstDriver.execute(command);
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(firstBridge.nativeThreadId);
		resumedBridge.setTurnStatus("completed");
		const resumedDriver = await CodexRuntimeDriver.open({
			path: join(directory, "driver.json"),
			bridgeOptions: {
				model: "gpt-5.3-codex",
				reasoningEffort: "high",
				provenance: CODEX_APP_SERVER_V2_PROVENANCE,
			},
			openBridge: async () => resumedBridge,
		});
		drivers.push(resumedDriver);

		expect(
			await resumedDriver.getStatus(
				firstResult.nativeSessionRef,
				command.executionId,
			),
		).toBe("completed");
		expect(resumedBridge.requests.map(({ method }) => method)).toEqual([
			"initialize",
			"thread/resume",
			"thread/turns/list",
		]);
		expect(resumedBridge.requests[1]?.params).toEqual({
			threadId: firstBridge.nativeThreadId,
			excludeTurns: true,
		});
		expect(resumedBridge.requests[2]?.params).toEqual({
			threadId: firstBridge.nativeThreadId,
			itemsView: "notLoaded",
			limit: 1,
		});
		expect(
			(
				await resumedDriver.execute(
					submitCommand({
						operationId: "execution-codex-after-completion",
						executionId: "execution-codex-after-completion",
						turnId: "turn-codex-after-completion",
						nativeSessionRef: firstResult.nativeSessionRef,
					}),
				)
			).result,
		).toEqual({ outcome: "accepted", status: "running" });
	});

	it("keeps duplicate and busy submit outcomes from starting another native Turn", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await CodexRuntimeDriver.open({
			path: join(directory, "driver.json"),
			bridgeOptions: {
				model: "gpt-5.3-codex",
				reasoningEffort: "high",
				provenance: CODEX_APP_SERVER_V2_PROVENANCE,
			},
			openBridge: async () => bridge,
		});
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		expect(await driver.execute(command)).toEqual(accepted);
		const busy = await driver.execute(
			submitCommand({
				operationId: "execution-codex-next",
				executionId: "execution-codex-next",
				turnId: "turn-codex-next",
				nativeSessionRef: accepted.nativeSessionRef,
			}),
		);

		expect(busy.result).toEqual({ outcome: "busy" });
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("keeps an unconfirmed native Turn unknown without retrying it", async () => {
		const directory = await runtimeDirectory();
		const command = submitCommand();
		const interruptedBridge = new TestCodexBridge(
			"codex-native-thread-private",
			"codex-native-turn-private",
			true,
		);
		const interruptedDriver = await CodexRuntimeDriver.open({
			path: join(directory, "driver.json"),
			bridgeOptions: {
				model: "gpt-5.3-codex",
				reasoningEffort: "high",
				provenance: CODEX_APP_SERVER_V2_PROVENANCE,
			},
			openBridge: async () => interruptedBridge,
		});
		drivers.push(interruptedDriver);

		await expect(interruptedDriver.execute(command)).rejects.toMatchObject({
			code: "RUNTIME_CODEX_UNAVAILABLE",
		});
		expect(
			interruptedBridge.requests.filter(
				({ method }) => method === "turn/start",
			),
		).toHaveLength(1);

		const recoveredBridge = new TestCodexBridge();
		const recoveredDriver = await CodexRuntimeDriver.open({
			path: join(directory, "driver.json"),
			bridgeOptions: {
				model: "gpt-5.3-codex",
				reasoningEffort: "high",
				provenance: CODEX_APP_SERVER_V2_PROVENANCE,
			},
			openBridge: async () => recoveredBridge,
		});
		drivers.push(recoveredDriver);

		expect(await recoveredDriver.lookupOperation(command)).toEqual({
			state: "unknown",
		});
		expect((await recoveredDriver.execute(command)).result).toEqual({
			outcome: "unknown",
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			message: "Runtime command acceptance could not be confirmed",
		});
		expect(
			recoveredBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);
	});

	it("fails closed for events and app-server notifications until #344 owns recovery", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await CodexRuntimeDriver.open({
			path: join(directory, "driver.json"),
			bridgeOptions: {
				model: "gpt-5.3-codex",
				reasoningEffort: "high",
				provenance: CODEX_APP_SERVER_V2_PROVENANCE,
			},
			openBridge: async () => bridge,
		});
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		await expect(
			driver.replayEvents(accepted.nativeSessionRef, command.executionId),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		await expect(
			driver.subscribeEvents(accepted.nativeSessionRef, command.executionId),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });

		bridge.emitNotification();
		await vi.waitFor(async () => {
			await expect(
				driver.getStatus(accepted.nativeSessionRef, command.executionId),
			).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		});
	});

	it.each([
		[
			"schema version",
			{
				schemaVersion: 2,
				sessions: {},
				operations: {},
			},
		],
		[
			"Session shape",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session": {
						nativeSessionRef: "opaque-session",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						threadId: "codex-native-thread-private",
						executions: [],
					},
				},
				operations: {},
			},
		],
		[
			"execution shape",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session": {
						nativeSessionRef: "opaque-session",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						threadId: "codex-native-thread-private",
						activeExecutionId: "execution-codex",
						executions: {
							"execution-codex": {
								executionId: "execution-codex",
								turnId: "turn-codex",
								nativeTurnId: "codex-native-turn-private",
								status: "idle",
							},
						},
					},
				},
				operations: {},
			},
		],
	] as const)(
		"fails closed without replacing corrupted durable %s",
		async (_name, state) => {
			const directory = await runtimeDirectory();
			const path = join(directory, "driver.json");
			const contents = JSON.stringify(state);
			await writeFile(path, contents);
			const bridge = new TestCodexBridge();

			await expect(
				CodexRuntimeDriver.open({
					path,
					bridgeOptions: {
						model: "gpt-5.3-codex",
						reasoningEffort: "high",
						provenance: CODEX_APP_SERVER_V2_PROVENANCE,
					},
					openBridge: async () => bridge,
				}),
			).rejects.toMatchObject({ code: "RUNTIME_CODEX_STATE_INVALID" });
			expect(bridge.requests).toEqual([]);
			expect(await readFile(path, "utf8")).toBe(contents);
		},
	);

	it.each(["error", "missing-result"] as const)(
		"fails all pending requests for a malformed turns-list %s response",
		async (kind) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			const driver = await CodexRuntimeDriver.open({
				path: join(directory, "driver.json"),
				bridgeOptions: {
					model: "gpt-5.3-codex",
					reasoningEffort: "high",
					provenance: CODEX_APP_SERVER_V2_PROVENANCE,
				},
				openBridge: async () => bridge,
			});
			drivers.push(driver);
			const command = submitCommand();
			const accepted = await driver.execute(command);
			bridge.holdTurnsList();
			const first = driver.getStatus(
				accepted.nativeSessionRef,
				command.executionId,
			);
			const second = driver.getStatus(
				accepted.nativeSessionRef,
				command.executionId,
			);

			await vi.waitFor(() => {
				expect(bridge.pendingTurnsListCount()).toBe(2);
			});
			bridge.respondToHeldTurnsList(kind);
			await expect(first).rejects.toMatchObject({
				code: "RUNTIME_CODEX_PROTOCOL_INVALID",
			});
			await expect(second).rejects.toMatchObject({
				code: "RUNTIME_CODEX_PROTOCOL_INVALID",
			});
		},
	);
});
