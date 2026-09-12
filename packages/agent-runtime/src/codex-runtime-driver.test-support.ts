import { readFile } from "node:fs/promises";

import type {
	CodexAppServerBridgeOptions,
	CodexAppServerFrame,
} from "./codex-app-server-bridge.js";
import {
	CodexRuntimeDriver,
	type CodexRuntimeDriverOptions,
} from "./codex-runtime-driver.js";

interface TestCodexAppServerTransport {
	send(frame: CodexAppServerFrame): Promise<void>;
	frames(): AsyncIterable<CodexAppServerFrame>;
	close?(): Promise<void>;
}

type OpenTestCodexBridge = (
	options: CodexAppServerBridgeOptions,
) => Promise<TestCodexAppServerTransport>;

type ConformanceTurnStatus =
	| "inProgress"
	| "completed"
	| "failed"
	| "interrupted";

interface CodexRuntimeDriverConformanceState {
	turnStarts: number;
	turnSelections: { model: string; effort: string }[];
}

interface CodexRuntimeDriverConformanceFixture {
	driver: CodexRuntimeDriver;
	emitRunningEvent(): Promise<void>;
	submitWithPreStartEvent<T>(submit: () => Promise<T>): Promise<T>;
	completeStopAsCancelled(): void;
	completeStopAsCompleted(): Promise<void>;
	turnStartCount(): number;
	turnSelections(): readonly { model: string; effort: string }[];
	rejectNextSelectedTurn(): void;
	delegatedToolWasDeniedAndRedacted(
		response?: "driver" | "unexpected-success",
	): Promise<boolean>;
	close(): Promise<void>;
	restart(): Promise<CodexRuntimeDriverConformanceFixture>;
}

class ConformanceCodexTransport implements TestCodexAppServerTransport {
	private readonly queuedFrames: CodexAppServerFrame[] = [];
	private wake?: () => void;
	private closed = false;
	private turnStatus: ConformanceTurnStatus = "inProgress";
	private terminalOnInterrupt?: Exclude<ConformanceTurnStatus, "inProgress">;
	private holdTurnStartResponse = false;
	private heldTurnStart?: { id: number; resolve: () => void };
	private signalTurnStartHeld?: () => void;
	private delegatedToolResult?: (result: boolean) => void;
	private rejectNextSelection = false;

	constructor(
		private readonly path: string,
		private readonly state: CodexRuntimeDriverConformanceState,
		private readonly loseTurnStartResponse: boolean,
	) {}

	async send(frame: CodexAppServerFrame) {
		if (
			!("method" in frame) &&
			"id" in frame &&
			frame.id === "request-opaque"
		) {
			const serialized = JSON.stringify(frame);
			this.delegatedToolResult?.(
				"error" in frame &&
					serialized.includes("Platform delegated tools are unavailable") &&
					!serialized.includes("redacted-input"),
			);
			this.delegatedToolResult = undefined;
			return;
		}
		if (!("method" in frame) || typeof frame.id !== "number") {
			throw new Error("Unexpected Codex conformance request");
		}
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
				this.respond(frame.id, { thread: { id: "thread-opaque" } });
				return;
			case "turn/start": {
				this.state.turnStarts += 1;
				const params = frame.params as
					| { model?: unknown; effort?: unknown }
					| undefined;
				if (
					typeof params?.model === "string" &&
					typeof params.effort === "string"
				) {
					this.state.turnSelections.push({
						model: params.model,
						effort: params.effort,
					});
				}
				if (this.rejectNextSelection) {
					this.rejectNextSelection = false;
					this.push({
						id: frame.id,
						error: {
							code: -32_600,
							message: "invalid thread settings override: synthetic selection",
						},
					});
					return;
				}
				if (this.loseTurnStartResponse) {
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
				const turnId = this.currentTurnId();
				this.respond(frame.id, {
					turn: {
						id: turnId,
						status: "inProgress",
					},
				});
				this.push({
					method: "turn/started",
					params: {
						threadId: "thread-opaque",
						turn: { id: turnId, status: "inProgress", items: [] },
					},
				});
				return;
			}
			case "turn/interrupt":
				if (this.terminalOnInterrupt) {
					this.turnStatus = this.terminalOnInterrupt;
				}
				this.respond(frame.id, {});
				return;
			case "thread/turns/list":
				this.respond(frame.id, {
					data: [
						{ id: this.currentTurnId(), status: this.turnStatus, items: [] },
					],
				});
				return;
			case "thread/items/list":
				this.respond(frame.id, { data: [] });
				return;
		}
		throw new Error("Unexpected Codex conformance method");
	}

