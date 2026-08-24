import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ldapEvents = vi.hoisted(() => [] as string[]);
const ldapSearches = vi.hoisted(
	() => [] as Array<{ attributes: string[]; filter: string }>,
);
const ldapDelays = vi.hoisted(() => ({ bindMs: 0, searchMs: 0, unbindMs: 0 }));

vi.mock("ldapts", () => ({
	Client: class {
		constructor(options: { url: string }) {
			ldapEvents.push(`connect:${options.url}`);
		}

		async bind(dn: string) {
			ldapEvents.push(`bind:${dn}`);
			if (ldapDelays.bindMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, ldapDelays.bindMs));
			}
		}

		async search(
			_baseDn: string,
			options: { attributes: string[]; filter: string },
		) {
			ldapEvents.push("search");
			if (ldapDelays.searchMs > 0) {
				await new Promise((resolve) =>
					setTimeout(resolve, ldapDelays.searchMs),
				);
			}
			ldapSearches.push({
				attributes: options.attributes,
				filter: options.filter,
			});
			return {
				searchEntries: [
					{
						displayName: "Alice",
						dn: "cn=alice,ou=users,dc=example,dc=com",
						employeeStatus: "active",
						mail: "alice@example.com",
						uid: "alice-id",
					},
				],
			};
		}

		async unbind() {
			ldapEvents.push("unbind");
			if (ldapDelays.unbindMs > 0) {
				await new Promise((resolve) =>
					setTimeout(resolve, ldapDelays.unbindMs),
				);
			}
		}
	},
}));

import { escapeLdapFilterValue, LdapDirectoryAuthenticator } from "./index";

const validOptionsWithoutActiveState = {
	displayNameAttribute: "displayName",
	emailAttribute: "mail",
	issuer: "urn:connection:identity:company-ldap",
	serviceBindDn: "cn=connection,ou=services,dc=example,dc=com",
	serviceBindPassword: "not-a-real-secret",
	uidAttribute: "uid",
	url: "ldaps://directory.example:636",
	usernameAttribute: "cn",
	usersBaseDn: "ou=users,dc=example,dc=com",
};

const validOptions = {
	...validOptionsWithoutActiveState,
	activeAttribute: "employeeStatus",
	activeValue: "active",
};

describe("LDAP directory boundary", () => {
	beforeEach(() => {
		ldapEvents.splice(0);
		ldapSearches.splice(0);
		ldapDelays.bindMs = 0;
		ldapDelays.searchMs = 0;
		ldapDelays.unbindMs = 0;
	});

	afterEach(() => vi.useRealTimers());

	it("escapes every RFC4515 special filter byte", () => {
		expect(escapeLdapFilterValue("alice*)(uid=*)\\\0")).toBe(
			"alice\\2a\\29\\28uid=\\2a\\29\\5c\\00",
		);
	});

	it("rejects unsupported LDAP protocols and injectable attribute names", () => {
		expect(
			() =>
				new LdapDirectoryAuthenticator({
					...validOptions,
					url: "http://directory.example",
				}),
		).toThrow(/ldap/);
		expect(
			() =>
				new LdapDirectoryAuthenticator({
					...validOptions,
					usernameAttribute: "cn)(uid=*",
				}),
		).toThrow(/attribute/);
		expect(
			() =>
				new LdapDirectoryAuthenticator({
					...validOptionsWithoutActiveState,
					activeAttribute: "employeeStatus",
				}),
		).toThrow("LDAP active attribute and value must be configured together");
	});

	it("uses the configured Rehoboam-compatible LDAP bind sequence", async () => {
		const authenticator = new LdapDirectoryAuthenticator({
			...validOptions,
			url: "ldap://directory.example:389",
		});

		await expect(
			authenticator.authenticate("alice", "password"),
		).resolves.toEqual({
			displayName: "Alice",
			email: "alice@example.com",
			issuer: validOptions.issuer,
			subject: "alice-id",
		});
		expect(ldapEvents).toEqual([
			"connect:ldap://directory.example:389",
			`bind:${validOptions.serviceBindDn}`,
			"search",
			"unbind",
			"connect:ldap://directory.example:389",
			"bind:cn=alice,ou=users,dc=example,dc=com",
			"unbind",
		]);
		expect(ldapSearches[0]?.filter).toBe(
			"(&(cn=alice)(employeeStatus=active))",
		);
	});

	it("requires a service credential", () => {
		expect(
			() =>
				new LdapDirectoryAuthenticator({
					...validOptions,
					serviceBindPassword: "",
				}),
		).toThrow("LDAP service bind password is required");
	});

	it("shares one total deadline across service bind and search", async () => {
		vi.useFakeTimers();
		ldapDelays.bindMs = 30;
		ldapDelays.searchMs = 30;
		const authenticator = new LdapDirectoryAuthenticator({
			...validOptions,
			operationTimeoutMs: 50,
		});

		const active = authenticator.isActive({
			issuer: validOptions.issuer,
			subject: "alice-id",
		});
		const rejected = expect(active).rejects.toThrow(
			"Directory authentication failed",
		);
		await vi.advanceTimersByTimeAsync(50);

		await rejected;
	});

	it("does not spend the authentication deadline waiting for LDAP cleanup", async () => {
		vi.useFakeTimers();
		ldapDelays.unbindMs = 500;
		const authenticator = new LdapDirectoryAuthenticator({
			...validOptions,
			operationTimeoutMs: 1_000,
		});

		const authentication = authenticator.authenticate("alice", "password");
		await vi.advanceTimersByTimeAsync(499);
		let settled = false;
		authentication.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(authentication).resolves.toMatchObject({
			subject: "alice-id",
		});
	});

	it("escapes account values without an active-state mapping", async () => {
		const authenticator = new LdapDirectoryAuthenticator(
			validOptionsWithoutActiveState,
		);

		await authenticator.authenticate("alice*)(uid=*)", "password");
		await expect(
			authenticator.isActive({
				issuer: validOptions.issuer,
				subject: "alice-id*)(uid=*)",
			}),
		).resolves.toBe(true);

		expect(ldapSearches).toEqual([
			{
				attributes: ["uid", "mail", "displayName"],
				filter: "(cn=alice\\2a\\29\\28uid=\\2a\\29)",
			},
			{
				attributes: ["uid", "mail", "displayName"],
				filter: "(uid=alice-id\\2a\\29\\28uid=\\2a\\29)",
			},
		]);
	});
});
