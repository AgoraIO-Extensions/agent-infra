import { createHash } from "node:crypto";
import {
	RuntimeBusinessGrantClaimsV2Schema,
	type RuntimeBusinessGrantClaimsV4,
	type RuntimeBusinessRequestV4,
	type RuntimeNativeCapabilityTransportV4,
	RuntimeNativeCapabilityTransportV4Schema,
	RuntimeOperationResponseV4Schema,
	type RuntimePinnedExecutionKeyScopeV4,
	RuntimePinnedExecutionKeyScopeV4Schema,
	type RuntimeRestoreExecutionKeyRequestV4,
	RuntimeRestoreExecutionKeyResponseV4Schema,
	type RuntimeRestoreExecutionKeyTransportV4,
	RuntimeRestoreExecutionKeyTransportV4Schema,
	type RuntimeSubmitTurnTransportV4,
	RuntimeSubmitTurnTransportV4Schema,
	type RuntimeSupplementTransportV4,
	RuntimeSupplementTransportV4Schema,
	runtimeOperationDigestInputV4,
	validateRuntimePinnedExecutionKeyScopeV4,
	validateRuntimePrivateRelayKeyFieldV1,
	validateRuntimeRestoreExecutionKeyPrivateFieldV4,
} from "@agent-infra/contracts/runtime";
import type {
	RuntimeDriver,
	RuntimeDriverExecutionContextV1,
	RuntimeOriginalEvidenceBinding,
} from "./driver.js";
import { RuntimeHostError } from "./errors.js";
import {
	type FileRuntimeStore,
	requestDigest,
	type StoredOperation,
} from "./file-runtime-store.js";
import { runtimeAuthorizationDenied } from "./runtime-authorization.js";
import type { RuntimeFileBridgePortV1 } from "./runtime-file-bridge.js";

type AcceptedV4 = {
	readonly request: RuntimeBusinessRequestV4;
	readonly claims: RuntimeBusinessGrantClaimsV4;
};

type AcceptedRecoveryV4 = {
	readonly request: RuntimeRestoreExecutionKeyRequestV4;
	readonly claims: import("@agent-infra/contracts/runtime").RuntimeRestoreExecutionKeyGrantClaimsV4;
};

interface Options {
	readonly store: FileRuntimeStore;
	readonly driver: RuntimeDriver;
	readonly assertOpen: () => void;
	readonly validateGrant: (request: unknown) => Promise<AcceptedV4>;
	readonly validateRecoveryGrant: (
		request: unknown,
	) => Promise<AcceptedRecoveryV4>;
	readonly dispatch: (
		hostSessionRef: string,
		operation: StoredOperation,
		allowBusinessExecution?: boolean,
		context?: RuntimeDriverExecutionContextV1,
	) => Promise<{ readonly result: unknown }>;
	readonly createFileBridge?: (
		request: RuntimeBusinessRequestV4,
		claims: RuntimeBusinessGrantClaimsV4,
	) => Promise<RuntimeFileBridgePortV1>;
	readonly serialize: <T>(key: string, work: () => Promise<T>) => Promise<T>;
	readonly installKey: (
		scope: RuntimePinnedExecutionKeyScopeV4,
		hostSessionRef: string,
		relayKey: string,
	) => void;
	readonly now?: () => number;
}

function nativeRequired(): never {
	throw new RuntimeHostError(
		"RUNTIME_SESSION_UNAVAILABLE",
		"Runtime session could not be recovered",
		503,
	);
}

/**
 * 会话存在但原生进程尚未绑定（nativeSessionRef 为空）时抛出可重试错误。
 * Worker 可通过重新提交 Turn 恢复；不同于 RUNTIME_SESSION_RECOVERY_FAILED（已绑定但丢失，不可重试）。
 * 修复 #3017。
 */
function nativeSessionUnbound(): never {
	throw new RuntimeHostError(
		"RUNTIME_SESSION_UNAVAILABLE",
		"Runtime session could not be recovered",
		503,
		true, // retryable：原生会话尚未绑定，Worker 可重新提交后重试
	);
}

