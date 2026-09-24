import { describe, expect, it, vi } from "vitest";
import { PrincipalIdentityResolver, stablePrincipalId } from "./principal.js";

describe("stable LDAP Principal mapping", () => {
	it("keys only issuer and uid and preserves the existing authority", async () => {
		const rows = new Map<
			string,
			{
				id: string;
				issuer: string;
				uid: string;
				status: "active";
				recoveryGeneration: number;
			}
		>();
		const insert = vi.fn(
			async (input: {
				id: string;
				issuer: string;
				uid: string;
				status: "active";
				recoveryGeneration: number;
			}) => {
				rows.set(`${input.issuer}\u0000${input.uid}`, input);
			},
		);
		const findByIssuerUid = vi.fn(
			async ({ issuer, uid }: { issuer: string; uid: string }) => {
				const row = rows.get(`${issuer}\u0000${uid}`);
				return row ? { ...row } : undefined;
			},
		);
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
		const row = rows.get("corp-ldap\u0000alice");
		if (!row) throw new Error("principal missing");
		row.recoveryGeneration = 3;
		const third = await resolver.resolve({
			issuer: "corp-ldap",
			uid: "alice",
			dn: "uid=alice",
			attributes: { displayName: "Changed again" },
		});
		expect(first.id).toBe(stablePrincipalId("corp-ldap", "alice"));
		expect(second.recoveryGeneration).toBe(1);
		expect(third.recoveryGeneration).toBe(3);
		expect(insert).toHaveBeenCalledTimes(1);
		expect(stablePrincipalId("corp-ldap", "alice")).not.toBe(
			stablePrincipalId("corp-ldap", "bob"),
		);
	});
});
