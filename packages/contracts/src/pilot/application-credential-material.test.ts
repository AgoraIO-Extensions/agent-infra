import { expect, it } from "vitest";
import { ApplicationCredentialMaterialIntentV1Schema } from "./application-credential-material.ts";
import { pilotBrowserHttpOpenApiPathsV2 } from "./browser.ts";

it("publishes separate metadata, one-time receive and confirmation operations", () => {
	const paths = pilotBrowserHttpOpenApiPathsV2 as Record<
		string,
		Record<string, unknown>
	>;
	const base =
		"/api/v2/applications/{applicationId}/credential-material-deliveries";
	expect(paths[base]?.post).toBeDefined();
	expect(paths[`${base}/{attemptId}`]?.get).toBeDefined();
	expect(paths[`${base}/{attemptId}/receive`]?.post).toBeDefined();
	expect(paths[`${base}/{attemptId}/confirm`]?.post).toBeDefined();
});
it("rejects caller-selected transport, forged identity and surplus material fields", () => {
	const body = {
		schemaVersion: 1,
		operation: "issue",
		recipient: { principalType: "user", principalId: "receiver" },
		scopes: ["agent:read"],
		expiresAt: null,
	};
	for (const extra of [
		{ callbackUrl: "https://other.example.test" },
		{ actorId: "other" },
		{ material: "synthetic-invalid" },
		{ adapter: "other" },
	])
		expect(
			ApplicationCredentialMaterialIntentV1Schema.safeParse({
				...body,
				...extra,
			}).success,
		).toBe(false);
});
