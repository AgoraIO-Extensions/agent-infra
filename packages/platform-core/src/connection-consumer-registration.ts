import { createHash } from "node:crypto";
import {
	isAgentManagementText,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import { platformIdempotencyV1 } from "./idempotency.js";

export const connectionConsumerRegistrationOperationV1 =
	"agent.connection.consumer.register.v1";

/** Deployment-owned, nonsecret policy. Absence keeps registration disabled. */
export interface ConnectionConsumerRegistrationPolicyV1 {
	readonly schemaVersion: 1;
	readonly sourceNamespace: string;
	readonly revision: string;
	readonly callbackUrl: string;
	readonly resource: string;
	readonly scope: string;
}

export interface ConnectionConsumerRegistrationIntentV1 {
	readonly schemaVersion: 1;
	readonly operationId: string;
	readonly sourceNamespace: string;
	readonly sourceKey: string;
	readonly platformAgentId: string;
	/** Platform authority only; an adapter must not treat it as a Connection Principal. */
	readonly platformOwnerId: string;
	readonly consumerName: string;
	readonly policyRevision: string;
	readonly callbackUrl: string;
	readonly resource: string;
	readonly scope: string;
	readonly requestDigest: string;
	readonly idempotencyKey: string;
}

export type ConnectionConsumerRegistrationStatusV1 =
	| "pending"
	| "sending"
	| "registered"
	| "failed"
	| "unknown";

/** The adapter verifies the published Connection receipt before returning these facts. */
export interface ConnectionConsumerRegistrationReceiptV1 {
	readonly schemaVersion: 1;
	readonly operationId: string;
	readonly sourceNamespace: string;
	readonly sourceKey: string;
	readonly consumerId: string;
	readonly consumerRevision: string;
	readonly registrationId: string;
	readonly requestDigest: string;
}

export type ConnectionConsumerRegistrationDeliveryV1 =
	| {
			readonly outcome: "registered";
			readonly receipt: ConnectionConsumerRegistrationReceiptV1;
	  }
	| {
			readonly outcome: "unknown" | "failed";
			readonly failureCode: string;
	  };

export class ConnectionConsumerRegistrationErrorV1 extends Error {
	constructor() {
		super("CONNECTION_CONSUMER_REGISTRATION_INVALID");
		this.name = "ConnectionConsumerRegistrationErrorV1";
	}
}

function exact(input: unknown, keys: readonly string[]) {
	const value = snapshotAgentManagementDataObject(input);
	if (
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new ConnectionConsumerRegistrationErrorV1();
	return value;
}

function https(input: unknown): input is string {
	if (
		!isAgentManagementText(input, 2048) ||
		!/^[\x21-\x7e]+$/.test(input) ||
		/[\\?#]/.test(input) ||
		/%(?![0-9A-F]{2})/.test(input)
	)
		return false;
	try {
		const url = new URL(input);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.hash === "" &&
			url.href === input
		);
	} catch {
		return false;
	}
}

export function captureConnectionConsumerRegistrationPolicyV1(
	input: unknown,
): ConnectionConsumerRegistrationPolicyV1 {
	try {
		const value = exact(input, [
			"schemaVersion",
			"sourceNamespace",
			"revision",
			"callbackUrl",
			"resource",
			"scope",
		]);
		if (
			value.schemaVersion !== 1 ||
			typeof value.sourceNamespace !== "string" ||
			// Keep the existing Store alphabet while rejecting nonportable path keys.
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.sourceNamespace) ||
			typeof value.revision !== "string" ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(value.revision) ||
			!https(value.callbackUrl) ||
			!https(value.resource) ||
			typeof value.scope !== "string" ||
			!/^[A-Za-z0-9._:-]{1,100}(?: [A-Za-z0-9._:-]{1,100}){0,31}$/.test(
				value.scope,
			) ||
			new Set(value.scope.split(" ")).size !== value.scope.split(" ").length
		)
			throw new Error();
		return Object.freeze({
			schemaVersion: 1,
			sourceNamespace: value.sourceNamespace,
			revision: value.revision,
			callbackUrl: value.callbackUrl,
			resource: value.resource,
			scope: value.scope,
		});
	} catch {
		throw new ConnectionConsumerRegistrationErrorV1();
	}
}

/** Called only by the formal API-create or approved Web creating transaction. */
export function planConnectionConsumerRegistrationV1(input: {
	readonly policy: ConnectionConsumerRegistrationPolicyV1;
	readonly platformAgentId: string;
	readonly platformOwnerId: string;
	readonly consumerName: string;
}): ConnectionConsumerRegistrationIntentV1 {
	const policy = captureConnectionConsumerRegistrationPolicyV1(input.policy);
	if (
		!isAgentManagementText(input.platformAgentId) ||
		!isAgentManagementText(input.platformOwnerId) ||
		!isAgentManagementText(input.consumerName, 800) ||
		Array.from(input.consumerName).length > 200
	)
		throw new ConnectionConsumerRegistrationErrorV1();
	const identity = createHash("sha256")
		.update(JSON.stringify([policy.sourceNamespace, input.platformAgentId]))
		.digest("hex");
	const request = {
		schemaVersion: 1 as const,
		operationId: `connection-consumer:${identity}`,
		sourceNamespace: policy.sourceNamespace,
		sourceKey: input.platformAgentId,
		platformAgentId: input.platformAgentId,
		platformOwnerId: input.platformOwnerId,
		consumerName: input.consumerName,
		policyRevision: policy.revision,
		callbackUrl: policy.callbackUrl,
		resource: policy.resource,
		scope: policy.scope,
	};
	return Object.freeze({
		...request,
		requestDigest: platformIdempotencyV1.canonicalRequestDigest(request),
		idempotencyKey: `ccr-v1.${identity}`,
	});
}

/** Web applications become formal Agents on approval; API creation has no approval stage. */
export function planConnectionConsumerRegistrationForTransitionV1(input: {
	readonly policy: ConnectionConsumerRegistrationPolicyV1;
	readonly platformAgentId: string;
	readonly platformOwnerId: string;
	readonly consumerName: string;
	readonly transition: {
		readonly operation: string;
		readonly creationChannel: "web" | "api";
		readonly from: string | null;
		readonly to: string;
	};
}): ConnectionConsumerRegistrationIntentV1 | undefined {
	const { transition } = input;
	const formalCreate =
		transition.to === "creating" &&
		((transition.creationChannel === "api" &&
			transition.operation === "api_create" &&
			transition.from === null) ||
			(transition.creationChannel === "web" &&
				transition.operation === "approve_application" &&
				transition.from === "pending_approval"));
	return formalCreate ? planConnectionConsumerRegistrationV1(input) : undefined;
}

export function parseConnectionConsumerRegistrationIntentV1(
	input: unknown,
): ConnectionConsumerRegistrationIntentV1 {
	try {
		const value = exact(input, [
			"schemaVersion",
			"operationId",
			"sourceNamespace",
			"sourceKey",
			"platformAgentId",
			"platformOwnerId",
			"consumerName",
			"policyRevision",
			"callbackUrl",
			"resource",
			"scope",
			"requestDigest",
			"idempotencyKey",
		]);
		const expected = planConnectionConsumerRegistrationV1({
			policy: {
				schemaVersion: value.schemaVersion,
				sourceNamespace: value.sourceNamespace,
				revision: value.policyRevision,
				callbackUrl: value.callbackUrl,
				resource: value.resource,
				scope: value.scope,
			} as ConnectionConsumerRegistrationPolicyV1,
			platformAgentId: value.platformAgentId as string,
			platformOwnerId: value.platformOwnerId as string,
			consumerName: value.consumerName as string,
		});
		if (Object.entries(expected).some(([key, entry]) => value[key] !== entry))
			throw new Error();
		return expected;
	} catch {
		throw new ConnectionConsumerRegistrationErrorV1();
	}
}

export function parseConnectionConsumerRegistrationDeliveryV1(
	input: unknown,
	intent: ConnectionConsumerRegistrationIntentV1,
): ConnectionConsumerRegistrationDeliveryV1 {
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
			"sourceNamespace",
			"sourceKey",
			"consumerId",
			"consumerRevision",
			"registrationId",
			"requestDigest",
		]);
		if (
			value.outcome !== "registered" ||
			receipt.schemaVersion !== 1 ||
			receipt.operationId !== intent.operationId ||
			receipt.sourceNamespace !== intent.sourceNamespace ||
			receipt.sourceKey !== intent.sourceKey ||
			receipt.requestDigest !== intent.requestDigest ||
			!isAgentManagementText(receipt.consumerId) ||
			!isAgentManagementText(receipt.consumerRevision, 128) ||
			!isAgentManagementText(receipt.registrationId)
		)
			throw new Error();
		return {
			outcome: "registered",
			receipt: {
				...receipt,
			} as unknown as ConnectionConsumerRegistrationReceiptV1,
		};
	} catch {
		throw new ConnectionConsumerRegistrationErrorV1();
	}
}
