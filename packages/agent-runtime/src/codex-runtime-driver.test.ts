import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	RuntimeDriverCommandV1,
	RuntimeGenerationCancelRequestV1,
	RuntimeStopRequestV1,
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

interface TestItemsListPage {
	data: {
		turnId: string;
		item: { id: string; type: string; text?: string };
	}[];
	nextCursor?: string | null;
}

interface StoredEventJournal {
	events: Record<string, unknown>[];
}

interface StoredCodexSession {
	eventSequence?: number;
	journals?: Record<string, StoredEventJournal>;
}

interface StoredCodexDriverState {
	sessions: Record<string, StoredCodexSession>;
}

// Narrow fixtures copied from the generated schema pinned by the Bridge provenance.
const pinnedV2EventRecoveryFrames = {
	threadStarted: {
		method: "turn/started",
		params: {
			threadId: "codex-native-thread-private",
			turn: {
				id: "codex-native-turn-private",
				status: "inProgress",
				items: [],
			},
		},
	},
	agentMessageDelta: {
		method: "item/agentMessage/delta",
		params: {
			threadId: "codex-native-thread-private",
			turnId: "codex-native-turn-private",
			itemId: "codex-native-item-private",
			delta: "schema-delta",
		},
	},
	turnCompleted: {
		method: "turn/completed",
		params: {
			threadId: "codex-native-thread-private",
			turn: {
				id: "codex-native-turn-private",
				status: "completed",
				items: [],
			},
		},
	},
	threadItemsListRequest: {
		threadId: "codex-native-thread-private",
		turnId: "codex-native-turn-private",
		limit: 100,
		sortDirection: "asc",
	},
	threadItemsListResponse: {
		data: [
			{
				turnId: "codex-native-turn-private",
				item: {
					id: "codex-native-item-private",
					type: "agentMessage",
					text: "schema-history",
				},
			},
		],
		nextCursor: null,
	},
};

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

function stopCommand(
	nativeSessionRef: string,
): Extract<RuntimeDriverCommandV1, { kind: "stop" }> {
	return {
		schemaVersion: 1,
		kind: "stop",
		operationId: "stop-codex",
		agentId: "agent-codex",
		conversationId: "conversation-codex",
		executionId: "execution-codex",
		turnId: "turn-codex",
		sessionGeneration: 1,
		nativeSessionRef,
	};
}

function stopRequest(
	request: RuntimeSubmitTurnRequestV1,
	hostSessionRef: string,
	overrides: Partial<RuntimeStopRequestV1> = {},
): RuntimeStopRequestV1 {
	const binding = {
		agentId: request.agentId,
		actorId: request.actorId,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
	};
	return {
		schemaVersion: 1,
		requestId: "request-codex-stop",
		...binding,
		deliveryFence: 1,
		executionDeliveryFence: 1,
		hostSessionRef,
		stopRequestId: "stop-codex",
		grant: runtimeGrantFixture(binding, ["turn.stop"]),
		...overrides,
	};
}

