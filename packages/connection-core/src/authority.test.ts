import { describe, expect, it } from "vitest";

import { type CurrentAuthorityState, isCurrentAuthority } from "./authority.js";
import { createGrant } from "./grants.js";

const grant = createGrant({
	id: "grant-a",
	principalId: "principal-a",
	consumerId: "consumer-a",
	consumerInstanceId: "instance-a",
	consumerActorRequired: true,
	actorId: "actor-a",
	connectionId: "connection-a",
	credentialVersionId: "credential-a-v1",
	actionVersionIds: ["action-a-v1"],
	principalRecoveryGeneration: 2,
	consumerInstanceRecoveryGeneration: 3,
	issuedAt: 1000,
	expiresAt: 5000,
});

const state: CurrentAuthorityState = {
	principalStatus: "active",
	principalGeneration: 2,
	consumerStatus: "active",
	consumerActorRequired: true,
	instanceStatus: "active",
	instancePrincipalId: "principal-a",
	instanceConsumerId: "consumer-a",
	instanceGeneration: 3,
	actorStatus: "active",
	actorInstanceId: "instance-a",
	connectionStatus: "active",
	connectionProviderId: "provider-a",
	currentCredentialVersionId: "credential-a-v1",
	credentialStatus: "active",
	credentialConnectionId: "connection-a",
	actionStatus: "published",
	actionProviderId: "provider-a",
	actionEffect: "write",
	providerStatus: "active",
	releaseStatus: "active",
};

const context = {
	principalId: "principal-a",
	consumerId: "consumer-a",
	consumerInstanceId: "instance-a",
	actorId: "actor-a",
	actionVersionId: "action-a-v1",
	principalRecoveryGeneration: 2,
	expectedGrantRevision: 1,
	expectedEffectPresent: true,
	now: 2000,
};

describe("current Connection authority", () => {
	it("accepts a fully bound current write", () => {
		expect(isCurrentAuthority(grant, state, context)).toBe(true);
	});

	it("denies stale identity, actor, Provider, Effect, and lifetime", () => {
		for (const change of [
			{ principalStatus: "disabled" },
			{ instanceGeneration: 4 },
			{ actorStatus: "revoked" },
			{ actionProviderId: "provider-b" },
			{ releaseStatus: "disabled" },
			{ actionEffect: "read" },
		]) {
			expect(isCurrentAuthority(grant, { ...state, ...change }, context)).toBe(
				false,
			);
		}
		expect(isCurrentAuthority(grant, state, { ...context, now: 5000 })).toBe(
			false,
		);
	});
});
