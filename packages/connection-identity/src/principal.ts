import { createHash } from "node:crypto";
import type { LdapPrincipal } from "./ldap.js";
import type { BrowserSessionPrincipal } from "./session.js";

export interface PrincipalIdentityStore {
	findByIssuerUid(input: {
		issuer: string;
		uid: string;
	}): Promise<BrowserSessionPrincipal | undefined>;
	insert(input: BrowserSessionPrincipal): Promise<void>;
}

/** Stable opaque identifier; display attributes never participate in the key. */
export function stablePrincipalId(issuer: string, uid: string): string {
	if (!issuer.trim() || !uid.trim())
		throw new Error("principal identity is incomplete");
	return `principal_${createHash("sha256")
		.update(`${issuer}\u0000${uid}`, "utf8")
		.digest("hex")}`;
}

export class PrincipalIdentityResolver {
	constructor(private readonly store: PrincipalIdentityStore) {}

	async resolve(input: LdapPrincipal): Promise<BrowserSessionPrincipal> {
		if (!input.issuer.trim() || !input.uid.trim() || !input.dn.trim())
			throw new Error("LDAP principal identity is invalid");
		const existing = await this.store.findByIssuerUid({
			issuer: input.issuer,
			uid: input.uid,
		});
		if (existing) return existing;
		const created: BrowserSessionPrincipal = {
			id: stablePrincipalId(input.issuer, input.uid),
			issuer: input.issuer,
			uid: input.uid,
			status: "active",
			recoveryGeneration: 1,
		};
		await this.store.insert(created);
		const stored = await this.store.findByIssuerUid({
			issuer: input.issuer,
			uid: input.uid,
		});
		if (!stored) throw new Error("LDAP principal could not be stored");
		return stored;
	}
}
