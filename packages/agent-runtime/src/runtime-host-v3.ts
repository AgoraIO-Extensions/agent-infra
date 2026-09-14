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

import type { RuntimeDriver } from "./driver.js";
import { RuntimeHostError } from "./errors.js";
import {
	type FileRuntimeStore,
	requestDigest,
	type StoredOperation,
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
	constructor(private readonly options: Options) {}

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
		const request = parseRequest(RuntimeSubmitTurnRequestV3Schema, value);
		const claims = this.validate(request, "turn.submit", verification);
		return this.options.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				this.validate(request, "turn.submit", verification);
				const prepared = await this.options.store.prepareOperation({
					authorization: claims,
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
	}

	async supplement(value: RuntimeSupplementRequestV3, verification: unknown) {
		const request = parseRequest(RuntimeSupplementRequestV3Schema, value);
		const claims = this.validate(request, "turn.supplement", verification);
		return this.options.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				this.validate(request, "turn.supplement", verification);
				const prepared = await this.options.store.prepareOperation({
					authorization: claims,
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
	}

	async stop(value: RuntimeStopRequestV3, verification: unknown) {
		const request = parseRequest(RuntimeStopRequestV3Schema, value);
		const claims = this.validate(request, "turn.stop", verification);
		// Persist cancellation before entering a possibly occupied business operation queue.
		await this.options.store.authorizeRequestV3(claims);
		return this.options.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				this.validate(request, "turn.stop", verification);
				const prepared = await this.options.store.prepareOperation({
					authorization: claims,
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
	}

	async recoverStatus(
		value: RuntimeStatusRequestV3,
		verification: unknown,
	): Promise<RuntimeStatusResponseV3> {
		const request = parseRequest(RuntimeStatusRequestV3Schema, value);
		const claims = this.validate(request, "session.status", verification);
		const { session, found } = await this.options.store.recoverOperationV3(
			claims,
			request.originalOperationDigest,
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
			response = await this.options.dispatch(
				session.hostSessionRef,
				operation,
				false,
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
		const request = parseRequest(RuntimeGenerationCancelRequestV3Schema, value);
		const claims = this.validate(request, "generation.cancel", verification);
		await this.options.store.authorizeRequestV3(claims);
		return this.options.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				this.validate(request, "generation.cancel", verification);
				const prepared = await this.options.store.prepareOperation({
					authorization: claims,
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
				const response = await this.options.dispatch(
					prepared.session.hostSessionRef,
					prepared.operation,
				);
				if (
					response.result.outcome === "accepted" &&
					["completed", "failed", "cancelled"].includes(response.result.status)
				)
					await this.options.store.confirmGenerationBarrier(
						request.hostSessionRef,
						request.operation.id,
					);
				return { ...response, schemaVersion: 3 as const };
			},
		);
	}

	async renewAuthorization(
		value: RuntimeAuthorizationRenewRequestV3,
		verification: unknown,
	) {
		const request = parseRequest(
			RuntimeAuthorizationRenewRequestV3Schema,
			value,
		);
		const claims = this.validate(request, "execution.renew", verification);
		const { authority } = await this.options.store.authorizeRequestV3(
			claims,
			"renew",
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
		const request = parseRequest(RuntimeEventAckRequestV3Schema, value);
		const claims = this.validate(request, "events.ack", verification);
		await this.options.store.authorizeRequestV3(claims);
		const session = this.options.store.checkAcknowledgableCursor(
			claims,
			request.confirmedCursor,
		);
		await this.options.driver.acknowledgeEvents?.(
			session.nativeSessionRef ?? nativeRequired(),
			request.executionId,
			request.confirmedCursor,
		);
		await this.options.store.acknowledgeCursor(claims, request.confirmedCursor);
		return {
			schemaVersion: 3 as const,
			executionId: request.executionId,
			confirmedCursor: request.confirmedCursor,
		};
	}

	async streamEvents(
		value: RuntimeEventPersistRequestV3,
		verification: unknown,
		signal?: AbortSignal,
	) {
		const request = parseRequest(RuntimeEventPersistRequestV3Schema, value);
		const claims = this.validate(request, "events.persist", verification);
		const { session } = await this.options.store.authorizeRequestV3(claims);
		const controller = new AbortController();
		const bounded = signal
			? AbortSignal.any([controller.signal, signal])
			: controller.signal;
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
			bounded.throwIfAborted();
			events = await abortable(
				this.options.driver.subscribeEvents(
					session.nativeSessionRef ?? nativeRequired(),
					request.executionId,
					request.afterCursor ?? undefined,
					bounded,
				),
				bounded,
			);
		} catch (error) {
			clearTimeout(timer);
			throw error;
		}
		const options = this.options;
		const validate = () =>
			this.validate(request, "events.persist", verification);
		return (async function* () {
			const iterator = events[Symbol.asyncIterator]();
			let rejectAborted: ((reason?: unknown) => void) | undefined;
			const aborted = new Promise<never>((_resolve, reject) => {
				rejectAborted = reject;
			});
			const onAbort = () => rejectAborted?.(bounded.reason);
			bounded.addEventListener("abort", onAbort, { once: true });
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
					await options.store.recordDeliveredCursor(claims, parsed.data.cursor);
					validate();
					options.store.checkRequestV3(claims);
					yield parsed.data;
				}
			} finally {
				clearTimeout(timer);
				bounded.removeEventListener("abort", onAbort);
				controller.abort();
				// A Driver that ignores abort cannot hold an expired HTTP stream open.
				void iterator.return?.().catch(() => undefined);
			}
		})();
	}
}