function generationCancelRequest(
	request: RuntimeSubmitTurnRequestV1,
	hostSessionRef: string,
	overrides: Partial<RuntimeGenerationCancelRequestV1> = {},
): RuntimeGenerationCancelRequestV1 {
	const binding = {
		agentId: request.agentId,
		actorId: request.actorId,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
	};
	return {
		schemaVersion: 1,
		requestId: "request-codex-generation-cancel",
		...binding,
		deliveryFence: 1,
		hostSessionRef,
		tombstoneId: "generation-codex",
		grant: runtimeGrantFixture(binding, ["generation.cancel"]),
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

function configReadResult(
	overrides: {
		config?: Record<string, unknown>;
		origins?: Record<string, unknown>;
	} = {},
) {
	return {
		config: {
			model: "gpt-5.3-codex",
			model_reasoning_effort: "high",
			mcp_servers: {},
			plugins: {},
			marketplaces: {},
			features: { plugins: false },
			...overrides.config,
		},
		origins: {
			model: { name: { type: "sessionFlags" }, version: "1" },
			model_reasoning_effort: { name: { type: "sessionFlags" }, version: "1" },
			"features.plugins": {
				name: { type: "sessionFlags" },
				version: "1",
			},
			...overrides.origins,
		},
	};
}

class TestCodexBridge {
	readonly requests: { method: string; params: unknown }[] = [];
	readonly responses: CodexAppServerFrame[] = [];

	private readonly queuedFrames: CodexAppServerFrame[] = [];
	private readonly heldTurnsListRequestIds: number[] = [];
	private readonly heldTurnStartRequestIds: number[] = [];
	private wake?: () => void;
	private notificationRead?: () => void;
	private closed = false;
	private turnStatus: CodexTurnStatus = "inProgress";
	private holdTurnStartResponses = false;
	private holdTurnsListResponses = false;
	private holdTurnsListSend = false;
	private turnsListPages?: TestTurnsListPage[];
	private itemsListPages?: TestItemsListPage[];
	private turnStartCount = 0;
	private duplicateNextNativeTurnId = false;
	private dropThreadStartResponse = false;
	private dropThreadResumeResponse = false;
	private dropInterruptResponse = false;
	private interruptTerminalStatus?: Exclude<CodexTurnStatus, "inProgress">;
	private configReadResult: Record<string, unknown> = configReadResult();

	constructor(
		readonly nativeThreadId = "codex-native-thread-private",
		readonly nativeTurnId = "codex-native-turn-private",
		private readonly closeOnTurnStart = false,
	) {}

	async send(frame: CodexAppServerFrame) {
		const { id, method, params } = frame;
		if (
			(typeof id === "string" ||
				(typeof id === "number" && Number.isSafeInteger(id))) &&
			!("method" in frame) &&
			"error" in frame
		) {
			this.responses.push(frame);
			return;
		}
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
		if (method === "config/read") {
			this.respond(id, this.configReadResult);
			return;
		}
		if (method === "thread/start") {
			if (this.dropThreadStartResponse) {
				await this.close();
				return;
			}
			this.respond(id, { thread: { id: this.nativeThreadId } });
			return;
		}
		if (method === "thread/resume") {
			if (this.dropThreadResumeResponse) {
				await this.close();
				return;
			}
			this.respond(id, { thread: { id: this.nativeThreadId } });
			return;
		}
		if (method === "thread/turns/list") {
			if (this.holdTurnsListSend) return new Promise<void>(() => {});
			if (this.holdTurnsListResponses) {
				this.heldTurnsListRequestIds.push(id);
				return;
			}
			this.respondTurnsList(id);
			return;
		}
		if (method === "thread/items/list") {
			this.respondItemsList(id);
			return;
		}
		if (method === "turn/start") {
			if (this.closeOnTurnStart) {
				await this.close();
				return;
			}
			if (this.holdTurnStartResponses) {
				this.heldTurnStartRequestIds.push(id);
				return;
			}
			const nativeTurnId = this.nextNativeTurnId();
			this.respond(id, {
				turn: { id: nativeTurnId, status: "inProgress" },
			});
			return;
		}
		if (method === "turn/interrupt") {
			if (this.interruptTerminalStatus) {
				this.turnStatus = this.interruptTerminalStatus;
			}
			if (this.dropInterruptResponse) {
				this.dropInterruptResponse = false;
				await this.close();
				return;
			}
			this.respond(id, {});
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

	setConfigReadResult(result: Record<string, unknown>) {
		this.configReadResult = structuredClone(result);
	}

	setItemsListPages(pages: TestItemsListPage[]) {
		this.itemsListPages = structuredClone(pages);
	}

	duplicateNextTurnResponse() {
		this.duplicateNextNativeTurnId = true;
	}

	continueAfterPersistedTurn() {
		this.turnStartCount = 1;
	}

	dropNextThreadStartResponse() {
		this.dropThreadStartResponse = true;
	}

	dropNextThreadResumeResponse() {
		this.dropThreadResumeResponse = true;
	}

	dropNextInterruptResponse() {
		this.dropInterruptResponse = true;
	}

	completeOnInterrupt(status: Exclude<CodexTurnStatus, "inProgress">) {
		this.interruptTerminalStatus = status;
	}

	holdTurnsList() {
		this.holdTurnsListResponses = true;
	}

	holdTurnStart() {
		this.holdTurnStartResponses = true;
	}

	pendingTurnStartCount() {
		return this.heldTurnStartRequestIds.length;
	}

	respondToHeldTurnStart(status: CodexTurnStatus = "inProgress") {
		const id = this.heldTurnStartRequestIds.shift();
		if (id === undefined) throw new Error("No held turn-start request");
		this.respond(id, {
			turn: { id: this.nextNativeTurnId(), status },
		});
	}

	holdTurnsListRequestSend() {
		this.holdTurnsListSend = true;
	}

	pendingTurnsListCount() {
		return this.heldTurnsListRequestIds.length;
	}

	isClosed() {
		return this.closed;
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

	respondToHeldTurnsListWithInvalidData(index = 0) {
		const id = this.heldTurnsListRequestIds.splice(index, 1)[0];
		if (id === undefined) throw new Error("No held turns-list request");
		this.respond(id, { data: "invalid" });
	}

	emitNotification(status: CodexTurnStatus = "inProgress") {
		return new Promise<void>((resolve) => {
			this.notificationRead = resolve;
			this.push({
				method: "turn/started",
				params: {
					threadId: this.nativeThreadId,
					turn: {
						id: this.nativeTurnId,
						status,
						items: [],
					},
				},
			});
		});
	}

	emitServerRequest(method: string, params: Record<string, unknown>) {
		this.push({
			id: "native-tool-request-private",
			method,
			params,
		});
	}

	emitAgentMessageDelta(delta: string) {
		return new Promise<void>((resolve) => {
			this.notificationRead = resolve;
			this.push({
				method: "item/agentMessage/delta",
				params: {
					threadId: this.nativeThreadId,
					turnId: this.nativeTurnId,
					itemId: "codex-native-item-private",
					delta,
				},
			});
		});
	}

	emitTurnCompleted(status: Exclude<CodexTurnStatus, "inProgress">) {
		return new Promise<void>((resolve) => {
			this.notificationRead = resolve;
			this.push({
				method: "turn/completed",
				params: {
					threadId: this.nativeThreadId,
					turn: {
						id: this.nativeTurnId,
						status,
						items: [],
					},
				},
			});
		});
	}

	emitFrame(frame: CodexAppServerFrame) {
		return new Promise<void>((resolve) => {
			this.notificationRead = resolve;
			this.push(frame);
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

	private respondItemsList(id: number) {
		const page = this.itemsListPages?.shift() ?? { data: [] };
		this.respond(id, {
			data: page.data.map((entry) => structuredClone(entry)),
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
			if (frame) {
				const notificationRead = this.notificationRead;
				this.notificationRead = undefined;
				notificationRead?.();
				return frame;
			}
			if (this.closed) return undefined;
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}
}

afterEach(async () => {
	vi.useRealTimers();
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
			"config/read",
			"thread/start",
			"turn/start",
			"thread/turns/list",
		]);
		expect(bridge.requests[1]?.params).toEqual({ includeLayers: false });
		expect(bridge.requests[4]?.params).toEqual({
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

	it("waits for a durable terminal Turn before confirming generation cancellation", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
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
		const submitted = await runtimeHost.submitTurn(request);
		const cancellation = generationCancelRequest(
			request,
			submitted.hostSessionRef,
		);

		expect((await runtimeHost.cancelGeneration(cancellation)).result).toEqual({
			outcome: "accepted",
			status: "running",
		});
		expect(
			bridge.requests.filter(({ method }) => method === "turn/interrupt"),
		).toHaveLength(1);

		bridge.setTurnStatus("interrupted");
		expect(
			(
				await runtimeHost.cancelGeneration({
					...cancellation,
					requestId: "request-codex-generation-cancel-retry",
					deliveryFence: 2,
				})
			).result,
		).toEqual({ outcome: "accepted", status: "cancelled" });
		expect(
			bridge.requests.filter(({ method }) => method === "turn/interrupt"),
		).toHaveLength(1);
	});

	it("fails closed while keeping a generation barrier active for an invalid cancellation retry", async () => {
		const directory = await runtimeDirectory();
		const hostPath = join(directory, "host.json");
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const runtimeHost = ingressVerifiedRuntimeHost(
			await RuntimeHost.open({
				store: await FileRuntimeStore.open(hostPath),
				driver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			}),
		);
		const request = submitRequest();
		const submitted = await runtimeHost.submitTurn(request);
		const cancellation = generationCancelRequest(
			request,
			submitted.hostSessionRef,
		);

		expect((await runtimeHost.cancelGeneration(cancellation)).result).toEqual({
			outcome: "accepted",
			status: "running",
		});
		bridge.holdTurnsList();
		const retry = runtimeHost.cancelGeneration({
			...cancellation,
			requestId: "request-codex-generation-cancel-retry-failure",
			deliveryFence: 2,
		});
		await vi.waitFor(() => expect(bridge.pendingTurnsListCount()).toBe(1));
		bridge.respondToHeldTurnsList("error");

		await expect(retry).rejects.toMatchObject({
			code: "RUNTIME_DRIVER_INVALID",
		});
		const state = JSON.parse(await readFile(hostPath, "utf8")) as {
			sessions: Record<string, { generationBarrier?: { state: string } }>;
		};
		expect(
			state.sessions[submitted.hostSessionRef]?.generationBarrier?.state,
		).toBe("active");
		expect(
			bridge.requests.filter(({ method }) => method === "turn/interrupt"),
		).toHaveLength(1);
	});

	it("recovers the actual completion after an interrupted stop response without replaying it", async () => {
		const directory = await runtimeDirectory();
		const hostPath = join(directory, "host.json");
		const driverPath = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		firstBridge.completeOnInterrupt("completed");
		firstBridge.dropNextInterruptResponse();
		const firstDriver = await openDriver(driverPath, firstBridge);
		drivers.push(firstDriver);
		const firstHost = ingressVerifiedRuntimeHost(
			await RuntimeHost.open({
				store: await FileRuntimeStore.open(hostPath),
				driver: firstDriver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			}),
		);
		const request = submitRequest();
		const submitted = await firstHost.submitTurn(request);
		const stop = stopRequest(request, submitted.hostSessionRef);

		expect((await firstHost.stop(stop)).result).toEqual({
			outcome: "unknown",
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			message: "Runtime command acceptance could not be confirmed",
		});
		expect(
			firstBridge.requests.filter(({ method }) => method === "turn/interrupt"),
		).toHaveLength(1);

		const recoveredBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		const recoveredDriver = await openDriver(driverPath, recoveredBridge);
		drivers.push(recoveredDriver);
		const recoveredHost = ingressVerifiedRuntimeHost(
			await RuntimeHost.open({
				store: await FileRuntimeStore.open(hostPath),
				driver: recoveredDriver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			}),
		);
		recoveredBridge.setTurnStatus("completed");

		expect(
			(
				await recoveredHost.stop({
					...stop,
					requestId: "request-codex-stop-retry",
					deliveryFence: 2,
				})
			).result,
		).toEqual({ outcome: "accepted", status: "completed" });
		expect(
			recoveredBridge.requests.filter(
				({ method }) => method === "turn/interrupt",
			),
		).toHaveLength(0);
	});

	it("coalesces concurrent stop resolution from execution and lookup", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		bridge.completeOnInterrupt("completed");
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const submitted = await driver.execute(submitCommand());
		const command = stopCommand(submitted.nativeSessionRef);

		bridge.holdTurnsList();
		const execution = driver.execute(command);
		await vi.waitFor(() => expect(bridge.pendingTurnsListCount()).toBe(1));
		const lookup = driver.lookupOperation(command);
		await vi.waitFor(() => expect(bridge.pendingTurnsListCount()).toBe(2));

		bridge.respondToHeldTurnsListWithStatus("inProgress", 0);
		await vi.waitFor(() =>
			expect(
				bridge.requests.filter(({ method }) => method === "turn/interrupt"),
			).toHaveLength(1),
		);
		await vi.waitFor(() => expect(bridge.pendingTurnsListCount()).toBe(2));

		bridge.respondToHeldTurnsListWithStatus("completed", 0);
		await expect(lookup).resolves.toMatchObject({
			state: "found",
			record: { result: { outcome: "accepted", status: "completed" } },
		});
		bridge.respondToHeldTurnsListWithStatus("completed");
		await expect(execution).resolves.toMatchObject({
			result: { outcome: "accepted", status: "completed" },
		});
	});

	it("accepts the scalar features.plugins session flag origin", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();

		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);

		expect(bridge.isClosed()).toBe(false);
	});

	it.each([
		[
			"MCP server",
			configReadResult({
				config: { mcp_servers: { inherited: { opaque: "private" } } },
				origins: {
					"mcp_servers.inherited": {
						name: { type: "system" },
						version: "1",
					},
				},
			}),
		],
		[
			"plugin",
			configReadResult({
				config: { plugins: { inherited: { opaque: "private" } } },
				origins: {
					"plugins.inherited": {
						name: { type: "enterpriseManaged" },
						version: "1",
					},
				},
			}),
		],
		[
			"plugin marketplace",
			configReadResult({
				config: { marketplaces: { inherited: { opaque: "private" } } },
			}),
		],
		[
			"plugin feature",
			configReadResult({ config: { features: { plugins: true } } }),
		],
		[
			"model override",
			configReadResult({ config: { model: "unapproved-model" } }),
		],
		[
			"non-session origin",
			configReadResult({
				origins: {
					model: { name: { type: "mdm" }, version: "1" },
				},
			}),
		],
	] as const)(
		"fails closed for an inherited %s configuration without persisting it",
		async (_name, configuration) => {
			const directory = await runtimeDirectory();
			const path = join(directory, "driver.json");
			const bridge = new TestCodexBridge();
			bridge.setConfigReadResult(configuration);

			const error = await openDriver(path, bridge).catch(
				(value: unknown) => value,
			);
			expect(error).toMatchObject({
				code: "RUNTIME_CODEX_CONFIGURATION_INVALID",
				message: "Codex Runtime configuration is unavailable",
			});
			expect(JSON.stringify(error)).not.toContain("private");
			expect(bridge.requests).toEqual([
				{
					method: "initialize",
					params: { clientInfo: { name: "agent-infra-runtime", version: "1" } },
				},
				{ method: "config/read", params: { includeLayers: false } },
			]);
			expect(await readFile(path, "utf8")).not.toContain("private");
			expect(bridge.isClosed()).toBe(true);
		},
	);

	it.each(["model", "model_reasoning_effort", "features.plugins"] as const)(
		"fails closed when the required %s configuration origin is absent",
		async (originKey) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			const configuration = configReadResult();
			delete configuration.origins[originKey];
			bridge.setConfigReadResult(configuration);

			await expect(
				openDriver(join(directory, "driver.json"), bridge),
			).rejects.toMatchObject({
				code: "RUNTIME_CODEX_CONFIGURATION_INVALID",
			});
			expect(bridge.isClosed()).toBe(true);
		},
	);

	it.each(["model", "model_reasoning_effort", "features.plugins"] as const)(
		"fails closed when the required %s configuration origin is not a session flag",
		async (originKey) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			bridge.setConfigReadResult(
				configReadResult({
					origins: {
						[originKey]: { name: { type: "system" }, version: "1" },
					},
				}),
			);

			await expect(
				openDriver(join(directory, "driver.json"), bridge),
			).rejects.toMatchObject({
				code: "RUNTIME_CODEX_CONFIGURATION_INVALID",
			});
			expect(bridge.isClosed()).toBe(true);
		},
	);

	it.each([
		["missing config", { origins: {} }, "RUNTIME_CODEX_PROTOCOL_INVALID"],
		[
			"unexpected layers",
			{ ...configReadResult(), layers: [] },
			"RUNTIME_CODEX_PROTOCOL_INVALID",
		],
		[
			"malformed origin",
			configReadResult({
				origins: { model: { name: "invalid", version: "1" } },
			}),
			"RUNTIME_CODEX_PROTOCOL_INVALID",
		],
	] as const)(
		"fails closed for a pinned config/read response with %s",
		async (_name, configuration, code) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			bridge.setConfigReadResult(configuration);

			await expect(
				openDriver(join(directory, "driver.json"), bridge),
			).rejects.toMatchObject({ code });
			expect(bridge.isClosed()).toBe(true);
		},
	);

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
			"config/read",
			"thread/resume",
			"thread/turns/list",
		]);
		expect(resumedBridge.requests[2]?.params).toEqual({
			threadId: firstBridge.nativeThreadId,
			excludeTurns: true,
		});
		expect(resumedBridge.requests[3]?.params).toEqual({
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

	it("persists a turn-start notification that races the Turn binding and replays it once", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		bridge.holdTurnStart();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const submitted = driver.execute(command);

		await vi.waitFor(() => {
			expect(bridge.pendingTurnStartCount()).toBe(1);
		});
		const notification = bridge.emitNotification();
		bridge.respondToHeldTurnStart();
		const accepted = await submitted;
		await notification;

		const events = await driver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		expect(events).toEqual([
			expect.objectContaining({
				executionId: command.executionId,
				type: "status",
				payload: { status: "running" },
			}),
		]);
		expect(JSON.stringify(events)).not.toContain(bridge.nativeThreadId);
		expect(JSON.stringify(events)).not.toContain(bridge.nativeTurnId);
	});

	it("binds a terminal notification that races the Turn response as terminal", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		bridge.holdTurnStart();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const submitted = driver.execute(command);

		await vi.waitFor(() => {
			expect(bridge.pendingTurnStartCount()).toBe(1);
		});
		const notification = bridge.emitTurnCompleted("completed");
		bridge.respondToHeldTurnStart();
		const accepted = await submitted;
		await notification;

		expect(accepted.result).toEqual({
			outcome: "accepted",
			status: "completed",
		});
		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("completed");
		expect(
			await driver.replayEvents(accepted.nativeSessionRef, command.executionId),
		).toEqual([
			expect.objectContaining({
				type: "completed",
				payload: { status: "completed" },
			}),
		]);
	});

	it("preserves started and delta order when a terminal start response races them", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		bridge.holdTurnStart();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const submitted = driver.execute(command);

		await vi.waitFor(() => {
			expect(bridge.pendingTurnStartCount()).toBe(1);
		});
		await bridge.emitNotification();
		await bridge.emitAgentMessageDelta("before-terminal-response");
		bridge.respondToHeldTurnStart("completed");
		const accepted = await submitted;

		expect(accepted.result).toEqual({
			outcome: "accepted",
			status: "completed",
		});
		expect(
			await driver.replayEvents(accepted.nativeSessionRef, command.executionId),
		).toEqual([
			expect.objectContaining({
				type: "status",
				payload: { status: "running" },
			}),
			expect.objectContaining({
				type: "text",
				payload: { delta: "before-terminal-response" },
			}),
			expect.objectContaining({
				type: "completed",
				payload: { status: "completed" },
			}),
		]);
	});

	it("accepts the pinned v2 event recovery wire shapes", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const bridge = new TestCodexBridge();
		const driver = await openDriver(path, bridge, (options) => {
			expect(options.provenance).toEqual(CODEX_APP_SERVER_V2_PROVENANCE);
		});
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		await bridge.emitFrame(pinnedV2EventRecoveryFrames.threadStarted);
		await bridge.emitFrame(pinnedV2EventRecoveryFrames.agentMessageDelta);
		await bridge.emitFrame(pinnedV2EventRecoveryFrames.turnCompleted);
		const events = await vi.waitFor(async () => {
			const replayed = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(replayed).toHaveLength(3);
			return replayed;
		});
		expect(events.map((event) => event.type)).toEqual([
			"status",
			"text",
			"completed",
		]);
	});

	it("restores the pinned v2 thread-items-list response", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge();
		resumedBridge.setItemsListPages([
			structuredClone(pinnedV2EventRecoveryFrames.threadItemsListResponse),
		]);
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);
		const events = await resumedDriver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		expect(events).toEqual([
			expect.objectContaining({
				type: "status",
				payload: { status: "running" },
			}),
			expect.objectContaining({
				type: "text",
				payload: { delta: "schema-history" },
			}),
		]);
		expect(
			resumedBridge.requests.find(
				({ method }) => method === "thread/items/list",
			),
		).toEqual({
			method: "thread/items/list",
			params: pinnedV2EventRecoveryFrames.threadItemsListRequest,
		});
	});

	it("keeps equal native delta occurrences distinct with stable local cursors", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		await bridge.emitAgentMessageDelta("same-delta");
		await vi.waitFor(async () => {
			expect(
				(
					await driver.replayEvents(
						accepted.nativeSessionRef,
						command.executionId,
					)
				).filter((event) => event.type === "text"),
			).toHaveLength(1);
		});
		await bridge.emitAgentMessageDelta("same-delta");
		const textEvents = await vi.waitFor(async () => {
			const events = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			const text = events.filter((event) => event.type === "text");
			expect(text).toHaveLength(2);
			return text;
		});

		expect(textEvents).toEqual([
			expect.objectContaining({ payload: { delta: "same-delta" } }),
			expect.objectContaining({ payload: { delta: "same-delta" } }),
		]);
		expect(textEvents[0]?.cursor).not.toBe(textEvents[1]?.cursor);
		expect(textEvents[0]?.adapterEventKey).not.toBe(
			textEvents[1]?.adapterEventKey,
		);
		expect(JSON.stringify(textEvents)).not.toContain(
			"codex-native-item-private",
		);
	});

	it("streams existing and later persisted journal events once", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const abort = new AbortController();
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
			undefined,
			abort.signal,
		);
		const iterator = stream[Symbol.asyncIterator]();

		expect(await iterator.next()).toMatchObject({
			done: false,
			value: {
				executionId: command.executionId,
				type: "status",
				payload: { status: "running" },
			},
		});
		const next = iterator.next();
		await bridge.emitAgentMessageDelta("later-delta");
		expect(await next).toMatchObject({
			done: false,
			value: {
				executionId: command.executionId,
				type: "text",
				payload: { delta: "later-delta" },
			},
		});
		abort.abort();
		expect(await iterator.next()).toEqual({ done: true, value: undefined });
	});

	it("wakes a live stream when polling persists a terminal status", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const abort = new AbortController();
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
			undefined,
			abort.signal,
		);
		const iterator = stream[Symbol.asyncIterator]();

		try {
			await iterator.next();
			const terminal = iterator.next();
			bridge.setTurnStatus("completed");
			expect(
				await driver.getStatus(accepted.nativeSessionRef, command.executionId),
			).toBe("completed");
			expect(
				await Promise.race([
					terminal,
					new Promise((resolve) => {
						setTimeout(() => resolve("timed out"), 100);
					}),
				]),
			).toMatchObject({
				done: false,
				value: { type: "completed", payload: { status: "completed" } },
			});
		} finally {
			abort.abort();
			await iterator.next();
		}
	});

	it("ends a live stream after its terminal event", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		const iterator = stream[Symbol.asyncIterator]();

		await iterator.next();
		const terminal = iterator.next();
		await bridge.emitTurnCompleted("completed");
		expect(await terminal).toMatchObject({
			done: false,
			value: { type: "completed", payload: { status: "completed" } },
		});
		expect(
			await Promise.race([
				iterator.next(),
				new Promise((resolve) => {
					setTimeout(() => resolve("timed out"), 100);
				}),
			]),
		).toEqual({ done: true, value: undefined });
	});

	it("ends a recovery stream from its terminal cursor", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		await bridge.emitTurnCompleted("completed");
		const terminal = await vi.waitFor(async () => {
			const events = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			const completed = events.find((event) => event.type === "completed");
			expect(completed).toBeDefined();
			return completed;
		});
		if (!terminal) throw new Error("expected a terminal event");
		const abort = new AbortController();
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
			terminal.cursor,
			abort.signal,
		);
		const iterator = stream[Symbol.asyncIterator]();

		try {
			expect(
				await Promise.race([
					iterator.next(),
					new Promise((resolve) => {
						setTimeout(() => resolve("timed out"), 100);
					}),
				]),
			).toEqual({ done: true, value: undefined });
		} finally {
			abort.abort();
			await iterator.next();
		}
	});

	it("fails closed when a delta follows a terminal event", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		const iterator = stream[Symbol.asyncIterator]();

		await iterator.next();
		const terminal = iterator.next();
		await bridge.emitTurnCompleted("completed");
		expect(await terminal).toMatchObject({
			done: false,
			value: { type: "completed", payload: { status: "completed" } },
		});
		await bridge.emitAgentMessageDelta("late-delta");
		await vi.waitFor(() => expect(bridge.isClosed()).toBe(true));
		await expect(
			driver.execute(
				submitCommand({
					operationId: "execution-codex-after-terminal",
					executionId: "execution-codex-after-terminal",
					turnId: "turn-codex-after-terminal",
					nativeSessionRef: accepted.nativeSessionRef,
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
	});

	it("fails closed when a terminal started notification follows a terminal event", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		await bridge.emitTurnCompleted("completed");
		await vi.waitFor(async () => {
			const events = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(events.filter((event) => event.type === "completed")).toHaveLength(
				1,
			);
		});

		await bridge.emitNotification("completed");
		await vi.waitFor(() => expect(bridge.isClosed()).toBe(true));
		await expect(
			driver.execute(
				submitCommand({
					operationId: "execution-codex-after-terminal-started",
					executionId: "execution-codex-after-terminal-started",
					turnId: "turn-codex-after-terminal-started",
					nativeSessionRef: accepted.nativeSessionRef,
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
	});

	it("fails closed for a terminal started notification", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const accepted = await driver.execute(submitCommand());

		await bridge.emitNotification("completed");
		await vi.waitFor(() => expect(bridge.isClosed()).toBe(true));
		await expect(
			driver.execute(
				submitCommand({
					conversationId: "conversation-codex-after-terminal-start",
					operationId: "execution-codex-after-terminal-start",
					executionId: "execution-codex-after-terminal-start",
					turnId: "turn-codex-after-terminal-start",
					nativeSessionRef: accepted.nativeSessionRef,
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_PROTOCOL_INVALID" });
	});

	it("replays a terminal event persisted after subscription setup", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);

		await bridge.emitTurnCompleted("completed");
		await vi.waitFor(async () => {
			const events = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(events.filter((event) => event.type === "completed")).toHaveLength(
				1,
			);
		});
		const iterator = stream[Symbol.asyncIterator]();
		expect(await iterator.next()).toMatchObject({
			done: false,
			value: { type: "status", payload: { status: "running" } },
		});
		expect(await iterator.next()).toMatchObject({
			done: false,
			value: { type: "completed", payload: { status: "completed" } },
		});
	});

	it("replays a terminal event that races the initial live replay", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const replay = driver.replayEvents.bind(driver);
		let replays = 0;
		vi.spyOn(driver, "replayEvents").mockImplementation(async (...args) => {
			const events = await replay(...args);
			replays += 1;
			if (replays === 1) {
				await bridge.emitTurnCompleted("completed");
				await vi.waitFor(async () => {
					const persisted = await replay(...args);
					expect(
						persisted.filter((event) => event.type === "completed"),
					).toHaveLength(1);
				});
			}
			return events;
		});
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		const iterator = stream[Symbol.asyncIterator]();

		expect(await iterator.next()).toMatchObject({
			done: false,
			value: { type: "status", payload: { status: "running" } },
		});
		expect(await iterator.next()).toMatchObject({
			done: false,
			value: { type: "completed", payload: { status: "completed" } },
		});
	});

	it("does not yield replayed events after stream abort", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const replay = driver.replayEvents.bind(driver);
		let replays = 0;
		let releaseReplay: (() => void) | undefined;
		vi.spyOn(driver, "replayEvents").mockImplementation(async (...args) => {
			replays += 1;
			if (replays === 2) {
				await new Promise<void>((resolve) => {
					releaseReplay = resolve;
				});
			}
			return replay(...args);
		});
		const abort = new AbortController();
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
			undefined,
			abort.signal,
		);
		const iterator = stream[Symbol.asyncIterator]();

		expect(await iterator.next()).toMatchObject({
			done: false,
			value: { type: "status", payload: { status: "running" } },
		});
		const next = iterator.next();
		await bridge.emitAgentMessageDelta("after-abort");
		await vi.waitFor(() => expect(releaseReplay).toBeTypeOf("function"));
		await vi.waitFor(async () => {
			const events = await replay(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(events.filter((event) => event.type === "text")).toHaveLength(1);
		});
		abort.abort();
		releaseReplay?.();
		expect(await next).toEqual({ done: true, value: undefined });
	});

	it("persists a terminal Turn notification and replays it once", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		await bridge.emitTurnCompleted("completed");
		const events = await vi.waitFor(async () => {
			const replayed = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(
				replayed.filter((event) => event.type === "completed"),
			).toHaveLength(1);
			return replayed;
		});
		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("completed");
		expect(events.at(-1)).toMatchObject({
			type: "completed",
			payload: { status: "completed" },
		});
		expect(JSON.stringify(events)).not.toContain(bridge.nativeThreadId);
		expect(JSON.stringify(events)).not.toContain(bridge.nativeTurnId);
	});

	it("recovers persisted Turn status and item history after Driver restart", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		resumedBridge.setTurnStatus("completed");
		resumedBridge.setItemsListPages([
			{
				data: [
					{
						turnId: firstBridge.nativeTurnId,
						item: {
							id: "codex-native-item-private",
							type: "agentMessage",
							text: "persisted answer",
						},
					},
				],
			},
		]);
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);

		const events = await resumedDriver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		expect(events).toEqual([
			expect.objectContaining({
				type: "status",
				payload: { status: "running" },
			}),
			expect.objectContaining({
				type: "text",
				payload: { delta: "persisted answer" },
			}),
			expect.objectContaining({
				type: "completed",
				payload: { status: "completed" },
			}),
		]);
		expect(
			await resumedDriver.getStatus(
				accepted.nativeSessionRef,
				command.executionId,
			),
		).toBe("completed");
		expect(resumedBridge.requests.map(({ method }) => method)).toEqual([
			"initialize",
			"config/read",
			"thread/resume",
			"thread/turns/list",
			"thread/items/list",
		]);
		expect(
			resumedBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);
		expect(JSON.stringify(events)).not.toContain(firstBridge.nativeThreadId);
		expect(JSON.stringify(events)).not.toContain(firstBridge.nativeTurnId);
		expect(JSON.stringify(events)).not.toContain("codex-native-item-private");
	});

	it("fails closed with a redacted error when persisted item recovery is malformed", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		resumedBridge.setItemsListPages([
			{
				data: [
					{
						turnId: firstBridge.nativeTurnId,
						item: {
							id: "codex-native-item-private",
							type: "agentMessage",
						},
					},
				],
			},
		]);
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);

		const failure = await resumedDriver
			.replayEvents(accepted.nativeSessionRef, command.executionId)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(failure).toMatchObject({
			code: "RUNTIME_CODEX_PROTOCOL_INVALID",
			message: "Codex Runtime returned an invalid response",
		});
		expect(JSON.stringify(failure)).not.toContain(firstBridge.nativeThreadId);
		expect(JSON.stringify(failure)).not.toContain(firstBridge.nativeTurnId);
		expect(JSON.stringify(failure)).not.toContain("codex-native-item-private");
	});

	it("keeps the original local cursor when recovery sees an already journaled item", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstBridge.emitAgentMessageDelta("already-persisted");
		const original = await vi.waitFor(async () => {
			const events = await firstDriver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			const event = events.find((candidate) => candidate.type === "text");
			if (!event) throw new Error("expected journaled text event");
			return event;
		});
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		resumedBridge.setItemsListPages([
			{
				data: [
					{
						turnId: firstBridge.nativeTurnId,
						item: {
							id: "codex-native-item-private",
							type: "agentMessage",
							text: "already-persisted",
						},
					},
				],
			},
		]);
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);

		const recovered = (
			await resumedDriver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			)
		).find((candidate) => candidate.type === "text");
		expect(recovered).toMatchObject({
			cursor: original.cursor,
			adapterEventKey: original.adapterEventKey,
			payload: { delta: "already-persisted" },
		});
	});

	it("replays recovered text before a persisted terminal event", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstBridge.emitTurnCompleted("completed");
		await vi.waitFor(async () => {
			const events = await firstDriver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(events.at(-1)?.type).toBe("completed");
		});
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		resumedBridge.setTurnStatus("completed");
		resumedBridge.setItemsListPages([
			{
				data: [
					{
						turnId: firstBridge.nativeTurnId,
						item: {
							id: "codex-native-item-private",
							type: "agentMessage",
							text: "recovered-after-terminal",
						},
					},
				],
			},
		]);
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);

		const events = await resumedDriver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		expect(events.map((event) => event.type)).toEqual([
			"status",
			"text",
			"completed",
		]);
		expect(events[1]).toMatchObject({
			type: "text",
			payload: { delta: "recovered-after-terminal" },
		});
	});

	it("fails closed for duplicate durable journal identities", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		await firstDriver.execute(submitCommand());
		await firstDriver.close();
		const state = JSON.parse(await readFile(path, "utf8")) as {
			sessions: Record<
				string,
				{ journals?: Record<string, { events: unknown[] }> }
			>;
		};
		const journal = Object.values(state.sessions)[0]?.journals?.[
			firstBridge.nativeTurnId
		];
		if (!journal?.events[0]) throw new Error("expected durable journal event");
		journal.events.push(structuredClone(journal.events[0]));
		await writeFile(path, JSON.stringify(state));
		const resumedBridge = new TestCodexBridge();

		await expect(openDriver(path, resumedBridge)).rejects.toMatchObject({
			code: "RUNTIME_CODEX_STATE_INVALID",
			message: "Codex Runtime session state is unavailable",
		});
		expect(resumedBridge.requests).toEqual([]);
	});

	it("fails closed for inconsistent durable terminal journals", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const accepted = await firstDriver.execute(submitCommand());
		await firstBridge.emitTurnCompleted("completed");
		await vi.waitFor(async () => {
			const events = await firstDriver.replayEvents(
				accepted.nativeSessionRef,
				"execution-codex",
			);
			expect(events.at(-1)?.type).toBe("completed");
		});
		await firstDriver.close();
		const state = JSON.parse(
			await readFile(path, "utf8"),
		) as StoredCodexDriverState;

		for (const corrupt of [
			(journal: StoredEventJournal) => {
				const completed = journal.events.find(
					(event) => event.type === "completed",
				);
				if (!completed) throw new Error("expected completed event");
				journal.events.push({
					...completed,
					cursor: "cursor-duplicate-terminal",
					adapterEventKey: "adapter-event-duplicate-terminal",
				});
			},
			(journal: StoredEventJournal) => {
				journal.events.push({
					cursor: "cursor-after-terminal",
					adapterEventKey: "adapter-event-after-terminal",
					occurredAt: "2026-09-04T00:00:00.000Z",
					nativeItemId: "item-after-terminal",
					type: "text",
					payload: { delta: "late" },
				});
			},
			(journal: StoredEventJournal) => {
				const completed = journal.events.find(
					(event) => event.type === "completed",
				);
				if (!completed) throw new Error("expected completed event");
				completed.payload = { status: "failed" };
			},
			(journal: StoredEventJournal) => {
				journal.events.pop();
			},
		]) {
			const candidate = structuredClone(state);
			const session = Object.values(candidate.sessions)[0];
			const journal = session?.journals?.[firstBridge.nativeTurnId];
			if (!session || !journal) throw new Error("expected durable journal");
			corrupt(journal);
			session.eventSequence = journal.events.length;
			await writeFile(path, JSON.stringify(candidate));
			const resumedBridge = new TestCodexBridge();

			await expect(openDriver(path, resumedBridge)).rejects.toMatchObject({
				code: "RUNTIME_CODEX_STATE_INVALID",
				message: "Codex Runtime session state is unavailable",
			});
			expect(resumedBridge.requests).toEqual([]);
		}
	});

	it("coalesces concurrent persisted Session resumes", async () => {
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
		const resumedDriver = await openDriver(
			join(directory, "driver.json"),
			resumedBridge,
		);
		drivers.push(resumedDriver);

		await expect(
			Promise.all([
				resumedDriver.getStatus(
					firstResult.nativeSessionRef,
					command.executionId,
				),
				resumedDriver.getStatus(
					firstResult.nativeSessionRef,
					command.executionId,
				),
			]),
		).resolves.toEqual(["running", "running"]);
		expect(
			resumedBridge.requests.filter(({ method }) => method === "thread/resume"),
		).toHaveLength(1);
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

	it("coalesces concurrent retries for one operation", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();

		const [first, duplicate] = await Promise.all([
			driver.execute(command),
			driver.execute(command),
		]);

		expect(duplicate).toEqual(first);
		expect(first.result).toEqual({ outcome: "accepted", status: "running" });
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("does not start a second native Turn for concurrent idle-Session submits", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const first = driver.execute(submitCommand());
		const second = driver.execute(
			submitCommand({
				operationId: "execution-codex-concurrent",
				executionId: "execution-codex-concurrent",
				turnId: "turn-codex-concurrent",
			}),
		);
		const [firstResult, secondResult] = await Promise.allSettled([
			first,
			second,
		]);

		expect(firstResult).toMatchObject({
			status: "fulfilled",
			value: { result: { outcome: "accepted", status: "running" } },
		});
		expect(secondResult).toMatchObject({
			status: "rejected",
			reason: { code: "RUNTIME_CODEX_UNAVAILABLE" },
		});
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("rejects a submit whose operation and Execution identities differ", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);

		await expect(
			driver.execute(
				submitCommand({ operationId: "operation-codex-not-an-execution" }),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_STATE_INVALID" });
		expect(
			bridge.requests.filter(({ method }) => method === "thread/start"),
		).toHaveLength(0);
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);
	});

	it("persists a prototype-like Execution identity across Driver restart", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand({
			operationId: "__proto__",
			executionId: "__proto__",
			turnId: "turn-codex-prototype",
		});
		const first = await firstDriver.execute(command);
		await firstDriver.close();
		const resumedBridge = new TestCodexBridge(firstBridge.nativeThreadId);
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);

		expect(
			await resumedDriver.getStatus(
				first.nativeSessionRef,
				command.executionId,
			),
		).toBe("running");
		expect(resumedBridge.requests.map(({ method }) => method)).toEqual([
			"initialize",
			"config/read",
			"thread/resume",
			"thread/turns/list",
		]);
	});

	it("fails closed for inherited Session and Execution identifiers", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const accepted = await driver.execute(submitCommand());

		await expect(
			driver.getStatus(accepted.nativeSessionRef, "constructor"),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		await expect(
			driver.getStatus("constructor", "execution-codex"),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
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

	it("keeps a command unknown when its native Session start response is lost", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const failedBridge = new TestCodexBridge();
		failedBridge.dropNextThreadStartResponse();
		const failedDriver = await openDriver(path, failedBridge);
		drivers.push(failedDriver);
		const command = submitCommand();

		await expect(failedDriver.execute(command)).rejects.toMatchObject({
			code: "RUNTIME_CODEX_UNAVAILABLE",
		});
		expect(
			failedBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);

		const recoveredBridge = new TestCodexBridge();
		const recoveredDriver = await openDriver(path, recoveredBridge);
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
		expect(
			recoveredBridge.requests.filter(
				({ method }) => method === "thread/start",
			),
		).toHaveLength(0);
		expect(
			recoveredBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);
	});

	it("retries a command after its persisted Session resume fails before Turn start", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const first = await firstDriver.execute(submitCommand());
		firstBridge.setTurnStatus("completed");
		await firstDriver.getStatus(first.nativeSessionRef, "execution-codex");
		await firstDriver.close();
		const command = submitCommand({
			operationId: "execution-codex-after-resume-failure",
			executionId: "execution-codex-after-resume-failure",
			turnId: "turn-codex-after-resume-failure",
			nativeSessionRef: first.nativeSessionRef,
		});
		const failedBridge = new TestCodexBridge(firstBridge.nativeThreadId);
		failedBridge.dropNextThreadResumeResponse();
		const failedDriver = await openDriver(path, failedBridge);
		drivers.push(failedDriver);

		await expect(failedDriver.execute(command)).rejects.toMatchObject({
			code: "RUNTIME_CODEX_UNAVAILABLE",
		});
		expect(
			failedBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);

		const recoveredBridge = new TestCodexBridge(firstBridge.nativeThreadId);
		recoveredBridge.continueAfterPersistedTurn();
		const recoveredDriver = await openDriver(path, recoveredBridge);
		drivers.push(recoveredDriver);

		expect((await recoveredDriver.execute(command)).result).toEqual({
			outcome: "accepted",
			status: "running",
		});
		expect(
			recoveredBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("fails closed for an out-of-order status that conflicts with a terminal read", async () => {
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
		await expect(firstStatus).rejects.toMatchObject({
			code: "RUNTIME_CODEX_PROTOCOL_INVALID",
		});
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

	it("returns a persisted terminal status when native Turn history is unavailable", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		bridge.setTurnStatus("completed");
		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("completed");
		bridge.setTurnsListPages([{ data: [], nextCursor: null }]);

		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("completed");
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

	it("keeps polling after a persisted app-server notification", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		await bridge.emitNotification();
		await vi.waitFor(async () => {
			expect(
				await driver.getStatus(accepted.nativeSessionRef, command.executionId),
			).toBe("running");
		});
	});

	it.each([
		["dynamic delegated Tool", "item/tool/call"],
		["MCP elicitation", "mcpServer/elicitation/request"],
	] as const)(
		"contains a native %s request without calling a provider or exposing its parameters",
		async (_name, method) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			const driver = await openDriver(join(directory, "driver.json"), bridge);
			drivers.push(driver);

			bridge.emitServerRequest(method, {
				connectionCredential: "connection-credential-private",
			});
			await vi.waitFor(() => {
				expect(bridge.responses).toContainEqual({
					id: "native-tool-request-private",
					error: {
						code: -32_001,
						message: "Platform delegated tools are unavailable",
					},
				});
			});

			expect(bridge.isClosed()).toBe(false);
			expect(
				bridge.requests.map(({ method: requestMethod }) => requestMethod),
			).toEqual(["initialize", "config/read"]);
			expect(JSON.stringify(bridge.responses)).not.toContain(
				"connection-credential-private",
			);
			expect(
				await readFile(join(directory, "driver.json"), "utf8"),
			).not.toContain("connection-credential-private");
			expect(await driver.getCapabilities()).toMatchObject({
				connection: false,
			});
		},
	);

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
			"execution without a native thread",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session": {
						nativeSessionRef: "opaque-session",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						executions: {
							"execution-codex": {
								executionId: "execution-codex",
								turnId: "turn-codex",
								nativeTurnId: "codex-native-turn-private",
								status: "completed",
							},
						},
					},
				},
				operations: {
					'["agent-codex","conversation-codex",1,"submit-turn","execution-codex"]':
						{
							state: "resolved",
							nativeSessionRef: "opaque-session",
							record: {
								schemaVersion: 1,
								agentId: "agent-codex",
								conversationId: "conversation-codex",
								sessionGeneration: 1,
								kind: "submit-turn",
								operationId: "execution-codex",
								nativeSessionRef: "opaque-session",
								result: { outcome: "accepted", status: "completed" },
							},
						},
				},
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
		[
			"unbound prepared operation key",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session": {
						nativeSessionRef: "opaque-session",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						executions: {},
					},
				},
				operations: {
					'["agent-other","conversation-other",1,"submit-turn","operation-other"]':
						{
							state: "prepared",
							nativeSessionRef: "opaque-session",
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

	it("fails all pending requests for a structurally invalid turns-list result", async () => {
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
		bridge.respondToHeldTurnsListWithInvalidData();
		await expect(first).rejects.toMatchObject({
			code: "RUNTIME_CODEX_PROTOCOL_INVALID",
		});
		await expect(second).rejects.toMatchObject({
			code: "RUNTIME_CODEX_PROTOCOL_INVALID",
		});
	});

	it("fails all pending requests when a turns-list response times out", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		bridge.holdTurnsList();
		vi.useFakeTimers();
		const failures: unknown[] = [];
		void driver
			.getStatus(accepted.nativeSessionRef, command.executionId)
			.catch((error: unknown) => failures.push(error));
		void driver
			.getStatus(accepted.nativeSessionRef, command.executionId)
			.catch((error: unknown) => failures.push(error));

		await vi.advanceTimersByTimeAsync(30_000);

		expect(failures).toHaveLength(2);
		for (const failure of failures) {
			expect(failure).toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		}
		expect(bridge.isClosed()).toBe(true);
	});

	it("does not leave an unhandled rejection when a request send times out", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		bridge.holdTurnsListRequestSend();
		vi.useFakeTimers();
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const status = driver.getStatus(
				accepted.nativeSessionRef,
				command.executionId,
			);
			const outcome = status.then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(30_000);

			expect(await outcome).toMatchObject({
				code: "RUNTIME_CODEX_UNAVAILABLE",
			});
			await Promise.resolve();
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
