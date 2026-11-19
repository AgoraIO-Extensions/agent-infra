import { createHash } from "node:crypto";
import {
	deriveConnectionConsumerProfileV1,
	resolveApprovedConnectionSystemAccessV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import { connectionServiceCredentialFingerprintV1 } from "@agent-infra/platform-core";
import {
	type ConnectionManualAssociationMaterialV1,
	PostgresConnectionHostSupplyStoreV1,
	PostgresConnectionManualAssociationReaderV1,
} from "@agent-infra/platform-store";
import {
	createSecretKeyringDecryptorV1,
	type SecretKeyringDecryptorV1,
} from "@agent-infra/secret-store/worker";
import {
	createProtectedConnectionHostSupplyV1,
	type ProtectedConnectionHostSupplyPortV1,
} from "./connection-host-supply.js";
import type { ConnectionConsumerDeploymentBindingV1 } from "./connection-registration-bindings.js";

export interface OwnerConnectionBindingsOptionsV1 {
	readonly databaseUrl: string;
	readonly associationReader?: Pick<
		PostgresConnectionManualAssociationReaderV1,
		"current" | "close"
	>;
	readonly decryptor: SecretKeyringDecryptorV1;
	readonly hostSupply: ProtectedConnectionHostSupplyPortV1;
	readonly connectionSystemAccess: unknown;
	readonly connectionSystemAccessApproval: unknown;
	readonly traceId?: string;
}

/** Mounted deployment configuration used to build the production Owner resolver. */
export interface OwnerConnectionBindingConfigurationV1
	extends Omit<OwnerConnectionBindingsOptionsV1, "decryptor"> {
	readonly databaseUrl: string;
	readonly decryptionKeys: readonly {
		readonly keyVersion: string;
		readonly privateKeyPkcs8DerBase64: string;
	}[];
}

/**
 * Assemble the Worker-only resolver from deployment-owned ports. The keyring
 * resolves the service credential specifically for the protected Host receiver.
 */
export function createProductionOwnerConnectionBindingsV1(
	input: OwnerConnectionBindingConfigurationV1,
): OwnerConnectionBindingsOptionsV1 {
	const { decryptionKeys, ...configuration } = input;
	return {
		...configuration,
		decryptor: createSecretKeyringDecryptorV1({ keys: decryptionKeys }),
	};
}

function decodeCredential(value: Uint8Array): string {
	const plaintext = Buffer.from(value);
	try {
		const credential = plaintext.toString("utf8");
		if (!/^conn_consumer_[\x21-\x7e]{8,4096}$/.test(credential))
			throw new Error("CONNECTION_CREDENTIAL_INVALID");
		return credential;
	} finally {
		plaintext.fill(0);
		value.fill(0);
	}
}

async function decryptAssociation(
	decryptor: SecretKeyringDecryptorV1,
	row: ConnectionManualAssociationMaterialV1,
	traceId: string,
) {
	const result = await decryptor.decrypt({
		encryptedRecord: row.credentialCiphertext,
		traceId,
	});
	if (result.outcome !== "decrypted")
		throw new Error("CONNECTION_CREDENTIAL_UNAVAILABLE");
	const credential = decodeCredential(result.plaintext);
	if (
		connectionServiceCredentialFingerprintV1(credential) !==
		row.credentialFingerprint
	)
		throw new Error("CONNECTION_CREDENTIAL_FINGERPRINT_MISMATCH");
	return credential;
}

/** Capture the dedicated Consumer and its approved Host supply. OAuth clients
 * are prepared later for the original user's individual installation. */
export function createOwnerConnectionBindingsResolverV1(
	options: OwnerConnectionBindingsOptionsV1,
	openSupplyStore: () => Pick<
		PostgresConnectionHostSupplyStoreV1,
		"reserve" | "publish" | "fence" | "cleanupResult" | "close"
	> = () => new PostgresConnectionHostSupplyStoreV1(options.databaseUrl),
) {
	const approved = resolveApprovedConnectionSystemAccessV1(
		options.connectionSystemAccess,
		options.connectionSystemAccessApproval,
	);
	const hostSupply = createProtectedConnectionHostSupplyV1(options.hostSupply);
	return async (
		signal: AbortSignal,
	): Promise<
		Readonly<
			Record<
				string,
				ConnectionConsumerDeploymentBindingV1 & {
					readonly manualAssociationRevision: number;
				}
			>
		>
	> => {
		signal.throwIfAborted();
		const reader =
			options.associationReader ??
			new PostgresConnectionManualAssociationReaderV1({
				databaseUrl: options.databaseUrl,
			});
		const supplyStore = openSupplyStore();
		const attempted = new Map<
			string,
			{
				agentId: string;
				associationRevision: number;
			}
		>();
		const bindings: Record<
			string,
			ConnectionConsumerDeploymentBindingV1 & {
				readonly manualAssociationRevision: number;
			}
		> = Object.create(null);
		let failure = false;
		try {
			if (approved.status !== "available")
				throw new Error("CONNECTION_SYSTEM_ACCESS_UNAVAILABLE");
			const rows = await reader.current();
			for (const row of Object.values(rows)) {
				signal.throwIfAborted();
				const identity = {
					agentId: row.agentId,
					associationRevision: row.associationRevision,
				};
				const stillCurrent = async () => {
					const rows = await reader.current([row.agentId]);
					const current = Object.hasOwn(rows, row.agentId)
						? rows[row.agentId]
						: undefined;
					return (
						current?.associationRevision === row.associationRevision &&
						current.credentialFingerprint === row.credentialFingerprint &&
						current.connectionAgentId === row.connectionAgentId &&
						current.ownerId === row.ownerId
					);
				};
				if (!(await stillCurrent())) continue;
				const binding = deriveConnectionConsumerProfileV1(approved, {
					consumerId: row.connectionAgentId,
					source: {
						ref: `connection-manual:${createHash("sha256")
							.update(
								JSON.stringify([
									row.agentId,
									approved.source,
									approved.configFingerprint,
								]),
							)
							.digest("hex")}`,
						revision: String(row.associationRevision),
					},
				});
				const reservation = await supplyStore.reserve(
					identity,
					approved.configFingerprint,
				);
				if (reservation.state === "unavailable") continue;
				let installationSupply: {
					readonly ref: string;
					readonly revision: string;
				};
				if (reservation.state === "reserved") {
					attempted.set(row.agentId, identity);
					const serviceCredential = await decryptAssociation(
						options.decryptor,
						row,
						options.traceId ?? "connection-owner-binding",
					);
					signal.throwIfAborted();
					installationSupply = await hostSupply.materialize({
						...identity,
						serviceCredential,
					});
					if (
						!(await stillCurrent()) ||
						!(await supplyStore.publish(identity, installationSupply))
					) {
						await closeHostSupply(supplyStore, hostSupply, identity);
						attempted.delete(row.agentId);
						continue;
					}
				} else {
					if (!(await stillCurrent())) continue;
					installationSupply = reservation.receipt;
				}
				signal.throwIfAborted();
				bindings[row.agentId] = {
					...binding,
					installationSupply,
					manualAssociationRevision: row.associationRevision,
				};
			}
		} catch {
			failure = true;
		} finally {
			try {
				await reader.close();
			} catch {
				failure = true;
			}
		}
		try {
			if (failure || signal.aborted) {
				const closed = await Promise.allSettled(
					[...attempted.values()].map((identity) =>
						closeHostSupply(supplyStore, hostSupply, identity),
					),
				);
				if (closed.some((result) => result.status === "rejected"))
					throw new Error("CONNECTION_HOST_SUPPLY_CLEANUP_UNCONFIRMED");
				signal.throwIfAborted();
				throw new Error("CONNECTION_OWNER_BINDINGS_UNAVAILABLE");
			}
			return Object.freeze(bindings);
		} finally {
			await supplyStore.close().catch(() => undefined);
		}
	};
}

async function closeHostSupply(
	store: Pick<PostgresConnectionHostSupplyStoreV1, "fence" | "cleanupResult">,
	supply: ReturnType<typeof createProtectedConnectionHostSupplyV1>,
	scope: Parameters<typeof supply.revoke>[0],
) {
	// Try the receiver even when the local DB is unavailable. A previously committed
	// writing row remains unavailable and later reconciles at the original revision.
	const fenced = await store.fence(scope).then(
		() => true,
		() => false,
	);
	try {
		await supply.revoke(scope);
	} catch {
		await store.cleanupResult(scope, "cleanup_unknown").catch(() => undefined);
		throw new Error("CONNECTION_HOST_SUPPLY_CLEANUP_UNCONFIRMED");
	}
	if (!fenced) throw new Error("CONNECTION_HOST_SUPPLY_CLEANUP_UNCONFIRMED");
	await store.cleanupResult(scope, "closed");
}

export function createOwnerConnectionSupplyCleanupV1(
	databaseUrl: string,
	port: ProtectedConnectionHostSupplyPortV1,
) {
	const store = new PostgresConnectionHostSupplyStoreV1(databaseUrl);
	const supply = createProtectedConnectionHostSupplyV1(port);
	return {
		async runOnce() {
			const scope = await store.claimCleanup();
			if (scope) await closeHostSupply(store, supply, scope);
		},
		close: () => store.close(),
	};
}
