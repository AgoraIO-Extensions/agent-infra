import { describe, expect, it, vi } from "vitest";
import type { LdapAccount } from "./ldap.js";
import { resolveLdapPrincipal } from "./ldap-principal.js";

const account: LdapAccount = {
	uid: "stable-a",
	userId: "e8c99945-5b39-4bcb-8f99-c29a7788432f",
	email: "person.a@example.test",
	displayName: "Person A",
	accountStatus: "active",
	roles: ["employee"],
	authorizationRevision: "ldap-revision",
};

describe("LDAP principal authority", () => {
	it("lets Platform disable override LDAP and skips organization lookup", async () => {
		const organizationIds = vi.fn(async () => ["org-a"]);
		const identity = await resolveLdapPrincipal(account, {
			isPlatformDisabled: async () => true,
			organizationIds,
		});
		expect(identity.accountStatus).toBe("disabled");
		expect(identity.organizationIds).toEqual([]);
		expect(organizationIds).not.toHaveBeenCalled();
	});

	it("rejects unavailable or ambiguous organization and disable facts", async () => {
		const isPlatformDisabled = async () => false;
		for (const organizationIds of [
			async () => ["org-a", "org-a"],
			async () => [""],
			async () => {
				throw new Error("private directory detail");
			},
		])
			await expect(
				resolveLdapPrincipal(account, {
					isPlatformDisabled,
					organizationIds,
				}),
			).rejects.toThrow();
		await expect(
			resolveLdapPrincipal(account, {
				isPlatformDisabled: async () => undefined as never,
				organizationIds: async () => ["org-a"],
			}),
		).rejects.toThrow("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
	});
});
