import { describe, expect, it } from "vitest";
import {
	ApplicationApiCredentialListQueryV1Schema,
	ApplicationApiCredentialPageV1Schema,
	ApplicationApiCredentialRequestV1Schema,
	ApplicationApiCredentialResponseV1Schema,
	ApplicationApiCredentialRevocationV1Schema,
} from "./application-api-credentials.ts";
import { pilotBrowserHttpOpenApiPathsV2 } from "./browser.ts";

const issue = {
	operation: "issue",
	recipient: { principalType: "user", principalId: "recipient-1" },
	scopes: ["agent:use"],
	expiresAt: null,
};

describe("application credential management contract", () => {
	it("requires a known old credential for rotation and a typed recipient", () => {
		expect(
			ApplicationApiCredentialRequestV1Schema.safeParse(issue).success,
		).toBe(true);
		expect(
			ApplicationApiCredentialRequestV1Schema.safeParse({
				...issue,
				operation: "rotate",
			}).success,
		).toBe(false);
		expect(
			ApplicationApiCredentialRequestV1Schema.safeParse({
				...issue,
				operation: "rotate",
				credentialId: "old-credential",
			}).success,
		).toBe(true);
		expect(
			ApplicationApiCredentialRequestV1Schema.safeParse({
				...issue,
				recipient: { principalId: "recipient-1" },
			}).success,
		).toBe(false);
	});
	it.each(["actor", "isSystemAdmin", "material", "credential", "deliveryUrl"])(
		"rejects caller-controlled %s",
		(field) => {
			expect(
				ApplicationApiCredentialRequestV1Schema.safeParse({
					...issue,
					[field]: "forged",
				}).success,
			).toBe(false);
		},
	);
	it("preserves existing scope and timestamp restrictions", () => {
		for (const changes of [
			{ scopes: [] },
			{ scopes: ["agent:use", "agent:use"] },
			{ scopes: ["connection:use"] },
			{ expiresAt: "2026-02-30T00:00:00Z" },
		]) {
			expect(
				ApplicationApiCredentialRequestV1Schema.safeParse({
					...issue,
					...changes,
				}).success,
			).toBe(false);
		}
	});
	it("never returns credential material in management or replay responses", () => {
		const response = {
			metadata: {
				credentialId: "credential-1",
				applicationId: "app-1",
				scopes: ["agent:use"],
				expiresAt: null,
				revokedAt: null,
				createdAt: "2026-10-04T00:00:00Z",
				lastUsedAt: null,
			},
			delivery: {
				attemptId: "attempt-1",
				recipient: issue.recipient,
				grantRevision: "grant-1",
				status: "unknown",
			},
			replayed: true,
		};
		expect(
			ApplicationApiCredentialResponseV1Schema.safeParse(response).success,
		).toBe(true);
		expect(
			ApplicationApiCredentialResponseV1Schema.safeParse({
				...response,
				credential: "private",
			}).success,
		).toBe(false);
		expect(
			ApplicationApiCredentialResponseV1Schema.safeParse({
				...response,
				delivery: { ...response.delivery, material: "private" },
			}).success,
		).toBe(false);
	});
});

it("bounds metadata pages, rejects credential material and exposes independent metadata/revoke routes", () => {
	expect(
		ApplicationApiCredentialListQueryV1Schema.safeParse({ limit: 101 }).success,
	).toBe(false);
	expect(
		ApplicationApiCredentialListQueryV1Schema.safeParse({ userId: "forged" })
			.success,
	).toBe(false);
	const metadata = {
		applicationId: "app-1",
		credentialId: "credential-1",
		scopes: ["agent:read"],
		expiresAt: null,
		revokedAt: null,
		createdAt: "2026-10-20T00:00:00Z",
		lastUsedAt: null,
	};
	expect(
		ApplicationApiCredentialPageV1Schema.safeParse({
			items: [metadata],
			nextCursor: null,
		}).success,
	).toBe(true);
	for (const key of ["credential", "credentialHash", "encryptedSecret"]) {
		expect(
			ApplicationApiCredentialPageV1Schema.safeParse({
				items: [{ ...metadata, [key]: "forbidden" }],
				nextCursor: null,
			}).success,
		).toBe(false);
		expect(
			ApplicationApiCredentialRevocationV1Schema.safeParse({
				metadata: { ...metadata, [key]: "forbidden" },
				replayed: false,
			}).success,
		).toBe(false);
	}
	expect(
		pilotBrowserHttpOpenApiPathsV2[
			"/api/v2/applications/{applicationId}/credentials"
		].get.operationId,
	).toBe("listApplicationApiCredentialsV2");
	expect(
		pilotBrowserHttpOpenApiPathsV2[
			"/api/v2/applications/{applicationId}/credentials/{credentialId}"
		].delete.operationId,
	).toBe("revokeApplicationApiCredentialV2");
});
