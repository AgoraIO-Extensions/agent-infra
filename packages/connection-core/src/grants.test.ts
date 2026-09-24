import { describe, expect, it } from "vitest";

import { assertGrantUsable, createGrant, revokeGrant } from "./grants.js";

const input = {
	id: "grant-1",
	principalId: "principal-a",
	consumerId: "consumer-a",
	consumerInstanceId: "instance-a",
	connectionId: "connection-a",
	credentialVersionId: "credential-a-v1",
	actionVersionIds: ["github.get_current_user@v1"],
	principalRecoveryGeneration: 3,
} as const;

describe("Connection Grant invariants", () => {
	it("binds the grant to principal, installation, generation and exact ActionVersion", () => {
		const grant = createGrant(input);
		expect(() =>
			assertGrantUsable(grant, {
				...input,
				actionVersionId: input.actionVersionIds[0],
			}),
		).not.toThrow();
		expect(() =>
			assertGrantUsable(grant, {
				...input,
				actionVersionId: input.actionVersionIds[0],
				consumerInstanceId: "other",
			}),
		).toThrow();
		expect(() =>
			assertGrantUsable(grant, {
				...input,
				actionVersionId: input.actionVersionIds[0],
				principalRecoveryGeneration: 4,
			}),
		).toThrow();
	});

	it("revokes monotonically and remains revoked on replay", () => {
		const grant = createGrant(input);
		const revoked = revokeGrant(grant);
		expect(revoked).toMatchObject({ status: "revoked", revision: 2 });
		expect(revokeGrant(revoked)).toBe(revoked);
	});
});
