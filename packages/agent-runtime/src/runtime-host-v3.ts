import {
	type RuntimeAuthorizationRenewRequestV3,
	RuntimeAuthorizationRenewRequestV3Schema,
	type RuntimeEventAckRequestV3,
	RuntimeEventAckRequestV3Schema,
	type RuntimeEventPersistRequestV3,
	RuntimeEventPersistRequestV3Schema,
	RuntimeEventSchema,
	type RuntimeExecutionGrantClaimsV2,
	type RuntimeGenerationCancelRequestV3,
	RuntimeGenerationCancelRequestV3Schema,
	type RuntimeOperationResponseV1,
	type RuntimeOperationResponseV2,
	type RuntimeStatusRequestV3,
	RuntimeStatusRequestV3Schema,
	type RuntimeStatusResponseV3,
	type RuntimeStopRequestV3,
	RuntimeStopRequestV3Schema,
	type RuntimeSubmitTurnRequestV3,
	RuntimeSubmitTurnRequestV3Schema,
	type RuntimeSupplementRequestV3,
	RuntimeSupplementRequestV3Schema,
} from "@agent-infra/contracts/runtime";

import type {
	RuntimeDriver,
	RuntimeOriginalEvidenceReadContext,
} from "./driver.js";
import { RuntimeHostError } from "./errors.js";
import {
	type FileRuntimeStore,
	requestDigest,
	type StoredOperation,
	type StoredSession,
} from "./file-runtime-store.js";
import {
	type RuntimeGrantValidationOptionsV2,
	validateRuntimeExecutionGrantV2,
} from "./grant-v2.js";

interface Options {
	store: FileRuntimeStore;
	driver: RuntimeDriver;
	grantValidation: RuntimeGrantValidationOptionsV2;
	dispatch: (
		hostSessionRef: string,
		operation: StoredOperation,
		allowBusinessExecution?: boolean,
	) => Promise<RuntimeOperationResponseV1 | RuntimeOperationResponseV2>;
	serialize: <T>(key: string, work: () => Promise<T>) => Promise<T>;
}

function nativeRequired(): never {
	throw new RuntimeHostError(
		"RUNTIME_SESSION_UNAVAILABLE",
		"Runtime session could not be recovered",
		503,
	);
}
function invalidDriver(): never {
	throw new RuntimeHostError(
		"RUNTIME_DRIVER_INVALID",
		"Runtime Driver response is invalid",
		503,
		true,
	);
}

function parseRequest<T>(
	schema: {
		safeParse(value: unknown): { success: true; data: T } | { success: false };
	},
	value: unknown,
): T {
	const result = schema.safeParse(value);
	if (!result.success)
		throw new RuntimeHostError(
			"RUNTIME_REQUEST_INVALID",
			"Runtime request is invalid",
			400,
		);
	return result.data;
}

async function abortable<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	let listener: (() => void) | undefined;
	if (signal.aborted) {
		void promise.catch(() => undefined);
		signal.throwIfAborted();
	}
	try {
		signal.throwIfAborted();
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				listener = () => reject(signal.reason);
				signal.addEventListener("abort", listener, { once: true });
			}),
		]);
	} finally {
		if (listener) signal.removeEventListener("abort", listener);
	}
}

export class RuntimeHostV3 {
	private readonly recoveryGuards = new Map<
		string,
		Set<{
			controller: AbortController;
			done: Promise<void>;
			recoveryGenerationKey: string;
		}>
	>();
	private readonly closedRecoveryGenerations = new Set<string>();
	private readonly lifetime = new AbortController();
	private closed = false;
	constructor(private readonly options: Options) {}

	async close() {
		if (this.closed) return;
		this.closed = true;
		const keys = [...this.recoveryGuards.keys()];
		this.lifetime.abort();
		await Promise.allSettled(
			[...this.recoveryGuards.values()].flatMap((guards) =>
				[...guards].map((guard) => guard.done),
			),
		);
		await Promise.allSettled(
			keys.map((key) => this.options.serialize(key, async () => undefined)),
		);
	}

