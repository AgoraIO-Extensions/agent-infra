import {
	connectionConsumerProfileFingerprintV1,
	resolveApprovedConnectionConsumerProfileV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import { connectionServiceCredentialFingerprintV1 } from "@agent-infra/platform-core";
import {
	type ConnectionManualAssociationMaterialV1,
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

export interface ProtectedConnectionHostSupplyV1 {
	materialize(input: {
		readonly agentId: string;
		readonly associationRevision: number;
		readonly serviceCredential: string;
	}): Promise<{ readonly ref: string; readonly revision: string }>;
	revoke(input: {
		readonly agentId: string;
		readonly associationRevision: number;
	}): Promise<void>;
}

export interface OwnerConnectionBindingsOptionsV1 {
	readonly databaseUrl: string;
	readonly associationReader?: Pick<
		PostgresConnectionManualAssociationReaderV1,
		"current" | "close"
	>;
	readonly decryptor: SecretKeyringDecryptorV1;
	readonly hostSupply: ProtectedConnectionHostSupplyV1;
	readonly publicOrigin: string;
	readonly mcpPath: string;
	readonly audience: string;
	readonly egressProfile: { readonly ref: string; readonly revision: string };
	readonly approvalSource: { readonly ref: string; readonly revision: string };
	readonly traceId?: string;
}

/** Mounted deployment configuration used to build the production Owner resolver. */
export interface OwnerConnectionBindingConfigurationV1
	extends Omit<OwnerConnectionBindingsOptionsV1, "decryptor" | "hostSupply"> {
	readonly databaseUrl: string;
	readonly decryptionKeys: readonly {
		readonly keyVersion: string;
		readonly privateKeyPkcs8DerBase64: string;
	}[];
	readonly hostSupply: ProtectedConnectionHostSupplyPortV1;
}

/**
 * Assemble the Worker-only resolver from deployment-owned ports. The keyring
 * resolves the service credential specifically for the protected Host receiver.
 */
export function createProductionOwnerConnectionBindingsV1(
	input: OwnerConnectionBindingConfigurationV1,
): OwnerConnectionBindingsOptionsV1 {
	const { decryptionKeys, hostSupply, ...configuration } = input;
	return {
		...configuration,
		decryptor: createSecretKeyringDecryptorV1({ keys: decryptionKeys }),
		hostSupply: createProtectedConnectionHostSupplyV1(hostSupply),
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
) {
	return async (
		signal: AbortSignal,
	): Promise<
		Readonly<Record<string, ConnectionConsumerDeploymentBindingV1>>
	> => {
		signal.throwIfAborted();
		const reader =
			options.associationReader ??
			new PostgresConnectionManualAssociationReaderV1({
				databaseUrl: options.databaseUrl,
			});
		try {
			const rows = await reader.current();
			const bindings: [string, ConnectionConsumerDeploymentBindingV1][] = [];
			for (const row of Object.values(rows)) {
				signal.throwIfAborted();
				const profile = {
					schemaVersion: 1 as const,
					consumerId: row.connectionAgentId,
					publicOrigin: options.publicOrigin,
					mcpPath: options.mcpPath,
					audience: options.audience,
					egressProfile: { ...options.egressProfile },
				};
				const approval = {
					schemaVersion: 1 as const,
					configFingerprint: connectionConsumerProfileFingerprintV1(profile),
					egressEnforced: true as const,
					source: { ...options.approvalSource },
				};
				if (
					resolveApprovedConnectionConsumerProfileV1(profile, approval)
						.status !== "available"
				)
					throw new Error("CONNECTION_CONSUMER_PROFILE_UNAVAILABLE");
				const identity = {
					agentId: row.agentId,
					associationRevision: row.associationRevision,
				};
				const installationSupply = await options.hostSupply.materialize({
					...identity,
					serviceCredential: await decryptAssociation(
						options.decryptor,
						row,
						options.traceId ?? "connection-owner-binding",
					),
				});
				const currentRows = await reader.current([row.agentId]);
				const current = Object.hasOwn(currentRows, row.agentId)
					? currentRows[row.agentId]
					: undefined;
				if (
					current?.associationRevision !== row.associationRevision ||
					current.credentialFingerprint !== row.credentialFingerprint ||
					current.connectionAgentId !== row.connectionAgentId ||
					current.ownerId !== row.ownerId
				) {
					await options.hostSupply.revoke(identity);
					continue;
				}
				signal.throwIfAborted();
				bindings.push([row.agentId, { profile, approval, installationSupply }]);
			}
			return Object.freeze(Object.fromEntries(bindings));
		} finally {
			await reader.close();
		}
	};
}
