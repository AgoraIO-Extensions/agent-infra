import { expect, it } from "vitest";
import { ldapTransportSecurityFromEnvironment } from "./index.js";

const url = "ldap://ldap.example.test";
const approved = {
	CONNECTION_LDAP_LA3_PLAINTEXT: "enabled",
	CONNECTION_ENVIRONMENT: "la3-connection-pilot",
	CONNECTION_LDAP_LA3_ENDPOINT: url,
};

it("keeps TLS as the default LDAP mode", () => {
	expect(ldapTransportSecurityFromEnvironment(url, {})).toBe("tls");
});

it("requires every LA3 plaintext deployment gate at startup", () => {
	expect(ldapTransportSecurityFromEnvironment(url, approved)).toBe(
		"la3-pilot-plaintext",
	);
	for (const key of Object.keys(approved).filter(
		(name) => name !== "CONNECTION_LDAP_LA3_PLAINTEXT",
	)) {
		expect(() =>
			ldapTransportSecurityFromEnvironment(url, { ...approved, [key]: "" }),
		).toThrow();
	}
	expect(() =>
		ldapTransportSecurityFromEnvironment(url, {
			...approved,
			CONNECTION_LDAP_LA3_PLAINTEXT: "fallback",
		}),
	).toThrow();
	expect(() =>
		ldapTransportSecurityFromEnvironment("ldap://other.example.test", approved),
	).toThrow();
	expect(() =>
		ldapTransportSecurityFromEnvironment(url, {
			...approved,
			CONNECTION_ENVIRONMENT: "production",
		}),
	).toThrow();
});
