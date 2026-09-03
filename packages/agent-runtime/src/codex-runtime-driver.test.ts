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
import type { CodexRuntimeDriver } from "./codex-runtime-driver.js";
import { openCodexRuntimeDriverForTest } from "./codex-runtime-driver.test-support.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import {
	ingressVerifiedRuntimeHost,
	runtimeGrantFixture,
} from "./grant-fixture.test-support.js";
import { RuntimeHost } from "./runtime-host.js";

const directories: string[] = [];
const drivers: CodexRuntimeDriver[] = [];

type CodexTurnStatus = "inProgress" | "completed" | "failed" | "interrupted";

interface TestTurnsListPage {
	data: { id: string; status: CodexTurnStatus }[];
	nextCursor?: string | null;
}

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

function driverOptions(path: string) {
	return {
		path,
		model: "gpt-5.3-codex",
		reasoningEffort: "high",
	};
}

function openDriver(
	path: string,
	bridge: TestCodexBridge,
	onOpen?: (options: CodexAppServerBridgeOptions) => void,
) {
	return openCodexRuntimeDriverForTest(driverOptions(path), async (options) => {
		onOpen?.(options);
		return bridge;
	});
}

class TestCodexBridge {
	readonly requests: { method: string; params: unknown }[] = [];

	private readonly queuedFrames: CodexAppServerFrame[] = [];
	private readonly heldTurnsListRequestIds: number[] = [];
	private wake?: () => void;
	private closed = false;
	private turnStatus: CodexTurnStatus = "inProgress";
	private holdTurnsListResponses = false;
	private turnsListPages?: TestTurnsListPage[];
	private turnStartCount = 0;
	private duplicateNextNativeTurnId = false;

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
			const nativeTurnId = this.nextNativeTurnId();
			this.respond(id, {
				turn: { id: nativeTurnId, status: "inProgress" },
			});
			return;
		}
		throw new Error(`Unexpected Codex JSON-RPC method: ${method}`);
	}

	setTurnStatus(status: CodexTurnStatus) {
		this.turnStatus = status;
	}

	setTurnsListPages(pages: TestTurnsListPage[]) {
		this.turnsListPages = structuredClone(pages);
	}

	duplicateNextTurnResponse() {
		this.duplicateNextNativeTurnId = true;
	}

	continueAfterPersistedTurn() {
		this.turnStartCount = 1;
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

	respondToHeldTurnsListWithStatus(status: CodexTurnStatus, index = 0) {
		const id = this.heldTurnsListRequestIds.splice(index, 1)[0];
		if (id === undefined) throw new Error("No held turns-list request");
		this.respondTurnsListPage(id, {
			data: [{ id: this.nativeTurnId, status }],
		});
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
		const page = this.turnsListPages?.shift() ?? {
			data: [{ id: this.nativeTurnId, status: this.turnStatus }],
		};
		this.respondTurnsListPage(id, page);
	}

	private respondTurnsListPage(id: number, page: TestTurnsListPage) {
		this.respond(id, {
			data: page.data.map((turn) => ({ ...turn, items: [] })),
			...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
		});
	}

	private nextNativeTurnId() {
		const nativeTurnId = this.duplicateNextNativeTurnId
			? this.nativeTurnId
			: this.turnStartCount === 0
				? this.nativeTurnId
				: `${this.nativeTurnId}-${this.turnStartCount + 1}`;
		this.duplicateNextNativeTurnId = false;
		this.turnStartCount += 1;
		return nativeTurnId;
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
		const driver = await openDriver(
			join(directory, "driver.json"),
			bridge,
			(options) => {
				openedWith = options;
			},
		);
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
			limit: 100,
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
		const firstDriver = await openDriver(
			join(directory, "driver.json"),
			firstBridge,
		);
		drivers.push(firstDriver);
		const command = submitCommand();
		const firstResult = await firstDriver.execute(command);
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(firstBridge.nativeThreadId);
		resumedBridge.setTurnStatus("completed");
		const resumedDriver = await openDriver(
			join(directory, "driver.json"),
			resumedBridge,
		);
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
			limit: 100,
		});
		resumedBridge.continueAfterPersistedTurn();
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
		const driver = await openDriver(join(directory, "driver.json"), bridge);
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

	it("rejects a duplicate native thread response across Sessions", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		await driver.execute(submitCommand());

		await expect(
			driver.execute(
				submitCommand({
					conversationId: "conversation-codex-other",
					operationId: "execution-codex-other",
					executionId: "execution-codex-other",
					turnId: "turn-codex-other",
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_PROTOCOL_INVALID" });
		expect(
			bridge.requests.filter(({ method }) => method === "thread/start"),
		).toHaveLength(2);
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("rejects a duplicate native Turn response in one Session", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const first = await driver.execute(submitCommand());
		bridge.setTurnStatus("completed");
		await driver.getStatus(first.nativeSessionRef, "execution-codex");
		bridge.duplicateNextTurnResponse();

		await expect(
			driver.execute(
				submitCommand({
					operationId: "execution-codex-duplicate-turn",
					executionId: "execution-codex-duplicate-turn",
					turnId: "turn-codex-duplicate-turn",
					nativeSessionRef: first.nativeSessionRef,
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_PROTOCOL_INVALID" });
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(2);
	});

	it("reuses an active Session for a ref-less submit retry", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		await driver.execute(submitCommand());

		expect(
			(
				await driver.execute(
					submitCommand({
						operationId: "execution-codex-ref-less-retry",
						executionId: "execution-codex-ref-less-retry",
						turnId: "turn-codex-ref-less-retry",
					}),
				)
			).result,
		).toEqual({ outcome: "busy" });
		expect(
			bridge.requests.filter(({ method }) => method === "thread/start"),
		).toHaveLength(1);
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("fails closed for a ref-less submit with multiple matching Sessions", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				sessions: {
					"opaque-session-one": {
						nativeSessionRef: "opaque-session-one",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						threadId: "codex-native-thread-one",
						executions: {},
					},
					"opaque-session-two": {
						nativeSessionRef: "opaque-session-two",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						threadId: "codex-native-thread-two",
						executions: {},
					},
				},
				operations: {},
			}),
		);
		const bridge = new TestCodexBridge();
		const driver = await openDriver(path, bridge);
		drivers.push(driver);

		await expect(driver.execute(submitCommand())).rejects.toMatchObject({
			code: "RUNTIME_CODEX_STATE_INVALID",
		});
		expect(
			bridge.requests.filter(({ method }) => method === "thread/start"),
		).toHaveLength(0);
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);
	});

	it("keeps an unconfirmed native Turn unknown without retrying it", async () => {
		const directory = await runtimeDirectory();
		const command = submitCommand();
		const interruptedBridge = new TestCodexBridge(
			"codex-native-thread-private",
			"codex-native-turn-private",
			true,
		);
		const interruptedDriver = await openDriver(
			join(directory, "driver.json"),
			interruptedBridge,
		);
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
		const recoveredDriver = await openDriver(
			join(directory, "driver.json"),
			recoveredBridge,
		);
		drivers.push(recoveredDriver);

		expect(await recoveredDriver.lookupOperation(command)).toEqual({
			state: "unknown",
		});
		const unknown = await recoveredDriver.execute(command);
		expect(unknown.result).toEqual({
			outcome: "unknown",
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			message: "Runtime command acceptance could not be confirmed",
		});
		await expect(
			recoveredDriver.execute(
				submitCommand({
					operationId: "execution-codex-after-unknown",
					executionId: "execution-codex-after-unknown",
					turnId: "turn-codex-after-unknown",
					nativeSessionRef: unknown.nativeSessionRef,
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		await expect(
			recoveredDriver.execute(
				submitCommand({
					operationId: "execution-codex-replacement-after-unknown",
					executionId: "execution-codex-replacement-after-unknown",
					turnId: "turn-codex-replacement-after-unknown",
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		expect(
			recoveredBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);
		expect(
			recoveredBridge.requests.filter(
				({ method }) => method === "thread/start",
			),
		).toHaveLength(0);
	});

	it("keeps terminal status sticky across out-of-order status reads", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		bridge.holdTurnsList();
		const firstStatus = driver.getStatus(
			accepted.nativeSessionRef,
			command.executionId,
		);
		const secondStatus = driver.getStatus(
			accepted.nativeSessionRef,
			command.executionId,
		);

		await vi.waitFor(() => {
			expect(bridge.pendingTurnsListCount()).toBe(2);
		});
		bridge.respondToHeldTurnsListWithStatus("completed", 1);
		expect(await secondStatus).toBe("completed");
		bridge.respondToHeldTurnsListWithStatus("inProgress");
		expect(await firstStatus).toBe("completed");
		expect(
			(
				await driver.execute(
					submitCommand({
						operationId: "execution-codex-after-terminal",
						executionId: "execution-codex-after-terminal",
						turnId: "turn-codex-after-terminal",
						nativeSessionRef: accepted.nativeSessionRef,
					}),
				)
			).result,
		).toEqual({ outcome: "accepted", status: "running" });
	});

	it("paginates to the requested historical native Turn status", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		bridge.setTurnsListPages([
			{
				data: [
					{
						id: "codex-native-later-turn-private",
						status: "completed",
					},
				],
				nextCursor: "next-turn-page-private",
			},
			{
				data: [{ id: bridge.nativeTurnId, status: "completed" }],
				nextCursor: null,
			},
		]);

		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("completed");
		const turnsListRequests = bridge.requests.filter(
			({ method }) => method === "thread/turns/list",
		);
		expect(turnsListRequests).toHaveLength(2);
		expect(turnsListRequests[0]?.params).toEqual({
			threadId: bridge.nativeThreadId,
			itemsView: "notLoaded",
			limit: 100,
		});
		expect(turnsListRequests[1]?.params).toEqual({
			threadId: bridge.nativeThreadId,
			itemsView: "notLoaded",
			limit: 100,
			cursor: "next-turn-page-private",
		});
	});

	it("fails closed for events and app-server notifications until #344 owns recovery", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
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
		[
			"unbacked active execution",
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
								status: "running",
							},
						},
					},
				},
				operations: {},
			},
		],
		[
			"duplicate native thread",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session-one": {
						nativeSessionRef: "opaque-session-one",
						agentId: "agent-codex-one",
						conversationId: "conversation-codex-one",
						sessionGeneration: 1,
						threadId: "codex-native-thread-duplicate",
						executions: {},
					},
					"opaque-session-two": {
						nativeSessionRef: "opaque-session-two",
						agentId: "agent-codex-two",
						conversationId: "conversation-codex-two",
						sessionGeneration: 1,
						threadId: "codex-native-thread-duplicate",
						executions: {},
					},
				},
				operations: {},
			},
		],
		[
			"duplicate native Turn",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session": {
						nativeSessionRef: "opaque-session",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						threadId: "codex-native-thread-private",
						activeExecutionId: "execution-codex-running",
						executions: {
							"execution-codex-completed": {
								executionId: "execution-codex-completed",
								turnId: "turn-codex-completed",
								nativeTurnId: "codex-native-turn-duplicate",
								status: "completed",
							},
							"execution-codex-running": {
								executionId: "execution-codex-running",
								turnId: "turn-codex-running",
								nativeTurnId: "codex-native-turn-duplicate",
								status: "running",
							},
						},
					},
				},
				operations: {
					'["agent-codex","conversation-codex",1,"submit-turn","execution-codex-completed"]':
						{
							state: "resolved",
							nativeSessionRef: "opaque-session",
							record: {
								schemaVersion: 1,
								agentId: "agent-codex",
								conversationId: "conversation-codex",
								sessionGeneration: 1,
								kind: "submit-turn",
								operationId: "execution-codex-completed",
								nativeSessionRef: "opaque-session",
								result: { outcome: "accepted", status: "completed" },
							},
						},
					'["agent-codex","conversation-codex",1,"submit-turn","execution-codex-running"]':
						{
							state: "resolved",
							nativeSessionRef: "opaque-session",
							record: {
								schemaVersion: 1,
								agentId: "agent-codex",
								conversationId: "conversation-codex",
								sessionGeneration: 1,
								kind: "submit-turn",
								operationId: "execution-codex-running",
								nativeSessionRef: "opaque-session",
								result: { outcome: "accepted", status: "running" },
							},
						},
				},
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

			await expect(openDriver(path, bridge)).rejects.toMatchObject({
				code: "RUNTIME_CODEX_STATE_INVALID",
			});
			expect(bridge.requests).toEqual([]);
			expect(await readFile(path, "utf8")).toBe(contents);
		},
	);

	it.each(["error", "missing-result"] as const)(
		"fails all pending requests for a malformed turns-list %s response",
		async (kind) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			const driver = await openDriver(join(directory, "driver.json"), bridge);
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
