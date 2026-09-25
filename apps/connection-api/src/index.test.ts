import { expect, it } from "vitest";
import { ldapTransportSecurityFromEnvironment } from "./index.js";

const url = "ldap://10.20.30.40:389";
const approved = {
	CONNECTION_LDAP_LA3_PLAINTEXT: "enabled",
	CONNECTION_ENVIRONMENT: "la3-connection-pilot",
	CONNECTION_LDAP_LA3_PRIVATE_ENDPOINT: url,
	CONNECTION_LDAP_LA3_APPROVED_NETWORK_PATH: "approved-private-egress",
	CONNECTION_LDAP_LA3_RISK_OWNER: "security-owner",
	CONNECTION_LDAP_LA3_RISK_RECORD: "internal-risk-record",
};

it("keeps TLS as the default LDAP mode", () => {
	expect(ldapTransportSecurityFromEnvironment(url, {})).toBe("tls");
});

it("requires every LA3 plaintext deployment gate at startup", () => {
	expect(ldapTransportSecurityFromEnvironment(url, approved)).toBe(
		"la3-private-plaintext",
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
		ldapTransportSecurityFromEnvironment("ldap://10.20.30.41:389", approved),
	).toThrow();
	expect(() =>
		ldapTransportSecurityFromEnvironment(url, {
			...approved,
			CONNECTION_ENVIRONMENT: "production",
		}),
	).toThrow();
});
