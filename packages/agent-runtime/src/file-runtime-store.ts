import { createHash, randomUUID } from "node:crypto";

import {
	type RuntimeDriverCommandV1,
	RuntimeDriverCommandV1Schema,
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
	command: RuntimeDriverCommandV1;
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
	recovery?: {
		status: "blocked";
		operationId: string;
		reason: "driver-unavailable";
	};
}

interface RuntimeStoreState {
	schemaVersion: 1;
	sessionBindings: Record<string, string>;
	sessions: Record<string, StoredSession>;
	quarantinedSessions: Record<string, unknown>;
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
	command: (nativeSessionRef?: string) => RuntimeDriverCommandV1;
}

function storeCorrupted(): never {
	throw new RuntimeHostError(
		"RUNTIME_STORE_CORRUPTED",
		"Runtime session state is unavailable",
		503,
	);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function hasOnlyKeys(value: object, allowed: readonly string[]) {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function sessionBindingKey(
	binding: Pick<SessionBinding, "agentId" | "conversationId">,
) {
	return JSON.stringify([binding.agentId, binding.conversationId]);
}

function isSessionBindingKey(value: string) {
	try {
		const parsed = JSON.parse(value) as unknown;
		return (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			parsed.every((entry) => typeof entry === "string" && entry.length > 0) &&
			JSON.stringify(parsed) === value
		);
	} catch {
		return false;
	}
}

function assertRootState(value: RuntimeStoreState) {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, [
			"schemaVersion",
			"sessionBindings",
			"sessions",
			"quarantinedSessions",
		]) ||
		value.schemaVersion !== 1 ||
		(value.sessionBindings !== undefined &&
			!isPlainRecord(value.sessionBindings)) ||
		!isPlainRecord(value.sessions) ||
		(value.quarantinedSessions !== undefined &&
			!isPlainRecord(value.quarantinedSessions))
	) {
		storeCorrupted();
	}
	value.sessionBindings ??= {};
	value.quarantinedSessions ??= {};
	if (
		Object.keys(value.sessions).some((hostSessionRef) =>
			Object.hasOwn(value.quarantinedSessions, hostSessionRef),
		)
	) {
		storeCorrupted();
	}
}

function assertBindingIndex(value: RuntimeStoreState) {
	const boundSessionRefs = new Set<string>();
	for (const [key, hostSessionRef] of Object.entries(value.sessionBindings)) {
		if (
			!isSessionBindingKey(key) ||
			!hostSessionRef ||
			boundSessionRefs.has(hostSessionRef) ||
			(!Object.hasOwn(value.sessions, hostSessionRef) &&
				!Object.hasOwn(value.quarantinedSessions, hostSessionRef))
		) {
			storeCorrupted();
		}
		boundSessionRefs.add(hostSessionRef);
	}
}

