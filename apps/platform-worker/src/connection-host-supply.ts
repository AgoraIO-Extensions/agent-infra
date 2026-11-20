const agentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const credentialPattern = /^conn_consumer_[\x21-\x7e]{8,4096}$/;

const attemptIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface HostSupplyAttemptV1 {
	readonly agentId: string;
	readonly associationRevision: number;
	readonly attemptId: string;
}

/** The receiver accepts credentials only during materialization.
 * Revocation fences exactly one attempt, including writes still in flight.
 */
export interface ProtectedConnectionHostSupplyPortV1 {
	materialize(
		input: HostSupplyAttemptV1 & {
			readonly credential: Uint8Array;
		},
	): Promise<
		HostSupplyAttemptV1 & {
			readonly ref: string;
			readonly revision: string;
		}
	>;
	revoke(input: HostSupplyAttemptV1): Promise<void>;
}

function validateIdentity({
	agentId,
	associationRevision,
	attemptId,
}: HostSupplyAttemptV1) {
	if (
		!agentIdPattern.test(agentId) ||
		!Number.isSafeInteger(associationRevision) ||
		associationRevision < 1 ||
		!attemptIdPattern.test(attemptId)
	)
		throw new Error("CONNECTION_HOST_SUPPLY_INPUT_INVALID");
}

function validateReceipt(
	value: unknown,
	expected: HostSupplyAttemptV1,
	credential: string,
): {
	readonly ref: string;
	readonly revision: string;
} {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !==
			"agentId,associationRevision,attemptId,ref,revision"
	)
		throw new Error("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
	const candidate = value as Record<string, unknown>;
	if (
		candidate.agentId !== expected.agentId ||
		candidate.associationRevision !== expected.associationRevision ||
		candidate.attemptId !== expected.attemptId ||
		typeof candidate.ref !== "string" ||
		candidate.ref.startsWith("conn_consumer_") ||
		candidate.ref.includes(credential) ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.ref) ||
		typeof candidate.revision !== "string" ||
		candidate.revision.startsWith("conn_consumer_") ||
		candidate.revision.includes(credential) ||
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
) {
	if (
		typeof port?.materialize !== "function" ||
		typeof port?.revoke !== "function"
	)
		throw new TypeError("CONNECTION_HOST_SUPPLY_PORT_INVALID");
	return {
		async materialize(
			input: HostSupplyAttemptV1 & {
				readonly serviceCredential: string;
			},
		) {
			validateIdentity(input);
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
						attemptId: input.attemptId,
						credential,
					}),
					input,
					input.serviceCredential,
				);
			} catch {
				throw new Error("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
			} finally {
				credential.fill(0);
			}
		},
		async revoke(input: HostSupplyAttemptV1) {
			validateIdentity(input);
			const { agentId, associationRevision, attemptId } = input;
			try {
				await port.revoke({ agentId, associationRevision, attemptId });
			} catch {
				throw new Error("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
			}
		},
	};
}
