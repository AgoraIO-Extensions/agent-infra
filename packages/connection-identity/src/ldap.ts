import { clearTimeout, setTimeout as scheduleTimeout } from "node:timers";

export interface LdapEntry {
	dn: string;
	attributes: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export interface LdapTransport {
	bind(input: {
		dn: string;
		password: string;
		signal: AbortSignal;
	}): Promise<void>;
	search(input: {
		baseDn: string;
		filter: string;
		attributes: readonly string[];
		signal: AbortSignal;
	}): Promise<readonly LdapEntry[]>;
}

export interface LdapProfile {
	issuer: string;
	url: string;
	baseDn: string;
	serviceDn: string;
	servicePassword: string;
	userFilterAttribute?: string;
	userDnAttribute?: string;
	timeoutMs?: number;
	/** Explicitly scoped LA3 private pilot exception; never a fallback. */
	allowInsecurePrivatePilot?: boolean;
	environmentName?: string;
}

export interface LdapPrincipal {
	issuer: string;
	uid: string;
	dn: string;
	attributes: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export class LdapAuthenticationError extends Error {
	constructor(message = "LDAP authentication failed") {
		super(message);
		this.name = "LdapAuthenticationError";
	}
}

export class LdapUnavailableError extends Error {
	constructor() {
		super("LDAP directory unavailable");
		this.name = "LdapUnavailableError";
	}
}

/** RFC 4515 escaping for a filter value. */
export function escapeLdapFilterValue(value: string): string {
	return [...value]
		.map((character) => {
			switch (character) {
				case "\\":
					return "\\5c";
				case "*":
					return "\\2a";
				case "(":
					return "\\28";
				case ")":
					return "\\29";
				case "\u0000":
					return "\\00";
				default:
					return character;
			}
		})
		.join("");
}

/** RFC 4514 escaping for a DN attribute value. */
export function escapeLdapDnValue(value: string): string {
	let escaped = value.replace(/[\\,#+<>;"=]/g, "\\$&");
	if (escaped.startsWith(" ")) escaped = `\\${escaped}`;
	if (escaped.endsWith(" ")) escaped = `${escaped.slice(0, -1)}\\ `;
	if (escaped.startsWith("#")) escaped = `\\${escaped}`;
	return escaped.replaceAll("\u0000", "\\00");
}

function singleAttribute(
	entry: LdapEntry,
	attribute: string,
): string | undefined {
	const value = entry.attributes[attribute];
	if (typeof value === "string") return value.trim() || undefined;
	if (
		Array.isArray(value) &&
		value.length === 1 &&
		typeof value[0] === "string"
	)
		return value[0].trim() || undefined;
	return undefined;
}

function validateProfile(
	profile: LdapProfile,
): Required<
	Pick<LdapProfile, "userFilterAttribute" | "userDnAttribute" | "timeoutMs">
> {
	if (
		!profile.issuer.trim() ||
		!profile.baseDn.trim() ||
		!profile.serviceDn.trim()
	)
		throw new Error("LDAP profile is incomplete");
	if (!profile.servicePassword)
		throw new Error("LDAP service bind is required");
	let url: URL;
	try {
		url = new URL(profile.url);
	} catch {
		throw new Error("LDAP URL is invalid");
	}
	if (
		url.protocol !== "ldaps:" &&
		!(url.protocol === "ldap:" && profile.allowInsecurePrivatePilot === true)
	)
		throw new Error("LDAP TLS is required");
	if (url.protocol === "ldap:" && !profile.environmentName?.trim())
		throw new Error("insecure LDAP requires a named environment");
	const timeoutMs = profile.timeoutMs ?? 5_000;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000)
		throw new Error("LDAP timeout is out of range");
	const userFilterAttribute = profile.userFilterAttribute ?? "uid";
	const userDnAttribute = profile.userDnAttribute ?? "uid";
	if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(userFilterAttribute))
		throw new Error("LDAP filter attribute is invalid");
	if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(userDnAttribute))
		throw new Error("LDAP DN attribute is invalid");
	return { userFilterAttribute, userDnAttribute, timeoutMs };
}

async function withDeadline<T>(
	timeoutMs: number,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timeout = scheduleTimeout(() => controller.abort(), timeoutMs);
	try {
		return await work(controller.signal);
	} catch (error) {
		if (controller.signal.aborted) throw new LdapUnavailableError();
		throw error;
	} finally {
		controller.abort();
		clearTimeout(timeout);
	}
}

export class LdapAuthenticator {
	readonly profile: Readonly<LdapProfile>;
	private readonly options: Required<
		Pick<LdapProfile, "userFilterAttribute" | "userDnAttribute" | "timeoutMs">
	>;

