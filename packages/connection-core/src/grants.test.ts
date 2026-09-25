import { describe, expect, it } from "vitest";

import { assertGrantUsable, createGrant, revokeGrant } from "./grants.js";

const now = Date.now();
const input = {
	id: "grant-1",
	principalId: "principal-a",
	consumerId: "consumer-a",
	consumerInstanceId: "instance-a",
	consumerActorRequired: false,
	connectionId: "connection-a",
	credentialVersionId: "credential-a-v1",
	actionVersionIds: ["github.get_current_user@v1"],
	principalRecoveryGeneration: 3,
	consumerInstanceRecoveryGeneration: 2,
	issuedAt: now - 1000,
	expiresAt: now + 60_000,
} as const;

describe("Connection Grant invariants", () => {
	it("binds the grant to principal, installation, generation and exact ActionVersion", () => {
		const grant = createGrant(input);
		expect(() =>
			assertGrantUsable(grant, {
				...input,
				now,
				actionVersionId: input.actionVersionIds[0],
			}),
		).not.toThrow();
		expect(() =>
			assertGrantUsable(grant, {
				...input,
				now,
				actionVersionId: input.actionVersionIds[0],
				consumerInstanceId: "other",
			}),
		).toThrow();
		expect(() =>
			assertGrantUsable(grant, {
				...input,
				now,
				actionVersionId: input.actionVersionIds[0],
				principalRecoveryGeneration: 4,
			}),
		).toThrow();
		expect(() =>
			assertGrantUsable(grant, {
				...input,
				actionVersionId: input.actionVersionIds[0],
				now: input.issuedAt - 1,
			}),
		).toThrow();
		expect(() =>
			assertGrantUsable(grant, {
				...input,
				actionVersionId: input.actionVersionIds[0],
				now: input.expiresAt,
			}),
		).toThrow();
		expect(() =>
			createGrant({ ...input, consumerActorRequired: true }),
		).toThrow("Actor mode does not match Consumer");
		expect(() =>
			createGrant({ ...input, consumerInstanceRecoveryGeneration: 0 }),
		).toThrow("consumerInstanceRecoveryGeneration");
	});

	it("revokes monotonically and remains revoked on replay", () => {
		const grant = createGrant(input);
		const revoked = revokeGrant(grant);
		expect(revoked).toMatchObject({ status: "revoked", revision: 2 });
		expect(revokeGrant(revoked)).toBe(revoked);
	});
});
