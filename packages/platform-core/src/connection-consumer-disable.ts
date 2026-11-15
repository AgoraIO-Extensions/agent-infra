import { createHash } from "node:crypto";
import {
	isAgentManagementText,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import {
	type ConnectionConsumerRegistrationPolicyV1,
	captureConnectionConsumerRegistrationPolicyV1,
	parseConnectionConsumerRegistrationDeliveryV1,
	parseConnectionConsumerRegistrationIntentV1,
} from "./connection-consumer-registration.js";
import { platformIdempotencyV1 } from "./idempotency.js";

/** Spec §13.5.7: only an accepted administrator `disable_agent` writes this operation. */
export const connectionConsumerDisableOperationV1 =
	"agent.connection.consumer.disable.v1";

export type ConnectionConsumerDisableStatusV1 =
	| "waiting"
	| "pending"
	| "sending"
	| "disabled"
	| "failed"
	| "unknown"
	| "not_required";

/** Stable per-Agent identity, written by the disable transaction before any Consumer is known. */
export interface ConnectionConsumerDisableIdentityV1 {
	readonly operationId: string;
	readonly registrationOperationId: string;
	readonly sourceNamespace: string;
	readonly platformAgentId: string;
	readonly idempotencyKey: string;
}

/** The complete lifecycle command, derived only from the same Agent's verified registration receipt. */
export interface ConnectionConsumerDisableIntentV1 {
	readonly schemaVersion: 1;
	readonly operationId: string;
	readonly registrationOperationId: string;
	readonly sourceNamespace: string;
	readonly platformAgentId: string;
	readonly consumerId: string;
	readonly registrationId: string;
	/** SHA-256 of the original create Idempotency-Key; binds the receipt to the original registration. */
	readonly registrationKeyHash: string;
	readonly policyRevision: string;
	/** The registration receipt revision used as the lifecycle CAS revision. */
	readonly expectedRevision: string;
	readonly idempotencyKey: string;
	readonly requestDigest: string;
}

export interface ConnectionConsumerDisableReceiptV1 {
	readonly schemaVersion: 1;
	readonly operationId: string;
	readonly consumerId: string;
	readonly registrationId: string;
	readonly resultRevision: string;
	readonly requestDigest: string;
}

export type ConnectionConsumerDisableDeliveryV1 =
	| {
			readonly outcome: "disabled";
			readonly receipt: ConnectionConsumerDisableReceiptV1;
	  }
	| {
			readonly outcome: "unknown" | "failed";
			readonly failureCode: string;
	  };

export class ConnectionConsumerDisableErrorV1 extends Error {
	constructor() {
		super("CONNECTION_CONSUMER_DISABLE_INVALID");
		this.name = "ConnectionConsumerDisableErrorV1";
	}
}

const intentKeys = [
	"schemaVersion",
	"operationId",
	"registrationOperationId",
	"sourceNamespace",
	"platformAgentId",
	"consumerId",
	"registrationId",
	"registrationKeyHash",
	"policyRevision",
	"expectedRevision",
	"idempotencyKey",
	"requestDigest",
] as const;

function exact(input: unknown, keys: readonly string[]) {
	const value = snapshotAgentManagementDataObject(input);
	if (
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new ConnectionConsumerDisableErrorV1();
	return value;
}

function sha256(value: string) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Connection's lifecycle revision: a positive signed 64-bit decimal string. */
export function isConnectionConsumerRevisionV1(
	input: unknown,
): input is string {
	return (
		typeof input === "string" &&
		/^[1-9][0-9]{0,18}$/.test(input) &&
		BigInt(input) <= 9223372036854775807n
	);
}

export function planConnectionConsumerDisableIdentityV1(input: {
	readonly registrationOperationId: string;
	readonly sourceNamespace: string;
	readonly platformAgentId: string;
}): ConnectionConsumerDisableIdentityV1 {
	if (
		!isAgentManagementText(input.registrationOperationId) ||
		!isAgentManagementText(input.sourceNamespace, 128) ||
		!isAgentManagementText(input.platformAgentId)
	)
		throw new ConnectionConsumerDisableErrorV1();
	const identity = sha256(
		JSON.stringify(["disable", input.sourceNamespace, input.platformAgentId]),
	);
	return Object.freeze({
		operationId: `connection-consumer-disable:${identity}`,
		registrationOperationId: input.registrationOperationId,
		sourceNamespace: input.sourceNamespace,
		platformAgentId: input.platformAgentId,
		idempotencyKey: `ccd-v1.${identity}`,
	});
}

/**
 * Builds the never-sent command from the same Agent's registered row and the current approved
 * policy. A different policy source never selects or disables this Agent's Consumer.
 */
export function planConnectionConsumerDisableV1(input: {
	readonly policy: ConnectionConsumerRegistrationPolicyV1;
	readonly registration: {
		readonly intent: unknown;
		readonly receipt: unknown;
	};
}): ConnectionConsumerDisableIntentV1 {
	try {
		const policy = captureConnectionConsumerRegistrationPolicyV1(input.policy);
		const registration = parseConnectionConsumerRegistrationIntentV1(
			input.registration.intent,
		);
		const delivery = parseConnectionConsumerRegistrationDeliveryV1(
			{ outcome: "registered", receipt: input.registration.receipt },
			registration,
		);
		if (
			delivery.outcome !== "registered" ||
			registration.sourceNamespace !== policy.sourceNamespace ||
			!isConnectionConsumerRevisionV1(delivery.receipt.consumerRevision)
		)
			throw new Error();
		const identity = planConnectionConsumerDisableIdentityV1({
			registrationOperationId: registration.operationId,
			sourceNamespace: registration.sourceNamespace,
			platformAgentId: registration.platformAgentId,
		});
		const request = {
			schemaVersion: 1 as const,
			operationId: identity.operationId,
			registrationOperationId: registration.operationId,
			sourceNamespace: registration.sourceNamespace,
			platformAgentId: registration.platformAgentId,
			consumerId: delivery.receipt.consumerId,
			registrationId: delivery.receipt.registrationId,
			registrationKeyHash: sha256(registration.idempotencyKey),
			policyRevision: policy.revision,
			expectedRevision: delivery.receipt.consumerRevision,
			idempotencyKey: identity.idempotencyKey,
		};
		return Object.freeze({
			...request,
			requestDigest: platformIdempotencyV1.canonicalRequestDigest(request),
		});
	} catch {
		throw new ConnectionConsumerDisableErrorV1();
	}
}

export function parseConnectionConsumerDisableIntentV1(
	input: unknown,
): ConnectionConsumerDisableIntentV1 {
	try {
		const value = exact(input, intentKeys);
		if (
			value.schemaVersion !== 1 ||
			!isAgentManagementText(value.consumerId) ||
			!isAgentManagementText(value.registrationId) ||
			typeof value.registrationKeyHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.registrationKeyHash) ||
			typeof value.policyRevision !== "string" ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(value.policyRevision) ||
			!isConnectionConsumerRevisionV1(value.expectedRevision)
		)
			throw new Error();
		const identity = planConnectionConsumerDisableIdentityV1({
			registrationOperationId: value.registrationOperationId as string,
			sourceNamespace: value.sourceNamespace as string,
			platformAgentId: value.platformAgentId as string,
		});
		if (
			value.operationId !== identity.operationId ||
			value.idempotencyKey !== identity.idempotencyKey
		)
			throw new Error();
		const request = {
			schemaVersion: 1 as const,
			operationId: identity.operationId,
			registrationOperationId: identity.registrationOperationId,
			sourceNamespace: identity.sourceNamespace,
			platformAgentId: identity.platformAgentId,
			consumerId: value.consumerId as string,
			registrationId: value.registrationId as string,
			registrationKeyHash: value.registrationKeyHash,
			policyRevision: value.policyRevision,
			expectedRevision: value.expectedRevision,
			idempotencyKey: identity.idempotencyKey,
		};
		const requestDigest = platformIdempotencyV1.canonicalRequestDigest(request);
		if (value.requestDigest !== requestDigest) throw new Error();
		return Object.freeze({ ...request, requestDigest });
	} catch {
		throw new ConnectionConsumerDisableErrorV1();
	}
}

export function parseConnectionConsumerDisableDeliveryV1(
	input: unknown,
	intent: ConnectionConsumerDisableIntentV1,
): ConnectionConsumerDisableDeliveryV1 {
	try {
		const envelope = snapshotAgentManagementDataObject(input);
		if (envelope.outcome === "unknown" || envelope.outcome === "failed") {
			const value = exact(input, ["outcome", "failureCode"]);
			if (
				typeof value.failureCode !== "string" ||
				!/^[A-Z][A-Z0-9_]{0,63}$/.test(value.failureCode)
			)
				throw new Error();
			return { outcome: envelope.outcome, failureCode: value.failureCode };
		}
		const value = exact(input, ["outcome", "receipt"]);
		const receipt = exact(value.receipt, [
			"schemaVersion",
			"operationId",
			"consumerId",
			"registrationId",
			"resultRevision",
			"requestDigest",
		]);
		if (
			value.outcome !== "disabled" ||
			receipt.schemaVersion !== 1 ||
			receipt.operationId !== intent.operationId ||
			receipt.consumerId !== intent.consumerId ||
			receipt.registrationId !== intent.registrationId ||
			receipt.requestDigest !== intent.requestDigest ||
			!isConnectionConsumerRevisionV1(receipt.resultRevision) ||
			BigInt(receipt.resultRevision) <= BigInt(intent.expectedRevision)
		)
			throw new Error();
		return {
			outcome: "disabled",
			receipt: Object.freeze({
				schemaVersion: 1,
				operationId: intent.operationId,
				consumerId: intent.consumerId,
				registrationId: intent.registrationId,
				resultRevision: receipt.resultRevision,
				requestDigest: intent.requestDigest,
			}),
		};
	} catch {
		throw new ConnectionConsumerDisableErrorV1();
	}
}
