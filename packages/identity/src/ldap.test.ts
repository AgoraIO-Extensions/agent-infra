import {
	type Client,
	type ClientOptions,
	InvalidCredentialsError,
} from "ldapts";
import { describe, expect, it } from "vitest";
import {
	createLdapIdentityDirectory,
	type LdapIdentityConfiguration,
	LdapIdentityUnavailableError,
} from "./ldap.js";

const employee = {
	dn: "uid=login-a,ou=people,dc=example,dc=test",
	uid: "login-a",
	entryUUID: "stable-a",
	mail: "Person.A@Example.Test",
	cn: "Person A",
	employeeStatus: "enabled",
};

function fixture() {
	let entries = [employee];
	let password = "correct-password";
	let serviceAvailable = true;
	const binds: string[] = [];
	const options: ClientOptions[] = [];
	const searches: string[] = [];
	const config: LdapIdentityConfiguration = {
		url: "ldaps://ldap.example.test:636",
		issuer: "company-ldap",
		baseDn: "ou=people,dc=example,dc=test",
		serviceBindDn: "cn=reader,dc=example,dc=test",
		serviceBindPassword: "service-password",
		loginAttribute: "uid",
		uidAttribute: "entryUUID",
		emailAttribute: "mail",
		displayNameAttribute: "cn",
		activeAttribute: "employeeStatus",
		parseAccountStatus: (value) =>
			value === "enabled" ? "active" : value === "disabled" ? "disabled" : null,
		administratorUids: ["stable-a"],
		createClient(clientOptions) {
			options.push(clientOptions);
			return {
				async bind(dn: string, candidate?: string) {
					binds.push(dn);
					if (!serviceAvailable) throw new Error("secret-provider-detail");
					if (dn === employee.dn && candidate !== password)
						throw new InvalidCredentialsError("secret-provider-detail");
				},
				async search(_base: string, searchOptions) {
					const filter = searchOptions?.filter?.toString() ?? "";
					searches.push(filter);
					const match = /^\((uid|entryUUID)=(.*)\)$/u.exec(filter);
					return {
						searchEntries: match
							? entries.filter(
									(entry) =>
										entry[match[1] as "uid" | "entryUUID"] === match[2],
								)
							: [],
						searchReferences: [],
					};
				},
				async unbind() {},
			} as Pick<Client, "bind" | "search" | "unbind">;
		},
	};
	return {
		config,
		binds,
		options,
		searches,
		setEntries(value: typeof entries) {
			entries = value;
		},
		setPassword(value: string) {
			password = value;
		},
		setServiceAvailable(value: boolean) {
			serviceAvailable = value;
		},
	};
}

describe("first-party LDAP identity directory", () => {
	it("requires LDAPS and a deployment-verified active-state parser", () => {
		const { config } = fixture();
		for (const url of [
			"ldap://ldap.example.test",
			"ldaps://user:secret@ldap.example.test",
			"ldaps://ldap.example.test/path",
			"ldaps://ldap.example.test?x=1",
		])
			expect(() => createLdapIdentityDirectory({ ...config, url })).toThrow(
				LdapIdentityUnavailableError,
			);
		expect(() =>
			createLdapIdentityDirectory({
				...config,
				parseAccountStatus: undefined as never,
			}),
		).toThrow(LdapIdentityUnavailableError);
		expect(() =>
			createLdapIdentityDirectory({ ...config, activeAttribute: "cn)(uid=*" }),
		).toThrow(LdapIdentityUnavailableError);
	});

	it("binds the unique employee, uses stable UID and verifies TLS settings", async () => {
		const state = fixture();
		const directory = createLdapIdentityDirectory(state.config);
		const account = await directory.authenticate("login-a", "correct-password");
		expect(account).toMatchObject({
			uid: "stable-a",
			email: "person.a@example.test",
			accountStatus: "active",
			roles: ["employee", "system_admin"],
		});
		expect(account?.userId).toMatch(/^ldap_[a-f0-9]{64}_/u);
		expect(state.binds).toEqual([
			state.config.serviceBindDn,
			employee.dn,
			state.config.serviceBindDn,
		]);
		expect(
			state.options.every(
				(item) =>
					item.tlsOptions?.rejectUnauthorized === true &&
					item.tlsOptions?.servername === "ldap.example.test" &&
					item.autoRebind === false,
			),
		).toBe(true);
		expect(state.searches).toEqual(["(uid=login-a)", "(entryUUID=stable-a)"]);
		if (!account) throw new Error("expected account");
		expect(await directory.currentByUserId(account.userId)).toEqual(account);
		const otherIssuer = createLdapIdentityDirectory({
			...state.config,
			issuer: "other-company",
		});
		expect((await otherIssuer.current("stable-a"))?.userId).not.toBe(
			account?.userId,
		);
		await expect(
			directory.currentByUserId("ldap_forged_stable-a"),
		).rejects.toThrow(LdapIdentityUnavailableError);
	});

	it("never grants administrator from an empty or mismatched UID set", async () => {
		const state = fixture();
		for (const administratorUids of [[], ["login-a"], ["other-stable-uid"]]) {
			const directory = createLdapIdentityDirectory({
				...state.config,
				administratorUids,
			});
			expect(
				(await directory.authenticate("login-a", "correct-password"))?.roles,
			).toEqual(["employee"]);
		}
	});

	it("does not accept wrong passwords, absent users or disabled accounts", async () => {
		const state = fixture();
		const directory = createLdapIdentityDirectory(state.config);
		await expect(
			directory.authenticate("login-a", "incorrect"),
		).resolves.toBeNull();
		await expect(
			directory.authenticate("absent", "correct-password"),
		).resolves.toBeNull();
		state.setEntries([{ ...employee, employeeStatus: "disabled" }]);
		await expect(
			directory.authenticate("login-a", "correct-password"),
		).resolves.toBeNull();
		await expect(directory.current("stable-a")).resolves.toMatchObject({
			accountStatus: "disabled",
		});
		state.setEntries([{ ...employee, employeeStatus: "unknown" }]);
		await expect(directory.current("stable-a")).rejects.toThrow(
			LdapIdentityUnavailableError,
		);
	});

	it("fails closed on duplicate or malformed UID, missing email and unavailable LDAP", async () => {
		const state = fixture();
		const directory = createLdapIdentityDirectory(state.config);
		for (const changed of [
			[employee, { ...employee, dn: "uid=other,dc=example,dc=test" }],
			[{ ...employee, entryUUID: "" }],
			[{ ...employee, mail: "" }],
		]) {
			state.setEntries(changed);
			await expect(
				directory.authenticate("login-a", "correct-password"),
			).rejects.toThrow(LdapIdentityUnavailableError);
		}
		state.setServiceAvailable(false);
		await expect(directory.current("stable-a")).rejects.toThrow(
			"LDAP_IDENTITY_UNAVAILABLE",
		);
	});

	it("passes a structured equality filter for hostile login input", async () => {
		const state = fixture();
		const directory = createLdapIdentityDirectory(state.config);
		await expect(
			directory.authenticate("a*)(uid=*)", "correct-password"),
		).resolves.toBeNull();
		expect(state.searches[0]).toBe("(uid=a\\2a\\29\\28uid=\\2a\\29)");
	});
});
