import type {
	RuntimeCapabilitiesRequestV1,
	RuntimeCapabilitiesResponseV1,
	RuntimeGenerationCancelRequestV1,
	RuntimeOperationResponseV1,
	RuntimeReplayRequestV1,
	RuntimeReplayResponseV1,
	RuntimeStatusRequestV1,
	RuntimeStatusResponseV1,
	RuntimeStopRequestV1,
	RuntimeSubmitTurnRequestV1,
	RuntimeSupplementRequestV1,
} from "@agent-infra/contracts/runtime";
import {
	RuntimeCapabilitiesRequestV1Schema,
	RuntimeGenerationCancelRequestV1Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeStatusRequestV1Schema,
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
	type ExecutionGrantVerifierOptions,
	verifyExecutionGrant,
} from "./grant.js";

interface RuntimeHostOptions {
	store: FileRuntimeStore;
	driver: RuntimeDriver;
	grantVerifier: ExecutionGrantVerifierOptions;
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
	): Promise<RuntimeOperationResponseV1> {
		const parsed = RuntimeSubmitTurnRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		verifyExecutionGrant(request, "turn.submit", this.options.grantVerifier);
		return this.serialize(
			request.hostSessionRef ?? request.conversationId,
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
	): Promise<RuntimeStatusResponseV1> {
		const parsed = RuntimeStatusRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		verifyExecutionGrant(request, "session.status", this.options.grantVerifier);
		const session = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.deliveryFence,
		);
		const nativeSessionRef =
			session.nativeSessionRef ?? nativeSessionRequired();
		return {
			schemaVersion: 1,
			hostSessionRef: request.hostSessionRef,
			executionId: request.executionId,
			status: await this.options.driver.getStatus(
				nativeSessionRef,
				request.executionId,
			),
		};
	}

	async capabilities(
		value: RuntimeCapabilitiesRequestV1,
	): Promise<RuntimeCapabilitiesResponseV1> {
		const parsed = RuntimeCapabilitiesRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		verifyExecutionGrant(
			request,
			"capabilities.read",
			this.options.grantVerifier,
		);
		if (request.hostSessionRef) {
			this.options.store.getSessionForQuery(
				request.hostSessionRef,
				request,
				request.deliveryFence,
			);
		}
		return {
			schemaVersion: 1,
			capabilities: await this.options.driver.getCapabilities(),
		};
	}

	async replay(
		value: RuntimeReplayRequestV1,
	): Promise<RuntimeReplayResponseV1> {
		const parsed = RuntimeReplayRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		verifyExecutionGrant(request, "events.replay", this.options.grantVerifier);
		const session = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.deliveryFence,
		);
		const nativeSessionRef =
			session.nativeSessionRef ?? nativeSessionRequired();
		return {
			schemaVersion: 1,
			events: await this.options.driver.replayEvents(
				nativeSessionRef,
				request.executionId,
				request.afterCursor,
			),
		};
	}

	async streamEvents(value: RuntimeReplayRequestV1, signal?: AbortSignal) {
		const parsed = RuntimeReplayRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		verifyExecutionGrant(request, "events.replay", this.options.grantVerifier);
		const session = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.deliveryFence,
		);
		const nativeSessionRef =
			session.nativeSessionRef ?? nativeSessionRequired();
		const events = await this.options.driver.subscribeEvents(
			nativeSessionRef,
			request.executionId,
			request.afterCursor,
			signal,
		);
		const store = this.options.store;
		return (async function* () {
			for await (const event of events) {
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
	): Promise<RuntimeOperationResponseV1> {
		const parsed = RuntimeSupplementRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		verifyExecutionGrant(
			request,
			"turn.supplement",
			this.options.grantVerifier,
		);
		return this.serialize(request.hostSessionRef, async () => {
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
		});
	}

	async stop(value: RuntimeStopRequestV1): Promise<RuntimeOperationResponseV1> {
		const parsed = RuntimeStopRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		verifyExecutionGrant(request, "turn.stop", this.options.grantVerifier);
		return this.serialize(request.hostSessionRef, async () => {
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
		});
	}

	async cancelGeneration(
		value: RuntimeGenerationCancelRequestV1,
	): Promise<RuntimeOperationResponseV1> {
		const parsed = RuntimeGenerationCancelRequestV1Schema.safeParse(value);
		if (!parsed.success) invalidRequest();
		const request = parsed.data;
		verifyExecutionGrant(
			request,
			"generation.cancel",
			this.options.grantVerifier,
		);
		return this.serialize(request.hostSessionRef, async () => {
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
			if (response.result.outcome === "accepted") {
				await this.options.store.confirmGenerationBarrier(
					request.hostSessionRef,
					request.tombstoneId,
				);
			}
			return response;
		});
	}

	private async dispatch(
		hostSessionRef: string,
		operation: StoredOperation,
	): Promise<RuntimeOperationResponseV1> {
		if (operation.state === "resolved" && operation.result) {
			return {
				schemaVersion: 1,
				hostSessionRef,
				operationId: operation.operationId,
				result: operation.result,
			};
		}
		await this.options.afterOperationPrepared?.(operation.operationId);
		const lookup = await this.options.driver.lookupOperation(
			operation.operationId,
		);
		if (lookup.state === "unknown") {
			const result = {
				outcome: "unknown" as const,
				code: "RUNTIME_ACCEPTANCE_UNKNOWN",
				message: "Runtime command acceptance could not be confirmed",
			};
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
		const driverRecord =
			lookup.state === "found"
				? lookup.record
				: await this.options.driver.execute(operation.command);
		await this.options.afterDriverResult?.(operation.operationId);
		const result = await this.currentDriverResult(
			driverRecord,
			operation.executionId,
		);
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
		const quarantinedSessions = new Set<string>();
		for (const {
			session,
			operation,
		} of this.options.store.listRecoverableOperations()) {
			if (quarantinedSessions.has(session.hostSessionRef)) continue;
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
						const lookup = await this.options.driver.lookupOperation(
							operation.operationId,
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
							recoveredResult = {
								outcome: "unknown",
								code: "RUNTIME_ACCEPTANCE_UNKNOWN",
								message: "Runtime command acceptance could not be confirmed",
							};
							await this.options.store.resolveOperation(
								session.hostSessionRef,
								operation.operationId,
								recoveredResult,
							);
						}
					}
					if (
						operation.kind === "generation-cancel" &&
						recoveredResult.outcome === "accepted"
					) {
						await this.options.store.confirmGenerationBarrier(
							session.hostSessionRef,
							operation.operationId,
						);
					}
				});
			} catch {
				await this.options.store.quarantineSession(session.hostSessionRef);
				quarantinedSessions.add(session.hostSessionRef);
			}
		}
	}

	private async currentDriverResult(
		record: Awaited<ReturnType<RuntimeDriver["execute"]>>,
		executionId: string,
	) {
		if (record.result.outcome !== "accepted") return record.result;
		return {
			outcome: "accepted" as const,
			status: await this.options.driver.getStatus(
				record.nativeSessionRef,
				executionId,
			),
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
