import { createHash } from "node:crypto";
import {
	Client,
	type ClientOptions,
	EqualityFilter,
	InvalidCredentialsError,
} from "ldapts";

type LdapClient = Pick<Client, "bind" | "search" | "unbind">;
type LdapEntry = Awaited<
	ReturnType<LdapClient["search"]>
>["searchEntries"][number];
type AccountStatus = "active" | "disabled";

export interface LdapIdentityConfiguration {
	readonly url: string;
	readonly issuer: string;
	readonly baseDn: string;
	readonly serviceBindDn: string;
	readonly serviceBindPassword: string;
	readonly loginAttribute: string;
	readonly uidAttribute: string;
	readonly emailAttribute: string;
	readonly displayNameAttribute: string;
	readonly activeAttribute: string;
	/** Supplied only after the deployed directory's #388 active-state contract is verified. */
	readonly parseAccountStatus: (value: string) => AccountStatus | null;
	readonly administratorUids?: readonly string[];
	readonly ca?: string;
	readonly timeoutMs?: number;
	readonly createClient?: (options: ClientOptions) => LdapClient;
}

export interface LdapAccount {
	readonly uid: string;
	readonly userId: string;
	readonly email: string;
	readonly displayName: string;
	readonly accountStatus: AccountStatus;
	readonly roles: readonly ("employee" | "system_admin")[];
	readonly authorizationRevision: string;
}

export class LdapIdentityUnavailableError extends Error {
	constructor() {
		super("LDAP_IDENTITY_UNAVAILABLE");
	}
}

function requiredText(value: unknown, maximum = 1024): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		!value.isWellFormed()
	) {
		throw new LdapIdentityUnavailableError();
	}
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127) throw new LdapIdentityUnavailableError();
	}
	return value;
}

function attributeName(value: string): string {
	if (!/^[a-z][a-z0-9-]{0,63}$/iu.test(value)) {
		throw new LdapIdentityUnavailableError();
	}
	return value;
}

