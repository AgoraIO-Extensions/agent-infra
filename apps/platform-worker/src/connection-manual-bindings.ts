import { connectionServiceCredentialFingerprintV1 } from "@agent-infra/platform-core";
import {
	type ConnectionManualAssociationMaterialV1,
	PostgresConnectionManualAssociationReaderV1,
} from "@agent-infra/platform-store";
import type { SecretKeyringDecryptorV1 } from "@agent-infra/secret-store/worker";
import {
	type ConnectionConsumerOAuthClientBindingV1,
	createConnectionConsumerDcrResolverV1,
	revokeConnectionConsumerMachineRegistrationV1,
} from "./connection-consumer-dcr.js";
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

export interface ConnectionMachineClientBindingStoreV1 {
	load(
		agentId: string,
		associationRevision: number,
		registrationKey: string,
	): Promise<ConnectionConsumerOAuthClientBindingV1 | undefined>;
	persist(
		agentId: string,
		binding: ConnectionConsumerOAuthClientBindingV1,
		associationRevision: number,
	): Promise<void>;
}

export interface OwnerConnectionBindingsOptionsV1 {
	readonly databaseUrl: string;
	readonly associationReader?: Pick<
		PostgresConnectionManualAssociationReaderV1,
		"current" | "close"
	>;
	readonly decryptor: SecretKeyringDecryptorV1;
	readonly hostSupply: ProtectedConnectionHostSupplyV1;
	readonly machineClientBindings: ConnectionMachineClientBindingStoreV1;
	readonly machineRegistrationEndpointForAgent: (agentId: string) => string;
	readonly issuer: string;
	readonly publicOrigin: string;
	readonly mcpPath: string;
	readonly audience: string;
	readonly egressProfile: { readonly ref: string; readonly revision: string };
	readonly approvalSource: { readonly ref: string; readonly revision: string };
	readonly callbackUrlForAgent: (agentId: string) => string;
	readonly fetch?: typeof fetch;
	readonly traceId?: string;
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

/**
 * Builds the Worker callback from the current Owner association table. Each invocation
 * reads a fresh association snapshot, materializes only that Agent's protected Host
 * supply, and registers a distinct EP-1060 machine client. No credential is returned
 * in the deployment binding or passed through env/argv.
 */
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
			const result: Record<string, ConnectionConsumerDeploymentBindingV1> = {};
			for (const row of Object.values(rows)) {
				signal.throwIfAborted();
				const credential = await decryptAssociation(
					options.decryptor,
					row,
					options.traceId ?? "connection-owner-binding",
				);
				const supply = await options.hostSupply.materialize({
					agentId: row.agentId,
					associationRevision: row.associationRevision,
					serviceCredential: credential,
				});
				const resolve = createConnectionConsumerDcrResolverV1({
					agentIds: [row.agentId],
					issuer: options.issuer,
					registrationEndpoint: options.machineRegistrationEndpointForAgent(
						row.agentId,
					),
					machineRegistrationEndpoint:
						options.machineRegistrationEndpointForAgent(row.agentId),
					serviceCredentialForAgent: () => credential,
					machineRegistrationKeyForAgent: () =>
						`${row.agentId}-association-${row.associationRevision}`,
					publicOrigin: options.publicOrigin,
					mcpPath: options.mcpPath,
					audience: options.audience,
					egressProfile: options.egressProfile,
					approvalSource: options.approvalSource,
					callbackUrlForAgent: options.callbackUrlForAgent,
					consumerIdForAgent: () => row.connectionAgentId,
					installationSupplyForAgent: () => supply,
					loadOAuthClientBindingForAgent: () =>
						options.machineClientBindings.load(
							row.agentId,
							row.associationRevision,
							`${row.agentId}-association-${row.associationRevision}`,
						),
					persistOAuthClientBindingForAgent: (agentId, binding) =>
						options.machineClientBindings.persist(
							agentId,
							binding,
							row.associationRevision,
						),
					...(options.fetch ? { fetch: options.fetch } : {}),
				});
				const bindings = await resolve(signal);
				const binding = bindings[row.agentId];
				if (binding) result[row.agentId] = binding;
			}
			return Object.freeze(result);
		} finally {
			await reader.close();
		}
	};
}

/** Revoke a removed association's Host supply after the external client revoke succeeds. */
export async function revokeOwnerConnectionBindingV1(
	hostSupply: ProtectedConnectionHostSupplyV1,
	input: { readonly agentId: string; readonly associationRevision: number },
) {
	await hostSupply.revoke(input);
}

/** Disconnect ordering: revoke the Connection client first, then remove Host supply. */
export async function revokeOwnerConnectionMachineBindingV1(input: {
	readonly endpoint: string;
	readonly serviceCredential: string;
	readonly binding: Pick<
		ConnectionConsumerOAuthClientBindingV1,
		"registrationKey"
	>;
	readonly signal: AbortSignal;
	readonly hostSupply: ProtectedConnectionHostSupplyV1;
	readonly agentId: string;
	readonly associationRevision: number;
	readonly fetch?: typeof fetch;
}) {
	await revokeConnectionConsumerMachineRegistrationV1({
		endpoint: input.endpoint,
		serviceCredential: input.serviceCredential,
		binding: input.binding,
		signal: input.signal,
		...(input.fetch ? { fetch: input.fetch } : {}),
	});
	await input.hostSupply.revoke({
		agentId: input.agentId,
		associationRevision: input.associationRevision,
	});
}
