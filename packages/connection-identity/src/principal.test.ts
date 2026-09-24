import { describe, expect, it, vi } from "vitest";
import { PrincipalIdentityResolver, stablePrincipalId } from "./principal.js";

describe("stable LDAP Principal mapping", () => {
	it("keys only issuer and uid and preserves the existing authority", async () => {
		const insert = vi.fn(async () => {});
		const findByIssuerUid = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({
				id: stablePrincipalId("corp-ldap", "alice"),
				issuer: "corp-ldap",
				uid: "alice",
				status: "active" as const,
				recoveryGeneration: 3,
			});
		const resolver = new PrincipalIdentityResolver({ findByIssuerUid, insert });
		const first = await resolver.resolve({
			issuer: "corp-ldap",
			uid: "alice",
			dn: "uid=alice",
			attributes: { displayName: "Alice" },
		});
		const second = await resolver.resolve({
			issuer: "corp-ldap",
			uid: "alice",
			dn: "uid=alice",
			attributes: { displayName: "Changed" },
		});
		expect(first.id).toBe(stablePrincipalId("corp-ldap", "alice"));
		expect(second.recoveryGeneration).toBe(3);
		expect(insert).toHaveBeenCalledTimes(1);
		expect(stablePrincipalId("corp-ldap", "alice")).not.toBe(
			stablePrincipalId("corp-ldap", "bob"),
		);
	});
});
