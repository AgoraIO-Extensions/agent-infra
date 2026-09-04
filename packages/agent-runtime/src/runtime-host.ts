import type {
	RuntimeCapabilitiesRequestV1,
	RuntimeCapabilitiesResponseV1,
	RuntimeGenerationCancelRequestV1,
	RuntimeOperationResponseV1,
	RuntimeReplayRequestV1,
	RuntimeReplayResponseV1,
	RuntimeStatusRequestV1,
	RuntimeStatusResponseV1,
	RuntimeStatusV1,
	RuntimeStopRequestV1,
	RuntimeSubmitTurnRequestV1,
	RuntimeSupplementRequestV1,
} from "@agent-infra/contracts/runtime";
import {
	RuntimeCapabilitiesRequestV1Schema,
	RuntimeCapabilitiesV1Schema,
	RuntimeDriverLookupV1Schema,
	RuntimeDriverOperationRecordV1Schema,
	RuntimeEventV1Schema,
	RuntimeGenerationCancelRequestV1Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeStatusRequestV1Schema,
	RuntimeStatusV1Schema,
	RuntimeStopRequestV1Schema,
	RuntimeSubmitTurnRequestV1Schema,
	RuntimeSupplementRequestV1Schema,
} from "@agent-infra/contracts/runtime";

import type { RuntimeDriver } from "./driver.js";
import { RuntimeHostError } from "./errors.js";
import {
	type FileRuntimeStore,
	requestDigest,
	type StoredOperation,
} from "./file-runtime-store.js";
import {
	type ExecutionGrantValidationOptions,
	validateRuntimeExecutionGrant,
} from "./grant.js";

interface RuntimeHostOptions {
	store: FileRuntimeStore;
	driver: RuntimeDriver;
	grantValidation: ExecutionGrantValidationOptions;
	afterOperationPrepared?: (operationId: string) => void | Promise<void>;
	afterDriverResult?: (operationId: string) => void | Promise<void>;
	afterOperationResolved?: (operationId: string) => void | Promise<void>;
}

function invalidRequest(): never {
	throw new RuntimeHostError(
		"RUNTIME_REQUEST_INVALID",
		"Runtime request is invalid",
		400,
	);
}

function nativeSessionRequired(): never {
	throw new RuntimeHostError(
		"RUNTIME_SESSION_UNAVAILABLE",
		"Runtime session could not be recovered",
		503,
	);
}

