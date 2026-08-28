import { createHash, randomUUID } from "node:crypto";

import {
	type RuntimeOperationResultV1,
	RuntimeOperationResultV1Schema,
} from "@agent-infra/contracts/runtime";

import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";

interface SessionBinding {
	agentId: string;
	conversationId: string;
	sessionGeneration: number;
}

export interface StoredOperation {
	operationId: string;
	kind: "submit-turn" | "supplement" | "stop" | "generation-cancel";
	executionId: string;
	turnId: string;
	scope: string;
	deliveryFence: number;
	requestDigest: string;
	state: "prepared" | "resolved";
	result?: RuntimeOperationResultV1;
}

export interface StoredSession extends SessionBinding {
	hostSessionRef: string;
	nativeSessionRef?: string;
	highestFences: Record<string, number>;
	operations: Record<string, StoredOperation>;
	generationBarrier?: {
		generation: number;
		tombstoneId: string;
		state: "active" | "confirmed";
	};
}

interface RuntimeStoreState {
	schemaVersion: 1;
	sessions: Record<string, StoredSession>;
}

interface PrepareOperation {
	requestedHostSessionRef?: string;
	binding: SessionBinding & { executionId: string; turnId: string };
	operationId: string;
	kind: StoredOperation["kind"];
	scope: string;
	deliveryFence: number;
	requestDigest: string;
	executionDeliveryFence?: number;
}

function storeCorrupted(): never {
	throw new RuntimeHostError(
		"RUNTIME_STORE_CORRUPTED",
		"Runtime session state is unavailable",
		503,
	);
}

function assertStoreState(value: RuntimeStoreState) {
	if (
		value.schemaVersion !== 1 ||
		!value.sessions ||
		typeof value.sessions !== "object"
	) {
		storeCorrupted();
	}
	for (const [hostSessionRef, session] of Object.entries(value.sessions)) {
		if (
			session.hostSessionRef !== hostSessionRef ||
			!session.agentId ||
			!session.conversationId ||
			!Number.isSafeInteger(session.sessionGeneration) ||
			session.sessionGeneration < 1 ||
			!session.highestFences ||
			typeof session.highestFences !== "object" ||
			!session.operations ||
			typeof session.operations !== "object" ||
			(session.nativeSessionRef !== undefined && !session.nativeSessionRef)
		) {
			storeCorrupted();
		}
		for (const [operationId, operation] of Object.entries(session.operations)) {
			if (
				operation.operationId !== operationId ||
				!operation.executionId ||
				!operation.turnId ||
				!operation.scope ||
				!operation.requestDigest ||
				!Number.isSafeInteger(operation.deliveryFence) ||
				operation.deliveryFence < 1 ||
				(operation.state === "resolved"
					? !RuntimeOperationResultV1Schema.safeParse(operation.result).success
					: operation.state !== "prepared")
			) {
				storeCorrupted();
			}
		}
	}
}

function sessionFor(
	state: RuntimeStoreState,
	hostSessionRef: string,
	binding: SessionBinding,
	allowGenerationBarrier = false,
) {
	const session = state.sessions[hostSessionRef];
	if (!session) {
		throw new RuntimeHostError(
			"RUNTIME_SESSION_NOT_FOUND",
			"Runtime session was not found",
			404,
		);
	}
	if (
		session.agentId !== binding.agentId ||
		session.conversationId !== binding.conversationId ||
		session.sessionGeneration !== binding.sessionGeneration
	) {
		throw new RuntimeHostError(
			"RUNTIME_SESSION_BINDING_MISMATCH",
			"Runtime session does not match this request",
			403,
		);
	}
	if (
		!allowGenerationBarrier &&
		session.generationBarrier?.generation === binding.sessionGeneration
	) {
		throw new RuntimeHostError(
			"RUNTIME_GENERATION_CANCELLED",
			"Runtime session generation is isolated",
			409,
		);
	}
	return session;
}

export class FileRuntimeStore {
	private constructor(
		private readonly file: DurableJsonFile<RuntimeStoreState>,
	) {}

	static async open(path: string) {
		let file: DurableJsonFile<RuntimeStoreState>;
		try {
			file = await DurableJsonFile.open(path, {
				schemaVersion: 1,
				sessions: {},
			});
			assertStoreState(file.read());
		} catch (error) {
			if (error instanceof RuntimeHostError) throw error;
			storeCorrupted();
		}
		return new FileRuntimeStore(file);
	}