function attribute(entry: LdapEntry, key: string): string {
	const values = Object.entries(entry)
		.filter(([name]) => name.toLowerCase() === key.toLowerCase())
		.map(([, value]) => value);
	if (values.length !== 1) throw new LdapIdentityUnavailableError();
	const value = values[0];
	return requiredText(
		Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value,
	);
}

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A first-party LDAP adapter; deployment must provide the verified #388 status parser. */
export function createLdapIdentityDirectory(
	configuration: LdapIdentityConfiguration,
) {
	const config = { ...configuration };
	let host: string;
	let timeoutMs: number;
	let administratorUids: Set<string>;
	try {
		const url = new URL(config.url);
		if (
			url.protocol !== "ldaps:" ||
			!url.hostname ||
			url.pathname !== "" ||
			url.search ||
			url.hash ||
			url.username ||
			url.password
		) {
			throw new Error();
		}
		host = url.hostname;
		requiredText(config.issuer, 256);
		requiredText(config.baseDn, 1024);
		requiredText(config.serviceBindDn, 1024);
		requiredText(config.serviceBindPassword, 4096);
		for (const name of [
			config.loginAttribute,
			config.uidAttribute,
			config.emailAttribute,
			config.displayNameAttribute,
			config.activeAttribute,
		])
			attributeName(name);
		if (typeof config.parseAccountStatus !== "function") throw new Error();
		if (
			config.ca !== undefined &&
			(typeof config.ca !== "string" ||
				config.ca.length > 64 * 1024 ||
				!config.ca.includes("-----BEGIN CERTIFICATE-----"))
		)
			throw new Error();
		timeoutMs = config.timeoutMs ?? 5000;
		if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
			throw new Error();
		administratorUids = new Set(
			(config.administratorUids ?? []).map((uid) => requiredText(uid, 256)),
		);
		if (administratorUids.size !== (config.administratorUids ?? []).length)
			throw new Error();
	} catch {
		throw new LdapIdentityUnavailableError();
	}
	const issuerHash = hash(config.issuer);
	const clientOptions: ClientOptions = {
		url: config.url,
		timeout: timeoutMs,
		connectTimeout: timeoutMs,
		autoRebind: false,
		tlsOptions: {
			rejectUnauthorized: true,
			servername: host,
			...(config.ca ? { ca: config.ca } : {}),
		},
	};
	const createClient =
		config.createClient ?? ((options: ClientOptions) => new Client(options));
	const userId = (uid: string) =>
		`ldap_${issuerHash}_${Buffer.from(uid).toString("base64url")}`;

	function parseUserId(value: string): string {
		const prefix = `ldap_${issuerHash}_`;
		if (
			!value.startsWith(prefix) ||
			!/^[A-Za-z0-9_-]+$/u.test(value.slice(prefix.length))
		)
			throw new LdapIdentityUnavailableError();
		const uid = requiredText(
			Buffer.from(value.slice(prefix.length), "base64url").toString("utf8"),
			256,
		);
		if (userId(uid) !== value) throw new LdapIdentityUnavailableError();
		return uid;
	}

	async function find(
		attributeNameToSearch: string,
		value: string,
	): Promise<LdapEntry | null> {
		const client = createClient(clientOptions);
		try {
			await client.bind(config.serviceBindDn, config.serviceBindPassword);
			const result = await client.search(config.baseDn, {
				filter: new EqualityFilter({ attribute: attributeNameToSearch, value }),
				scope: "sub",
				derefAliases: "never",
				sizeLimit: 2,
				timeLimit: Math.ceil(timeoutMs / 1000),
				attributes: [
					config.uidAttribute,
					config.emailAttribute,
					config.displayNameAttribute,
					config.activeAttribute,
				],
			});
			if (result.searchReferences.length || result.searchEntries.length > 1)
				throw new LdapIdentityUnavailableError();
			return result.searchEntries[0] ?? null;
		} catch {
			throw new LdapIdentityUnavailableError();
		} finally {
			await client.unbind().catch(() => undefined);
		}
	}

	function account(entry: LdapEntry): LdapAccount {
		const uid = requiredText(attribute(entry, config.uidAttribute), 256);
		const email = attribute(entry, config.emailAttribute).trim().toLowerCase();
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email))
			throw new LdapIdentityUnavailableError();
		const displayName = attribute(entry, config.displayNameAttribute);
		const status = config.parseAccountStatus(
			attribute(entry, config.activeAttribute),
		);
		if (status !== "active" && status !== "disabled")
			throw new LdapIdentityUnavailableError();
		const roles = administratorUids.has(uid)
			? (["employee", "system_admin"] as const)
			: (["employee"] as const);
		return {
			uid,
			userId: userId(uid),
			email,
			displayName,
			accountStatus: status,
			roles,
			authorizationRevision: hash([config.issuer, uid, email, status, roles]),
		};
	}

	async function verifyUniqueEmail(value: LdapAccount): Promise<void> {
		const entry = await find(config.emailAttribute, value.email);
		if (
			!entry ||
			attribute(entry, config.uidAttribute) !== value.uid ||
			attribute(entry, config.emailAttribute).trim().toLowerCase() !==
				value.email
		) {
			throw new LdapIdentityUnavailableError();
		}
	}

	async function current(uid: string): Promise<LdapAccount | null> {
		try {
			requiredText(uid, 256);
			const entry = await find(config.uidAttribute, uid);
			if (!entry) return null;
			const parsed = account(entry);
			if (parsed.uid !== uid) throw new LdapIdentityUnavailableError();
			await verifyUniqueEmail(parsed);
			return parsed;
		} catch {
			throw new LdapIdentityUnavailableError();
		}
	}

	return {
		userIdForUid(uid: string) {
			return userId(requiredText(uid, 256));
		},
		current,
		async currentByUserId(id: string) {
			return current(parseUserId(id));
		},
		async authenticate(
			login: string,
			password: string,
		): Promise<LdapAccount | null> {
			try {
				requiredText(login, 256);
				requiredText(password, 4096);
				const entry = await find(config.loginAttribute, login);
				if (!entry) return null;
				const first = account(entry);
				if (first.accountStatus !== "active") return null;
				const client = createClient(clientOptions);
				try {
					await client.bind(requiredText(entry.dn), password);
				} catch (error) {
					if (error instanceof InvalidCredentialsError) return null;
					throw error;
				} finally {
					await client.unbind().catch(() => undefined);
				}
				const verified = await current(first.uid);
				return verified?.accountStatus === "active" &&
					verified.email === first.email
					? verified
					: null;
			} catch {
				throw new LdapIdentityUnavailableError();
			}
		},
	};
}