	frames(): AsyncIterable<CodexAppServerFrame> {
		const transport = this;
		return (async function* () {
			while (true) {
				const frame = await transport.nextFrame();
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

	emitRunningEvent() {
		this.push({
			method: "turn/started",
			params: {
				threadId: "thread-opaque",
				turn: { id: "turn-opaque", status: "inProgress", items: [] },
			},
		});
	}

	completeStopAsCancelled() {
		this.terminalOnInterrupt = "interrupted";
	}

	completeStopAsCompleted() {
		this.turnStatus = "completed";
		this.terminalOnInterrupt = undefined;
	}

	rejectNextSelectedTurn() {
		this.rejectNextSelection = true;
	}

	private currentTurnId() {
		return this.state.turnStarts <= 1
			? "turn-opaque"
			: `turn-opaque-${this.state.turnStarts}`;
	}

	async submitWithPreStartEvent<T>(submit: () => Promise<T>) {
		this.holdTurnStartResponse = true;
		const turnStartHeld = new Promise<void>((resolve) => {
			this.signalTurnStartHeld = resolve;
		});
		try {
			const result = submit();
			await Promise.race([
				turnStartHeld,
				result.then(
					() => {
						throw new Error("Submission completed before turn/start was held");
					},
					(error: unknown) => {
						throw error;
					},
				),
			]);
			this.emitRunningEvent();
			const held = this.heldTurnStart;
			if (!held) throw new Error("No held turn start");
			this.respond(held.id, {
				turn: { id: "turn-opaque", status: "inProgress" },
			});
			held.resolve();
			this.heldTurnStart = undefined;
			return await result;
		} finally {
			this.signalTurnStartHeld = undefined;
			this.holdTurnStartResponse = false;
			this.heldTurnStart?.resolve();
			this.heldTurnStart = undefined;
		}
	}

	async delegatedToolWasDeniedAndRedacted(
		response: "driver" | "unexpected-success" = "driver",
	) {
		const result = new Promise<boolean>((resolve) => {
			this.delegatedToolResult = resolve;
		});
		if (response === "unexpected-success") {
			await this.send({ id: "request-opaque", result: {} });
		} else {
			this.push({
				id: "request-opaque",
				method: "item/tool/call",
				params: { privateInput: "redacted-input" },
			});
		}
		const denied = await result;
		const state = await readFile(this.path, "utf8").catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return "";
				throw error;
			},
		);
		return denied && !state.includes("redacted-input");
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

class CodexRuntimeDriverTestAccess extends CodexRuntimeDriver {
	static async openForTest(
		options: CodexRuntimeDriverOptions,
		openBridge: OpenTestCodexBridge,
	) {
		const driver = (await CodexRuntimeDriverTestAccess.openWithBridge(
			options,
			openBridge,
		)) as CodexRuntimeDriverTestAccess;
		try {
			// Production admits a native process when a Conversation first needs it.
			// Tests keep asserting deployment admission at Driver open.
			await driver.openConversationRpc(admissionConversationKey);
		} catch (error) {
			await driver.close().catch(() => {});
			throw error;
		}
		return driver;
	}
}

const admissionConversationKey = `${"0".repeat(63)}1`;

/** @internal Test-only source helper. It is intentionally absent from the package barrel. */
export function openCodexRuntimeDriverForTest(
	options: CodexRuntimeDriverOptions,
	openBridge: OpenTestCodexBridge,
) {
	return CodexRuntimeDriverTestAccess.openForTest(options, openBridge);
}

async function openCodexRuntimeDriverConformanceFixtureWithState(
	path: string,
	loseTurnStartResponse: boolean,
	state: CodexRuntimeDriverConformanceState,
): Promise<CodexRuntimeDriverConformanceFixture> {
	const transport = new ConformanceCodexTransport(
		path,
		state,
		loseTurnStartResponse,
	);
	const driver = await openCodexRuntimeDriverForTest(
		{
			path,
			configVersion: "synthetic-config-1",
			defaultModelOptionId: "model-option-primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "model-option-primary",
					model: "gpt-5.3-codex",
					reasoningLevels: ["high"],
				},
				{
					modelOptionId: "model-option-alternate",
					model: "gpt-5.2-codex",
					reasoningLevels: ["low"],
				},
			],
		},
		async () => transport,
	);
	return {
		driver,
		emitRunningEvent: async () => transport.emitRunningEvent(),
		submitWithPreStartEvent: (submit) =>
			transport.submitWithPreStartEvent(submit),
		completeStopAsCancelled: () => transport.completeStopAsCancelled(),
		completeStopAsCompleted: async () => transport.completeStopAsCompleted(),
		turnStartCount: () => state.turnStarts,
		turnSelections: () => structuredClone(state.turnSelections),
		rejectNextSelectedTurn: () => transport.rejectNextSelectedTurn(),
		delegatedToolWasDeniedAndRedacted: (response) =>
			transport.delegatedToolWasDeniedAndRedacted(response),
		close: async () => {
			await driver.close();
			await transport.close();
		},
		restart: () =>
			openCodexRuntimeDriverConformanceFixtureWithState(path, false, state),
	};
}

export function openCodexRuntimeDriverConformanceFixture(
	path: string,
	loseTurnStartResponse = false,
) {
	return openCodexRuntimeDriverConformanceFixtureWithState(
		path,
		loseTurnStartResponse,
		{ turnStarts: 0, turnSelections: [] },
	);
}
