import { describe, expect, it } from "vitest";

import {
	PlatformEntryContextClaimsV1Schema,
	PlatformEntryContextMaximumLifetimeMsV1,
	PlatformEntryContextV1Schema,
} from "./platform-entry-auth.ts";

const claims = {
	schemaVersion: 1 as const,
	issuer: "platform_01",
	audience: "custom_agent" as const,
	issuedAt: 1_700_000_000_000,
	expiresAt: 1_700_000_030_000,
	contextId: "ctx_01",
	keyVersion: "key_01",
	userId: "user_01",
	organizationIds: ["org_01"],
	roles: ["employee" as const],
	authorizationRevision: "authrev_01",
	agentId: "agent_01",
};

describe("Platform entry context contract", () => {
	it("accepts the minimal versioned identity binding", () => {
		expect(PlatformEntryContextClaimsV1Schema.parse(claims)).toEqual(claims);
		expect(PlatformEntryContextMaximumLifetimeMsV1).toBe(60_000);
	});

	it("rejects a token envelope with an unsafe format or unknown field", () => {
		expect(
			PlatformEntryContextV1Schema.safeParse({
				schemaVersion: 1,
				format: "platform-entry-jws",
				token: "header.payload.signature",
			}),
		).toMatchObject({ success: true });
		expect(
			PlatformEntryContextV1Schema.safeParse({
				schemaVersion: 1,
				format: "platform-entry-jws",
				token: "header.payload.signature",
				extra: true,
			}),
		).toMatchObject({ success: false });
		expect(
			PlatformEntryContextV1Schema.safeParse({
				schemaVersion: 1,
				format: "platform-entry-jws",
				token: "header/payload/signature",
			}),
		).toMatchObject({ success: false });
	});
});
