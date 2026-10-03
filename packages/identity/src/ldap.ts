import { createHash, randomUUID } from "node:crypto";
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

/** #481 persists an atomic, one-to-one issuer/UID to random Platform ID mapping. */
export interface LdapIdentityIds {
	findByUid(issuer: string, uid: string): Promise<string | null>;
	findUidByUserId(issuer: string, userId: string): Promise<string | null>;
	getOrCreate(
		issuer: string,
		uid: string,
		/** Used only when this issuer/UID has no existing ID. */
		candidateUserId: string,
	): Promise<string>;
}

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
	/** Trusted, current account or session authority; null means unknown, never active. */
	readonly verifyCurrentStatus?: (identity: {
		readonly issuer: string;
		readonly uid: string;
	}) => Promise<AccountStatus | null>;
	readonly identityIds: LdapIdentityIds;
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

function opaqueUserId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
			value,
		)
	)
		throw new LdapIdentityUnavailableError();
	return value;
}

/** A first-party LDAP adapter; user bind authorizes login, current sessions need a separate verifier. */
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
		])
			attributeName(name);
		if (
			config.verifyCurrentStatus !== undefined &&
			typeof config.verifyCurrentStatus !== "function"
		)
			throw new Error();
		if (
			!config.identityIds ||
			["findByUid", "findUidByUserId", "getOrCreate"].some(
				(method) =>
					typeof config.identityIds[method as keyof LdapIdentityIds] !==
					"function",
			)
		)
			throw new Error();
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

	type Identity = Pick<LdapAccount, "uid" | "email" | "displayName" | "roles">;
	function identity(entry: LdapEntry): Identity {
		const uid = requiredText(attribute(entry, config.uidAttribute), 256);
		const email = attribute(entry, config.emailAttribute).trim().toLowerCase();
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email))
			throw new LdapIdentityUnavailableError();
		const displayName = attribute(entry, config.displayNameAttribute);
		const roles = administratorUids.has(uid)
			? (["employee", "system_admin"] as const)
			: (["employee"] as const);
		return { uid, email, displayName, roles };
	}

	function account(
		value: Identity,
		status: AccountStatus,
	): Omit<LdapAccount, "userId"> {
		return {
			...value,
			accountStatus: status,
			authorizationRevision: hash([
				config.issuer,
				value.uid,
				value.email,
				status,
				value.roles,
			]),
		};
	}

	async function verifyUniqueEmail(value: Identity): Promise<void> {
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

	async function resolveAccount(
		uid: string,
		status: AccountStatus,
		createIdentity = false,
		expectedEmail?: string,
	): Promise<LdapAccount | null> {
		try {
			requiredText(uid, 256);
			const entry = await find(config.uidAttribute, uid);
			if (!entry) return null;
			const parsed = identity(entry);
			if (parsed.uid !== uid) throw new LdapIdentityUnavailableError();
			await verifyUniqueEmail(parsed);
			if (createIdentity && parsed.email !== expectedEmail) return null;
			const storedId = createIdentity
				? await config.identityIds.getOrCreate(config.issuer, uid, randomUUID())
				: await config.identityIds.findByUid(config.issuer, uid);
			return storedId
				? { ...account(parsed, status), userId: opaqueUserId(storedId) }
				: null;
		} catch {
			throw new LdapIdentityUnavailableError();
		}
	}

	async function current(uid: string): Promise<LdapAccount | null> {
		try {
			requiredText(uid, 256);
			const verifier = config.verifyCurrentStatus;
			if (!verifier) throw new LdapIdentityUnavailableError();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new LdapIdentityUnavailableError()),
					timeoutMs,
				);
			});
			let status: AccountStatus | null;
			try {
				status = await Promise.race([
					verifier({ issuer: config.issuer, uid }),
					deadline,
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
			if (status !== "active" && status !== "disabled")
				throw new LdapIdentityUnavailableError();
			return await resolveAccount(uid, status);
		} catch {
			throw new LdapIdentityUnavailableError();
		}
	}

	return {
		async userIdForUid(uid: string) {
			try {
				const id = await config.identityIds.findByUid(
					config.issuer,
					requiredText(uid, 256),
				);
				return opaqueUserId(id);
			} catch {
				throw new LdapIdentityUnavailableError();
			}
		},
		current,
		async currentByUserId(id: string) {
			try {
				const uid = await config.identityIds.findUidByUserId(
					config.issuer,
					opaqueUserId(id),
				);
				if (!uid) return null;
				const found = await current(requiredText(uid, 256));
				if (found && found.userId !== id)
					throw new LdapIdentityUnavailableError();
				return found;
			} catch {
				throw new LdapIdentityUnavailableError();
			}
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
				const first = identity(entry);
				const firstDn = requiredText(entry.dn);
				const client = createClient(clientOptions);
				try {
					await client.bind(firstDn, password);
				} catch (error) {
					if (error instanceof InvalidCredentialsError) return null;
					throw error;
				} finally {
					await client.unbind().catch(() => undefined);
				}
				const rebound = await find(config.loginAttribute, login);
				if (
					!rebound ||
					requiredText(rebound.dn) !== firstDn ||
					identity(rebound).uid !== first.uid
				)
					return null;
				return await resolveAccount(first.uid, "active", true, first.email);
			} catch {
				throw new LdapIdentityUnavailableError();
			}
		},
	};
}
