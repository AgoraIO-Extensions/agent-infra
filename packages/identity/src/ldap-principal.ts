import { createHash } from "node:crypto";
import type { LdapAccount } from "./ldap.js";

export interface LdapPrincipalAuthorities {
	/** A current, fail-closed Platform DB read keyed by the opaque user ID. */
	readonly isPlatformDisabled: (userId: string) => Promise<boolean>;
	/** A complete, current #889 directory mapping for this LDAP account. */
	readonly organizationIds: (
		account: LdapAccount,
	) => Promise<readonly string[]>;
}

export async function resolveLdapPrincipal(
	account: LdapAccount,
	authorities: LdapPrincipalAuthorities,
) {
	const disabled = await authorities.isPlatformDisabled(account.userId);
	if (typeof disabled !== "boolean")
		throw new Error("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
	const isDisabled = account.accountStatus === "disabled" || disabled;
	const organizationIds = isDisabled
		? []
		: await authorities.organizationIds(account);
	if (
		!Array.isArray(organizationIds) ||
		organizationIds.some(
			(id) => typeof id !== "string" || !id || id.length > 1024,
		) ||
		new Set(organizationIds).size !== organizationIds.length
	)
		throw new Error("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
	return {
		schemaVersion: 1 as const,
		userId: account.userId,
		displayName: account.displayName,
		accountStatus: isDisabled ? ("disabled" as const) : ("active" as const),
		organizationIds,
		roles: account.roles,
		authorizationRevision: createHash("sha256")
			.update(
				JSON.stringify([
					account.authorizationRevision,
					disabled,
					organizationIds,
				]),
			)
			.digest("hex"),
	};
}
