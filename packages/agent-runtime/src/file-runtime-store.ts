import { createHash, randomUUID } from "node:crypto";

import {
	type RuntimeDriverCommandV1,
	RuntimeDriverCommandV1Schema,
	type RuntimeDriverSubmitTurnCommandV2,
	RuntimeDriverSubmitTurnCommandV2Schema,
	type RuntimeExecutionGrantClaimsV2,
	type RuntimeOperationResultV1,
	RuntimeOperationResultV1Schema,
	type RuntimeOperationResultV2,
	RuntimeOperationResultV2Schema,
	type RuntimePrincipalV1,
} from "@agent-infra/contracts/runtime";
import type {
	RuntimeExternalActionAuthorization,
	RuntimeOriginalEvidenceBinding,
} from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";
import {
	applyRuntimeAuthority,
	assertSessionAuthority,
	type RuntimeExecutionAuthority,
	type RuntimeOriginalExecutionRef,
	type RuntimeSessionAuthority,
	runtimeAuthorizationDenied,
	validStoredAuthority,
	validStoredExecutionAuthority,
} from "./runtime-authorization.js";

const maximumAcknowledgedCursors = 256;

interface SessionBinding {
	principal?: RuntimePrincipalV1;
	channelId?: string;
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
	command: RuntimeDriverCommandV1 | RuntimeDriverSubmitTurnCommandV2;
	state: "prepared" | "resolved";
	result?: RuntimeOperationResultV1 | RuntimeOperationResultV2;
}

