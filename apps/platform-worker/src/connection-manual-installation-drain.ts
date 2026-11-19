import { randomBytes, randomUUID } from "node:crypto";
import { resolveApprovedConnectionSystemAccessV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	type ConnectionInstallCommandResponseV1,
	type ConnectionRegistrationTemplateV1,
	connectionHostDeploymentIdentityV1,
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

type Store = Pick<
	PostgresConnectionManualInstallationStoreV1,
	| "listPending"
	| "claim"
	| "fixSupply"
	| "settleSupply"
	| "commitDelivery"
	| "settleRegistration"
	| "settleRevoke"
	| "firstBeginContext"
	| "settleBegin"
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

	/** Same-attempt supply (first delivery or idempotent redelivery). */
	async function supply(
		claimed: ConnectionManualInstallationClaimV1,
		command: "prepare" | "status" | "revoke" | "begin" | "begin_status",
		template: ConnectionRegistrationTemplateV1,
		registrationKey: string,
		supplyAttemptId: string,
		signal: AbortSignal,
	): Promise<boolean> {
		const attempt = {
			commandId: claimed.command.commandId,
			attemptId: claimed.command.attemptId,
			attemptOwner: owner,
		};
		const fixed = await store.fixSupply({
			...attempt,
			command,
			template,
			registrationKey,
			supplyAttemptId,
		});
		if (!fixed || !credentialRecordMatches(fixed.ciphertext, fixed.binding))
			return false;
		let credential: Uint8Array | undefined;
		let delivered = false;
		try {
			const decrypted = await options.decryptor.decrypt({
				encryptedRecord: fixed.ciphertext,
				traceId: randomUUID(),
			});
			if (decrypted.outcome !== "decrypted") return false;
			credential = decrypted.plaintext;
			const { runtimeOrigin: _origin, ...target } = template.target;
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
		await store.settleSupply({
			...attempt,
			command,
			authorizationId: claimed.authorization.authorizationId,
			supplyAttemptId,
			outcome: delivered ? "confirmed" : "unknown",
		});
		return delivered;
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
		const registrationKey = `mi-${randomBytes(32).toString("base64url")}`;
		const supplyAttemptId = randomUUID();
		const template = buildConnectionRegistrationTemplateV1({
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
		if (
			!(await supply(
				claimed,
				"prepare",
				template,
				registrationKey,
				supplyAttemptId,
				signal,
			))
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
			(kind === "revoke" && !receipt) ||
			!(await supply(
				claimed,
				kind,
				template,
				registrationKey,
				supplyAttemptId,
				signal,
			))
		)
			return settle(rejected);
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
			command: kind,
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
					command: kind,
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
		return settle(response);
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
		if (
			!context ||
			!(await supply(
				claimed,
				kind,
				context.template,
				context.registrationKey,
				context.supplyAttemptId,
				signal,
			))
		)
			return unknown();
		const { template, configuration, receipt, supplyAttemptId } = context;
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
			const pending = await store.listPending(32, executionIds);
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
