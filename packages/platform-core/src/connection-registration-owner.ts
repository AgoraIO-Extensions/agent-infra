import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type ConnectionConsumerRegistrationIntentV1,
	type ConnectionConsumerRegistrationPolicyV1,
	captureConnectionConsumerRegistrationPolicyV1,
	isConnectionConsumerRegistrationCurrentV1,
	parseConnectionConsumerRegistrationIntentV1,
} from "./connection-consumer-registration.js";

/** Resolved domain facts; the HTTP adapter maps/validates them with its own Zod contract. */
export interface ConnectionRegistrationOwnerV1 {
	readonly schemaVersion: 1;
	readonly sourceNamespace: string;
	readonly platformAgentId: string;
	readonly platformOwnerId: string;
	readonly policyRevision: string;
	readonly directorySource: string;
	readonly wechatUserId: string;
	readonly email: string;
	readonly ownerRevision: string;
	readonly expiresAt: number;
}

export type ConnectionRegistrationOwnerPurposeV1 =
	| "create"
	| "read"
	| "disable"
	| "delete";
export interface ConnectionRegistrationOwnerFactsV1 {
	readonly intent: ConnectionConsumerRegistrationIntentV1;
	readonly ownerId: string | null;
	readonly ownerCurrent: boolean;
	readonly agentStatus: string | null;
	readonly revision: string;
	readonly sent: boolean;
}

/** Reuses current registration authority; no database locks span identity I/O. */
export function createConnectionRegistrationOwnerReaderV1(input: {
	readonly policy: ConnectionConsumerRegistrationPolicyV1;
	readonly directorySource: string;
	readonly readFacts: (
		source: string,
		agent: string,
		signal: AbortSignal,
	) => Promise<ConnectionRegistrationOwnerFactsV1 | undefined>;
	readonly readIdentity: (
		ownerId: string,
		signal: AbortSignal,
	) => Promise<
		| {
				userId: string;
				accountStatus: string;
				wechatUserId: string;
				email: string;
				revision: string;
				expiresAt: number;
		  }
		| undefined
	>;
}) {
	const policy = captureConnectionConsumerRegistrationPolicyV1(input.policy);
	if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(input.directorySource))
		throw new Error("CONNECTION_REGISTRATION_OWNER_CONFIGURATION_INVALID");
	return async (
		source: string,
		agent: string,
		purpose: ConnectionRegistrationOwnerPurposeV1,
		signal: AbortSignal,
	): Promise<ConnectionRegistrationOwnerV1 | undefined> => {
		signal.throwIfAborted();
		if (
			source !== policy.sourceNamespace ||
			!["create", "read", "disable", "delete"].includes(purpose)
		)
			return undefined;
		const before = await input.readFacts(source, agent, signal);
		if (!before) return undefined;
		const intent = parseConnectionConsumerRegistrationIntentV1(before.intent);
		const eligible = (facts: ConnectionRegistrationOwnerFactsV1) =>
			facts.intent.platformAgentId === agent &&
			isConnectionConsumerRegistrationCurrentV1({
				...facts,
				policy,
				readOnly: purpose !== "create" && facts.sent,
			});
		if (!eligible(before)) return undefined;
		const identity = await input.readIdentity(intent.platformOwnerId, signal);
		signal.throwIfAborted();
		if (
			!identity ||
			identity.userId !== intent.platformOwnerId ||
			identity.accountStatus !== "active" ||
			!identity.wechatUserId ||
			identity.wechatUserId.length > 256 ||
			!identity.revision ||
			identity.email !== identity.email.trim().toLowerCase() ||
			!/^[^\s@]+@[^\s@]+$/.test(identity.email) ||
			!Number.isSafeInteger(identity.expiresAt) ||
			identity.expiresAt <= Date.now()
		)
			return undefined;
		const after = await input.readFacts(source, agent, signal);
		signal.throwIfAborted();
		if (
			!after ||
			!eligible(after) ||
			!isDeepStrictEqual(before, after) ||
			identity.expiresAt <= Date.now()
		)
			return undefined;
		const { expiresAt, ...stableIdentity } = identity;
		return {
			schemaVersion: 1,
			sourceNamespace: source,
			platformAgentId: agent,
			platformOwnerId: intent.platformOwnerId,
			policyRevision: policy.revision,
			directorySource: input.directorySource,
			wechatUserId: identity.wechatUserId,
			email: identity.email,
			ownerRevision: createHash("sha256")
				.update(JSON.stringify([before, stableIdentity, input.directorySource]))
				.digest("hex"),
			expiresAt: Math.min(Date.now() + 20_000, expiresAt),
		};
	};
}
