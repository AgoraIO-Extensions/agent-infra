import type {
	DirectoryAuthenticator,
	DirectoryIdentity,
} from "@agent-infra/connection-core";
import { Client, type Entry } from "ldapts";

export type LdapDirectoryOptions = {
	activeAttribute?: string;
	activeValue?: string;
	connectTimeoutMs?: number;
	displayNameAttribute: string;
	emailAttribute: string;
	issuer: string;
	operationTimeoutMs?: number;
	serviceBindDn: string;
	serviceBindPassword: string;
	uidAttribute: string;
	url: string;
	usernameAttribute: string;
	usersBaseDn: string;
};

const attributePattern = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const defaultConnectTimeoutMs = 5_000;
const defaultOperationTimeoutMs = 8_000;
const maximumTimeoutMs = 30_000;
const cleanupTimeoutMs = 250;

export class DirectoryAuthenticationError extends Error {
	constructor() {
		super("Directory authentication failed");
	}
}

export function escapeLdapFilterValue(value: string) {
	let escaped = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (character === "*") escaped += "\\2a";
		else if (character === "(") escaped += "\\28";
		else if (character === ")") escaped += "\\29";
		else if (character === "\\") escaped += "\\5c";
		else if (codePoint === 0) escaped += "\\00";
		else escaped += character;
	}
	return escaped;
}

function requireAttribute(value: string, name: string) {
	if (!attributePattern.test(value)) {
		throw new Error(`${name} must be a valid LDAP attribute name`);
	}
	return value;
}

function boundedTimeout(
	value: number | undefined,
	fallback: number,
	name: string,
) {
	const timeout = value ?? fallback;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > maximumTimeoutMs) {
		throw new Error(`${name} must be between 1 and ${maximumTimeoutMs}`);
	}
	return timeout;
}

function requiredString(value: string, name: string) {
	if (!value.trim()) throw new Error(`${name} is required`);
	return value;
}

function remainingMilliseconds(deadline: number) {
	const remaining = deadline - Date.now();
	if (remaining < 1) throw new DirectoryAuthenticationError();
	return remaining;
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number) {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new DirectoryAuthenticationError()),
					remainingMilliseconds(deadline),
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function singleAttribute(entry: Entry, attribute: string) {
	const value = entry[attribute];
	if (typeof value === "string") return value.trim() || undefined;
	if (Buffer.isBuffer(value)) return value.toString("utf8").trim() || undefined;
	if (Array.isArray(value) && value.length === 1) {
		const item = value[0];
		if (typeof item === "string") return item.trim() || undefined;
		if (Buffer.isBuffer(item)) return item.toString("utf8").trim() || undefined;
	}
	return undefined;
}

export class LdapDirectoryAuthenticator implements DirectoryAuthenticator {
	private readonly options: Required<
		Pick<LdapDirectoryOptions, "connectTimeoutMs" | "operationTimeoutMs">
	> &
		LdapDirectoryOptions;

	constructor(options: LdapDirectoryOptions) {
		const { activeAttribute, activeValue, ...baseOptions } = options;
		if ((activeAttribute === undefined) !== (activeValue === undefined)) {
			throw new Error(
				"LDAP active attribute and value must be configured together",
			);
		}
		let url: URL;
		try {
			url = new URL(options.url);
		} catch {
			throw new Error("LDAP URL must be an absolute ldap:// or ldaps:// URL");
		}
		if (
			(url.protocol !== "ldap:" && url.protocol !== "ldaps:") ||
			url.username ||
			url.password
		) {
			throw new Error(
				"LDAP URL must be an absolute ldap:// or ldaps:// URL without credentials",
			);
		}
		this.options = {
			...baseOptions,
			...(activeAttribute !== undefined && activeValue !== undefined
				? {
						activeAttribute: requireAttribute(
							activeAttribute,
							"LDAP active attribute",
						),
						activeValue: requiredString(activeValue, "LDAP active value"),
					}
				: {}),
			connectTimeoutMs: boundedTimeout(
				options.connectTimeoutMs,
				defaultConnectTimeoutMs,
				"LDAP connect timeout",
			),
			displayNameAttribute: requireAttribute(
				options.displayNameAttribute,
				"LDAP display name attribute",
			),
			emailAttribute: requireAttribute(
				options.emailAttribute,
				"LDAP email attribute",
			),
			issuer: requiredString(options.issuer, "LDAP issuer"),
			operationTimeoutMs: boundedTimeout(
				options.operationTimeoutMs,
				defaultOperationTimeoutMs,
				"LDAP operation timeout",
			),
			serviceBindDn: requiredString(
				options.serviceBindDn,
				"LDAP service bind DN",
			),
			serviceBindPassword: requiredString(
				options.serviceBindPassword,
				"LDAP service bind password",
			),
			uidAttribute: requireAttribute(
				options.uidAttribute,
				"LDAP uid attribute",
			),
			url: url.toString(),
			usernameAttribute: requireAttribute(
				options.usernameAttribute,
				"LDAP username attribute",
			),
			usersBaseDn: requiredString(options.usersBaseDn, "LDAP users base DN"),
		};
	}

