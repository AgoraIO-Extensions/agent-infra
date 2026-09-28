import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ldapEvents = vi.hoisted(() => [] as string[]);
const ldapSearches = vi.hoisted(
	() =>
		[] as Array<{
			attributes: string[];
			filter: string;
			paged?: unknown;
			sizeLimit?: number;
		}>,
);
const ldapDelays = vi.hoisted(() => ({ bindMs: 0, searchMs: 0, unbindMs: 0 }));
const ldapOverride = vi.hoisted(() => ({
	entries: undefined as Array<Record<string, string>> | undefined,
}));
const employeePages = vi.hoisted(
	() => [] as Array<Array<Record<string, string>>>,
);

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
				searchEntries: ldapOverride.entries ?? [
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

		async *searchPaginated(
			_baseDn: string,
			options: {
				attributes: string[];
				filter: string;
				paged: unknown;
				sizeLimit: number;
			},
		) {
			ldapSearches.push({
				attributes: options.attributes,
				filter: options.filter,
				paged: options.paged,
				sizeLimit: options.sizeLimit,
			});
			if (employeePages.length) {
				for (const searchEntries of employeePages) {
					ldapEvents.push("employee-page");
					yield { searchEntries };
				}
				return;
			}
			yield {
				searchEntries: [
					{
						alias: "alice",
						displayName: "Alice",
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
		ldapOverride.entries = undefined;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("uses the company employee list for discovery and LDAP for the stable identity", async () => {
		const fetchEmployees = vi.fn(async () =>
			Response.json([
				{
					name: "Alice Employee",
					email: "alice@example.com",
					iamId: "not-the-ldap-uid",
				},
				{ name: "Bob", email: "bob@example.com", iamId: "other" },
			]),
		);
		vi.stubGlobal("fetch", fetchEmployees);
		const directory = new LdapDirectoryAuthenticator({
			...validOptionsWithoutActiveState,
			employeeDirectory: {
				url: "https://employees.example/users",
				serviceKey: "test-key",
			},
		});
		await expect(directory.searchEmployees("ALICE")).resolves.toEqual([
			{
				alias: null,
				displayName: "Alice Employee",
				email: "alice@example.com",
				issuer: validOptions.issuer,
				subject: "alice-id",
			},
		]);
		expect(fetchEmployees).toHaveBeenCalledWith(
			"https://employees.example/users",
			expect.objectContaining({
				redirect: "error",
				headers: {
					"agora-service-key": "test-key",
					Accept: "application/json",
				},
			}),
		);
		expect(ldapSearches[0]?.filter).toBe("(mail=alice@example.com)");
	});

	it("rejects mismatched LDAP email and does not fall back on upstream failure", async () => {
		const directory = new LdapDirectoryAuthenticator({
			...validOptions,
			employeeDirectory: {
				url: "https://employees.example/users",
				serviceKey: "test-key",
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json([
					{ name: "Bob", email: "bob@example.com", iamId: "bob" },
				]),
			),
		);
		await expect(directory.searchEmployees("bob")).rejects.toThrow(
			"Directory authentication failed",
		);
		ldapSearches.length = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("private diagnostic", { status: 503 })),
		);
		await expect(directory.searchEmployees("alice")).rejects.toThrow(
			"Directory authentication failed",
		);
		expect(ldapSearches).toHaveLength(0);
	});

	it("escapes every RFC4515 special filter byte", () => {
		expect(escapeLdapFilterValue("alice*)(uid=*)\\\0")).toBe(
			"alice\\2a\\29\\28uid=\\2a\\29\\5c\\00",
		);
	});

	it("omits missing active LDAP identities and rejects ambiguous email mappings", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json([
					{ name: "Alice", email: "alice@example.com", iamId: "external" },
				]),
			),
		);
		const directory = new LdapDirectoryAuthenticator({
			...validOptions,
			employeeDirectory: {
				url: "https://employees.example/users",
				serviceKey: "test-key",
			},
		});
		ldapOverride.entries = [];
		await expect(directory.searchEmployees("alice")).resolves.toEqual([]);
		ldapOverride.entries = [
			{ uid: "first", mail: "alice@example.com" },
			{ uid: "second", mail: "alice@example.com" },
		];
		await expect(directory.searchEmployees("alice")).rejects.toThrow(
			"Directory authentication failed",
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

	it("rejects absent and ambiguous uid entries without an active-state mapping", async () => {
		const authenticator = new LdapDirectoryAuthenticator(
			validOptionsWithoutActiveState,
		);
		const identity = { issuer: validOptions.issuer, subject: "alice-id" };
		ldapOverride.entries = [];
		await expect(authenticator.isActive(identity)).resolves.toBe(false);
		ldapOverride.entries = [{ uid: "alice-id" }, { uid: "alice-id" }];
		await expect(authenticator.isActive(identity)).resolves.toBe(false);
		expect(ldapSearches.map((search) => search.filter)).toEqual([
			"(uid=alice-id)",
			"(uid=alice-id)",
		]);
	});

	it("searches a bounded employee projection without filtering active state", async () => {
		const authenticator = new LdapDirectoryAuthenticator({
			...validOptions,
			aliasAttribute: "alias",
		});
		await expect(
			authenticator.searchEmployees("ali*)(uid=*)"),
		).resolves.toEqual([
			{
				alias: "alice",
				displayName: "Alice",
				email: "alice@example.com",
				issuer: validOptions.issuer,
				subject: "alice-id",
			},
		]);
		expect(ldapSearches[0]).toEqual({
			attributes: ["uid", "displayName", "mail", "alias"],
			filter:
				"(|(displayName=*ali\\2a\\29\\28uid=\\2a\\29*)(mail=*ali\\2a\\29\\28uid=\\2a\\29*)(alias=*ali\\2a\\29\\28uid=\\2a\\29*))",
			paged: { pageSize: 10 },
			sizeLimit: 21,
		});
	});

	it("returns twenty candidates without reading the next page for broad searches", async () => {
		const page = (offset: number, count: number) =>
			Array.from({ length: count }, (_, index) => ({
				uid: `employee-${offset + index}`,
				displayName: "Common name",
			}));
		employeePages.push(page(0, 10), page(10, 10), page(20, 10));
		try {
			const candidates = await new LdapDirectoryAuthenticator(
				validOptions,
			).searchEmployees("Common");
			expect(candidates).toHaveLength(20);
			expect(candidates[19]?.subject).toBe("employee-19");
			expect(
				ldapEvents.filter((event) => event === "employee-page"),
			).toHaveLength(2);
			expect(ldapEvents.at(-1)).toBe("unbind");
		} finally {
			employeePages.length = 0;
		}
	});

	it("still rejects ambiguous employee identities in a bounded page", async () => {
		employeePages.push([
			{ uid: "same-id", displayName: "First" },
			{ uid: "same-id", displayName: "Second" },
		]);
		try {
			await expect(
				new LdapDirectoryAuthenticator(validOptions).searchEmployees("Common"),
			).rejects.toThrow("Directory authentication failed");
		} finally {
			employeePages.length = 0;
		}
	});

	it("searches employees without an active-state mapping but still validates query bounds", async () => {
		const authenticator = new LdapDirectoryAuthenticator(
			validOptionsWithoutActiveState,
		);
		await expect(authenticator.searchEmployees("alice")).resolves.toMatchObject(
			[{ subject: "alice-id" }],
		);
		expect(ldapSearches).toHaveLength(1);
		for (const query of ["a", "a".repeat(65)]) {
			await expect(authenticator.searchEmployees(query)).rejects.toThrow(
				"Directory authentication failed",
			);
		}
		expect(ldapSearches).toHaveLength(1);
	});
});
