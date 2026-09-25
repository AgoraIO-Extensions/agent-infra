import { beforeEach, expect, it, vi } from "vitest";
import { LdapUnavailableError } from "./ldap.js";
import { createLdaptsAuthenticator } from "./ldapts-transport.js";

const state = vi.hoisted(() => ({
	events: [] as string[],
	failStartTls: false,
	startTlsOptions: undefined as Record<string, unknown> | undefined,
	clientOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock("ldapts", () => ({
	Client: class {
		constructor(options: Record<string, unknown>) {
			state.clientOptions = options;
		}
		async startTLS(options: Record<string, unknown>) {
			state.events.push("startTLS");
			state.startTlsOptions = options;
			if (state.failStartTls) throw new Error("certificate rejected");
		}
		async bind() {
			state.events.push("bind");
		}
		async search() {
			state.events.push("search");
			return {
				searchEntries: [{ dn: "uid=alice,dc=example,dc=test", uid: "alice" }],
				searchReferences: [],
			};
		}
		async unbind() {
			state.events.push("unbind");
		}
	},
}));

beforeEach(() => {
	state.events = [];
	state.failStartTls = false;
	state.startTlsOptions = undefined;
	state.clientOptions = undefined;
});

const profile = (url: string) => ({
	issuer: "test-directory",
	url,
	baseDn: "dc=example,dc=test",
	serviceDn: "cn=reader,dc=example,dc=test",
	servicePassword: "test-only-secret",
});

it("upgrades and verifies ldap:// before the first bind", async () => {
	const ldap = createLdaptsAuthenticator(
		profile("ldap://ldap.example.test"),
		"test-ca",
	);
	expect(await ldap.entryExists("alice")).toBe(true);
	expect(state.events).toEqual(["startTLS", "bind", "search", "unbind"]);
	expect(state.startTlsOptions).toMatchObject({
		ca: "test-ca",
		rejectUnauthorized: true,
		servername: "ldap.example.test",
	});
	expect(state.clientOptions?.tlsOptions).toBeUndefined();
});

it("never binds if STARTTLS or certificate verification fails", async () => {
	state.failStartTls = true;
	const ldap = createLdaptsAuthenticator(profile("ldap://ldap.example.test"));
	await expect(ldap.entryExists("alice")).rejects.toBeInstanceOf(
		LdapUnavailableError,
	);
	expect(state.events).toEqual(["startTLS", "unbind"]);
});

it("also upgrades a URL whose scheme uses uppercase letters", async () => {
	const ldap = createLdaptsAuthenticator(profile("LDAP://ldap.example.test"));
	expect(await ldap.entryExists("alice")).toBe(true);
	expect(state.events[0]).toBe("startTLS");
});

it("uses direct TLS without a STARTTLS operation for ldaps://", async () => {
	const ldap = createLdaptsAuthenticator(profile("ldaps://ldap.example.test"));
	expect(await ldap.entryExists("alice")).toBe(true);
	expect(state.events).toEqual(["bind", "search", "unbind"]);
	expect(state.clientOptions?.tlsOptions).toMatchObject({
		rejectUnauthorized: true,
	});
});

it("uses the explicitly selected LA3 pilot plaintext transport without TLS fallback", async () => {
	const ldap = createLdaptsAuthenticator({
		...profile("ldap://ldap.example.test"),
		transportSecurity: "la3-pilot-plaintext",
	});
	expect(await ldap.entryExists("alice")).toBe(true);
	expect(state.events).toEqual(["bind", "search", "unbind"]);
	expect(state.clientOptions?.tlsOptions).toBeUndefined();
});
