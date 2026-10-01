import { describe, expect, it } from "vitest";
import {
	PersonalApiCredentialIssueRequestV1Schema,
	PersonalApiCredentialIssueResponseV1Schema,
	PersonalApiCredentialMetadataV1Schema,
	pilotBrowserHttpOpenApiPathsV2,
} from "../../src/pilot/index.ts";

const metadata = {
	credentialId: "api_credential_fixture",
	scopes: ["agent:read"],
	expiresAt: null,
	revokedAt: null,
	createdAt: "2030-01-01T00:00:00.000Z",
	lastUsedAt: null,
};
const material = `papi_${"a".repeat(43)}`;

describe("personal API credential wire boundary", () => {
	it("permits material only in the first committed 201 response", () => {
		const operation =
			pilotBrowserHttpOpenApiPathsV2["/api/v2/me/api-credentials"].post;
		const first = operation.responses["201"].content["application/json"].schema;
		const replay =
			operation.responses["200"].content["application/json"].schema;
		expect(
			first.safeParse({ metadata, credential: material, replayed: false })
				.success,
		).toBe(true);
		expect(
			replay.safeParse({ metadata, credential: null, replayed: true }).success,
		).toBe(true);
		expect(
			first.safeParse({ metadata, credential: null, replayed: false }).success,
		).toBe(false);
		expect(
			replay.safeParse({ metadata, credential: material, replayed: true })
				.success,
		).toBe(false);
		expect(
			replay.safeParse({ metadata, credential: material, replayed: false })
				.success,
		).toBe(false);
	});

	it.each([
		"credential",
		"credentialHash",
		"principalId",
		"userId",
		"role",
		"recipient",
	])("rejects %s in ordinary metadata and response envelopes", (field) => {
		expect(
			PersonalApiCredentialMetadataV1Schema.safeParse({
				...metadata,
				[field]: material,
			}).success,
		).toBe(false);
		expect(
			PersonalApiCredentialIssueResponseV1Schema.safeParse({
				metadata,
				credential: null,
				replayed: true,
				[field]: material,
			}).success,
		).toBe(false);
	});

	it.each([
		{ scopes: [], expiresAt: null },
		{ scopes: ["agent:read", "agent:read"], expiresAt: null },
		{ scopes: ["system_admin"], expiresAt: null },
		{ scopes: ["agent:read"], expiresAt: "2030-02-30T00:00:00Z" },
		{ scopes: ["agent:read"], expiresAt: "2030-01-01T00:00:00.0001Z" },
		{ scopes: ["agent:read"], expiresAt: "2030-01-01T00:00:00+00:00" },
		{ scopes: ["agent:read"], expiresAt: null, principal: { id: "other" } },
		{ scopes: ["agent:read"], expiresAt: null, userId: "other" },
		{ scopes: ["agent:read"], expiresAt: null, applicationId: "other" },
		{ scopes: ["agent:read"], expiresAt: null, recipient: "other" },
		{ scopes: ["agent:read"], expiresAt: null, role: "system_admin" },
	])("rejects invalid issuance and authority overrides", (input) => {
		expect(
			PersonalApiCredentialIssueRequestV1Schema.safeParse(input).success,
		).toBe(false);
	});
});
