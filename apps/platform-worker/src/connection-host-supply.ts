import type { ProtectedConnectionHostSupplyV1 } from "./connection-manual-bindings.js";

const agentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const credentialPattern = /^conn_consumer_[\x21-\x7e]{8,4096}$/;

/**
 * Deployment-owned bridge into the RuntimeHost protected supply boundary.
 * The bridge receives credential bytes only for the duration of materialization.
 * It must never persist them outside the Host's protected receiver.
 */
export interface ProtectedConnectionHostSupplyPortV1 {
	materialize(input: {
		readonly agentId: string;
		readonly associationRevision: number;
		readonly credential: Uint8Array;
	}): Promise<{ readonly ref: string; readonly revision: string }>;
	revoke(input: {
		readonly agentId: string;
		readonly associationRevision: number;
	}): Promise<void>;
}

function validateIdentity(agentId: string, associationRevision: number) {
	if (
		!agentIdPattern.test(agentId) ||
		!Number.isSafeInteger(associationRevision) ||
		associationRevision < 1
	)
		throw new Error("CONNECTION_HOST_SUPPLY_INPUT_INVALID");
}

function validateReceipt(value: unknown): {
	readonly ref: string;
	readonly revision: string;
} {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== "ref,revision"
	)
		throw new Error("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.ref !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.ref) ||
		typeof candidate.revision !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.revision)
	)
		throw new Error("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
	return { ref: candidate.ref, revision: candidate.revision };
}

/**
 * Adapt the deployment-owned Host receiver to the Worker resolver contract.
 * Credential bytes are zeroed immediately after the receiver returns and are
 * never included in the adapter's result or thrown errors.
 */
export function createProtectedConnectionHostSupplyV1(
	port: ProtectedConnectionHostSupplyPortV1,
): ProtectedConnectionHostSupplyV1 {
	if (
		typeof port?.materialize !== "function" ||
		typeof port?.revoke !== "function"
	)
		throw new TypeError("CONNECTION_HOST_SUPPLY_PORT_INVALID");
	return {
		async materialize(input) {
			validateIdentity(input.agentId, input.associationRevision);
			if (
				typeof input.serviceCredential !== "string" ||
				!credentialPattern.test(input.serviceCredential)
			)
				throw new Error("CONNECTION_CREDENTIAL_INVALID");
			const credential = Buffer.from(input.serviceCredential, "utf8");
			try {
				return validateReceipt(
					await port.materialize({
						agentId: input.agentId,
						associationRevision: input.associationRevision,
						credential,
					}),
				);
			} catch {
				throw new Error("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
			} finally {
				credential.fill(0);
			}
		},
		async revoke(input) {
			validateIdentity(input.agentId, input.associationRevision);
			try {
				await port.revoke(input);
			} catch {
				throw new Error("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
			}
		},
	};
}