function isTerminalRuntimeStatus(status: RuntimeStatusV1) {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

function driverInvalid(): never {
	throw new RuntimeHostError(
		"RUNTIME_DRIVER_INVALID",
		"Runtime Driver response is invalid",
		503,
		true,
	);
}

function acceptanceUnknown() {
	return {
		outcome: "unknown" as const,
		code: "RUNTIME_ACCEPTANCE_UNKNOWN",
		message: "Runtime command acceptance could not be confirmed",
	} as const;
}

function isInterruption(operation: StoredOperation) {
	return operation.kind === "stop" || operation.kind === "generation-cancel";
}

function unknownOperationResponse(
	hostSessionRef: string,
	operationId: string,
): RuntimeOperationResponseV1 {
	return {
		schemaVersion: 1,
		hostSessionRef,
		operationId,
		result: acceptanceUnknown(),
	};
}

async function callDriver<T>(work: () => Promise<T>) {
	try {
		return await work();
	} catch {
		driverInvalid();
	}
}

async function* validatedDriverEventStream(
	events: AsyncIterable<unknown>,
	executionId: string,
) {
	let iterator: AsyncIterator<unknown>;
	try {
		iterator = events[Symbol.asyncIterator]();
	} catch {
		driverInvalid();
	}
	try {
		while (true) {
			let next: IteratorResult<unknown>;
			try {
				next = await iterator.next();
			} catch {
				driverInvalid();
			}
			if (next.done) return;
			const event = RuntimeEventV1Schema.safeParse(next.value);
			if (!event.success || event.data.executionId !== executionId) {
				driverInvalid();
			}
			yield event.data;
		}
	} finally {
		try {
			await iterator.return?.();
		} catch {
			driverInvalid();
		}
	}
}

function parseDriverRecord(
	value: unknown,
	operation: StoredOperation,
	persistedNativeSessionRef?: string,
) {
	const parsed = RuntimeDriverOperationRecordV1Schema.safeParse(value);
	const expectedNativeSessionRef =
		persistedNativeSessionRef ??
		("nativeSessionRef" in operation.command
			? operation.command.nativeSessionRef
			: undefined);
	if (
		!parsed.success ||
		parsed.data.agentId !== operation.command.agentId ||
		parsed.data.conversationId !== operation.command.conversationId ||
		parsed.data.sessionGeneration !== operation.command.sessionGeneration ||
		parsed.data.kind !== operation.command.kind ||
		parsed.data.operationId !== operation.operationId ||
		(expectedNativeSessionRef !== undefined &&
			parsed.data.nativeSessionRef !== expectedNativeSessionRef)
	)
		driverInvalid();
	return parsed.data;
}

function parseDriverLookup(
	value: unknown,
	operation: StoredOperation,
	persistedNativeSessionRef?: string,
) {
	const parsed = RuntimeDriverLookupV1Schema.safeParse(value);
	if (!parsed.success) driverInvalid();
	if (parsed.data.state === "found") {
		return {
			state: "found" as const,
			record: parseDriverRecord(
				parsed.data.record,
				operation,
				persistedNativeSessionRef,
			),
		};
	}
	return parsed.data;
}

export class RuntimeHost {
	private readonly queues = new Map<string, Promise<void>>();

	private constructor(private readonly options: RuntimeHostOptions) {}

	static async open(options: RuntimeHostOptions) {
		const host = new RuntimeHost(options);
		await host.recoverOperations();
		return host;
	}

	async submitTurn(
		value: RuntimeSubmitTurnRequestV1,
		verification: unknown,
	): Promise<RuntimeOperationResponseV1> {
		const parsed = RuntimeSubmitTurnRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"turn.submit",
			verification,
			this.options.grantValidation,
		);
		return this.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				const prepared = await this.options.store.prepareOperation({
					requestedHostSessionRef: request.hostSessionRef,
					binding: request,
					operationId: request.executionId,
					kind: "submit-turn",
					scope: `execution:${request.executionId}`,
					deliveryFence: request.deliveryFence,
					requestDigest: requestDigest({
						kind: "submit-turn",
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						input: request.input,
					}),
					command: (nativeSessionRef) => ({
						schemaVersion: 1,
						kind: "submit-turn",
						operationId: request.executionId,
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						...(nativeSessionRef ? { nativeSessionRef } : {}),
						input: request.input,
					}),
				});
				return this.dispatch(
					prepared.session.hostSessionRef,
					prepared.operation,
				);
			},
		);
	}

	async status(
		value: RuntimeStatusRequestV1,
		verification: unknown,
	): Promise<RuntimeStatusResponseV1> {
		const parsed = RuntimeStatusRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"session.status",
			verification,
			this.options.grantValidation,
		);
		const session = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.deliveryFence,
		);
		if (session.recovery?.status === "blocked") {
			return {
				schemaVersion: 1,
				hostSessionRef: request.hostSessionRef,
				executionId: request.executionId,
				status: "unavailable",
			};
		}
		const nativeSessionRef =
			session.nativeSessionRef ?? nativeSessionRequired();
		const status = RuntimeStatusV1Schema.safeParse(
			await callDriver(() =>
				this.options.driver.getStatus(nativeSessionRef, request.executionId),
			),
		);
		if (!status.success) driverInvalid();
		return {
			schemaVersion: 1,
			hostSessionRef: request.hostSessionRef,
			executionId: request.executionId,
			status: status.data,
		};
	}

	async capabilities(
		value: RuntimeCapabilitiesRequestV1,
		verification: unknown,
	): Promise<RuntimeCapabilitiesResponseV1> {
		const parsed = RuntimeCapabilitiesRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"capabilities.read",
			verification,
			this.options.grantValidation,
		);
		if (request.hostSessionRef) {
			this.options.store.getSessionForQuery(
				request.hostSessionRef,
				request,
				request.deliveryFence,
			);
		}
		const capabilities = RuntimeCapabilitiesV1Schema.safeParse(
			await callDriver(() => this.options.driver.getCapabilities()),
		);
		if (!capabilities.success) driverInvalid();
		return {
			schemaVersion: 1,
			capabilities: capabilities.data,
		};
	}

	async replay(
		value: RuntimeReplayRequestV1,
		verification: unknown,
	): Promise<RuntimeReplayResponseV1> {
		const parsed = RuntimeReplayRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"events.replay",
			verification,
			this.options.grantValidation,
		);
		const session = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.deliveryFence,
		);
		const nativeSessionRef =
			session.nativeSessionRef ?? nativeSessionRequired();
		const events = RuntimeEventV1Schema.array().safeParse(
			await callDriver(() =>
				this.options.driver.replayEvents(
					nativeSessionRef,
					request.executionId,
					request.afterCursor,
				),
			),
		);
		if (
			!events.success ||
			events.data.some((event) => event.executionId !== request.executionId)
		) {
			driverInvalid();
		}
		return {
			schemaVersion: 1,
			events: events.data,
		};
	}

	async streamEvents(
		value: RuntimeReplayRequestV1,
		verification: unknown,
		signal?: AbortSignal,
	) {
		const parsed = RuntimeReplayRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"events.replay",
			verification,
			this.options.grantValidation,
		);
		const session = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.deliveryFence,
		);
		const nativeSessionRef =
			session.nativeSessionRef ?? nativeSessionRequired();
		const events = await callDriver(() =>
			this.options.driver.subscribeEvents(
				nativeSessionRef,
				request.executionId,
				request.afterCursor,
				signal,
			),
		);
		const store = this.options.store;
		return (async function* () {
			for await (const event of validatedDriverEventStream(
				events,
				request.executionId,
			)) {
				store.getSessionForQuery(
					request.hostSessionRef,
					request,
					request.deliveryFence,
				);
				yield event;
			}
		})();
	}

	async supplement(
		value: RuntimeSupplementRequestV1,
		verification: unknown,
	): Promise<RuntimeOperationResponseV1> {
		const parsed = RuntimeSupplementRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"turn.supplement",
			verification,
			this.options.grantValidation,
		);
		return this.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				const prepared = await this.options.store.prepareOperation({
					requestedHostSessionRef: request.hostSessionRef,
					binding: request,
					operationId: request.messageId,
					kind: "supplement",
					scope: `message:${request.messageId}`,
					deliveryFence: request.deliveryFence,
					executionDeliveryFence: request.executionDeliveryFence,
					requestDigest: requestDigest({
						kind: "supplement",
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						messageId: request.messageId,
						input: request.input,
					}),
					command: (nativeSessionRef) => ({
						schemaVersion: 1,
						kind: "supplement",
						operationId: request.messageId,
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						nativeSessionRef: nativeSessionRef ?? nativeSessionRequired(),
						input: request.input,
					}),
				});
				return this.dispatch(request.hostSessionRef, prepared.operation);
			},
		);
	}

	async stop(
		value: RuntimeStopRequestV1,
		verification: unknown,
	): Promise<RuntimeOperationResponseV1> {
		const parsed = RuntimeStopRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"turn.stop",
			verification,
			this.options.grantValidation,
		);
		return this.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				const prepared = await this.options.store.prepareOperation({
					requestedHostSessionRef: request.hostSessionRef,
					binding: request,
					operationId: request.stopRequestId,
					kind: "stop",
					scope: `stop:${request.stopRequestId}`,
					deliveryFence: request.deliveryFence,
					executionDeliveryFence: request.executionDeliveryFence,
					requestDigest: requestDigest({
						kind: "stop",
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						stopRequestId: request.stopRequestId,
					}),
					command: (nativeSessionRef) => ({
						schemaVersion: 1,
						kind: "stop",
						operationId: request.stopRequestId,
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						nativeSessionRef: nativeSessionRef ?? nativeSessionRequired(),
					}),
				});
				return this.dispatch(request.hostSessionRef, prepared.operation);
			},
		);
	}

	async cancelGeneration(
		value: RuntimeGenerationCancelRequestV1,
		verification: unknown,
	): Promise<RuntimeOperationResponseV1> {
		const parsed = RuntimeGenerationCancelRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		validateRuntimeExecutionGrant(
			request,
			"generation.cancel",
			verification,
			this.options.grantValidation,
		);
		return this.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				const prepared = await this.options.store.prepareOperation({
					requestedHostSessionRef: request.hostSessionRef,
					binding: request,
					operationId: request.tombstoneId,
					kind: "generation-cancel",
					scope: `generation:${request.sessionGeneration}`,
					deliveryFence: request.deliveryFence,
					requestDigest: requestDigest({
						kind: "generation-cancel",
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						tombstoneId: request.tombstoneId,
					}),
					command: (nativeSessionRef) => ({
						schemaVersion: 1,
						kind: "generation-cancel",
						operationId: request.tombstoneId,
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						nativeSessionRef: nativeSessionRef ?? nativeSessionRequired(),
					}),
				});
				await this.options.store.activateGenerationBarrier(
					request.hostSessionRef,
					request,
					request.tombstoneId,
				);
				const response = await this.dispatch(
					request.hostSessionRef,
					prepared.operation,
				);
				if (
					response.result.outcome === "accepted" &&
					isTerminalRuntimeStatus(response.result.status)
				) {
					await this.options.store.confirmGenerationBarrier(
						request.hostSessionRef,
						request.tombstoneId,
					);
					await this.options.store.clearRecoveryBlocked(request.hostSessionRef);
				}
				return response;
			},
		);
	}

	private async dispatch(
		hostSessionRef: string,
		operation: StoredOperation,
	): Promise<RuntimeOperationResponseV1> {
		if (operation.state === "resolved" && operation.result) {
			let result = operation.result;
			if (result.outcome === "accepted" && result.status === "running") {
				const nativeSessionRef =
					this.options.store.nativeSessionRef(hostSessionRef) ??
					nativeSessionRequired();
				try {
					result = await this.currentDriverResult(
						{ nativeSessionRef, result },
						operation.executionId,
					);
				} catch (error) {
					if (isInterruption(operation)) {
						return unknownOperationResponse(
							hostSessionRef,
							operation.operationId,
						);
					}
					throw error;
				}
				await this.options.store.resolveOperation(
					hostSessionRef,
					operation.operationId,
					result,
					nativeSessionRef,
				);
			}
			return {
				schemaVersion: 1,
				hostSessionRef,
				operationId: operation.operationId,
				result,
			};
		}
		await this.options.afterOperationPrepared?.(operation.operationId);
		let lookup: ReturnType<typeof parseDriverLookup>;
		try {
			lookup = parseDriverLookup(
				await callDriver(() =>
					this.options.driver.lookupOperation(operation.command),
				),
				operation,
				this.options.store.nativeSessionRef(hostSessionRef),
			);
		} catch (error) {
			if (isInterruption(operation)) {
				return unknownOperationResponse(hostSessionRef, operation.operationId);
			}
			throw error;
		}
		if (lookup.state === "unknown") {
			const result = acceptanceUnknown();
			if (isInterruption(operation)) {
				return unknownOperationResponse(hostSessionRef, operation.operationId);
			}
			await this.options.store.resolveOperation(
				hostSessionRef,
				operation.operationId,
				result,
			);
			return {
				schemaVersion: 1,
				hostSessionRef,
				operationId: operation.operationId,
				result,
			};
		}
		let driverRecord: ReturnType<typeof parseDriverRecord>;
		try {
			driverRecord = parseDriverRecord(
				lookup.state === "found"
					? lookup.record
					: await callDriver(() =>
							this.options.driver.execute(operation.command),
						),
				operation,
				this.options.store.nativeSessionRef(hostSessionRef),
			);
		} catch (error) {
			if (isInterruption(operation)) {
				return unknownOperationResponse(hostSessionRef, operation.operationId);
			}
			throw error;
		}
		await this.options.afterDriverResult?.(operation.operationId);
		let result: RuntimeOperationResponseV1["result"];
		try {
			result = await this.currentDriverResult(
				driverRecord,
				operation.executionId,
			);
		} catch (error) {
			if (isInterruption(operation)) {
				return unknownOperationResponse(hostSessionRef, operation.operationId);
			}
			throw error;
		}
		await this.options.store.resolveOperation(
			hostSessionRef,
			operation.operationId,
			result,
			driverRecord.nativeSessionRef,
		);
		await this.options.afterOperationResolved?.(operation.operationId);
		return {
			schemaVersion: 1,
			hostSessionRef,
			operationId: operation.operationId,
			result,
		};
	}

	private async recoverOperations() {
		const attemptedSessions = new Set<string>();
		const blockedSessions = new Set<string>();
		for (const {
			session,
			operation,
		} of this.options.store.listRecoverableOperations()) {
			if (blockedSessions.has(session.hostSessionRef)) continue;
			attemptedSessions.add(session.hostSessionRef);
			try {
				await this.serialize(session.hostSessionRef, async () => {
					let recoveredResult: RuntimeOperationResponseV1["result"];
					if (operation.kind === "generation-cancel") {
						await this.options.store.activateGenerationBarrier(
							session.hostSessionRef,
							session,
							operation.operationId,
						);
					}
					if (operation.state === "prepared") {
						recoveredResult = (
							await this.dispatch(session.hostSessionRef, operation)
						).result;
					} else {
						const lookup = parseDriverLookup(
							await callDriver(() =>
								this.options.driver.lookupOperation(operation.command),
							),
							operation,
							session.nativeSessionRef,
						);
						if (lookup.state === "found") {
							recoveredResult = await this.currentDriverResult(
								lookup.record,
								operation.executionId,
							);
							await this.options.store.resolveOperation(
								session.hostSessionRef,
								operation.operationId,
								recoveredResult,
								lookup.record.nativeSessionRef,
							);
						} else {
							recoveredResult = acceptanceUnknown();
							await this.options.store.resolveOperation(
								session.hostSessionRef,
								operation.operationId,
								recoveredResult,
							);
						}
					}
					if (
						operation.kind === "generation-cancel" &&
						recoveredResult.outcome === "accepted" &&
						isTerminalRuntimeStatus(recoveredResult.status)
					) {
						await this.options.store.confirmGenerationBarrier(
							session.hostSessionRef,
							operation.operationId,
						);
					}
				});
			} catch {
				await this.options.store.markRecoveryBlocked(
					session.hostSessionRef,
					operation.operationId,
				);
				blockedSessions.add(session.hostSessionRef);
			}
		}
		for (const hostSessionRef of attemptedSessions) {
			if (!blockedSessions.has(hostSessionRef)) {
				await this.options.store.clearRecoveryBlocked(hostSessionRef);
			}
		}
	}

	private async currentDriverResult(
		record: Pick<
			Awaited<ReturnType<RuntimeDriver["execute"]>>,
			"nativeSessionRef" | "result"
		>,
		executionId: string,
	) {
		if (record.result.outcome !== "accepted") {
			return record.result;
		}
		const status = RuntimeStatusV1Schema.safeParse(
			await callDriver(() =>
				this.options.driver.getStatus(record.nativeSessionRef, executionId),
			),
		);
		if (!status.success) driverInvalid();
		return {
			outcome: "accepted" as const,
			status: status.data,
		};
	}

	private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(key) ?? Promise.resolve();
		const result = previous.then(work, work);
		const completion = result.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(key, completion);
		return result.finally(() => {
			if (this.queues.get(key) === completion) this.queues.delete(key);
		});
	}
}
