import { randomBytes, randomUUID } from "node:crypto";
import { resolveApprovedConnectionSystemAccessV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	type ConnectionInstallCommandResponseV1,
	type ConnectionInstallConfirmBindingReadbackResponseV1,
	type ConnectionInstallConfirmExchangeResponseV1,
	type ConnectionRegistrationTemplateV1,
	connectionHostDeploymentIdentityV1,
	connectionManualConfirmContractV1,
	type RuntimeOAuthAuthorizedRequestV1,
	type RuntimeOAuthResponseV1,
} from "@agent-infra/contracts/runtime";
import {
	buildConnectionRegistrationTemplateV1,
	connectionInstallCommandDigestV1,
	connectionInstallFirstBeginBodyDigestV1,
	connectionInstallRequestDigestV1,
} from "@agent-infra/contracts/runtime/connection-install-node";
import { connectionServiceCredentialSecretNameV1 } from "@agent-infra/platform-core";
import type {
	ConnectionManualInstallationClaimV1,
	PostgresConnectionManualInstallationStoreV1,
} from "@agent-infra/platform-store";
import type { SecretKeyringDecryptorV1 } from "@agent-infra/secret-store/worker";
import type { ConnectionInstallHostClientV1 } from "./connection-install-host-client.js";

type ExchangeInput = Parameters<
	ConnectionInstallHostClientV1["confirmExchange"]
>[0];

type Store = Pick<
	PostgresConnectionManualInstallationStoreV1,
	| "listPending"
	| "claim"
	| "fixSupply"
	| "settleSupply"
	| "recoverSupply"
	| "commitDelivery"
	| "settleRegistration"
	| "settleRevoke"
	| "firstBeginContext"
	| "settleBegin"
	| "openConfirmPhase"
	| "commitConfirmPin"
	| "settleConfirmPhase"
	| "commitPermit"
>;

export interface ConnectionManualInstallationDrainOptionsV1 {
	readonly store: Store;
	/** Worker-only ADR 0002 keyring; decrypts only while materializing the Host supply. */
	readonly decryptor: SecretKeyringDecryptorV1;
	readonly host: ConnectionInstallHostClientV1;
	/** Approved one-time system access and fixed EP-1060 client name (§13.5.7). */
	readonly systemAccess: unknown;
	readonly approval: unknown;
	readonly clientName: string;
	/** Session Sandbox namespace and install listener port from the Worker policy. */
	readonly namespace: string;
	readonly receiverPort: number;
	/** Runtime grant signing Worker id; also names the deployment identity. */
	readonly deploymentWorkerId: string;
	/** Original outbox claim owner of this Worker process. */
	readonly attemptOwner: string;
}

function credentialRecordMatches(
	ciphertext: unknown,
	binding: { agentId: string; ownerId: string; associationRevision: number },
) {
	if (!ciphertext || typeof ciphertext !== "object") return false;
	const record = ciphertext as Record<string, unknown>;
	return (
		record.ownerType === "platform" &&
		record.agentId === binding.agentId &&
		record.ownerId === binding.ownerId &&
		record.name === connectionServiceCredentialSecretNameV1 &&
		record.secretVersion === binding.associationRevision &&
		record.configRevision === binding.associationRevision &&
		record.secretId ===
			`${connectionServiceCredentialSecretNameV1}:${binding.agentId}:${binding.associationRevision}`
	);
}

/**
 * Drains the manual EP-1060 install commands of Executions this Worker holds
 * (§13.5.5–§13.5.7), inside the existing installation tick. Every command is a
 * persisted `sending` attempt before any byte is sent; any failure after that
 * is recorded unknown and never retried, replayed or moved to another claim.
 */
