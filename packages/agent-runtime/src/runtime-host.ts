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

	constructor(private readonly options: RuntimeHostOptions) {}

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
				});
				return this.dispatch(
					prepared.session.hostSessionRef,
					prepared.operation,
					{
						schemaVersion: 1,
						kind: "submit-turn",
						operationId: request.executionId,
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						nativeSessionRef: prepared.session.nativeSessionRef,
						input: request.input,
					},
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
			});
			const nativeSessionRef =
				prepared.session.nativeSessionRef ?? nativeSessionRequired();
			return this.dispatch(request.hostSessionRef, prepared.operation, {
				schemaVersion: 1,
				kind: "supplement",
				operationId: request.messageId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				nativeSessionRef,
				input: request.input,
			});
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
			});
			const nativeSessionRef =
				prepared.session.nativeSessionRef ?? nativeSessionRequired();
			return this.dispatch(request.hostSessionRef, prepared.operation, {
				schemaVersion: 1,
				kind: "stop",
				operationId: request.stopRequestId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				nativeSessionRef,
			});
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
			});
			const nativeSessionRef =
				prepared.session.nativeSessionRef ?? nativeSessionRequired();
			await this.options.store.activateGenerationBarrier(
				request.hostSessionRef,
				request,
				request.tombstoneId,
			);
			const response = await this.dispatch(
				request.hostSessionRef,
				prepared.operation,
				{
					schemaVersion: 1,
					kind: "generation-cancel",
					operationId: request.tombstoneId,
					agentId: request.agentId,
					conversationId: request.conversationId,
					executionId: request.executionId,
					turnId: request.turnId,
					sessionGeneration: request.sessionGeneration,
					nativeSessionRef,
				},
			);
			await this.options.store.confirmGenerationBarrier(
				request.hostSessionRef,
				request.tombstoneId,
			);
			return response;
		});
	}

	private async dispatch(
		hostSessionRef: string,
		operation: StoredOperation,
		command: Parameters<RuntimeDriver["execute"]>[0],
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
				: await this.options.driver.execute(command);
		await this.options.afterDriverResult?.(operation.operationId);
		await this.options.store.resolveOperation(
			hostSessionRef,
			operation.operationId,
			driverRecord.result,
			driverRecord.nativeSessionRef,
		);
		return {
			schemaVersion: 1,
			hostSessionRef,
			operationId: operation.operationId,
			result: driverRecord.result,
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
