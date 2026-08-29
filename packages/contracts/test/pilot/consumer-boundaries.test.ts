import { describe, expect, it } from "vitest";

import { MessageCommandRequestV1Schema } from "@agent-infra/contracts/pilot";

describe("Pilot consumer contract boundaries", () => {
	it("fails closed for unknown browser command versions", () => {
		expect(
			MessageCommandRequestV1Schema.safeParse({
				schemaVersion: 2,
				text: "hello",
			}).success,
		).toBe(false);
	});

	it("rejects caller-supplied identity and authorization selectors", () => {
		for (const [field, value] of Object.entries({
			actorId: "actor-forged",
			userId: "user-forged",
			organizationId: "organization-forged",
			agentId: "agent-forged",
			connectionId: "connection-forged",
			authorization: "caller-controlled",
		})) {
			expect(
				MessageCommandRequestV1Schema.safeParse({
					schemaVersion: 1,
					text: "hello",
					[field]: value,
				}).success,
			).toBe(false);
		}
	});
});
