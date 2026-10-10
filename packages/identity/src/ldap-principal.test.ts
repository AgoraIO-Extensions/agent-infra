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

	it("carries an opaque current directory binding beside organization facts", async () => {
		const binding = {
			schemaVersion: 1 as const,
			source: "internal",
			revision: "00000000-0000-4000-8000-000000000001",
			fetchedAt: Date.now() - 1_000,
			validUntil: Date.now() + 60_000,
		};
		const identity = await resolveLdapPrincipal(account, {
			isPlatformDisabled: async () => false,
			organizationIds: async () => ["legacy-org"],
			organizationAuthority: async () => ({
				organizationIds: ["org-a"],
				binding,
			}),
		});
		expect(identity.organizationIds).toEqual(["org-a"]);
		expect(identity.directorySnapshotBinding).toEqual(binding);
	});

	it("fails closed when configured directory authority is incomplete", async () => {
		const organizationIds = vi.fn(async () => ["legacy-org"]);
		for (const authority of [
			null,
			{ organizationIds: ["org-a"] },
			{ binding: { schemaVersion: 1 } },
			{
				organizationIds: ["org-a"],
				binding: {
					schemaVersion: 1,
					source: "internal",
					revision: "stale",
					fetchedAt: 2_000,
					validUntil: 1_000,
				},
			},
		]) {
			organizationIds.mockClear();
			await expect(
				resolveLdapPrincipal(account, {
					isPlatformDisabled: async () => false,
					organizationIds,
					organizationAuthority: async () => authority as never,
				}),
			).rejects.toThrow("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
			expect(organizationIds).not.toHaveBeenCalled();
		}
	});
});