function assertSessionRecord(hostSessionRef: string, session: StoredSession) {
	if (
		!isPlainRecord(session) ||
		!hasOnlyKeys(session, [
			"hostSessionRef",
			"agentId",
			"conversationId",
			"sessionGeneration",
			"nativeSessionRef",
			"highestFences",
			"operations",
			"generationBarrier",
			"recovery",
		]) ||
		session.hostSessionRef !== hostSessionRef ||
		!session.agentId ||
		!session.conversationId ||
		!Number.isSafeInteger(session.sessionGeneration) ||
		session.sessionGeneration < 1 ||
		!isPlainRecord(session.highestFences) ||
		!isPlainRecord(session.operations) ||
		(session.nativeSessionRef !== undefined && !session.nativeSessionRef) ||
		Object.entries(session.highestFences).some(
			([scope, fence]) => !scope || !Number.isSafeInteger(fence) || fence < 1,
		) ||
		(session.generationBarrier !== undefined &&
			(!isPlainRecord(session.generationBarrier) ||
				!hasOnlyKeys(session.generationBarrier, [
					"generation",
					"tombstoneId",
					"state",
				]) ||
				session.generationBarrier.generation !== session.sessionGeneration ||
				!session.generationBarrier.tombstoneId ||
				!(["active", "confirmed"] as const).includes(
					session.generationBarrier.state,
				))) ||
		(session.recovery !== undefined &&
			(!isPlainRecord(session.recovery) ||
				!hasOnlyKeys(session.recovery, ["status", "operationId", "reason"]) ||
				session.recovery.status !== "blocked" ||
				!session.recovery.operationId ||
				session.recovery.reason !== "driver-unavailable"))
	) {
		storeCorrupted();
	}
	for (const [operationId, operation] of Object.entries(session.operations)) {
		if (!isPlainRecord(operation)) storeCorrupted();
		const expectedScope =
			operation.kind === "submit-turn"
				? `execution:${operation.executionId}`
				: operation.kind === "supplement"
					? `message:${operation.operationId}`
					: operation.kind === "stop"
						? `stop:${operation.operationId}`
						: operation.kind === "generation-cancel"
							? `generation:${session.sessionGeneration}`
							: undefined;
		if (
			!hasOnlyKeys(operation, [
				"operationId",
				"kind",
				"executionId",
				"turnId",
				"scope",
				"deliveryFence",
				"requestDigest",
				"command",
				"state",
				"result",
			]) ||
			operation.operationId !== operationId ||
			!operation.executionId ||
			!operation.turnId ||
			!operation.scope ||
			!operation.requestDigest ||
			!RuntimeDriverCommandV1Schema.safeParse(operation.command).success ||
			operation.command.operationId !== operation.operationId ||
			operation.command.kind !== operation.kind ||
			operation.command.agentId !== session.agentId ||
			operation.command.conversationId !== session.conversationId ||
			operation.command.sessionGeneration !== session.sessionGeneration ||
			operation.command.executionId !== operation.executionId ||
			operation.command.turnId !== operation.turnId ||
			("nativeSessionRef" in operation.command &&
				session.nativeSessionRef !== undefined &&
				operation.command.nativeSessionRef !== session.nativeSessionRef) ||
			!expectedScope ||
			operation.scope !== expectedScope ||
			!Number.isSafeInteger(operation.deliveryFence) ||
			operation.deliveryFence < 1 ||
			(session.highestFences[operation.scope] ?? 0) < operation.deliveryFence ||
			(operation.state === "resolved"
				? !RuntimeOperationResultV1Schema.safeParse(operation.result).success
				: operation.state !== "prepared" || operation.result !== undefined)
		) {
			storeCorrupted();
		}
	}
	if (
		(session.generationBarrier !== undefined &&
			!session.operations[session.generationBarrier.tombstoneId]) ||
		(session.recovery !== undefined &&
			!session.operations[session.recovery.operationId])
	) {
		storeCorrupted();
	}
}

function assertStoreState(value: RuntimeStoreState) {
	assertRootState(value);
	assertBindingIndex(value);
	const conversationKeys = new Set<string>();
	for (const [hostSessionRef, session] of Object.entries(value.sessions)) {
		assertSessionRecord(hostSessionRef, session);
		const conversationKey = `${session.agentId}\u0000${session.conversationId}`;
		if (
			conversationKeys.has(conversationKey) ||
			value.sessionBindings[sessionBindingKey(session)] !== hostSessionRef
		) {
			storeCorrupted();
		}
		conversationKeys.add(conversationKey);
	}
}

