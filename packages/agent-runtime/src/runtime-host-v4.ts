import {
	RuntimeBusinessGrantClaimsV2Schema,
	type RuntimeBusinessGrantClaimsV4,
	type RuntimeBusinessRequestV4,
	RuntimeOperationResponseV4Schema,
	type RuntimePinnedExecutionKeyScopeV4,
	RuntimePinnedExecutionKeyScopeV4Schema,
	type RuntimeSubmitTurnTransportV4,
	RuntimeSubmitTurnTransportV4Schema,
	type RuntimeSupplementTransportV4,
	RuntimeSupplementTransportV4Schema,
	runtimeOperationDigestInputV4,
	validateRuntimePinnedExecutionKeyScopeV4,
	validateRuntimePrivateRelayKeyFieldV1,
} from "@agent-infra/contracts/runtime";

import { RuntimeHostError } from "./errors.js";
import {
	type FileRuntimeStore,
	requestDigest,
	type StoredOperation,
} from "./file-runtime-store.js";
import { runtimeAuthorizationDenied } from "./runtime-authorization.js";

type AcceptedV4 = {
	readonly request: RuntimeBusinessRequestV4;
	readonly claims: RuntimeBusinessGrantClaimsV4;
};

interface Options {
	readonly store: FileRuntimeStore;
	readonly assertOpen: () => void;
	readonly validateGrant: (request: unknown) => Promise<AcceptedV4>;
	readonly dispatch: (
		hostSessionRef: string,
		operation: StoredOperation,
	) => Promise<{ readonly result: unknown }>;
	readonly serialize: <T>(key: string, work: () => Promise<T>) => Promise<T>;
	readonly installKey: (
		scope: RuntimePinnedExecutionKeyScopeV4,
		hostSessionRef: string,
		relayKey: string,
	) => void;
	readonly clearKey?: (executionId: string) => void;
	readonly now?: () => number;
}

function businessAuthority(claims: RuntimeBusinessGrantClaimsV4) {
	const {
		schemaVersion: _schemaVersion,
		executionSource: _executionSource,
		relayKeyBinding: _relayKeyBinding,
		...common
	} = claims;
	return RuntimeBusinessGrantClaimsV2Schema.parse({
		...common,
		schemaVersion: 2,
	});
}

function scope(request: RuntimeBusinessRequestV4) {
	return RuntimePinnedExecutionKeyScopeV4Schema.parse({
		principal: request.principal,
		executionSource: request.executionSource,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		hostSessionRef: request.hostSessionRef,
		keyBinding: request.keyBinding,
	});
}

function operationDigest(request: RuntimeBusinessRequestV4) {
	return requestDigest(runtimeOperationDigestInputV4(request));
}

function response(hostSessionRef: string, operation: StoredOperation) {
	if (operation.state !== "resolved" || !operation.result)
		throw new RuntimeHostError(
			"RUNTIME_ACCEPTANCE_UNKNOWN",
			"Runtime command acceptance could not be confirmed",
			503,
			true,
		);
	return RuntimeOperationResponseV4Schema.parse({
		schemaVersion: 4,
		hostSessionRef,
		operationId: operation.operationId,
		result: operation.result,
	});
}

export class RuntimeHostV4 {
	constructor(private readonly options: Options) {}

	async submitTurn(transport: RuntimeSubmitTurnTransportV4) {
		return this.execute(RuntimeSubmitTurnTransportV4Schema.parse(transport));
	}

	async supplement(transport: RuntimeSupplementTransportV4) {
		return this.execute(RuntimeSupplementTransportV4Schema.parse(transport));
	}

	private async execute(
		transport: RuntimeSubmitTurnTransportV4 | RuntimeSupplementTransportV4,
	) {
		this.options.assertOpen();
		const request = transport.businessRequest;
		await this.options.validateGrant(request);
		this.options.assertOpen();
		return this.options.serialize(
			this.options.store.sessionQueueKey(request),
			async () => {
				this.options.assertOpen();
				const { claims } = await this.options.validateGrant(request);
				this.options.assertOpen();
				const original =
					this.options.store.readOriginalExecutionKeyScopeV4(request);
				const submit = "selection" in request;
				if (original && !original.scope) runtimeAuthorizationDenied();
				if (!submit && !original?.scope) runtimeAuthorizationDenied();
				if (original?.scope)
					validateRuntimePinnedExecutionKeyScopeV4(
						original.scope,
						request,
						submit ? original.scope.hostSessionRef : original.hostSessionRef,
					);
				const privateField = validateRuntimePrivateRelayKeyFieldV1(
					transport.privateKeyField,
					{
						request,
						grantId: claims.grantId,
						requestDigest: claims.requestDigest,
					},
				);
				const digest = operationDigest(request);
				const pinned = original?.scope ?? scope(request);
				const authority = businessAuthority(claims);
				const prepared = await this.options.store.prepareOperation({
					authorization: authority,
					now: this.options.now ?? Date.now,
					requestedHostSessionRef: request.hostSessionRef ?? undefined,
					binding: request,
					operationId: request.operation.id,
					kind: submit ? "submit-turn" : "supplement",
					scope: `${submit ? "execution" : "message"}:${request.operation.id}`,
					deliveryFence: request.operation.deliveryFence,
					...(submit
						? {}
						: {
								executionDeliveryFence:
									request.operation.executionDeliveryFence,
							}),
					requestDigest: digest,
					keyScopeV4: pinned,
					command: (nativeSessionRef) => {
						const base = {
							operationId: request.operation.id,
							agentId: request.agentId,
							conversationId: request.conversationId,
							executionId: request.executionId,
							turnId: request.turnId,
							sessionGeneration: request.sessionGeneration,
							input: request.input,
						};
						return "selection" in request
							? {
									schemaVersion: 2 as const,
									kind: "submit-turn" as const,
									...base,
									...(nativeSessionRef ? { nativeSessionRef } : {}),
									selection: request.selection,
								}
							: {
									schemaVersion: 1 as const,
									kind: "supplement" as const,
									...base,
									nativeSessionRef:
										nativeSessionRef ?? runtimeAuthorizationDenied(),
								};
					},
				});
				this.options.assertOpen();
				if (prepared.operation.state === "resolved") {
					const replayed = response(
						prepared.session.hostSessionRef,
						prepared.operation,
					);
					if (
						replayed.result.outcome === "accepted" &&
						replayed.result.status === "running"
					)
						this.options.installKey(
							pinned,
							prepared.session.hostSessionRef,
							privateField.keyDelivery.relayKey,
						);
					else this.options.clearKey?.(request.executionId);
					return replayed;
				}
				this.options.installKey(
					pinned,
					prepared.session.hostSessionRef,
					privateField.keyDelivery.relayKey,
				);
				try {
					this.options.assertOpen();
					const dispatched = await this.options.dispatch(
						prepared.session.hostSessionRef,
						prepared.operation,
					);
					const result = RuntimeOperationResponseV4Schema.parse({
						schemaVersion: 4,
						hostSessionRef: prepared.session.hostSessionRef,
						operationId: prepared.operation.operationId,
						result: dispatched.result,
					});
					if (
						result.result.outcome !== "accepted" ||
						result.result.status !== "running"
					)
						this.options.clearKey?.(request.executionId);
					return result;
				} catch (error) {
					this.options.clearKey?.(request.executionId);
					throw error;
				}
			},
		);
	}
}