	prepareOperation(input: PrepareOperation) {
		return this.file.update((state) => {
			assertStoreState(state);
			const existingSession = Object.values(state.sessions).find(
				(session) => session.operations[input.operationId],
			);
			const hostSessionRef =
				input.requestedHostSessionRef ?? existingSession?.hostSessionRef;
			let session: StoredSession;
			if (hostSessionRef) {
				session = sessionFor(
					state,
					hostSessionRef,
					input.binding,
					input.kind === "generation-cancel",
				);
			} else {
				if (input.kind !== "submit-turn") {
					throw new RuntimeHostError(
						"RUNTIME_SESSION_REQUIRED",
						"Runtime session is required",
						400,
					);
				}
				const newHostSessionRef = randomUUID();
				session = {
					hostSessionRef: newHostSessionRef,
					agentId: input.binding.agentId,
					conversationId: input.binding.conversationId,
					sessionGeneration: input.binding.sessionGeneration,
					highestFences: {},
					operations: {},
				};
				state.sessions[newHostSessionRef] = session;
			}

			if (input.executionDeliveryFence !== undefined) {
				const executionFence =
					session.highestFences[`execution:${input.binding.executionId}`];
				if (executionFence !== input.executionDeliveryFence) {
					throw new RuntimeHostError(
						"RUNTIME_FENCE_STALE",
						"Runtime delivery fence is stale",
						409,
					);
				}
			}

			const operation = session.operations[input.operationId];
			if (operation) {
				if (
					operation.requestDigest !== input.requestDigest ||
					operation.kind !== input.kind
				) {
					throw new RuntimeHostError(
						"RUNTIME_OPERATION_CONFLICT",
						"Runtime operation was retried with different content",
						409,
					);
				}
				if (input.deliveryFence > operation.deliveryFence) {
					operation.deliveryFence = input.deliveryFence;
					session.highestFences[input.scope] = input.deliveryFence;
				}
				return {
					session: structuredClone(session),
					operation: structuredClone(operation),
				};
			}

			const highestFence = session.highestFences[input.scope] ?? 0;
			if (input.deliveryFence <= highestFence) {
				throw new RuntimeHostError(
					"RUNTIME_FENCE_STALE",
					"Runtime delivery fence is stale",
					409,
				);
			}
			const prepared: StoredOperation = {
				operationId: input.operationId,
				kind: input.kind,
				executionId: input.binding.executionId,
				turnId: input.binding.turnId,
				scope: input.scope,
				deliveryFence: input.deliveryFence,
				requestDigest: input.requestDigest,
				state: "prepared",
			};
			session.highestFences[input.scope] = input.deliveryFence;
			session.operations[input.operationId] = prepared;
			return {
				session: structuredClone(session),
				operation: structuredClone(prepared),
			};
		});
	}

	resolveOperation(
		hostSessionRef: string,
		operationId: string,
		result: RuntimeOperationResultV1,
		nativeSessionRef?: string,
	) {
		return this.file.update((state) => {
			const session = state.sessions[hostSessionRef] ?? storeCorrupted();
			const operation = session.operations[operationId] ?? storeCorrupted();
			operation.state = "resolved";
			operation.result = result;
			if (nativeSessionRef) session.nativeSessionRef = nativeSessionRef;
			return {
				session: structuredClone(session),
				operation: structuredClone(operation),
			};
		});
	}

	getSessionForQuery(
		hostSessionRef: string,
		binding: SessionBinding & { executionId: string },
		deliveryFence: number,
	) {
		const state = this.file.read();
		assertStoreState(state);
		const session = sessionFor(state, hostSessionRef, binding);
		if (
			session.highestFences[`execution:${binding.executionId}`] !==
			deliveryFence
		) {
			throw new RuntimeHostError(
				"RUNTIME_FENCE_STALE",
				"Runtime delivery fence is stale",
				409,
			);
		}
		return session;
	}

	activateGenerationBarrier(
		hostSessionRef: string,
		binding: SessionBinding,
		tombstoneId: string,
	) {
		return this.file.update((state) => {
			const session = sessionFor(state, hostSessionRef, binding, true);
			if (
				session.generationBarrier &&
				(session.generationBarrier.generation !== binding.sessionGeneration ||
					session.generationBarrier.tombstoneId !== tombstoneId)
			) {
				throw new RuntimeHostError(
					"RUNTIME_GENERATION_BARRIER_CONFLICT",
					"Runtime generation is already isolated",
					409,
				);
			}
			session.generationBarrier ??= {
				generation: binding.sessionGeneration,
				tombstoneId,
				state: "active",
			};
			return structuredClone(session);
		});
	}

	confirmGenerationBarrier(hostSessionRef: string, tombstoneId: string) {
		return this.file.update((state) => {
			const session = state.sessions[hostSessionRef] ?? storeCorrupted();
			if (session.generationBarrier?.tombstoneId !== tombstoneId)
				storeCorrupted();
			session.generationBarrier.state = "confirmed";
		});
	}
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, sortValue(entry)]),
	);
}

export function requestDigest(value: unknown) {
	return createHash("sha256")
		.update(JSON.stringify(sortValue(value)))
		.digest("base64url");
}