	constructor(
		profile: LdapProfile,
		private readonly transport: LdapTransport,
	) {
		this.options = validateProfile(profile);
		this.profile = Object.freeze({ ...profile });
	}

	async authenticate(
		username: string,
		password: string,
	): Promise<LdapPrincipal> {
		if (!username.trim() || !password) throw new LdapAuthenticationError();
		try {
			return await withDeadline(this.options.timeoutMs, async (signal) => {
				await this.transport.bind({
					dn: this.profile.serviceDn,
					password: this.profile.servicePassword,
					signal,
				});
				const entries = await this.transport.search({
					baseDn: this.profile.baseDn,
					filter: `(&(${this.options.userFilterAttribute}=${escapeLdapFilterValue(username)}))`,
					attributes: [
						this.options.userDnAttribute,
						"uid",
						"displayName",
						"mail",
					],
					signal,
				});
				if (entries.length !== 1) throw new LdapAuthenticationError();
				const entry = entries[0];
				if (!entry) throw new LdapAuthenticationError();
				const uid = singleAttribute(entry, "uid");
				const userDn = entry.dn.trim();
				if (!uid || !userDn) throw new LdapAuthenticationError();
				await this.transport.bind({ dn: userDn, password, signal });
				return {
					issuer: this.profile.issuer,
					uid,
					dn: userDn,
					attributes: entry.attributes,
				};
			});
		} catch (error) {
			if (error instanceof LdapAuthenticationError) throw error;
			if (error instanceof LdapUnavailableError) throw error;
			throw new LdapAuthenticationError();
		}
	}

	/** Verify only directory entry existence; this does not assert employment status. */
	async entryExists(uid: string): Promise<boolean> {
		if (!uid.trim()) throw new LdapAuthenticationError();
		try {
			return await withDeadline(this.options.timeoutMs, async (signal) => {
				await this.transport.bind({
					dn: this.profile.serviceDn,
					password: this.profile.servicePassword,
					signal,
				});
				const entries = await this.transport.search({
					baseDn: this.profile.baseDn,
					filter: `(&(${this.options.userFilterAttribute}=${escapeLdapFilterValue(uid)}))`,
					attributes: ["uid"],
					signal,
				});
				if (entries.length > 1) throw new LdapAuthenticationError();
				return (
					entries.length === 1 &&
					Boolean(entries[0] && singleAttribute(entries[0], "uid"))
				);
			});
		} catch (error) {
			if (error instanceof LdapAuthenticationError) throw error;
			if (error instanceof LdapUnavailableError) throw error;
			throw new LdapUnavailableError();
		}
	}
}

export interface DirectoryEntryCheck {
	exists: boolean;
	checkedAt: number;
}

export class PrincipalDirectoryCache {
	private readonly values = new Map<string, DirectoryEntryCheck>();
	private readonly pending = new Map<string, Promise<DirectoryEntryCheck>>();

	constructor(
		private readonly authenticateDirectory: Pick<
			LdapAuthenticator,
			"entryExists"
		>,
		private readonly now: () => number = Date.now,
		private readonly ttlMs = 15 * 60 * 1000,
	) {
		if (!Number.isInteger(ttlMs) || ttlMs <= 0)
			throw new Error("invalid LDAP cache TTL");
	}

	async check(issuer: string, uid: string): Promise<DirectoryEntryCheck> {
		const key = `${issuer}\u0000${uid}`;
		const current = this.values.get(key);
		const now = this.now();
		if (current && now - current.checkedAt < this.ttlMs) return current;
		const existing = this.pending.get(key);
		if (existing) return existing;
		const pending = this.authenticateDirectory
			.entryExists(uid)
			.then((exists) => {
				const result = { exists, checkedAt: this.now() };
				this.values.set(key, result);
				return result;
			});
		this.pending.set(key, pending);
		try {
			return await pending;
		} finally {
			if (this.pending.get(key) === pending) this.pending.delete(key);
		}
	}
}
