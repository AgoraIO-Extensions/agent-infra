import { describe, expect, it } from "vitest";

import {
	connectionApiRuntimeConfig,
	connectionWorkerRuntimeConfig,
	fullConnectionRuntimeConfig,
	productionMigrationRuntimeConfig,
} from "./runtime-config";

const base = {
	CONNECTION_CREDENTIAL_KEY: Buffer.alloc(32, "0").toString("base64"),
	DATABASE_URL: "postgresql://connection:connection@database:5432/connection",
};

const accountBase = {
	CONNECTION_CREDENTIAL_KEY: Buffer.alloc(32, 9).toString("base64"),
	CONNECTION_DIRECT_CONSUMER_ID: "consumer-codex",
	CONNECTION_DIRECT_CONSUMER_NAME: "Codex",
	CONNECTION_IDENTITY_KEY: Buffer.alloc(32, 7).toString("base64"),
	CONNECTION_PUBLIC_BASE_URL: "https://connection.example",
	DATABASE_URL: "postgresql://connection:secret@database:5432/connection",
	LDAP_DISPLAY_NAME_ATTRIBUTE: "sn",
	LDAP_EMAIL_ATTRIBUTE: "uid",
	LDAP_ISSUER: "urn:connection:identity:company-ldap",
	LDAP_SERVICE_BIND_DN: "cn=connection,ou=services,dc=example,dc=com",
	LDAP_SERVICE_BIND_PASSWORD: "not-a-real-secret",
	LDAP_UID_ATTRIBUTE: "uid",
	LDAP_URL: "ldap://directory.example:389",
	LDAP_USERNAME_ATTRIBUTE: "cn",
	LDAP_USERS_BASE_DN: "ou=users,dc=agora,dc=org",
	GITHUB_OAUTH_CLIENT_ID: "github-client",
	GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
};

describe("Connection runtime configuration", () => {
	it("requires one HTTPS account authority and derives the MCP resource", () => {
		const config = connectionApiRuntimeConfig(accountBase);
		expect(config.publicBaseUrl).toBe("https://connection.example/");
		expect(config.resourceUrl).toBe("https://connection.example/mcp");
		expect(config.identityKey).toHaveLength(32);
	});

	it("rejects insecure public URLs and malformed identity keys", () => {
		expect(() =>
			connectionApiRuntimeConfig({
				...accountBase,
				CONNECTION_PUBLIC_BASE_URL: "http://connection.example",
			}),
		).toThrow(/HTTPS/);
		expect(() =>
			connectionApiRuntimeConfig({
				...accountBase,
				CONNECTION_IDENTITY_KEY: "short",
			}),
		).toThrow(/32 bytes/);
	});

	it("allows only exact loopback HTTP for local conformance", () => {
		const config = connectionApiRuntimeConfig({
			...accountBase,
			CONNECTION_PUBLIC_BASE_URL: "http://127.0.0.1:3002",
		});
		expect(config.publicBaseUrl).toBe("http://127.0.0.1:3002/");
		expect(config.resourceUrl).toBe("http://127.0.0.1:3002/mcp");
		expect(() =>
			connectionApiRuntimeConfig({
				...accountBase,
				CONNECTION_PUBLIC_BASE_URL: "http://localhost:3002",
			}),
		).toThrow(/exact loopback/);
	});

	it("builds the full runtime from the same account authority", () => {
		const config = fullConnectionRuntimeConfig(accountBase);
		expect(config.credentialKey).toHaveLength(32);
		expect(config.github.redirectUri).toBe(
			"https://connection.example/oauth/callback",
		);
	});

	it("requires optional LDAP active-state settings to be configured together", () => {
		expect(() =>
			connectionApiRuntimeConfig({
				...accountBase,
				LDAP_ACTIVE_ATTRIBUTE: "employeeStatus",
			}),
		).toThrow(
			"LDAP_ACTIVE_ATTRIBUTE and LDAP_ACTIVE_VALUE must be configured together",
		);
		expect(() =>
			connectionApiRuntimeConfig({
				...accountBase,
				LDAP_ACTIVE_VALUE: "active",
			}),
		).toThrow(
			"LDAP_ACTIVE_ATTRIBUTE and LDAP_ACTIVE_VALUE must be configured together",
		);
	});

	it("keeps the production skeleton migration config database-only", () => {
		expect(
			productionMigrationRuntimeConfig({ DATABASE_URL: "postgresql://db" }),
		).toEqual({
			databaseUrl: "postgresql://db",
		});
	});

	it("allows the production recovery worker to omit browser OAuth settings", () => {
		const config = connectionWorkerRuntimeConfig({
			...base,
			GITHUB_API_BASE_URL: "https://api.github.com",
		});
		expect(config.github.apiBaseUrl).toBe("https://api.github.com");
		expect(config.credentialKey).toHaveLength(32);
	});
});
