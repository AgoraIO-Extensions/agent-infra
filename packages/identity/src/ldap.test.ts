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
};

function fixture() {
	let entries = [employee];
	let password = "correct-password";
	let bindAllowed = true;
	let currentStatus: "active" | "disabled" | null = "active";
	let verifierAvailable = true;
	let serviceAvailable = true;
	const ids = new Map<string, string>();
	const binds: string[] = [];
	const options: ClientOptions[] = [];
	const searches: string[] = [];
	const verifications: { issuer: string; uid: string }[] = [];
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
		async verifyCurrentStatus(identity) {
			verifications.push(identity);
			if (!verifierAvailable) throw new Error("private verifier detail");
			return currentStatus;
		},
		identityIds: {
			async findByUid(issuer, uid) {
				return ids.get(JSON.stringify([issuer, uid])) ?? null;
			},
			async findUidByUserId(issuer, userId) {
				for (const [key, value] of ids)
					if (value === userId) {
						const [storedIssuer, uid] = JSON.parse(key) as [string, string];
						if (storedIssuer === issuer) return uid;
					}
				return null;
			},
			async getOrCreate(issuer, uid, candidateUserId) {
				const key = JSON.stringify([issuer, uid]);
				const existing = ids.get(key);
				if (existing) return existing;
				ids.set(key, candidateUserId);
				return candidateUserId;
			},
		},
		administratorUids: ["stable-a"],
		createClient(clientOptions) {
			options.push(clientOptions);
			return {
				async bind(dn: string, candidate?: string) {
					binds.push(dn);
					if (!serviceAvailable) throw new Error("secret-provider-detail");
					if (dn === employee.dn && (!bindAllowed || candidate !== password))
						throw new InvalidCredentialsError("secret-provider-detail");
				},
				async search(_base: string, searchOptions) {
					const filter = searchOptions?.filter?.toString() ?? "";
					searches.push(filter);
					const match = /^\((uid|entryUUID|mail)=(.*)\)$/u.exec(filter);
					return {
						searchEntries: match
							? entries.filter((entry) =>
									match[1] === "mail"
										? entry.mail.toLowerCase() === match[2]?.toLowerCase()
										: entry[match[1] as "uid" | "entryUUID"] === match[2],
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
		ids,
		binds,
		options,
		searches,
		verifications,
		setEntries(value: typeof entries) {
			entries = value;
		},
		setPassword(value: string) {
			password = value;
		},
		setBindAllowed(value: boolean) {
			bindAllowed = value;
		},
		setCurrentStatus(value: "active" | "disabled" | null) {
			currentStatus = value;
		},
		setVerifierAvailable(value: boolean) {
			verifierAvailable = value;
		},
		setServiceAvailable(value: boolean) {
			serviceAvailable = value;
		},
	};
}

describe("first-party LDAP identity directory", () => {
	it("requires LDAPS and rejects a malformed current-status verifier", () => {
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
				verifyCurrentStatus: "active" as never,
			}),
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
		expect(account?.userId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
		);
		expect(account?.userId).not.toContain("stable-a");
		await expect(directory.userIdForUid("stable-a")).resolves.toBe(
			account?.userId,
		);
		await expect(directory.userIdForUid("")).rejects.toThrow(
			LdapIdentityUnavailableError,
		);
		expect(state.binds).toEqual([
			state.config.serviceBindDn,
			employee.dn,
			state.config.serviceBindDn,
			state.config.serviceBindDn,
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
		expect(state.searches).toEqual([
			"(uid=login-a)",
			"(uid=login-a)",
			"(entryUUID=stable-a)",
			"(mail=person.a@example.test)",
		]);
		if (!account) throw new Error("expected account");
		expect(await directory.currentByUserId(account.userId)).toEqual(account);
		const secondInstance = createLdapIdentityDirectory(state.config);
		expect(await secondInstance.currentByUserId(account.userId)).toEqual(
			account,
		);
		const otherIssuer = createLdapIdentityDirectory({
			...state.config,
			issuer: "other-company",
		});
		expect(
			(await otherIssuer.authenticate("login-a", "correct-password"))?.userId,
		).not.toBe(account?.userId);
		await expect(
			directory.currentByUserId("ldap_forged_stable-a"),
		).rejects.toThrow(LdapIdentityUnavailableError);
		const otherId = (
			await otherIssuer.authenticate("login-a", "correct-password")
		)?.userId;
		if (!otherId) throw new Error("expected other issuer ID");
		await expect(directory.currentByUserId(otherId)).resolves.toBeNull();
		state.ids.clear();
		await expect(directory.userIdForUid("stable-a")).rejects.toThrow(
			LdapIdentityUnavailableError,
		);
		await expect(directory.current("stable-a")).resolves.toBeNull();
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

	it("uses user bind for new login and the injected verifier for existing sessions", async () => {
		const state = fixture();
		const directory = createLdapIdentityDirectory(state.config);
		await directory.authenticate("login-a", "correct-password");
		await expect(
			directory.authenticate("login-a", "incorrect"),
		).resolves.toBeNull();
		await expect(
			directory.authenticate("absent", "correct-password"),
		).resolves.toBeNull();
		expect(state.ids.size).toBe(1);
		state.setBindAllowed(false);
		state.setCurrentStatus("disabled");
		await expect(
			directory.authenticate("login-a", "correct-password"),
		).resolves.toBeNull();
		await expect(directory.current("stable-a")).resolves.toMatchObject({
			accountStatus: "disabled",
		});
		expect(state.verifications).toContainEqual({
			issuer: "company-ldap",
			uid: "stable-a",
		});
		state.setCurrentStatus(null);
		await expect(directory.current("stable-a")).rejects.toThrow(
			LdapIdentityUnavailableError,
		);
		state.setVerifierAvailable(false);
		await expect(directory.current("stable-a")).rejects.toThrow(
			"LDAP_IDENTITY_UNAVAILABLE",
		);
	});

	it("does not infer current activity from a searchable entry", async () => {
		const state = fixture();
		const directory = createLdapIdentityDirectory({
			...state.config,
			verifyCurrentStatus: undefined,
		});
		const account = await directory.authenticate("login-a", "correct-password");
		if (!account) throw new Error("expected bound account");
		await expect(directory.current("stable-a")).rejects.toThrow(
			"LDAP_IDENTITY_UNAVAILABLE",
		);
		await expect(directory.currentByUserId(account.userId)).rejects.toThrow(
			"LDAP_IDENTITY_UNAVAILABLE",
		);
		const unknown = createLdapIdentityDirectory({
			...state.config,
			async verifyCurrentStatus() {
				return "unknown" as never;
			},
		});
		await expect(unknown.current("stable-a")).rejects.toThrow(
			"LDAP_IDENTITY_UNAVAILABLE",
		);
	});

	it("bounds an unresponsive current-status verifier", async () => {
		const state = fixture();
		const directory = createLdapIdentityDirectory({
			...state.config,
			timeoutMs: 100,
			async verifyCurrentStatus() {
				return new Promise<never>(() => undefined);
			},
		});
		await expect(directory.current("stable-a")).rejects.toThrow(
			"LDAP_IDENTITY_UNAVAILABLE",
		);
	});

	it("rejects deleted accounts for login and current sessions", async () => {
		const state = fixture();
		const directory = createLdapIdentityDirectory(state.config);
		await directory.authenticate("login-a", "correct-password");
		state.setEntries([]);
		await expect(
			directory.authenticate("login-a", "correct-password"),
		).resolves.toBeNull();
		await expect(directory.current("stable-a")).resolves.toBeNull();
	});

	it("does not create an ID when the user bind rejects a disabled account", async () => {
		const state = fixture();
		state.setBindAllowed(false);
		const directory = createLdapIdentityDirectory(state.config);
		await expect(
			directory.authenticate("login-a", "correct-password"),
		).resolves.toBeNull();
		expect(state.ids.size).toBe(0);
	});

	it("does not create an ID if email changes after password bind", async () => {
		const state = fixture();
		const directory = createLdapIdentityDirectory({
			...state.config,
			createClient(options) {
				const client = state.config.createClient?.(options);
				if (!client) throw new Error("expected fixture client");
				return {
					...client,
					async bind(dn, password) {
						await client.bind(dn, password);
						if (dn === employee.dn)
							state.setEntries([{ ...employee, mail: "changed@example.test" }]);
					},
				};
			},
		});
		await expect(
			directory.authenticate("login-a", "correct-password"),
		).resolves.toBeNull();
		expect(state.ids.size).toBe(0);
	});

	it("rejects login DN reassignment after password bind", async () => {
		for (const changed of [
			[
				{ ...employee, entryUUID: "stable-b", mail: "other@example.test" },
				{
					...employee,
					dn: "uid=moved,ou=people,dc=example,dc=test",
					uid: "moved",
				},
			],
			[{ ...employee, dn: "uid=renamed,ou=people,dc=example,dc=test" }],
		]) {
			const state = fixture();
			const directory = createLdapIdentityDirectory({
				...state.config,
				createClient(options) {
					const client = state.config.createClient?.(options);
					if (!client) throw new Error("expected fixture client");
					return {
						...client,
						async bind(dn, password) {
							await client.bind(dn, password);
							if (dn === employee.dn) state.setEntries(changed);
						},
					};
				},
			});
			await expect(
				directory.authenticate("login-a", "correct-password"),
			).resolves.toBeNull();
			expect(state.ids.size).toBe(0);
		}
	});

	it("rejects malformed or unavailable persistent identity mappings", async () => {
		const state = fixture();
		const malformed = createLdapIdentityDirectory({
			...state.config,
			identityIds: {
				...state.config.identityIds,
				async getOrCreate() {
					return "stable-a";
				},
			},
		});
		await expect(
			malformed.authenticate("login-a", "correct-password"),
		).rejects.toThrow(LdapIdentityUnavailableError);
		const unavailable = createLdapIdentityDirectory({
			...state.config,
			identityIds: {
				...state.config.identityIds,
				async getOrCreate() {
					throw new Error("private database detail");
				},
			},
		});
		await expect(
			unavailable.authenticate("login-a", "correct-password"),
		).rejects.toThrow("LDAP_IDENTITY_UNAVAILABLE");
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

	it("rejects shared LDAP email across stable UIDs", async () => {
		const state = fixture();
		state.setEntries([
			employee,
			{
				...employee,
				dn: "uid=login-b,ou=people,dc=example,dc=test",
				uid: "login-b",
				entryUUID: "stable-b",
				mail: "person.a@example.test",
			},
		]);
		const directory = createLdapIdentityDirectory(state.config);
		await expect(directory.current("stable-a")).rejects.toThrow(
			LdapIdentityUnavailableError,
		);
		await expect(
			directory.authenticate("login-a", "correct-password"),
		).rejects.toThrow(LdapIdentityUnavailableError);
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