export function createConnectionManualInstallationDrainV1(
	options: ConnectionManualInstallationDrainOptionsV1,
) {
	const access = resolveApprovedConnectionSystemAccessV1(
		structuredClone(options.systemAccess),
		structuredClone(options.approval),
	);
	if (
		access.status !== "available" ||
		!Number.isSafeInteger(options.receiverPort) ||
		options.receiverPort < 1024 ||
		options.receiverPort > 65_535 ||
		!options.attemptOwner
	)
		throw new Error("CONNECTION_MANUAL_INSTALLATION_UNAVAILABLE");
	const deploymentIdentity = connectionHostDeploymentIdentityV1({
		namespace: options.namespace,
		workerId: options.deploymentWorkerId,
	});
	const { store, host } = options;
	const owner = options.attemptOwner;

	/** One delivery. Losing confirmation is a separate recovery state. */
	async function supply(
		claimed: ConnectionManualInstallationClaimV1,
		template: ConnectionRegistrationTemplateV1,
		registrationKey: string,
		supplyAttemptId: string,
		signal: AbortSignal,
	): Promise<"confirmed" | "unknown" | "not_sent"> {
		const attempt = {
			commandId: claimed.command.commandId,
			attemptId: claimed.command.attemptId,
			attemptOwner: owner,
		};
		const fixed = await store.fixSupply({
			...attempt,
			command: "prepare",
			template,
			registrationKey,
			supplyAttemptId,
		});
		if (!fixed || !credentialRecordMatches(fixed.ciphertext, fixed.binding))
			return "not_sent";
		let credential: Uint8Array | undefined;
		let deliveryStarted = false;
		let delivered = false;
		try {
			const decrypted = await options.decryptor.decrypt({
				encryptedRecord: fixed.ciphertext,
				traceId: randomUUID(),
			});
			if (decrypted.outcome !== "decrypted") return "not_sent";
			credential = decrypted.plaintext;
			const { runtimeOrigin: _origin, ...target } = template.target;
			deliveryStarted = true;
			await host.supply(
				{ template, attemptId: supplyAttemptId, credential, target },
				signal,
			);
			delivered = true;
		} catch {
			delivered = false;
		} finally {
			credential?.fill(0);
		}
		if (!deliveryStarted) return "not_sent";
		const settled = await store.settleSupply({
			...attempt,
			command: "prepare",
			authorizationId: claimed.authorization.authorizationId,
			supplyAttemptId,
			outcome: delivered ? "confirmed" : "unknown",
		});
		return settled && delivered ? "confirmed" : "unknown";
	}

	async function prepare(
		claimed: ConnectionManualInstallationClaimV1,
		signal: AbortSignal,
	) {
		const attempt = {
			commandId: claimed.command.commandId,
			attemptId: claimed.command.attemptId,
			attemptOwner: owner,
		};
		const { current, authorization } = claimed;
		const registrationKey =
			claimed.installation.registrationKey ??
			`mi-${randomBytes(32).toString("base64url")}`;
		const supplyAttemptId =
			claimed.installation.supplyAttemptId ?? randomUUID();
		const template =
			claimed.installation.template ??
			buildConnectionRegistrationTemplateV1({
				access: access as Extract<typeof access, { status: "available" }>,
				clientName: options.clientName,
				principal: authorization.principal,
				reference: authorization.reference,
				authorizationId: authorization.authorizationId,
				confirmationRevision: authorization.confirmationRevision,
				association: current.preparation.association,
				claim: current.claim,
				target: {
					deploymentIdentity,
					hostRef: current.preparation.hostRef,
					sandboxId: current.preparation.sandboxId,
					podUid: current.preparation.podUid,
					sessionGeneration: current.preparation.sessionGeneration,
					resourceFence: current.preparation.resourceFence,
					runtimeOrigin: `https://${current.preparation.resourceName}.${options.namespace}.svc:${options.receiverPort}/`,
				},
				registrationKey,
			});
		const rejected = () =>
			store.settleRegistration({
				...attempt,
				command: "prepare",
				authorizationId: authorization.authorizationId,
				response: {
					schemaVersion: 1,
					outcome: "rejected",
					commandId: attempt.commandId,
				},
			});
		if (claimed.installation.supplyState === "pending") {
			const supplied = await supply(
				claimed,
				template,
				registrationKey,
				supplyAttemptId,
				signal,
			);
			if (supplied === "unknown") return;
			if (supplied !== "confirmed") return rejected();
		} else if (
			claimed.installation.supplyState !== "confirmed" ||
			!claimed.installation.template ||
			!claimed.installation.registrationKey ||
			!claimed.installation.supplyAttemptId
		)
			return rejected();
		const deliveryDigest = connectionInstallCommandDigestV1({
			schemaVersion: 1,
			command: "prepare",
			...attempt,
			template,
			supplyAttemptId,
			registrationKey,
		});
		if (
			!(await store.commitDelivery({
				...attempt,
				command: "prepare",
				authorizationId: authorization.authorizationId,
				deliveryDigest,
			}))
		)
			return rejected();
		let response: ConnectionInstallCommandResponseV1 | undefined;
		try {
			response = await host.command(
				{
					command: "prepare",
					...attempt,
					template,
					supplyAttemptId,
					registrationKey,
				},
				signal,
			);
		} catch {
			response = undefined;
		}
		return store.settleRegistration({
			...attempt,
			command: "prepare",
			authorizationId: authorization.authorizationId,
			...(response ? { response } : {}),
		});
	}

	async function command(
		claimed: ConnectionManualInstallationClaimV1,
		kind: "status" | "revoke",
		signal: AbortSignal,
	) {
		const attempt = {
			commandId: claimed.command.commandId,
			attemptId: claimed.command.attemptId,
			attemptOwner: owner,
		};
		const { template, registrationKey, supplyAttemptId, receipt } =
			claimed.installation;
		const settle = (response?: ConnectionInstallCommandResponseV1) =>
			kind === "status"
				? store.settleRegistration({
						...attempt,
						command: "status",
						authorizationId: claimed.authorization.authorizationId,
						...(response ? { response } : {}),
					})
				: store.settleRevoke({
						...attempt,
						authorizationId: claimed.authorization.authorizationId,
						...(response ? { response } : {}),
					});
		const rejected = {
			schemaVersion: 1 as const,
			outcome: "rejected" as const,
			commandId: attempt.commandId,
		};
		if (
			!template ||
			!registrationKey ||
			!supplyAttemptId ||
			(kind === "revoke" && !receipt)
		)
			return settle(rejected);
		const originalSupplyUnknown =
			kind === "status" &&
			claimed.installation.supplyState === "unknown" &&
			claimed.installation.registrationState === "pending";
		const wireCommand = originalSupplyUnknown ? "supply_status" : kind;
		const expected =
			kind === "revoke" && receipt
				? {
						consumerId: receipt.consumerId,
						clientId: receipt.clientId,
						instanceId: receipt.instanceId,
					}
				: undefined;
		const deliveryDigest = connectionInstallCommandDigestV1({
			schemaVersion: 1,
			command: wireCommand,
			...attempt,
			template,
			supplyAttemptId,
			registrationKey,
			...(expected ? { expected } : {}),
		});
		if (
			!(await store.commitDelivery({
				...attempt,
				command: kind,
				authorizationId: claimed.authorization.authorizationId,
				deliveryDigest,
			}))
		)
			return settle(rejected);
		let response: ConnectionInstallCommandResponseV1 | undefined;
		try {
			response = await host.command(
				{
					command: wireCommand,
					...attempt,
					template,
					supplyAttemptId,
					registrationKey,
					...(expected ? { expected } : {}),
				},
				signal,
			);
		} catch {
			response = undefined;
		}
		if (originalSupplyUnknown)
			return store.recoverSupply({
				...attempt,
				authorizationId: claimed.authorization.authorizationId,
				supplyAttemptId,
				confirmed: response?.outcome === "supply_confirmed",
			});
		return settle(response);
	}

	/**
	 * §13.5.6 exception confirm, phase 1: under the logical confirm's attempt the
	 * Worker commits the phase's sending before it signs and sends, then commits
	 * the first pin in the Store from this command's own candidate. A pinned
	 * confirm continues into phase 2 under the same attempt.
	 */
	async function confirm(
		claimed: ConnectionManualInstallationClaimV1,
		signal: AbortSignal,
	) {
		const authorizationId = claimed.authorization.authorizationId;
		const attempt = {
			attemptId: claimed.command.attemptId,
			attemptOwner: owner,
			authorizationId,
		};
		const context = await store.firstBeginContext({
			...attempt,
			commandId: claimed.command.commandId,
			command: "confirm",
		});
		if (!context) return;
		const phase = await store.openConfirmPhase({
			...attempt,
			confirmCommandId: claimed.command.commandId,
			phase: "confirm_binding_readback",
		});
		if (!phase) return;
		const request = {
			confirmCommandId: claimed.command.commandId,
			commandId: phase.phaseCommandId,
			attemptId: claimed.command.attemptId,
			attemptOwner: owner,
			template: context.template,
			supplyAttemptId: context.supplyAttemptId,
			registrationKey: context.registrationKey,
			descriptor: context.descriptor,
		};
		const settle = (outcome: "rejected" | "unknown") =>
			store.settleConfirmPhase({
				...attempt,
				confirmCommandId: claimed.command.commandId,
				phaseCommandId: phase.phaseCommandId,
				outcome,
			});
		if (
			!(await store.commitDelivery({
				...attempt,
				commandId: phase.phaseCommandId,
				command: "confirm_binding_readback",
				deliveryDigest: connectionInstallRequestDigestV1({
					schemaVersion: 1,
					contract: connectionManualConfirmContractV1,
					phase: "binding_readback",
					...request,
				}),
			}))
		)
			return;
		let response: ConnectionInstallConfirmBindingReadbackResponseV1 | undefined;
		try {
			response = await host.confirmBindingReadback(request, signal);
		} catch {
			response = undefined;
		}
		if (response?.outcome === "candidate") {
			const pinned = await store.commitConfirmPin({
				...attempt,
				confirmCommandId: claimed.command.commandId,
				phaseCommandId: phase.phaseCommandId,
				candidate: response.candidate,
			});
			if (pinned.outcome !== "pinned") return;
			const { commandId: _phase1, ...fixedInput } = request;
			return exchange(
				fixedInput,
				attempt,
				pinned.receipt,
				response.candidate,
				signal,
			);
		}
		return settle(response?.outcome === "rejected" ? "rejected" : "unknown");
	}

	/**
	 * §13.5.6 exception confirm, phase 2: only while the same attempt still holds
	 * and this confirm's first-pin receipt is committed. The phase is opened
	 * with that receipt, its sending is committed before it is signed and sent,
	 * and its result is settled under the same final predicate. A lost answer
	 * stays unknown; nothing is resent.
	 */
	async function exchange(
		fixedInput: Omit<ExchangeInput, "commandId" | "pinReceipt" | "candidate">,
		attempt: {
			readonly attemptId: string;
			readonly attemptOwner: string;
			readonly authorizationId: string;
		},
		committed: { readonly id: string; readonly candidateDigest: string },
		candidate: ExchangeInput["candidate"],
		signal: AbortSignal,
	) {
		const phase = await store.openConfirmPhase({
			...attempt,
			confirmCommandId: fixedInput.confirmCommandId,
			phase: "confirm_exchange",
		});
		if (
			!phase?.receipt ||
			phase.receipt.id !== committed.id ||
			phase.receipt.candidateDigest !== committed.candidateDigest
		)
			return;
		const request: ExchangeInput = {
			...fixedInput,
			commandId: phase.phaseCommandId,
			pinReceipt: phase.receipt,
			candidate,
		};
		if (
			!(await store.commitDelivery({
				...attempt,
				commandId: phase.phaseCommandId,
				command: "confirm_exchange",
				deliveryDigest: connectionInstallRequestDigestV1({
					schemaVersion: 1,
					contract: connectionManualConfirmContractV1,
					phase: "exchange",
					...request,
				}),
			}))
		)
			return;
		let response: ConnectionInstallConfirmExchangeResponseV1 | undefined;
		try {
			response = await host.confirmExchange(request, signal);
		} catch {
			response = undefined;
		}
		const settled = await store.settleConfirmPhase({
			...attempt,
			confirmCommandId: fixedInput.confirmCommandId,
			phaseCommandId: phase.phaseCommandId,
			phase: "confirm_exchange",
			outcome:
				response?.outcome === "exchanged" || response?.outcome === "rejected"
					? response.outcome
					: "unknown",
		});
		// §13.5.6 启用许可: only this exchange's own committed publication
		// evidence, while the same attempt and original claim still hold.
		if (settled !== "exchanged" || !response?.publication) return settled;
		return store.commitPermit({
			...attempt,
			confirmCommandId: fixedInput.confirmCommandId,
			exchangeCommandId: phase.phaseCommandId,
			publication: response.publication,
		});
	}

	async function begin(
		claimed: ConnectionManualInstallationClaimV1,
		kind: "begin" | "begin_status",
		signal: AbortSignal,
	) {
		const attempt = {
			commandId: claimed.command.commandId,
			attemptId: claimed.command.attemptId,
			attemptOwner: owner,
		};
		const authorizationId = claimed.authorization.authorizationId;
		const context = await store.firstBeginContext({
			...attempt,
			authorizationId,
			command: kind,
		});
		const unknown = () =>
			store.settleBegin({ ...attempt, command: kind, authorizationId });
		if (!context) return unknown();
		const { template, configuration, receipt, supplyAttemptId, descriptor } =
			context;
		let result: RuntimeOAuthResponseV1 | undefined;
		if (kind === "begin") {
			const request: Omit<RuntimeOAuthAuthorizedRequestV1, "grant"> = {
				schemaVersion: 1,
				agentId: template.reference.agentId,
				sandboxId: template.target.sandboxId,
				podUid: template.target.podUid,
				sessionGeneration: template.target.sessionGeneration,
				configFingerprint: configuration.configFingerprint,
				source: configuration.source,
				oauthConfiguration: {
					ref: configuration.ref,
					revision: configuration.revision,
				},
				reference: template.reference,
				authorizationId,
				confirmationRevision: template.confirmationRevision,
				command: "begin",
			};
			const deliveryDigest = connectionInstallFirstBeginBodyDigestV1({
				schemaVersion: 1,
				...attempt,
				template,
				supplyAttemptId,
				receipt,
				configuration,
				descriptor,
				request,
			});
			if (
				!(await store.commitDelivery({
					...attempt,
					command: "begin",
					authorizationId,
					deliveryDigest,
				}))
			)
				return unknown();
			try {
				result = await host.firstBegin(
					{
						...attempt,
						template,
						supplyAttemptId,
						receipt,
						configuration,
						descriptor,
						request,
						principal: template.principal,
					},
					signal,
				);
			} catch {
				result = undefined;
			}
		} else {
			if (!context.beginCommandId) return unknown();
			const deliveryDigest = connectionInstallRequestDigestV1({
				schemaVersion: 1,
				...attempt,
				beginCommandId: context.beginCommandId,
				template,
				supplyAttemptId,
				registrationKey: context.registrationKey,
			});
			if (
				!(await store.commitDelivery({
					...attempt,
					command: "begin_status",
					authorizationId,
					deliveryDigest,
				}))
			)
				return unknown();
			try {
				result = await host.beginStatus(
					{
						...attempt,
						beginCommandId: context.beginCommandId,
						template,
						supplyAttemptId,
						registrationKey: context.registrationKey,
						configuration,
					},
					signal,
				);
			} catch {
				result = undefined;
			}
		}
		return store.settleBegin({
			...attempt,
			command: kind,
			authorizationId,
			...(result ? { result } : {}),
		});
	}

	return {
		/** One bounded pass over the commands of Executions this Worker holds. */
		async drain(
			executionIds: readonly string[],
			signal: AbortSignal,
		): Promise<number> {
			if (executionIds.length === 0 || signal.aborted) return 0;
			// The listing's recovery pass is bounded and yields to the same signal.
			const pending = await store.listPending(32, executionIds, signal);
			let drained = 0;
			for (const item of pending) {
				if (signal.aborted) break;
				if (!executionIds.includes(item.executionId)) continue;
				const claimed = await store.claim({
					commandId: item.commandId,
					attemptId: randomUUID(),
					attemptOwner: owner,
				});
				if (!claimed) continue;
				const bounded = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
				try {
					switch (claimed.command.command) {
						case "prepare":
							await prepare(claimed, bounded);
							break;
						case "status":
						case "revoke":
							await command(claimed, claimed.command.command, bounded);
							break;
						case "begin":
						case "begin_status":
							await begin(claimed, claimed.command.command, bounded);
							break;
						case "confirm":
							await confirm(claimed, bounded);
							break;
					}
					drained++;
				} catch {
					// A storage failure leaves the attempt to expire into unknown.
				}
			}
			return drained;
		},
	};
}