export interface StoredSession extends SessionBinding {
	authority?: RuntimeSessionAuthority;
	executionAuthorities?: Record<string, RuntimeExecutionAuthority>;
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

type RuntimeStoreClock = number | (() => number);

interface PrepareOperation {
	authorization?: RuntimeExecutionGrantClaimsV2;
	now?: RuntimeStoreClock;
	requestedHostSessionRef?: string;
	binding: SessionBinding & { executionId: string; turnId: string };
	operationId: string;
	kind: StoredOperation["kind"];
	scope: string;
	deliveryFence: number;
	requestDigest: string;
	executionDeliveryFence?: number;
	command: (
		nativeSessionRef?: string,
	) => RuntimeDriverCommandV1 | RuntimeDriverSubmitTurnCommandV2;
}

type RecoverOperation = Omit<PrepareOperation, "command"> & {
	requestedHostSessionRef: string;
};

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
			"authority",
			"executionAuthorities",
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
		(session.authority !== undefined &&
			!validStoredAuthority(session.authority)) ||
		(session.executionAuthorities !== undefined &&
			(!session.authority ||
				!isPlainRecord(session.executionAuthorities) ||
				Object.values(session.executionAuthorities).some(
					(entry) => !validStoredExecutionAuthority(entry),
				))) ||
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
			!(
				operation.command.schemaVersion === 2
					? RuntimeDriverSubmitTurnCommandV2Schema
					: RuntimeDriverCommandV1Schema
			).safeParse(operation.command).success ||
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
				? !(
						operation.command.schemaVersion === 2
							? RuntimeOperationResultV2Schema
							: RuntimeOperationResultV1Schema
					).safeParse(operation.result).success
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

function assertMigrationControlRecord(
	authority: RuntimeSessionAuthority | undefined,
	claims: RuntimeExecutionGrantClaimsV2,
) {
	if (
		authority?.migrationId !== undefined &&
		claims.purpose === "control" &&
		claims.controlRecordId !== authority.migrationId
	)
		runtimeAuthorizationDenied();
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
	if (session.authority || binding.principal)
		assertSessionAuthority(session.authority, binding);
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

	async close() {
		await this.file.close();
	}

	sessionQueueKey(binding: SessionBinding) {
		return sessionBindingKey(binding);
	}

	nativeSessionRef(hostSessionRef: string) {
		const state = this.file.read();
		assertStoreState(state);
		return (state.sessions[hostSessionRef] ?? storeCorrupted())
			.nativeSessionRef;
	}

	prepareOperation(input: PrepareOperation) {
		return this.file.update((state) => {
			const now =
				typeof input.now === "function"
					? input.now()
					: (input.now ?? Date.now());
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
					...(input.authorization
						? {
								authority: {
									principal: input.authorization.principal,
									channelId: input.authorization.channelId,
								},
								executionAuthorities: {},
							}
						: {}),
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
			if (input.authorization) {
				assertSessionAuthority(session.authority, input.binding);
				assertMigrationControlRecord(session.authority, input.authorization);
				const resolvedReplay =
					operation?.state === "resolved" &&
					operation.requestDigest === input.requestDigest;
				// A retry of an already-resolved operation only reads its durable
				// receipt. Recovery query authority must not turn that read into a
				// fresh business authorization decision.
				if (!resolvedReplay) {
					session.executionAuthorities ??= {};
					applyRuntimeAuthority(
						session.executionAuthorities,
						input.authorization,
						"prepare",
						now,
					);
				}
			}
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
				.filter((operation) => {
					// Once isolation starts, recover only its control operation. A confirmed
					// barrier preserves history without reviving any retired generation work.
					if (session.generationBarrier) {
						return (
							session.generationBarrier.state === "active" &&
							session.generationBarrier.tombstoneId === operation.operationId
						);
					}
					return (
						operation.state === "prepared" ||
						(session.recovery?.status === "blocked" &&
							session.recovery.operationId === operation.operationId) ||
						(operation.result?.outcome === "accepted" &&
							["running", "unknown"].includes(operation.result.status))
					);
				})
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
		result: RuntimeOperationResultV1 | RuntimeOperationResultV2,
		nativeSessionRef?: string,
	) {
		return this.file.update((state) => {
			const session = state.sessions[hostSessionRef] ?? storeCorrupted();
			const operation = session.operations[operationId] ?? storeCorrupted();
			if (
				nativeSessionRef &&
				session.nativeSessionRef &&
				nativeSessionRef !== session.nativeSessionRef
			) {
				throw new RuntimeHostError(
					"RUNTIME_DRIVER_INVALID",
					"Runtime Driver response is invalid",
					503,
					true,
				);
			}
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

	recoverOperation(input: RecoverOperation) {
		return this.file.update((state) => {
			assertStoreState(state);
			const session = sessionFor(
				state,
				input.requestedHostSessionRef,
				input.binding,
			);
			const currentFence = session.highestFences[input.scope] ?? 0;
			if (
				!Number.isSafeInteger(input.deliveryFence) ||
				input.deliveryFence < 1 ||
				input.deliveryFence < currentFence
			) {
				throw new RuntimeHostError(
					"RUNTIME_FENCE_STALE",
					"Runtime delivery fence is stale",
					409,
				);
			}
			const operation = session.operations[input.operationId];
			if (!operation) {
				session.highestFences[input.scope] = input.deliveryFence;
				return undefined;
			}
			if (
				operation.requestDigest !== input.requestDigest ||
				operation.kind !== input.kind ||
				operation.scope !== input.scope
			) {
				throw new RuntimeHostError(
					"RUNTIME_OPERATION_CONFLICT",
					"Runtime operation was retried with different content",
					409,
				);
			}
			assertExecutionBinding(session, input.binding);
			if (input.deliveryFence > operation.deliveryFence) {
				operation.deliveryFence = input.deliveryFence;
				session.highestFences[input.scope] = input.deliveryFence;
			}
			return structuredClone(session);
		});
	}

	// Protected migration input comes from the Platform producer history, never an HTTP caller.
	migrateLegacyPrincipal(input: {
		migrationId: string;
		hostSessionRef: string;
		agentId: string;
		conversationId: string;
		sessionGeneration: number;
		principal: RuntimePrincipalV1;
		channelId: string;
		executions: {
			executionId: string;
			turnId: string;
			originalOperationDigest: string;
		}[];
	}) {
		return this.file.update((state) => {
			assertStoreState(state);
			const session = state.sessions[input.hostSessionRef];
			if (
				!input.migrationId ||
				!session ||
				session.agentId !== input.agentId ||
				session.conversationId !== input.conversationId ||
				session.sessionGeneration !== input.sessionGeneration ||
				input.principal.kind !== "user"
			)
				runtimeAuthorizationDenied();
			const authority = {
				principal: input.principal,
				channelId: input.channelId,
				migrationId: input.migrationId,
			};
			if (!validStoredAuthority(authority)) runtimeAuthorizationDenied();
			if (session.authority) {
				assertSessionAuthority(session.authority, input);
				if (session.authority.migrationId !== input.migrationId)
					runtimeAuthorizationDenied();
				return;
			}
			const executions = Object.values(session.operations).filter(
				(entry) => entry.kind === "submit-turn",
			);
			if (
				!executions.length ||
				executions.length !== input.executions.length ||
				new Set(input.executions.map((entry) => entry.executionId)).size !==
					executions.length
			)
				runtimeAuthorizationDenied();
			for (const execution of executions) {
				const evidence = input.executions.find(
					(entry) => entry.executionId === execution.executionId,
				);
				if (
					!evidence ||
					evidence.turnId !== execution.turnId ||
					evidence.originalOperationDigest !== execution.requestDigest
				)
					runtimeAuthorizationDenied();
			}
			session.authority = authority;
			session.executionAuthorities = {};
		});
	}

	// Persist an absence fence even when the first submit response and Host reference were lost.
	recoverOperationV3(
		claims: RuntimeExecutionGrantClaimsV2,
		originalOperationDigest: string,
		now: RuntimeStoreClock = Date.now,
	) {
		return this.file.update((state) => {
			const currentNow = typeof now === "function" ? now() : now;
			assertStoreState(state);
			const indexed = state.sessionBindings[sessionBindingKey(claims)];
			const ref = claims.hostSessionRef ?? indexed;
			let session: StoredSession;
			if (ref) {
				session = sessionFor(state, ref, claims, true);
			} else {
				const hostSessionRef = randomUUID();
				session = {
					hostSessionRef,
					agentId: claims.agentId,
					conversationId: claims.conversationId,
					sessionGeneration: claims.sessionGeneration,
					authority: {
						principal: claims.principal,
						channelId: claims.channelId,
					},
					executionAuthorities: {},
					highestFences: {},
					operations: {},
				};
				state.sessions[hostSessionRef] = session;
				state.sessionBindings[sessionBindingKey(claims)] = hostSessionRef;
			}
			assertSessionAuthority(session.authority, claims);
			assertMigrationControlRecord(session.authority, claims);
			const scope = `execution:${claims.executionId}`;
			const fence = claims.operation.executionDeliveryFence;
			if (fence < (session.highestFences[scope] ?? 0))
				runtimeAuthorizationDenied();
			const operation = session.operations[claims.executionId];
			if (
				operation &&
				(operation.kind !== "submit-turn" ||
					operation.turnId !== claims.turnId ||
					operation.requestDigest !== originalOperationDigest)
			)
				runtimeAuthorizationDenied();
			session.executionAuthorities ??= {};
			const authority = applyRuntimeAuthority(
				session.executionAuthorities,
				claims,
				"query",
				currentNow,
			);
			// Recovery is the durable absence-fence path. Persist its query
			// authority explicitly after the verified session/migration checks.
			session.executionAuthorities[claims.executionId] = authority;
			session.highestFences[scope] = fence;
			if (operation) operation.deliveryFence = fence;
			return { session: structuredClone(session), found: !!operation };
		});
	}

	authorizeRequestV3(
		claims: RuntimeExecutionGrantClaimsV2,
		mode: "query" | "renew" | "generation-cancel" = "query",
		now: RuntimeStoreClock = Date.now,
	) {
		return this.file.update((state) => {
			const currentNow = typeof now === "function" ? now() : now;
			assertStoreState(state);
			if (!claims.hostSessionRef) runtimeAuthorizationDenied();
			const session = sessionFor(
				state,
				claims.hostSessionRef,
				claims,
				claims.purpose === "control",
			);
			assertExecutionBinding(session, claims);
			assertSessionAuthority(session.authority, claims);
			assertMigrationControlRecord(session.authority, claims);
			const executionScope = `execution:${claims.executionId}`;
			const executionFence = claims.operation.executionDeliveryFence;
			if (mode === "generation-cancel") {
				const scope = `generation:${claims.sessionGeneration}`;
				const operation = session.operations[claims.operation.id];
				const control =
					session.executionAuthorities?.[claims.executionId]?.control;
				if (
					claims.purpose !== "control" ||
					claims.reason !== "generation_isolation" ||
					claims.allowedCommands[0] !== "generation.cancel" ||
					claims.operation.kind !== "generation" ||
					executionFence < (session.highestFences[executionScope] ?? 0) ||
					claims.operation.deliveryFence <
						(session.highestFences[scope] ?? 0) ||
					(!operation &&
						claims.operation.deliveryFence === session.highestFences[scope]) ||
					(session.generationBarrier &&
						(session.generationBarrier.generation !==
							claims.sessionGeneration ||
							session.generationBarrier.tombstoneId !== claims.operation.id)) ||
					(control?.reason === "generation_isolation" &&
						control.controlRecordId !== claims.controlRecordId) ||
					(operation &&
						(operation.kind !== "generation-cancel" ||
							operation.scope !== scope ||
							operation.executionId !== claims.executionId ||
							operation.turnId !== claims.turnId ||
							operation.requestDigest !==
								requestDigest({
									kind: "generation-cancel",
									agentId: claims.agentId,
									conversationId: claims.conversationId,
									executionId: claims.executionId,
									turnId: claims.turnId,
									sessionGeneration: claims.sessionGeneration,
									tombstoneId: claims.operation.id,
								})))
				)
					runtimeAuthorizationDenied();
			} else if (session.highestFences[executionScope] !== executionFence)
				runtimeAuthorizationDenied();
			if (mode === "renew") {
				const execution = session.operations[claims.executionId];
				if (
					claims.purpose !== "business" ||
					execution?.result?.outcome !== "accepted" ||
					!["running", "unknown"].includes(execution.result.status)
				)
					runtimeAuthorizationDenied();
			}
			session.executionAuthorities ??= {};
			const authority = applyRuntimeAuthority(
				session.executionAuthorities,
				claims,
				mode === "generation-cancel" ? "query" : mode,
				currentNow,
			);
			if (mode === "generation-cancel") {
				// The isolation claim advances the original Turn's fence without recovering it.
				session.highestFences[executionScope] = executionFence;
				const execution =
					session.operations[claims.executionId] ?? storeCorrupted();
				execution.deliveryFence = executionFence;
			}
			return {
				session: structuredClone(session),
				authority: structuredClone(authority),
			};
		});
	}

	checkRequestV3(claims: RuntimeExecutionGrantClaimsV2) {
		const state = this.file.read();
		assertStoreState(state);
		if (!claims.hostSessionRef) runtimeAuthorizationDenied();
		const session = sessionFor(
			state,
			claims.hostSessionRef,
			claims,
			claims.purpose === "control",
		);
		assertExecutionBinding(session, claims);
		const authority = session.executionAuthorities?.[claims.executionId];
		if (
			!authority ||
			authority.workerId !== claims.workerId ||
			session.highestFences[`execution:${claims.executionId}`] !==
				claims.operation.executionDeliveryFence
		)
			runtimeAuthorizationDenied();
		if (
			claims.purpose === "business" &&
			(authority.stopped ||
				authority.control !== undefined ||
				authority.authorizationRecordId !== claims.authorizationRecordId)
		)
			runtimeAuthorizationDenied();
		if (
			claims.purpose === "control" &&
			authority.control?.controlRecordId !== claims.controlRecordId
		)
			runtimeAuthorizationDenied();
		return session;
	}

	/** Query high-water mark is independent of business authorization expiry. */
	latchOriginalEvidenceQuery(
		claims: RuntimeExecutionGrantClaimsV2,
		requestId: string,
	) {
		if (
			typeof requestId !== "string" ||
			requestId.length === 0 ||
			requestId.length > 1024
		)
			runtimeAuthorizationDenied();
		return this.file.update((state) => {
			const checked = this.checkRequestV3(claims);
			if (
				checked.generationBarrier ||
				!checked.nativeSessionRef ||
				(!claims.allowedCommands.includes("session.status") &&
					!claims.allowedCommands.includes("events.persist")) ||
				(claims.purpose === "control" &&
					claims.reason === "generation_isolation")
			)
				runtimeAuthorizationDenied();
			const session = state.sessions[checked.hostSessionRef];
			const authority = session?.executionAuthorities?.[claims.executionId];
			if (!authority) runtimeAuthorizationDenied();
			const previous = authority.evidenceQuery;
			if (
				previous &&
				previous.requestId !== requestId &&
				claims.issuedAt <= previous.issuedAt
			)
				runtimeAuthorizationDenied();
			authority.evidenceQuery = {
				requestId,
				issuedAt: Math.max(previous?.issuedAt ?? 0, claims.issuedAt),
			};
			return previous ? { ...previous } : undefined;
		});
	}

	/** Restore the previous evidence-query latch after an unsuccessful native read. */
	restoreOriginalEvidenceQuery(
		claims: RuntimeExecutionGrantClaimsV2,
		requestId: string,
		previous: { requestId: string; issuedAt: number } | undefined,
	) {
		return this.file.update((state) => {
			const checked = this.checkRequestV3(claims);
			const session = state.sessions[checked.hostSessionRef];
			const authority = session?.executionAuthorities?.[claims.executionId];
			if (!authority || authority.evidenceQuery?.requestId !== requestId)
				return;
			if (previous) authority.evidenceQuery = { ...previous };
			else delete authority.evidenceQuery;
		});
	}

	/** Read only the original accepted submit; never consult its old business lease. */
	assertOriginalEvidenceBinding(
		claims: RuntimeExecutionGrantClaimsV2,
		requestId: string,
		nativeSessionRef: string,
		originalOperationDigest: string,
	): RuntimeOriginalEvidenceBinding {
		const session = this.checkRequestV3(claims);
		const original = session.operations[claims.executionId];
		if (
			session.generationBarrier ||
			session.nativeSessionRef !== nativeSessionRef ||
			session.executionAuthorities?.[claims.executionId]?.evidenceQuery
				?.requestId !== requestId ||
			original?.kind !== "submit-turn" ||
			original.turnId !== claims.turnId ||
			original.requestDigest !== originalOperationDigest ||
			original.command.executionId !== claims.executionId ||
			original.command.agentId !== claims.agentId ||
			original.command.conversationId !== claims.conversationId ||
			original.command.sessionGeneration !== claims.sessionGeneration
		)
			runtimeAuthorizationDenied();
		return {
			principal: { ...claims.principal },
			scope: {
				agentId: claims.agentId,
				conversationId: claims.conversationId,
				executionId: claims.executionId,
				sessionGeneration: claims.sessionGeneration,
			},
		};
	}

	recordDeliveredCursor(
		claims: RuntimeExecutionGrantClaimsV2,
		cursor: string,
		now: RuntimeStoreClock = Date.now,
	) {
		return this.file.update((state) => {
			const currentNow = typeof now === "function" ? now() : now;
			if (!claims.hostSessionRef) runtimeAuthorizationDenied();
			const session = sessionFor(
				state,
				claims.hostSessionRef,
				claims,
				claims.purpose === "control",
			);
			const authority = session.executionAuthorities?.[claims.executionId];
			if (
				!authority ||
				authority.expiresAt <= currentNow ||
				claims.expiresAt <= currentNow ||
				authority.executionDeliveryFence !==
					claims.operation.executionDeliveryFence ||
				authority.workerId !== claims.workerId ||
				session.highestFences[`execution:${claims.executionId}`] !==
					claims.operation.executionDeliveryFence
			)
				runtimeAuthorizationDenied();
			if (
				claims.purpose === "business" &&
				(authority.stopped ||
					authority.control !== undefined ||
					authority.authorizationRecordId !== claims.authorizationRecordId)
			)
				runtimeAuthorizationDenied();
			if (
				claims.purpose === "control" &&
				(authority.control?.controlRecordId !== claims.controlRecordId ||
					authority.control.reason !== claims.reason)
			)
				runtimeAuthorizationDenied();
			if (
				!authority.deliveredCursors.includes(cursor) &&
				!authority.acknowledgedCursors?.includes(cursor) &&
				authority.confirmedCursor !== cursor
			) {
				if (authority.deliveredCursors.length >= maximumAcknowledgedCursors)
					runtimeAuthorizationDenied();
				authority.deliveredCursors.push(cursor);
			}
		});
	}

	checkAcknowledgableCursor(
		claims: RuntimeExecutionGrantClaimsV2,
		cursor: string,
	) {
		const session = this.checkRequestV3(claims);
		const authority = session.executionAuthorities?.[claims.executionId];
		if (
			!authority ||
			(authority.confirmedCursor !== cursor &&
				!authority.acknowledgedCursors?.includes(cursor) &&
				!authority.deliveredCursors.includes(cursor))
		)
			runtimeAuthorizationDenied();
		return session;
	}

	acknowledgeCursor(
		claims: RuntimeExecutionGrantClaimsV2,
		cursor: string,
		now: RuntimeStoreClock = Date.now,
	) {
		return this.file.update((state) => {
			const currentNow = typeof now === "function" ? now() : now;
			if (!claims.hostSessionRef) runtimeAuthorizationDenied();
			const session = sessionFor(
				state,
				claims.hostSessionRef,
				claims,
				claims.purpose === "control",
			);
			const authority = session.executionAuthorities?.[claims.executionId];
			if (
				!authority ||
				authority.expiresAt <= currentNow ||
				claims.expiresAt <= currentNow ||
				authority.executionDeliveryFence !==
					claims.operation.executionDeliveryFence ||
				authority.workerId !== claims.workerId ||
				session.highestFences[`execution:${claims.executionId}`] !==
					claims.operation.executionDeliveryFence
			)
				runtimeAuthorizationDenied();
			if (
				claims.purpose === "business" &&
				(authority.stopped ||
					authority.control !== undefined ||
					authority.authorizationRecordId !== claims.authorizationRecordId)
			)
				runtimeAuthorizationDenied();
			if (
				claims.purpose === "control" &&
				(authority.control?.controlRecordId !== claims.controlRecordId ||
					authority.control.reason !== claims.reason)
			)
				runtimeAuthorizationDenied();
			if (
				authority.confirmedCursor === cursor ||
				authority.acknowledgedCursors?.includes(cursor)
			)
				return;
			const index = authority.deliveredCursors.indexOf(cursor);
			if (index < 0) runtimeAuthorizationDenied();
			authority.confirmedCursor = cursor;
			authority.acknowledgedCursors ??= [];
			authority.acknowledgedCursors.push(
				...authority.deliveredCursors.splice(0, index + 1),
			);
			if (authority.acknowledgedCursors.length > maximumAcknowledgedCursors)
				authority.acknowledgedCursors.splice(
					0,
					authority.acknowledgedCursors.length - maximumAcknowledgedCursors,
				);
		});
	}

	authorizePreparedOperation(
		hostSessionRef: string,
		operation: StoredOperation,
		now: number,
	) {
		const state = this.file.read();
		assertStoreState(state);
		const session = state.sessions[hostSessionRef];
		const authority = session?.executionAuthorities?.[operation.executionId];
		if (
			!session?.authority ||
			!authority?.authorizationRecordId ||
			session.generationBarrier ||
			authority.stopped ||
			authority.control !== undefined ||
			authority.expiresAt <= now ||
			authority.issuedAt > now ||
			authority.executionDeliveryFence !==
				session.highestFences[`execution:${operation.executionId}`]
		)
			runtimeAuthorizationDenied();
	}

	async authorizeExternalAction(
		action: RuntimeExternalActionAuthorization,
		readNow: () => number,
	) {
		if (
			!action.nativeSessionRef ||
			!action.executionId ||
			!action.runtimeOperationId ||
			!action.operationRef ||
			!action.attemptRef ||
			(action.kind !== "model" && action.kind !== "tool")
		)
			runtimeAuthorizationDenied();
		await this.authorizedOriginalExecution(action, readNow);
	}

	async resolveOriginalExecutionBinding(
		reference: RuntimeOriginalExecutionRef,
		readNow: () => number,
	) {
		const session = await this.authorizedOriginalExecution(
			{ ...reference, runtimeOperationId: reference.executionId },
			readNow,
		);
		if (
			session.agentId !== reference.agentId ||
			session.conversationId !== reference.conversationId ||
			session.sessionGeneration !== reference.sessionGeneration ||
			!session.authority
		)
			runtimeAuthorizationDenied();
		return {
			principal: structuredClone(session.authority.principal),
			scope: {
				agentId: session.agentId,
				conversationId: session.conversationId,
				sessionGeneration: session.sessionGeneration,
				executionId: reference.executionId,
			},
		};
	}

	private async authorizedOriginalExecution(
		action: {
			nativeSessionRef?: string;
			executionId: string;
			runtimeOperationId: string;
		},
		readNow: () => number,
	) {
		const state = await this.file.readCommitted();
		assertStoreState(state);
		// A queued durable write may outlive the Grant being checked.
		const now = readNow();
		const candidates = Object.values(state.sessions).filter(
			(entry) =>
				entry.operations[action.runtimeOperationId]?.kind === "submit-turn" &&
				entry.operations[action.runtimeOperationId]?.executionId ===
					action.executionId &&
				(action.nativeSessionRef === undefined ||
					entry.nativeSessionRef === action.nativeSessionRef),
		);
		if (candidates.length !== 1) runtimeAuthorizationDenied();
		const session = candidates[0];
		if (
			!session?.authority ||
			session.generationBarrier ||
			(action.nativeSessionRef !== undefined &&
				session.nativeSessionRef !== action.nativeSessionRef)
		)
			runtimeAuthorizationDenied();
		const authority = session.executionAuthorities?.[action.executionId];
		if (
			!authority?.authorizationRecordId ||
			authority.stopped ||
			authority.control !== undefined ||
			authority.expiresAt <= now ||
			authority.issuedAt > now ||
			authority.executionDeliveryFence !==
				session.highestFences[`execution:${action.executionId}`]
		)
			runtimeAuthorizationDenied();
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