	private assertOpen() {
		if (this.closed) nativeRequired();
	}

	private async abortRecovery(key: string, recoveryGenerationKey: string) {
		const guards = [...(this.recoveryGuards.get(key) ?? [])];
		const matching = guards.filter(
			(guard) => guard.recoveryGenerationKey === recoveryGenerationKey,
		);
		for (const guard of matching) guard.controller.abort();
		await Promise.allSettled(matching.map((guard) => guard.done));
	}

	private async recoverEvidence(
		request: RuntimeStatusRequestV3 | RuntimeEventPersistRequestV3,
		claims: RuntimeExecutionGrantClaimsV2,
		verification: unknown,
		session: StoredSession,
		signal?: AbortSignal,
		skipLatched = false,
	) {
		const recover = this.options.driver.recoverOriginalEvidence;
		const nativeSessionRef = session.nativeSessionRef;
		const key = this.options.store.sessionQueueKey(request);
		const recoveryGenerationKey = JSON.stringify([
			key,
			request.sessionGeneration,
			request.executionId,
		]);
		if (
			!recover ||
			!nativeSessionRef ||
			session.generationBarrier ||
			this.closedRecoveryGenerations.has(recoveryGenerationKey) ||
			(claims.purpose === "control" && claims.reason === "generation_isolation")
		)
			return;
		if (
			skipLatched &&
			session.executionAuthorities?.[request.executionId]?.evidenceQuery
		)
			return;
		const originalOperationDigest =
			session.operations[request.executionId]?.requestDigest;
		if (!originalOperationDigest) invalidDriver();
		const queryClaims = { ...claims, hostSessionRef: session.hostSessionRef };
		const controller = new AbortController();
		const active = AbortSignal.any([
			controller.signal,
			this.lifetime.signal,
			...(signal ? [signal] : []),
		]);
		const now = this.options.grantValidation.now ?? Date.now;
		const expiresAt = Math.min(claims.expiresAt, now() + 30_000);
		const timer = setTimeout(
			() => controller.abort(),
			Math.max(0, expiresAt - now()),
		);
		timer.unref();
		const assertCurrent = () => {
			active.throwIfAborted();
			if (
				this.closedRecoveryGenerations.has(recoveryGenerationKey) ||
				now() >= expiresAt
			)
				nativeRequired();
			const allowedCommand = claims.allowedCommands[0];
			if (!allowedCommand) nativeRequired();
			this.validate(request, allowedCommand, verification);
			return this.options.store.assertOriginalEvidenceBinding(
				queryClaims,
				request.requestId,
				nativeSessionRef,
				originalOperationDigest,
			);
		};
		const read: RuntimeOriginalEvidenceReadContext = {
			signal: active,
			expiresAt,
			assertCurrent,
			commit: async <T>(write: () => Promise<T>) =>
				abortable(
					this.options.serialize(key, async () => {
						assertCurrent();
						// Keep Host ordering until the Driver's durable write actually settles.
						return await write();
					}),
					active,
				),
		};
		const work = async () => {
			let previousEvidenceQuery:
				| { requestId: string; issuedAt: number }
				| undefined;
			try {
				previousEvidenceQuery = await abortable(
					this.options.serialize(key, async () => {
						active.throwIfAborted();
						const allowedCommand = claims.allowedCommands[0];
						if (!allowedCommand) nativeRequired();
						this.validate(request, allowedCommand, verification);
						if (this.closedRecoveryGenerations.has(recoveryGenerationKey))
							nativeRequired();
						return this.options.store.latchOriginalEvidenceQuery(
							queryClaims,
							request.requestId,
						);
					}),
					active,
				);
				assertCurrent();
				try {
					await recover.call(
						this.options.driver,
						{
							nativeSessionRef,
							executionId: request.executionId,
							recoveryRequestId: request.requestId,
						},
						read,
					);
				} catch (error) {
					if (
						error instanceof RuntimeHostError &&
						error.driverFailureKind === "session_recovery_failed"
					)
						throw new RuntimeHostError(
							"RUNTIME_SESSION_RECOVERY_FAILED",
							"Runtime Session recovery failed",
							503,
							false,
							"session_recovery_failed",
						);
					invalidDriver();
				}
			} catch (error) {
				// A failed native recovery must not leave an evidence-query latch that
				// blocks a later authorized retry. Restore the prior high-water mark only
				// while this request still owns the current latch.
				await this.options
					.serialize(key, async () =>
						this.options.store.restoreOriginalEvidenceQuery(
							queryClaims,
							request.requestId,
							previousEvidenceQuery,
						),
					)
					.catch(() => undefined);
				throw error;
			}
		};
		const guard = {
			controller,
			done: Promise.resolve(),
			recoveryGenerationKey,
		};
		const guards = this.recoveryGuards.get(key) ?? new Set();
		this.recoveryGuards.set(key, guards);
		guards.add(guard);
		guard.done = work().finally(() => {
			clearTimeout(timer);
			guards.delete(guard);
			if (guards.size === 0) this.recoveryGuards.delete(key);
		});
		try {
			await abortable(guard.done, active);
		} finally {
			controller.abort();
		}
	}

