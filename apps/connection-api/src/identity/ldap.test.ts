import { describe, expect, it, vi } from "vitest";
import {
	escapeLdapFilterValue,
	LdapAuthenticationError,
	LdapAuthenticator,
	type LdapTransport,
	LdapUnavailableError,
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
		async close() {},
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
	it("escapes filter input", () => {
		expect(escapeLdapFilterValue("a*)(uid=*)")).toBe(
			"a\\2a\\29\\28uid=\\2a\\29",
		);
	});

	it("service-binds, searches uniquely, then verifies the user bind", async () => {
		const ldap = transport();
		const authenticator = new LdapAuthenticator(profile(), () => ldap);
		expect(JSON.stringify(authenticator)).not.toContain("service-secret");
		const principal = await authenticator.authenticate("alice", "password");
		expect(principal).toMatchObject({ issuer: "corp-ldap", uid: "alice" });
		expect(ldap.binds).toEqual([
			{ dn: profile().serviceDn, password: profile().servicePassword },
			{ dn: "uid=alice,ou=people,dc=example,dc=test", password: "password" },
		]);
	});

	it("rejects empty password, anonymous configuration, and ambiguous search", async () => {
		const ldap = transport();
		await expect(
			new LdapAuthenticator(profile(), () => ldap).authenticate("alice", ""),
		).rejects.toBeInstanceOf(LdapAuthenticationError);
		expect(
			() => new LdapAuthenticator(profile({ serviceDn: "" }), () => ldap),
		).toThrow();
		expect(
			() =>
				new LdapAuthenticator(
					profile({ url: "ldap://ldap.example.test" }),
					() => ldap,
				),
		).not.toThrow();
		expect(
			() =>
				new LdapAuthenticator(
					profile({ url: "http://ldap.example.test" }),
					() => ldap,
				),
		).toThrow("LDAP TLS is required");
		expect(
			() =>
				new LdapAuthenticator(
					profile({
						url: "ldap://10.20.30.40:389",
						transportSecurity: "la3-private-plaintext",
					}),
					() => ldap,
				),
		).not.toThrow();
		for (const url of [
			"ldap://ldap.example.test:389",
			"ldap://198.51.100.2:389",
			"ldap://10.20.30.40:1389",
			"ldaps://10.20.30.40:636",
		])
			expect(
				() =>
					new LdapAuthenticator(
						profile({ url, transportSecurity: "la3-private-plaintext" }),
						() => ldap,
					),
			).toThrow("fixed private IPv4 endpoint");
		const ambiguous = {
			...ldap,
			search: vi.fn(async () => [
				{ dn: "uid=a", attributes: { uid: "a" } },
				{ dn: "uid=b", attributes: { uid: "b" } },
			]),
		};
		await expect(
			new LdapAuthenticator(profile(), () => ambiguous).authenticate(
				"alice",
				"password",
			),
		).rejects.toBeInstanceOf(LdapAuthenticationError);
	});

	it("does not silently downgrade LDAP errors", async () => {
		const ldap: LdapTransport = {
			close: vi.fn(async () => {}),
			bind: vi.fn(async () => {
				throw new Error("network");
			}),
			search: vi.fn(async () => []),
		};
		await expect(
			new LdapAuthenticator(profile(), () => ldap).authenticate(
				"alice",
				"password",
			),
		).rejects.toBeInstanceOf(LdapUnavailableError);
		await expect(
			new LdapAuthenticator(profile(), () => ldap).entryExists("alice"),
		).rejects.toBeInstanceOf(LdapUnavailableError);
	});

	it("escapes submitted usernames in the actual search filter", async () => {
		const ldap = transport();
		ldap.search = async ({ filter }) => {
			ldap.searches.push(filter);
			return [];
		};
		await expect(
			new LdapAuthenticator(profile(), () => ldap).authenticate(
				"a*)(uid=*)",
				"password",
			),
		).rejects.toBeInstanceOf(LdapAuthenticationError);
		expect(ldap.searches).toEqual(["(uid=a\\2a\\29\\28uid=\\2a\\29)"]);
	});

	it("closes a stalled bind at the configured deadline", async () => {
		const close = vi.fn(async () => {});
		const ldap: LdapTransport = {
			bind: async () => new Promise<void>(() => {}),
			search: async () => [],
			close,
		};
		await expect(
			new LdapAuthenticator(
				profile({ timeoutMs: 100 }),
				() => ldap,
			).authenticate("alice", "password"),
		).rejects.toBeInstanceOf(LdapUnavailableError);
	});
});
