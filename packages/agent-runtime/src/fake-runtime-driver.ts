import { randomUUID } from "node:crypto";

import type {
	RuntimeCapabilitiesV1,
	RuntimeDriverCommandV1,
	RuntimeDriverOperationRecordV1,
	RuntimeEventV1,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";
import type { RuntimeDriver, RuntimeDriverLookup } from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";

interface FakeSession {
	nativeSessionRef: string;
	agentId: string;
	conversationId: string;
	sessionGeneration: number;
	activeExecutionId?: string;
	status: RuntimeStatusV1;
	events: RuntimeEventV1[];
	cancelledGeneration?: number;
}

interface FakeDriverState {
	schemaVersion: 1;
	sessions: Record<string, FakeSession>;
	operations: Record<string, RuntimeDriverOperationRecordV1>;
	unknownOperations: string[];
	lookupFailures: string[];
	statusFailures: string[];
	sideEffects: number;
}

const capabilities: RuntimeCapabilitiesV1 = {
	modelSelection: true,
	attachments: true,
	resultFiles: true,
	connection: true,
	supplementaryInstruction: true,
};

function timestamp() {
	return "2026-08-28T10:00:00Z";
}

export class FakeRuntimeDriver implements RuntimeDriver {
	private readonly eventWaiters = new Map<string, Set<() => void>>();

	private constructor(
		private readonly file: DurableJsonFile<FakeDriverState>,
	) {}

	static async open(path: string) {
		return new FakeRuntimeDriver(
			await DurableJsonFile.open(path, {
				schemaVersion: 1,
				sessions: {},
				operations: {},
				unknownOperations: [],
				lookupFailures: [],
				statusFailures: [],
				sideEffects: 0,
			}),
		);
	}

	async execute(command: RuntimeDriverCommandV1) {
		let eventStreamKey: string | undefined;
		const record = await this.file.update((state) => {
			const previous = state.operations[command.operationId];
			if (previous) return structuredClone(previous);
			const nativeSessionRef =
				command.nativeSessionRef ?? `native-${randomUUID()}`;
			let session = state.sessions[nativeSessionRef];
			if (!session) {
				if (command.kind !== "submit-turn" || command.nativeSessionRef) {
					throw new RuntimeHostError(
						"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
						"Runtime session could not be recovered",
						503,
					);
				}
				session = {
					nativeSessionRef,
					agentId: command.agentId,
					conversationId: command.conversationId,
					sessionGeneration: command.sessionGeneration,
					status: "idle",
					events: [],
				};
				state.sessions[nativeSessionRef] = session;
			}
			if (
				session.agentId !== command.agentId ||
				session.conversationId !== command.conversationId ||
				session.sessionGeneration !== command.sessionGeneration ||
				(session.cancelledGeneration === command.sessionGeneration &&
					command.kind !== "generation-cancel")
			) {
				throw new RuntimeHostError(
					"RUNTIME_DRIVER_SESSION_MISMATCH",
					"Runtime session could not be recovered",
					503,
				);
			}

			let result: RuntimeDriverOperationRecordV1["result"];
			if (command.kind === "submit-turn") {
				if (
					session.activeExecutionId &&
					session.activeExecutionId !== command.executionId
				) {
					result = { outcome: "busy" };
				} else {
					session.activeExecutionId = command.executionId;
					session.status = "running";
					this.appendEvent(session, command.executionId, "status", {
						status: "running",
					});
					eventStreamKey = this.eventStreamKey(
						nativeSessionRef,
						command.executionId,
					);
					result = { outcome: "accepted", status: "running" };
					state.sideEffects += 1;
				}
			} else if (command.kind === "supplement") {
				if (
					session.activeExecutionId !== command.executionId ||
					session.status !== "running"
				) {
					result = {
						outcome: "rejected",
						code: "RUNTIME_TURN_NOT_ACTIVE",
						message: "Runtime turn is no longer active",
						retryable: false,
					};
				} else {
					this.appendEvent(session, command.executionId, "text", {
						delta: "synthetic-supplement-accepted",
					});
					eventStreamKey = this.eventStreamKey(
						nativeSessionRef,
						command.executionId,
					);
					result = { outcome: "accepted", status: "running" };
					state.sideEffects += 1;
				}
			} else if (command.kind === "stop") {
				if (
					session.activeExecutionId === command.executionId &&
					session.status === "running"
				) {
					session.status = "cancelled";
					session.activeExecutionId = undefined;
					this.appendEvent(session, command.executionId, "completed", {
						status: "cancelled",
					});
					eventStreamKey = this.eventStreamKey(
						nativeSessionRef,
						command.executionId,
					);
					state.sideEffects += 1;
				}
				result = { outcome: "accepted", status: session.status };
			} else {
				session.cancelledGeneration = command.sessionGeneration;
				session.status = "cancelled";
				session.activeExecutionId = undefined;
				state.sideEffects += 1;
				result = { outcome: "accepted", status: "cancelled" };
			}

			const record: RuntimeDriverOperationRecordV1 = {
				schemaVersion: 1,
				operationId: command.operationId,
				nativeSessionRef,
				result,
			};
			state.operations[command.operationId] = record;
			return structuredClone(record);
		});
		if (eventStreamKey) this.notifyEventStream(eventStreamKey);
		return record;
	}

	async lookupOperation(operationId: string): Promise<RuntimeDriverLookup> {
		const state = this.file.read();
		if (state.lookupFailures.includes(operationId)) {
			throw new RuntimeHostError(
				"RUNTIME_DRIVER_RECOVERY_FAILED",
				"Runtime operation recovery failed",
				503,
			);
		}
		if (state.unknownOperations.includes(operationId))
			return { state: "unknown" };
		const record = state.operations[operationId];
		return record ? { state: "found", record } : { state: "missing" };
	}

	failLookupFor(operationId: string) {
		return this.file.update((state) => {
			state.lookupFailures.push(operationId);
		});
	}

	failStatusFor(executionId: string) {
		return this.file.update((state) => {
			state.statusFailures.push(executionId);
		});
	}

	makeOperationUnknown(operationId: string) {
		return this.file.update((state) => {
			if (!state.operations[operationId]) {
				throw new RuntimeHostError(
					"RUNTIME_FAKE_OPERATION_NOT_FOUND",
					"Fake Runtime operation was not found",
					404,
				);
			}
			delete state.operations[operationId];
			state.unknownOperations.push(operationId);
		});
	}

	setOperationStatus(operationId: string, status: RuntimeStatusV1) {
		return this.file.update((state) => {
			const operation = state.operations[operationId];
			const session = operation
				? state.sessions[operation.nativeSessionRef]
				: undefined;
			if (!session) {
				throw new RuntimeHostError(
					"RUNTIME_FAKE_OPERATION_NOT_FOUND",
					"Fake Runtime operation was not found",
					404,
				);
			}
			session.status = status;
			if (["completed", "failed", "cancelled"].includes(status)) {
				session.activeExecutionId = undefined;
			}
		});
	}

	async getStatus(nativeSessionRef: string, executionId: string) {
		if (this.file.read().statusFailures.includes(executionId)) {
			throw new RuntimeHostError(
				"RUNTIME_DRIVER_RECOVERY_FAILED",
				"Runtime status recovery failed",
				503,
			);
		}
		const session = this.session(nativeSessionRef);
		if (session.activeExecutionId && session.activeExecutionId !== executionId)
			return "idle";
		return session.status;
	}

	async getCapabilities() {
		return capabilities;
	}

	async replayEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
	) {
		const events = this.session(nativeSessionRef).events.filter(
			(event) => event.executionId === executionId,
		);
		if (!afterCursor) return events;
		const index = events.findIndex((event) => event.cursor === afterCursor);
		if (index === -1) {
			throw new RuntimeHostError(
				"RUNTIME_REPLAY_CURSOR_UNKNOWN",
				"Runtime replay cursor is unknown",
				409,
			);
		}
		return events.slice(index + 1);
	}

	async subscribeEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
		signal?: AbortSignal,
	) {
		const initialEvents = await this.replayEvents(
			nativeSessionRef,
			executionId,
			afterCursor,
		);
		const driver = this;
		return (async function* () {
			let cursor = afterCursor;
			let pending = initialEvents;
			while (!signal?.aborted) {
				for (const event of pending) {
					cursor = event.cursor;
					yield event;
				}
				const waiter = driver.waitForEvent(
					driver.eventStreamKey(nativeSessionRef, executionId),
					signal,
				);
				pending = await driver.replayEvents(
					nativeSessionRef,
					executionId,
					cursor,
				);
				if (pending.length > 0) {
					waiter.cancel();
					continue;
				}
				await waiter.promise;
				pending = await driver.replayEvents(
					nativeSessionRef,
					executionId,
					cursor,
				);
			}
		})();
	}

	async sideEffectCount() {
		return this.file.read().sideEffects;
	}

	private session(nativeSessionRef: string) {
		const session = this.file.read().sessions[nativeSessionRef];
		if (!session) {
			throw new RuntimeHostError(
				"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
				"Runtime session could not be recovered",
				503,
			);
		}
		return session;
	}

	private eventStreamKey(nativeSessionRef: string, executionId: string) {
		return `${nativeSessionRef}\u0000${executionId}`;
	}

	private notifyEventStream(key: string) {
		for (const wake of this.eventWaiters.get(key) ?? []) wake();
	}

	private waitForEvent(key: string, signal?: AbortSignal) {
		let wake: () => void = () => undefined;
		const promise = new Promise<void>((resolve) => {
			wake = () => {
				cleanup();
				resolve();
			};
		});
		const waiters = this.eventWaiters.get(key) ?? new Set<() => void>();
		this.eventWaiters.set(key, waiters);
		waiters.add(wake);
		const cleanup = () => {
			waiters.delete(wake);
			if (waiters.size === 0) this.eventWaiters.delete(key);
			signal?.removeEventListener("abort", wake);
		};
		signal?.addEventListener("abort", wake, { once: true });
		if (signal?.aborted) wake();
		return { promise, cancel: cleanup };
	}

	private appendEvent(
		session: FakeSession,
		executionId: string,
		type: "status" | "text" | "completed",
		payload: { status: "running" | "cancelled" } | { delta: string },
	) {
		const sequence = session.events.length + 1;
		const base = {
			schemaVersion: 1 as const,
			adapterEventKey: `fake-event-${sequence}`,
			executionId,
			cursor: `fake-cursor-${sequence}`,
			occurredAt: timestamp(),
		};
		if (type === "text" && "delta" in payload) {
			session.events.push({ ...base, type, payload });
		} else if (
			type === "completed" &&
			"status" in payload &&
			payload.status === "cancelled"
		) {
			session.events.push({ ...base, type, payload: { status: "cancelled" } });
		} else if (
			type === "status" &&
			"status" in payload &&
			payload.status === "running"
		) {
			session.events.push({ ...base, type, payload: { status: "running" } });
		}
	}
}
