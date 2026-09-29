import { describe, expect, it } from "vitest";

import { isAgentConfigurationQueryAllowedV1 } from "./agent-configuration-query-access.js";

const grant = {
	principalType: "user",
	principalId: "user-1",
	grantType: "manage",
	authorizationRevision: "revision-1",
	revokedAt: null,
};

function allowedInput(principal: {
	kind: "user" | "application";
	id: string;
}): Parameters<typeof isAgentConfigurationQueryAllowedV1>[0] {
	return {
		actorId: "user-1",
		organizationIds: [],
		isAdministrator: false,
		principal,
		intent: "discover",
		authorizationRevision: "revision-1",
		ownerIds: [],
		availability: [],
		principalGrants: [grant],
	};
}

describe("agent configuration query principal binding", () => {
	it.each(["discover", "manage"] as const)(
		"rejects a user principal that differs from the actor for %s",
		(intent) => {
			expect(
				isAgentConfigurationQueryAllowedV1({
					...allowedInput({ kind: "user", id: "other-user" }),
					intent,
				}),
			).toBe(false);
		},
	);

	it("does not apply the user binding to application principals", () => {
		expect(
			isAgentConfigurationQueryAllowedV1({
				...allowedInput({ kind: "application", id: "application-1" }),
				principalGrants: [
					{
						...grant,
						principalType: "application",
						principalId: "application-1",
					},
				],
			}),
		).toBe(true);
	});
});
