import { describe, expect, it } from "vitest";
import { isEquivalentApprovedCredential } from "./repository";

const unchanged = {
	connectionId: "connection-1",
	currentScopes: ["mail.read", "mail.write"],
	expectedConnectionId: "connection-1",
	expectedStatus: "ACTIVE" as const,
	grantedScopes: ["mail.write", "mail.read"],
	providerReleaseId: "outlook-v1",
	storedProviderReleaseId: "outlook-v1",
	storedStatus: "ACTIVE",
};

describe("credential refresh after approval enforcement", () => {
	it("accepts only the unchanged approved account, release, and scopes", () => {
		expect(isEquivalentApprovedCredential(unchanged)).toBe(true);
		for (const changed of [
			{ expectedConnectionId: undefined },
			{ connectionId: "another-account" },
			{ storedStatus: "DISCONNECTED" },
			{ storedProviderReleaseId: "outlook-v2" },
			{ currentScopes: ["mail.read"] },
			{ currentScopes: ["mail.read", "mail.write", "mail.send"] },
			{ currentScopes: { scopes: ["mail.read", "mail.write"] } },
		]) {
			expect(isEquivalentApprovedCredential({ ...unchanged, ...changed })).toBe(
				false,
			);
		}
		expect(
			isEquivalentApprovedCredential({
				...unchanged,
				expectedStatus: "DISCONNECTED",
				storedStatus: "DISCONNECTED",
			}),
		).toBe(true);
	});
});
