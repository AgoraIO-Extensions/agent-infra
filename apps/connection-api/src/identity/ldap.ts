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
	close(): Promise<void>;
}

export interface LdapProfile {
	issuer: string;
	url: string;
	baseDn: string;
	serviceDn: string;
	servicePassword: string;
	userFilterAttribute?: string;
	timeoutMs?: number;
	transportSecurity?: "tls" | "la3-pilot-plaintext";
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
): Required<Pick<LdapProfile, "userFilterAttribute" | "timeoutMs">> {
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
		(url.protocol !== "ldaps:" && url.protocol !== "ldap:") ||
		!url.hostname ||
		url.username ||
		url.password ||
		(url.pathname !== "" && url.pathname !== "/") ||
		url.search ||
		url.hash
	)
		throw new Error("LDAP TLS is required");
	if (profile.transportSecurity === "la3-pilot-plaintext") {
		if (url.protocol !== "ldap:" || (url.port && url.port !== "389"))
			throw new Error("LA3 plaintext LDAP requires the standard LDAP endpoint");
	} else if (profile.transportSecurity && profile.transportSecurity !== "tls") {
		throw new Error("LDAP transport security mode is invalid");
	}
	const timeoutMs = profile.timeoutMs ?? 5_000;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000)
		throw new Error("LDAP timeout is out of range");
	const userFilterAttribute = profile.userFilterAttribute ?? "uid";
	if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(userFilterAttribute))
		throw new Error("LDAP filter attribute is invalid");
	return { userFilterAttribute, timeoutMs };
}

async function withDeadline<T>(
	timeoutMs: number,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timeout = scheduleTimeout(() => controller.abort(), timeoutMs);
	try {
		return await Promise.race([
			work(controller.signal),
			new Promise<never>((_resolve, reject) =>
				controller.signal.addEventListener(
					"abort",
					() => reject(new LdapUnavailableError()),
					{ once: true },
				),
			),
		]);
	} catch (error) {
		if (controller.signal.aborted) throw new LdapUnavailableError();
		throw error;
	} finally {
		controller.abort();
		clearTimeout(timeout);
	}
}

export class LdapAuthenticator {
	readonly #profile: Readonly<LdapProfile>;
	private readonly options: Required<
		Pick<LdapProfile, "userFilterAttribute" | "timeoutMs">
	>;

	constructor(
		profile: LdapProfile,
		private readonly transportFactory: () => LdapTransport,
	) {
		this.options = validateProfile(profile);
		this.#profile = Object.freeze({ ...profile });
	}

	private withServiceConnection<T>(
		work: (transport: LdapTransport, signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		return withDeadline(this.options.timeoutMs, async (signal) => {
			let transport: LdapTransport;
			try {
				transport = this.transportFactory();
			} catch {
				throw new LdapUnavailableError();
			}
			try {
				try {
					await transport.bind({
						dn: this.#profile.serviceDn,
						password: this.#profile.servicePassword,
						signal,
					});
				} catch {
					throw new LdapUnavailableError();
				}
				return await work(transport, signal);
			} finally {
				await transport.close().catch(() => {});
			}
		});
	}

	async authenticate(
		username: string,
		password: string,
	): Promise<LdapPrincipal> {
		if (!username.trim() || !password) throw new LdapAuthenticationError();
		try {
			return await this.withServiceConnection(async (transport, signal) => {
				let entries: readonly LdapEntry[];
				try {
					entries = await transport.search({
						baseDn: this.#profile.baseDn,
						filter: `(${this.options.userFilterAttribute}=${escapeLdapFilterValue(username)})`,
						attributes: ["uid", "displayName", "mail", "cn"],
						signal,
					});
				} catch {
					throw new LdapUnavailableError();
				}
				if (entries.length !== 1) throw new LdapAuthenticationError();
				const entry = entries[0];
				if (!entry) throw new LdapAuthenticationError();
				const uid = singleAttribute(entry, "uid");
				const userDn = entry.dn.trim();
				if (!uid || !userDn) throw new LdapAuthenticationError();
				try {
					await transport.bind({ dn: userDn, password, signal });
				} catch {
					throw new LdapAuthenticationError();
				}
				return {
					issuer: this.#profile.issuer,
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
			return await this.withServiceConnection(async (transport, signal) => {
				const entries = await transport.search({
					baseDn: this.#profile.baseDn,
					filter: `(uid=${escapeLdapFilterValue(uid)})`,
					attributes: ["uid"],
					signal,
				});
				if (entries.length > 1) throw new LdapAuthenticationError();
				const entry = entries[0];
				return entry !== undefined && singleAttribute(entry, "uid") === uid;
			});
		} catch (error) {
			if (error instanceof LdapAuthenticationError) throw error;
			if (error instanceof LdapUnavailableError) throw error;
			throw new LdapUnavailableError();
		}
	}
}