function nativeUnsupported(): never {
	throw new RuntimeHostError(
		"RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED",
		"Native capability execution is unavailable for this runtime",
		409,
	);
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

export class RuntimeHostV4 {
	constructor(private readonly options: Options) {}

	async submitTurn(transport: RuntimeSubmitTurnTransportV4) {
		return this.execute(RuntimeSubmitTurnTransportV4Schema.parse(transport));
	}

	async supplement(transport: RuntimeSupplementTransportV4) {
		return this.execute(RuntimeSupplementTransportV4Schema.parse(transport));
	}

	async nativeCapability(transport: RuntimeNativeCapabilityTransportV4) {
		this.options.assertOpen();
		const parsed = RuntimeNativeCapabilityTransportV4Schema.parse(transport);
		const request = parsed.businessRequest;
		const { claims } = await this.options.validateGrant(request);
		if (
			claims.purpose !== "business" ||
			request.operation.kind !== "execution" ||
			request.operation.id !== request.executionId ||
			request.operation.deliveryFence !==
				request.operation.executionDeliveryFence
		)
			runtimeAuthorizationDenied();
		if (
			createHash("sha256").update(request.parameters).digest("hex") !==
			request.parametersDigest
		)
			runtimeAuthorizationDenied();
		const pinnedScope = scope(request);
		const privateField = validateRuntimePrivateRelayKeyFieldV1(
			parsed.privateKeyField,
			{
				request,
				grantId: claims.grantId,
				requestDigest: claims.requestDigest,
			},
		);
		const session = this.options.store.getSessionForQuery(
			request.hostSessionRef,
			request,
			request.operation.deliveryFence,
			"capabilityKind" in request,
		);
		const nativeSessionRef = session.nativeSessionRef ?? nativeSessionUnbound();
		const now = this.options.now ?? Date.now;
		const expiresAt = Math.min(claims.expiresAt, now() + 30_000);
		if (!Number.isSafeInteger(expiresAt) || expiresAt <= now())
			nativeRequired();
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			Math.max(0, expiresAt - now()),
		);
		timer.unref();
		const binding: RuntimeOriginalEvidenceBinding = {
			principal: request.principal,
			scope: {
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				sessionGeneration: request.sessionGeneration,
			},
		};
		const read = {
			nativeSessionRef,
			allowUnboundExecution: true,
			signal: controller.signal,
			expiresAt,
			assertCurrent: () => {
				if (controller.signal.aborted || expiresAt <= now()) nativeRequired();
				this.options.assertOpen();
				const currentSession = this.options.store.getSessionForQuery(
					request.hostSessionRef,
					request,
					request.operation.deliveryFence,
					"capabilityKind" in request,
				);
				if (currentSession.nativeSessionRef !== nativeSessionRef)
					nativeRequired();
				return binding;
			},
			revalidate: async () => {
				const current = read.assertCurrent();
				await this.options.validateGrant(request);
				return current;
			},
		};
		try {
			read.assertCurrent();
			const metadataReader = this.options.driver.readNativeMetadataV1;
			if (!metadataReader) nativeUnsupported();
			const selector =
				request.capabilityKind === "command" ? "commands" : "skills";
			const projection = await metadataReader.call(
				this.options.driver,
				selector,
				read,
			);
			await read.revalidate();
			if (
				projection.selector !== selector ||
				projection.revision !== request.directoryRevision
			)
				throw new RuntimeHostError(
					"RUNTIME_NATIVE_CAPABILITY_STALE",
					"Native capability directory is no longer current",
					409,
				);
			const capability = projection.capabilities.find(
				(entry) =>
					entry.id === request.capabilityId &&
					entry.kind === request.capabilityKind,
			);
			const expectedAvailability =
				request.capabilityKind === "command" ? "available" : "discovered";
			if (
				!capability ||
				capability.availability !== expectedAvailability ||
				capability.source.version !== request.capabilitySourceVersion
			)
				throw new RuntimeHostError(
					"RUNTIME_NATIVE_CAPABILITY_UNAVAILABLE",
					"Native capability is unavailable",
					409,
				);
			const capabilityName = capability.name;
			const response = await this.options.serialize(
				this.options.store.sessionQueueKey(request),
				async () => {
					this.options.assertOpen();
					await this.options.validateGrant(request);
					const latest = await metadataReader.call(
						this.options.driver,
						selector,
						read,
					);
					if (
						latest.selector !== selector ||
						latest.revision !== request.directoryRevision
					)
						throw new RuntimeHostError(
							"RUNTIME_NATIVE_CAPABILITY_STALE",
							"Native capability directory is no longer current",
							409,
						);
					const latestCapability = latest.capabilities.find(
						(entry) =>
							entry.id === request.capabilityId &&
							entry.kind === request.capabilityKind,
					);
					if (
						!latestCapability ||
						latestCapability.name !== capabilityName ||
						latestCapability.availability !== expectedAvailability ||
						latestCapability.source.version !== request.capabilitySourceVersion
					)
						throw new RuntimeHostError(
							"RUNTIME_NATIVE_CAPABILITY_STALE",
							"Native capability is no longer current",
							409,
						);
					const prepared = await this.options.store.prepareOperation({
						authorization: businessAuthority(claims),
						now,
						requestedHostSessionRef: request.hostSessionRef,
						binding: request,
						operationId: request.executionId,
						kind:
							request.capabilityKind === "command"
								? "native-command"
								: "submit-turn",
						scope: `execution:${request.executionId}`,
						deliveryFence: request.operation.deliveryFence,
						requestDigest: requestDigest(
							runtimeOperationDigestInputV4(request),
						),
						keyScopeV4: pinnedScope,
						command: (commandNativeSessionRef) => {
							if (commandNativeSessionRef !== nativeSessionRef)
								nativeRequired();
							if (request.capabilityKind === "command") {
								const commandCreate =
									this.options.driver.createNativeCommandCommand;
								if (!commandCreate) nativeUnsupported();
								return commandCreate.call(this.options.driver, {
									schemaVersion: 1,
									kind: "native-command",
									operationId: request.executionId,
									agentId: request.agentId,
									conversationId: request.conversationId,
									executionId: request.executionId,
									turnId: request.turnId,
									sessionGeneration: request.sessionGeneration,
									nativeSessionRef: commandNativeSessionRef,
									capabilityId: request.capabilityId,
									directoryRevision: request.directoryRevision,
									parameters: request.parameters,
									parametersDigest: request.parametersDigest,
									capabilityName,
									capabilitySourceVersion: request.capabilitySourceVersion,
								});
							}
							const skillCreate = this.options.driver.createNativeSkillCommand;
							if (!skillCreate) nativeUnsupported();
							const resolveSkill =
								this.options.driver.resolveNativeSkillBinding;
							if (!resolveSkill) nativeUnsupported();
							const skillBinding = resolveSkill.call(this.options.driver, {
								nativeSessionRef: commandNativeSessionRef,
								capabilityName,
								capabilitySourceVersion: request.capabilitySourceVersion,
								directoryRevision: request.directoryRevision,
							});
							return skillCreate.call(this.options.driver, {
								schemaVersion: 1,
								kind: "native-capability",
								operationId: request.executionId,
								agentId: request.agentId,
								conversationId: request.conversationId,
								executionId: request.executionId,
								turnId: request.turnId,
								sessionGeneration: request.sessionGeneration,
								nativeSessionRef: commandNativeSessionRef,
								capabilityId: request.capabilityId,
								directoryRevision: request.directoryRevision,
								parameters: request.parameters,
								parametersDigest: request.parametersDigest,
								capabilityName,
								capabilitySourceVersion: request.capabilitySourceVersion,
								packageDigest: skillBinding.packageDigest,
								manifestDigest: skillBinding.manifestDigest,
							});
						},
					});
					this.options.assertOpen();
					if (prepared.operation.state === "resolved") {
						const replayed = RuntimeOperationResponseV4Schema.parse({
							schemaVersion: 4,
							hostSessionRef: prepared.session.hostSessionRef,
							operationId: prepared.operation.operationId,
							result: (
								await this.options.dispatch(
									prepared.session.hostSessionRef,
									prepared.operation,
									false,
								)
							).result,
						});
						if (
							request.capabilityKind === "skill" &&
							replayed.result.outcome === "accepted" &&
							replayed.result.status === "running"
						)
							this.options.installKey(
								pinnedScope,
								prepared.session.hostSessionRef,
								privateField.keyDelivery.relayKey,
							);
						return replayed;
					}
					if (request.capabilityKind === "skill")
						this.options.installKey(
							pinnedScope,
							prepared.session.hostSessionRef,
							privateField.keyDelivery.relayKey,
						);
					const dispatched = await this.options.dispatch(
						prepared.session.hostSessionRef,
						prepared.operation,
						true,
						request.capabilityKind === "command"
							? { nativeCommand: read }
							: undefined,
					);
					return RuntimeOperationResponseV4Schema.parse({
						schemaVersion: 4,
						hostSessionRef: prepared.session.hostSessionRef,
						operationId: prepared.operation.operationId,
						result: dispatched.result,
					});
				},
			);
			return response;
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}

	async restoreExecutionKey(transport: RuntimeRestoreExecutionKeyTransportV4) {
		this.options.assertOpen();
		const parsed = RuntimeRestoreExecutionKeyTransportV4Schema.parse(transport);
		await this.options.validateRecoveryGrant(parsed.recoveryRequest);
		this.options.assertOpen();
		return this.options.serialize(
			this.options.store.sessionQueueKey(
				parsed.recoveryRequest.originalRequest,
			),
			async () => {
				this.options.assertOpen();
				const accepted = await this.options.validateRecoveryGrant(
					parsed.recoveryRequest,
				);
				this.options.assertOpen();
				const privateField = validateRuntimeRestoreExecutionKeyPrivateFieldV4(
					parsed.privateKeyField,
					accepted,
				);
				const recovered =
					await this.options.store.recoverAcceptedExecutionKeyV4({
						request: accepted.request,
						claims: accepted.claims,
						now: this.options.now ?? Date.now,
					});
				this.options.assertOpen();
				const observed = await this.options.dispatch(
					recovered.hostSessionRef,
					recovered.operation,
					false,
				);
				const observedResult =
					RuntimeOperationResponseV4Schema.shape.result.parse(observed.result);
				if (
					observedResult.outcome !== "accepted" ||
					observedResult.status !== "running"
				)
					runtimeAuthorizationDenied();
				this.options.assertOpen();
				this.options.store.assertAcceptedExecutionKeyCurrentV4({
					request: accepted.request,
					claims: accepted.claims,
					now: this.options.now ?? Date.now,
				});
				this.options.installKey(
					recovered.scope,
					recovered.hostSessionRef,
					privateField.keyDelivery.relayKey,
				);
				return RuntimeRestoreExecutionKeyResponseV4Schema.parse({
					schemaVersion: 4,
					hostSessionRef: recovered.hostSessionRef,
					operationId: recovered.operation.operationId,
					result: "restored",
				});
			},
		);
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
				const digest = requestDigest(runtimeOperationDigestInputV4(request));
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
					const replayed = RuntimeOperationResponseV4Schema.parse({
						schemaVersion: 4,
						hostSessionRef: prepared.session.hostSessionRef,
						operationId: prepared.operation.operationId,
						result: (
							await this.options.dispatch(
								prepared.session.hostSessionRef,
								prepared.operation,
								false,
							)
						).result,
					});
					if (
						replayed.result.outcome === "accepted" &&
						replayed.result.status === "running"
					)
						this.options.installKey(
							pinned,
							prepared.session.hostSessionRef,
							privateField.keyDelivery.relayKey,
						);
					return replayed;
				}
				this.options.installKey(
					pinned,
					prepared.session.hostSessionRef,
					privateField.keyDelivery.relayKey,
				);
				this.options.assertOpen();
				const fileBridge = this.options.createFileBridge
					? await this.options.createFileBridge(request, claims)
					: undefined;
				const dispatched = await this.options.dispatch(
					prepared.session.hostSessionRef,
					prepared.operation,
					true,
					fileBridge ? { fileBridge } : undefined,
				);
				const result = RuntimeOperationResponseV4Schema.parse({
					schemaVersion: 4,
					hostSessionRef: prepared.session.hostSessionRef,
					operationId: prepared.operation.operationId,
					result: dispatched.result,
				});
				return result;
			},
		);
	}
}