	private validate(
		request:
			| RuntimeSubmitTurnRequestV3
			| RuntimeSupplementRequestV3
			| RuntimeStopRequestV3
			| RuntimeStatusRequestV3
			| RuntimeGenerationCancelRequestV3
			| RuntimeAuthorizationRenewRequestV3
			| RuntimeEventPersistRequestV3
			| RuntimeEventAckRequestV3,
		command: RuntimeExecutionGrantClaimsV2["allowedCommands"][0],
		verification: unknown,
	) {
		return validateRuntimeExecutionGrantV2(
			request,
			command,
			verification,
			this.options.grantValidation,
		);
	}

	async submitTurn(value: RuntimeSubmitTurnRequestV3, verification: unknown) {
		this.assertOpen();
		const request = parseRequest(RuntimeSubmitTurnRequestV3Schema, value);
		const claims = this.validate(request, "turn.submit", verification);
		const response = await this.options.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				this.assertOpen();
				this.validate(request, "turn.submit", verification);
				const prepared = await this.options.store.prepareOperation({
					authorization: claims,
					now: this.options.grantValidation.now ?? Date.now,
					requestedHostSessionRef: request.hostSessionRef ?? undefined,
					binding: request,
					operationId: request.executionId,
					kind: "submit-turn",
					scope: `execution:${request.executionId}`,
					deliveryFence: request.operation.deliveryFence,
					requestDigest: requestDigest({
						kind: "submit-turn",
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						input: request.input,
						...(request.selection ? { selection: request.selection } : {}),
					}),
					command: (nativeSessionRef) => {
						const command = {
							kind: "submit-turn" as const,
							operationId: request.executionId,
							agentId: request.agentId,
							conversationId: request.conversationId,
							executionId: request.executionId,
							turnId: request.turnId,
							sessionGeneration: request.sessionGeneration,
							...(nativeSessionRef ? { nativeSessionRef } : {}),
							input: request.input,
						};
						return request.selection
							? {
									schemaVersion: 2 as const,
									...command,
									selection: request.selection,
								}
							: { schemaVersion: 1 as const, ...command };
					},
				});
				const response = await this.options.dispatch(
					prepared.session.hostSessionRef,
					prepared.operation,
				);
				return { ...response, schemaVersion: 3 as const };
			},
		);
		return response;
	}

	async supplement(value: RuntimeSupplementRequestV3, verification: unknown) {
		this.assertOpen();
		const request = parseRequest(RuntimeSupplementRequestV3Schema, value);
		const claims = this.validate(request, "turn.supplement", verification);
		const response = await this.options.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				this.assertOpen();
				this.validate(request, "turn.supplement", verification);
				const prepared = await this.options.store.prepareOperation({
					authorization: claims,
					now: this.options.grantValidation.now ?? Date.now,
					requestedHostSessionRef: request.hostSessionRef,
					binding: request,
					operationId: request.operation.id,
					kind: "supplement",
					scope: `message:${request.operation.id}`,
					deliveryFence: request.operation.deliveryFence,
					executionDeliveryFence: request.operation.executionDeliveryFence,
					requestDigest: requestDigest({
						kind: "supplement",
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						messageId: request.operation.id,
						input: request.input,
					}),
					command: (nativeSessionRef) => ({
						schemaVersion: 1,
						kind: "supplement",
						operationId: request.operation.id,
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						nativeSessionRef: nativeSessionRef ?? nativeRequired(),
						input: request.input,
					}),
				});
				return {
					...(await this.options.dispatch(
						prepared.session.hostSessionRef,
						prepared.operation,
					)),
					schemaVersion: 3 as const,
				};
			},
		);
		return response;
	}

	async stop(value: RuntimeStopRequestV3, verification: unknown) {
		this.assertOpen();
		const request = parseRequest(RuntimeStopRequestV3Schema, value);
		const claims = this.validate(request, "turn.stop", verification);
		const key = this.options.store.sessionQueueKey(request);
		const recoveryGenerationKey = JSON.stringify([
			key,
			request.sessionGeneration,
			request.executionId,
		]);
		await this.options.serialize(key, async () => {
			this.assertOpen();
			this.validate(request, "turn.stop", verification);
			await this.options.store.authorizeRequestV3(
				claims,
				"query",
				this.options.grantValidation.now ?? Date.now,
			);
			this.closedRecoveryGenerations.add(recoveryGenerationKey);
		});
		await this.abortRecovery(key, recoveryGenerationKey);
		try {
			const response = await this.options.serialize(
				this.options.store.sessionQueueKey(request),
				async () => {
					this.assertOpen();
					this.validate(request, "turn.stop", verification);
					const prepared = await this.options.store.prepareOperation({
						authorization: claims,
						now: this.options.grantValidation.now ?? Date.now,
						requestedHostSessionRef: request.hostSessionRef,
						binding: request,
						operationId: request.operation.id,
						kind: "stop",
						scope: `stop:${request.operation.id}`,
						deliveryFence: request.operation.deliveryFence,
						executionDeliveryFence: request.operation.executionDeliveryFence,
						requestDigest: requestDigest({
							kind: "stop",
							agentId: request.agentId,
							conversationId: request.conversationId,
							executionId: request.executionId,
							turnId: request.turnId,
							sessionGeneration: request.sessionGeneration,
							stopRequestId: request.operation.id,
						}),
						command: (nativeSessionRef) => ({
							schemaVersion: 1,
							kind: "stop",
							operationId: request.operation.id,
							agentId: request.agentId,
							conversationId: request.conversationId,
							executionId: request.executionId,
							turnId: request.turnId,
							sessionGeneration: request.sessionGeneration,
							nativeSessionRef: nativeSessionRef ?? nativeRequired(),
						}),
					});
					return {
						...(await this.options.dispatch(
							prepared.session.hostSessionRef,
							prepared.operation,
						)),
						schemaVersion: 3 as const,
					};
				},
			);
			if (
				response.result.outcome !== "accepted" ||
				["completed", "failed", "cancelled"].includes(response.result.status)
			)
				this.closedRecoveryGenerations.delete(recoveryGenerationKey);
			return response;
		} catch (error) {
			this.closedRecoveryGenerations.delete(recoveryGenerationKey);
			throw error;
		}
	}

	async recoverStatus(
		value: RuntimeStatusRequestV3,
		verification: unknown,
		signal?: AbortSignal,
	): Promise<RuntimeStatusResponseV3> {
		this.assertOpen();
		const request = parseRequest(RuntimeStatusRequestV3Schema, value);
		const claims = this.validate(request, "session.status", verification);
		const { session, found } = await this.options.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				this.assertOpen();
				this.validate(request, "session.status", verification);
				if (
					!request.hostSessionRef &&
					!(claims.purpose === "control" && claims.reason === "recovery")
				)
					nativeRequired();
				return this.options.store.recoverOperationV3(
					claims,
					request.originalOperationDigest,
					this.options.grantValidation.now ?? Date.now,
				);
			},
		);
		if (!found)
			return {
				schemaVersion: 3,
				hostSessionRef: session.hostSessionRef,
				executionId: request.executionId,
				outcome: "not_found",
			};
		const operation = session.operations[request.executionId];
		if (!operation) invalidDriver();
		// Lookup may retrieve a receipt but may never submit missing work under control authority.
		let response: Awaited<ReturnType<Options["dispatch"]>>;
		try {
			this.assertOpen();
			response = await abortable(
				this.options.serialize(
					this.options.store.sessionQueueKey(request),
					async () => {
						this.assertOpen();
						signal?.throwIfAborted();
						this.validate(request, "session.status", verification);
						this.options.store.checkRequestV3({
							...claims,
							hostSessionRef: session.hostSessionRef,
						});
						return this.options.dispatch(
							session.hostSessionRef,
							operation,
							false,
						);
					},
				),
				signal ?? this.lifetime.signal,
			);
		} catch (error) {
			if (
				error instanceof RuntimeHostError &&
				error.driverFailureKind === "session_recovery_failed"
			) {
				// The original submit receipt may have been lost. Return only the
				// authenticated durable mapping so its generation can still be isolated.
				return {
					schemaVersion: 3,
					hostSessionRef: session.hostSessionRef,
					executionId: request.executionId,
					outcome: "recovery_failed",
					code: "RUNTIME_SESSION_RECOVERY_FAILED",
				};
			}
			throw error;
		}
		const status =
			response.result.outcome === "accepted"
				? response.result.status
				: "unknown";
		await this.recoverEvidence(
			request,
			claims,
			verification,
			this.options.store.checkRequestV3({
				...claims,
				hostSessionRef: session.hostSessionRef,
			}),
			signal,
		);
		return {
			schemaVersion: 3,
			hostSessionRef: session.hostSessionRef,
			executionId: request.executionId,
			outcome: "found",
			status,
		};
	}

	async cancelGeneration(
		value: RuntimeGenerationCancelRequestV3,
		verification: unknown,
	) {
		this.assertOpen();
		const request = parseRequest(RuntimeGenerationCancelRequestV3Schema, value);
		const claims = this.validate(request, "generation.cancel", verification);
		const recoveryKey = this.options.store.sessionQueueKey(request);
		const recoveryGenerationKey = JSON.stringify([
			recoveryKey,
			request.sessionGeneration,
			request.executionId,
		]);
		await this.options.serialize(recoveryKey, async () => {
			this.assertOpen();
			this.validate(request, "generation.cancel", verification);
			await this.options.store.authorizeRequestV3(
				claims,
				"generation-cancel",
				this.options.grantValidation.now ?? Date.now,
			);
			// Close the in-memory generation before aborting existing guards. This
			// serialized latch prevents a new recovery from registering in the gap.
			this.closedRecoveryGenerations.add(recoveryGenerationKey);
		});
		await this.abortRecovery(recoveryKey, recoveryGenerationKey);
		let barrierActivated = false;
		try {
			const response = await this.options.serialize(
				this.options.store.sessionQueueKey(request),
				async () => {
					this.assertOpen();
					this.validate(request, "generation.cancel", verification);
					const prepared = await this.options.store.prepareOperation({
						authorization: claims,
						now: this.options.grantValidation.now ?? Date.now,
						requestedHostSessionRef: request.hostSessionRef,
						binding: request,
						operationId: request.operation.id,
						kind: "generation-cancel",
						scope: `generation:${request.sessionGeneration}`,
						deliveryFence: request.operation.deliveryFence,
						executionDeliveryFence: request.operation.executionDeliveryFence,
						requestDigest: requestDigest({
							kind: "generation-cancel",
							agentId: request.agentId,
							conversationId: request.conversationId,
							executionId: request.executionId,
							turnId: request.turnId,
							sessionGeneration: request.sessionGeneration,
							tombstoneId: request.operation.id,
						}),
						command: (nativeSessionRef) => ({
							schemaVersion: 1,
							kind: "generation-cancel",
							operationId: request.operation.id,
							agentId: request.agentId,
							conversationId: request.conversationId,
							executionId: request.executionId,
							turnId: request.turnId,
							sessionGeneration: request.sessionGeneration,
							nativeSessionRef: nativeSessionRef ?? nativeRequired(),
						}),
					});
					await this.options.store.activateGenerationBarrier(
						request.hostSessionRef,
						request,
						request.operation.id,
					);
					barrierActivated = true;
					const response = await this.options.dispatch(
						prepared.session.hostSessionRef,
						prepared.operation,
					);
					if (
						response.result.outcome === "accepted" &&
						["completed", "failed", "cancelled"].includes(
							response.result.status,
						)
					)
						await this.options.store.confirmGenerationBarrier(
							request.hostSessionRef,
							request.operation.id,
						);
					return { ...response, schemaVersion: 3 as const };
				},
			);
			if (barrierActivated)
				this.closedRecoveryGenerations.delete(recoveryGenerationKey);
			return response;
		} catch (error) {
			// Preparation or barrier activation may fail before the durable barrier
			// exists. In that case leave the generation recoverable for a retry.
			if (!barrierActivated)
				this.closedRecoveryGenerations.delete(recoveryGenerationKey);
			throw error;
		}
	}

	async renewAuthorization(
		value: RuntimeAuthorizationRenewRequestV3,
		verification: unknown,
	) {
		this.assertOpen();
		const request = parseRequest(
			RuntimeAuthorizationRenewRequestV3Schema,
			value,
		);
		const claims = this.validate(request, "execution.renew", verification);
		const { authority } = await this.options.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				this.assertOpen();
				this.validate(request, "execution.renew", verification);
				return this.options.store.authorizeRequestV3(
					claims,
					"renew",
					this.options.grantValidation.now ?? Date.now,
				);
			},
		);
		return {
			schemaVersion: 3 as const,
			executionId: request.executionId,
			expiresAt: authority.expiresAt,
		};
	}

	async acknowledgeEvents(
		value: RuntimeEventAckRequestV3,
		verification: unknown,
	) {
		this.assertOpen();
		const request = parseRequest(RuntimeEventAckRequestV3Schema, value);
		const claims = this.validate(request, "events.ack", verification);
		return this.options.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				this.assertOpen();
				this.validate(request, "events.ack", verification);
				await this.options.store.authorizeRequestV3(
					claims,
					"query",
					this.options.grantValidation.now ?? Date.now,
				);
				const session = this.options.store.checkAcknowledgableCursor(
					claims,
					request.confirmedCursor,
				);
				// Persist the Host watermark before asking the Driver to compact. A
				// Driver failure can be retried from durable state; the reverse order
				// could compact an event whose Host acknowledgement then fails.
				await this.options.store.acknowledgeCursor(
					claims,
					request.confirmedCursor,
					this.options.grantValidation.now ?? Date.now,
				);
				// The durable write can outlive the grant. Re-authorize immediately
				// before the Driver call so an expired grant cannot trigger compaction.
				await this.options.store.authorizeRequestV3(
					claims,
					"query",
					this.options.grantValidation.now ?? Date.now,
				);
				await this.options.driver.acknowledgeEvents?.(
					session.nativeSessionRef ?? nativeRequired(),
					request.executionId,
					request.confirmedCursor,
				);
				return {
					schemaVersion: 3 as const,
					executionId: request.executionId,
					confirmedCursor: request.confirmedCursor,
				};
			},
		);
	}

	async streamEvents(
		value: RuntimeEventPersistRequestV3,
		verification: unknown,
		signal?: AbortSignal,
	) {
		this.assertOpen();
		const request = parseRequest(RuntimeEventPersistRequestV3Schema, value);
		const claims = this.validate(request, "events.persist", verification);
		const { session } = await this.options.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				this.assertOpen();
				this.validate(request, "events.persist", verification);
				return this.options.store.authorizeRequestV3(
					claims,
					"query",
					this.options.grantValidation.now ?? Date.now,
				);
			},
		);
		const controller = new AbortController();
		const bounded = AbortSignal.any([
			controller.signal,
			this.lifetime.signal,
			...(signal ? [signal] : []),
		]);
		const expires = () =>
			controller.abort(
				new RuntimeHostError(
					"RUNTIME_GRANT_EXPIRED",
					"Runtime authorization expired",
					403,
				),
			);
		const timer = setTimeout(
			expires,
			Math.max(
				0,
				claims.expiresAt - (this.options.grantValidation.now ?? Date.now)(),
			),
		);
		timer.unref();
		let events: AsyncIterable<unknown>;
		try {
			this.assertOpen();
			bounded.throwIfAborted();
			await this.recoverEvidence(
				request,
				claims,
				verification,
				session,
				bounded,
				true,
			);
			const subscription = this.options.driver.subscribeEvents(
				session.nativeSessionRef ?? nativeRequired(),
				request.executionId,
				request.afterCursor ?? undefined,
				bounded,
			);
			try {
				events = await abortable(subscription, bounded);
			} catch (error) {
				// If cancellation wins while the Driver is still constructing its
				// iterable, close that late iterable as soon as it arrives. This
				// prevents a subscription created after grant expiry from leaking
				// listeners or native resources past the HTTP request lifetime.
				void subscription
					.then((late) => late[Symbol.asyncIterator]().return?.())
					.catch(() => undefined);
				throw error;
			}
		} catch (error) {
			clearTimeout(timer);
			throw error;
		}
		const options = this.options;
		let cleaned = false;
		let onAbort: (() => void) | undefined;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			clearTimeout(timer);
			if (onAbort) bounded.removeEventListener("abort", onAbort);
			controller.abort();
		};
		const validate = () => {
			this.assertOpen();
			this.validate(request, "events.persist", verification);
		};
		const generator = (async function* () {
			const iterator = events[Symbol.asyncIterator]();
			let rejectAborted: ((reason?: unknown) => void) | undefined;
			const aborted = new Promise<never>((_resolve, reject) => {
				rejectAborted = reject;
			});
			const abortListener = () => rejectAborted?.(bounded.reason);
			onAbort = abortListener;
			bounded.addEventListener("abort", abortListener, { once: true });
			try {
				while (true) {
					bounded.throwIfAborted();
					const next = await Promise.race([iterator.next(), aborted]);
					if (next.done) return;
					validate();
					options.store.checkRequestV3(claims);
					const parsed = RuntimeEventSchema.safeParse(next.value);
					if (
						!parsed.success ||
						parsed.data.executionId !== request.executionId
					)
						invalidDriver();
					validate();
					options.store.checkRequestV3(claims);
					bounded.throwIfAborted();
					validate();
					options.store.checkRequestV3(claims);
					bounded.throwIfAborted();
					await options.store.recordDeliveredCursor(
						claims,
						parsed.data.cursor,
						options.grantValidation.now ?? Date.now,
					);
					validate();
					options.store.checkRequestV3(claims);
					yield parsed.data;
				}
			} finally {
				cleanup();
				// A Driver that ignores abort cannot hold an expired HTTP stream open.
				void Promise.resolve(iterator.return?.()).catch(() => undefined);
			}
		})();
		const iterator = generator[Symbol.asyncIterator]();
		return {
			[Symbol.asyncIterator]() {
				return {
					next: (...args: [] | [unknown]) => iterator.next(...(args as [])),
					return: async (value?: unknown) => {
						cleanup();
						void value;
						return iterator.return?.();
					},
					throw: async (reason?: unknown) => {
						cleanup();
						return iterator.throw?.(reason);
					},
				};
			},
		};
	}
}