	async authenticate(
		username: string,
		password: string,
	): Promise<DirectoryIdentity> {
		if (!username || !password) throw new DirectoryAuthenticationError();
		try {
			const deadline = Date.now() + this.options.operationTimeoutMs;
			const entry = await this.findSingleEntry(
				this.accountFilter(this.options.usernameAttribute, username),
				deadline,
			);
			const subject = singleAttribute(entry, this.options.uidAttribute);
			const displayName = singleAttribute(
				entry,
				this.options.displayNameAttribute,
			);
			if (!subject || !displayName || !entry.dn) {
				throw new DirectoryAuthenticationError();
			}
			await this.verifyUserPassword(entry.dn, password, deadline);
			return {
				displayName,
				email: singleAttribute(entry, this.options.emailAttribute) ?? null,
				issuer: this.options.issuer,
				subject,
			};
		} catch {
			throw new DirectoryAuthenticationError();
		}
	}

	async isActive(identity: { issuer: string; subject: string }) {
		if (identity.issuer !== this.options.issuer || !identity.subject)
			return false;
		const entries = await this.searchEntries(
			this.accountFilter(this.options.uidAttribute, identity.subject),
			Date.now() + this.options.operationTimeoutMs,
		);
		return entries.length === 1;
	}

	private accountFilter(attribute: string, value: string) {
		const identityFilter = `(${attribute}=${escapeLdapFilterValue(value)})`;
		const { activeAttribute, activeValue } = this.options;
		return activeAttribute && activeValue
			? `(&${identityFilter}(${activeAttribute}=${escapeLdapFilterValue(activeValue)}))`
			: identityFilter;
	}

	private async createClient(deadline: number) {
		const remaining = remainingMilliseconds(deadline);
		return new Client({
			connectTimeout: Math.min(this.options.connectTimeoutMs, remaining),
			timeout: Math.min(this.options.operationTimeoutMs, remaining),
			url: this.options.url,
		});
	}

	private async findSingleEntry(filter: string, deadline: number) {
		const entries = await this.searchEntries(filter, deadline);
		if (entries.length !== 1) throw new DirectoryAuthenticationError();
		return entries[0] as Entry;
	}

	private async searchEntries(filter: string, deadline: number) {
		const client = await this.createClient(deadline);
		try {
			await beforeDeadline(
				client.bind(
					this.options.serviceBindDn,
					this.options.serviceBindPassword,
				),
				deadline,
			);
			const searchTimeoutMs = remainingMilliseconds(deadline);
			const result = await beforeDeadline(
				client.search(this.options.usersBaseDn, {
					attributes: [
						this.options.uidAttribute,
						this.options.emailAttribute,
						this.options.displayNameAttribute,
						...(this.options.activeAttribute
							? [this.options.activeAttribute]
							: []),
					],
					derefAliases: "never",
					filter,
					paged: false,
					scope: "sub",
					sizeLimit: 2,
					timeLimit: Math.ceil(searchTimeoutMs / 1_000),
				}),
				deadline,
			);
			return result.searchEntries;
		} finally {
			const cleanup = client.unbind().catch(() => undefined);
			const cleanupDeadline = Math.min(deadline, Date.now() + cleanupTimeoutMs);
			await beforeDeadline(cleanup, cleanupDeadline).catch(() => undefined);
		}
	}

	private async verifyUserPassword(
		dn: string,
		password: string,
		deadline: number,
	) {
		const client = await this.createClient(deadline);
		try {
			await beforeDeadline(client.bind(dn, password), deadline);
		} finally {
			const cleanup = client.unbind().catch(() => undefined);
			const cleanupDeadline = Math.min(deadline, Date.now() + cleanupTimeoutMs);
			await beforeDeadline(cleanup, cleanupDeadline).catch(() => undefined);
		}
	}
}