function sessionFor(
	state: RuntimeStoreState,
	hostSessionRef: string,
	binding: SessionBinding,
	allowGenerationBarrier = false,
) {
	if (state.sessionBindings[sessionBindingKey(binding)] !== hostSessionRef) {
		throw new RuntimeHostError(
			"RUNTIME_SESSION_BINDING_MISMATCH",
			"Runtime session does not match this request",
			403,
		);
	}
	if (Object.hasOwn(state.quarantinedSessions, hostSessionRef)) {
		throw new RuntimeHostError(
			"RUNTIME_SESSION_QUARANTINED",
			"Runtime session state is quarantined",
			503,
		);
	}
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

function assertExecutionBinding(
	session: StoredSession,
	binding: { executionId: string; turnId: string },
) {
	const execution = session.operations[binding.executionId];
	if (
		execution?.kind !== "submit-turn" ||
		execution.executionId !== binding.executionId ||
		execution.turnId !== binding.turnId
	) {
		throw new RuntimeHostError(
			"RUNTIME_EXECUTION_BINDING_MISMATCH",
			"Runtime execution does not match this request",
			403,
		);
	}
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
				sessionBindings: {},
				sessions: {},
				quarantinedSessions: {},
			});
			await file.update((state) => {
				const hadBindingIndex = Object.hasOwn(state, "sessionBindings");
				assertRootState(state);
				if (!hadBindingIndex) {
					if (Object.keys(state.quarantinedSessions).length > 0) {
						storeCorrupted();
					}
					for (const [hostSessionRef, session] of Object.entries(
						state.sessions,
					)) {
						if (
							!isPlainRecord(session) ||
							typeof session.agentId !== "string" ||
							!session.agentId ||
							typeof session.conversationId !== "string" ||
							!session.conversationId
						) {
							storeCorrupted();
						}
						const key = sessionBindingKey({
							agentId: session.agentId,
							conversationId: session.conversationId,
						});
						if (state.sessionBindings[key]) storeCorrupted();
						state.sessionBindings[key] = hostSessionRef;
					}
				}
				assertBindingIndex(state);
				const invalidSessionRefs = new Set<string>();
				const sessionsByConversation = new Map<string, string[]>();
				for (const [hostSessionRef, session] of Object.entries(
					state.sessions,
				)) {
					try {
						assertSessionRecord(hostSessionRef, session);
						const key = `${session.agentId}\u0000${session.conversationId}`;
						if (
							state.sessionBindings[sessionBindingKey(session)] !==
							hostSessionRef
						) {
							invalidSessionRefs.add(hostSessionRef);
							continue;
						}
						const refs = sessionsByConversation.get(key) ?? [];
						refs.push(hostSessionRef);
						sessionsByConversation.set(key, refs);
					} catch {
						invalidSessionRefs.add(hostSessionRef);
					}
				}
				for (const refs of sessionsByConversation.values()) {
					if (refs.length > 1) {
						for (const hostSessionRef of refs) {
							invalidSessionRefs.add(hostSessionRef);
						}
					}
				}
				for (const hostSessionRef of invalidSessionRefs) {
					const session = state.sessions[hostSessionRef];
					if (session === undefined) storeCorrupted();
					state.quarantinedSessions[hostSessionRef] = session;
					delete state.sessions[hostSessionRef];
				}
				assertStoreState(state);
			});
		} catch (error) {
			if (error instanceof RuntimeHostError) throw error;
			storeCorrupted();
		}
		return new FileRuntimeStore(file);
	}

	sessionQueueKey(
		requestedHostSessionRef: string | undefined,
		binding: SessionBinding,
	) {
		if (requestedHostSessionRef) return requestedHostSessionRef;
		const state = this.file.read();
		assertStoreState(state);
		const key = sessionBindingKey(binding);
		return state.sessionBindings[key] ?? key;
	}

	prepareOperation(input: PrepareOperation) {
		return this.file.update((state) => {
			assertStoreState(state);
			const indexedHostSessionRef =
				state.sessionBindings[sessionBindingKey(input.binding)];
			const hostSessionRef =
				input.requestedHostSessionRef ?? indexedHostSessionRef;
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
				state.sessionBindings[sessionBindingKey(input.binding)] =
					newHostSessionRef;
			}
			if (input.kind !== "submit-turn") {
				assertExecutionBinding(session, input.binding);
			}
			if (
				session.recovery?.status === "blocked" &&
				["submit-turn", "supplement"].includes(input.kind)
			) {
				throw new RuntimeHostError(
					"RUNTIME_SESSION_RECOVERY_BLOCKED",
					"Runtime session recovery has not converged",
					503,
				);
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
				command: input.command(session.nativeSessionRef),
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

	listRecoverableOperations() {
		const state = this.file.read();
		assertStoreState(state);
		return Object.values(state.sessions).flatMap((session) =>
			Object.values(session.operations)
				.filter(
					(operation) =>
						operation.state === "prepared" ||
						(session.generationBarrier?.state === "active" &&
							session.generationBarrier.tombstoneId ===
								operation.operationId) ||
						(session.recovery?.status === "blocked" &&
							session.recovery.operationId === operation.operationId) ||
						(operation.result?.outcome === "accepted" &&
							["running", "unknown"].includes(operation.result.status)),
				)
				.map((operation) => ({
					session: structuredClone(session),
					operation: structuredClone(operation),
				})),
		);
	}

	quarantineSession(hostSessionRef: string) {
		return this.file.update((state) => {
			assertStoreState(state);
			const session = state.sessions[hostSessionRef];
			if (!session) return;
			state.quarantinedSessions[hostSessionRef] = session;
			delete state.sessions[hostSessionRef];
		});
	}

	markRecoveryBlocked(hostSessionRef: string, operationId: string) {
		return this.file.update((state) => {
			assertStoreState(state);
			const session = state.sessions[hostSessionRef];
			if (!session) return;
			session.recovery = {
				status: "blocked",
				operationId,
				reason: "driver-unavailable",
			};
		});
	}

	clearRecoveryBlocked(hostSessionRef: string) {
		return this.file.update((state) => {
			assertStoreState(state);
			const session = state.sessions[hostSessionRef];
			if (session) delete session.recovery;
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
		binding: SessionBinding & { executionId: string; turnId: string },
		deliveryFence: number,
	) {
		const state = this.file.read();
		assertStoreState(state);
		const session = sessionFor(state, hostSessionRef, binding);
		assertExecutionBinding(session, binding);
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
