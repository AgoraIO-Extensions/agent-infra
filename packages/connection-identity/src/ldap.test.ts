import { describe, expect, it, vi } from "vitest";
import {
	escapeLdapDnValue,
	escapeLdapFilterValue,
	LdapAuthenticationError,
	LdapAuthenticator,
	type LdapTransport,
	LdapUnavailableError,
	PrincipalDirectoryCache,
} from "./ldap.js";

function profile(overrides: Record<string, unknown> = {}) {
	return {
		issuer: "corp-ldap",
		url: "ldaps://ldap.example.test",
		baseDn: "ou=people,dc=example,dc=test",
		serviceDn: "cn=connection,ou=svc,dc=example,dc=test",
		servicePassword: "service-secret",
		...overrides,
	};
}

function transport(): LdapTransport & {
	binds: Array<{ dn: string; password: string }>;
	searches: string[];
} {
	return {
		binds: [],
		searches: [],
		async bind({ dn, password }) {
			this.binds.push({ dn, password });
			if (dn.startsWith("uid=alice") && password !== "password")
				throw new Error("invalid");
		},
		async search({ filter }) {
			this.searches.push(filter);
			return [
				{
					dn: "uid=alice,ou=people,dc=example,dc=test",
					attributes: { uid: "alice", displayName: "Alice" },
				},
			];
		},
	};
}

describe("LDAP identity", () => {
	it("escapes filter and DN input", () => {
		expect(escapeLdapFilterValue("a*)(uid=*)")).toBe(
			"a\\2a\\29\\28uid=\\2a\\29",
		);
		expect(escapeLdapDnValue(" a,b#c ")).toBe("\\ a\\,b\\#c\\ ");
	});

	it("service-binds, searches uniquely, then verifies the user bind", async () => {
		const ldap = transport();
		const principal = await new LdapAuthenticator(profile(), ldap).authenticate(
			"alice",
			"password",
		);
		expect(principal).toMatchObject({ issuer: "corp-ldap", uid: "alice" });
		expect(ldap.binds).toEqual([
			{ dn: profile().serviceDn, password: profile().servicePassword },
			{ dn: "uid=alice,ou=people,dc=example,dc=test", password: "password" },
		]);
	});

	it("rejects empty password, anonymous configuration, and ambiguous search", async () => {
		const ldap = transport();
		await expect(
			new LdapAuthenticator(profile(), ldap).authenticate("alice", ""),
		).rejects.toBeInstanceOf(LdapAuthenticationError);
		expect(
			() => new LdapAuthenticator(profile({ serviceDn: "" }), ldap),
		).toThrow();
		const ambiguous = {
			...ldap,
			search: vi.fn(async () => [
				{ dn: "uid=a", attributes: { uid: "a" } },
				{ dn: "uid=b", attributes: { uid: "b" } },
			]),
		};
		await expect(
			new LdapAuthenticator(profile(), ambiguous).authenticate(
				"alice",
				"password",
			),
		).rejects.toBeInstanceOf(LdapAuthenticationError);
	});

	it("does not silently downgrade LDAP errors", async () => {
		const ldap: LdapTransport = {
			bind: vi.fn(async () => {
				throw new Error("network");
			}),
			search: vi.fn(async () => []),
		};
		await expect(
			new LdapAuthenticator(profile(), ldap).authenticate("alice", "password"),
		).rejects.toBeInstanceOf(LdapAuthenticationError);
		await expect(
			new LdapAuthenticator(profile(), ldap).entryExists("alice"),
		).rejects.toBeInstanceOf(LdapUnavailableError);
	});

	it("caches entry checks for 15 minutes and single-flights expiry", async () => {
		let now = 1_000;
		const entryExists = vi.fn(async () => {
			await Promise.resolve();
			return true;
		});
		const cache = new PrincipalDirectoryCache({ entryExists }, () => now);
		await Promise.all([
			cache.check("corp-ldap", "alice"),
			cache.check("corp-ldap", "alice"),
			cache.check("corp-ldap", "alice"),
		]);
		expect(entryExists).toHaveBeenCalledTimes(1);
		now += 15 * 60 * 1000;
		await cache.check("corp-ldap", "alice");
		expect(entryExists).toHaveBeenCalledTimes(2);
	});
});
