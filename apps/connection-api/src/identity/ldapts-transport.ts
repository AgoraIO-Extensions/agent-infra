import type { ConnectionOptions } from "node:tls";
import { Client } from "ldapts";
import type { LdapEntry, LdapProfile, LdapTransport } from "./ldap.js";
import { LdapAuthenticator, LdapUnavailableError } from "./ldap.js";

function ldapEntry(entry: { dn: string; [name: string]: unknown }): LdapEntry {
	const attributes: Record<string, string | readonly string[]> = {};
	for (const [name, value] of Object.entries(entry)) {
		if (name === "dn") continue;
		if (
			typeof value === "string" ||
			(Array.isArray(value) && value.every((part) => typeof part === "string"))
		)
			attributes[name.toLowerCase()] = value;
		else throw new LdapUnavailableError();
	}
	return { dn: entry.dn, attributes };
}

class LdaptsTransport implements LdapTransport {
	private secured = false;

	constructor(
		private readonly client: Client,
		private readonly timeoutMs: number,
		private readonly startTlsOptions?: ConnectionOptions,
	) {}

	private async operation<T>(
		signal: AbortSignal,
		work: () => Promise<T>,
	): Promise<T> {
		signal.throwIfAborted();
		const abort = () => {
			void this.client.unbind().catch(() => {});
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			if (this.startTlsOptions && !this.secured) {
				await this.client.startTLS(this.startTlsOptions);
				this.secured = true;
			}
			return await work();
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}

	bind({ dn, password, signal }: Parameters<LdapTransport["bind"]>[0]) {
		return this.operation(signal, () => this.client.bind(dn, password));
	}

	search({
		baseDn,
		filter,
		attributes,
		signal,
	}: Parameters<LdapTransport["search"]>[0]) {
		return this.operation(signal, async () => {
			const result = await this.client.search(baseDn, {
				filter,
				attributes: [...attributes],
				scope: "sub",
				sizeLimit: 2,
				timeLimit: Math.max(1, Math.ceil(this.timeoutMs / 1_000)),
			});
			if (result.searchReferences.length > 0) throw new LdapUnavailableError();
			return result.searchEntries.map(ldapEntry);
		});
	}

	close() {
		return this.client.unbind();
	}
}

/** One short-lived TLS client per authentication or directory recheck. */
export function createLdaptsAuthenticator(
	profile: LdapProfile,
	caPem?: string,
): LdapAuthenticator {
	return new LdapAuthenticator(profile, () => {
		const timeoutMs = profile.timeoutMs ?? 5_000;
		const tlsOptions: ConnectionOptions = {
			ca: caPem,
			minVersion: "TLSv1.2",
			rejectUnauthorized: true,
			servername: new URL(profile.url).hostname,
		};
		const protocol = new URL(profile.url).protocol;
		return new LdaptsTransport(
			new Client({
				url: profile.url,
				timeout: timeoutMs,
				connectTimeout: timeoutMs,
				autoRebind: false,
				tlsOptions,
			}),
			timeoutMs,
			protocol === "ldap:" &&
				profile.transportSecurity !== "la3-private-plaintext"
				? tlsOptions
				: undefined,
		);
	});
}
