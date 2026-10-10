import { createHash } from "node:crypto";
import {
	type DirectorySnapshotBindingV1,
	parseDirectorySnapshotBindingV1,
} from "@agent-infra/platform-core";
import type { LdapAccount } from "./ldap.js";

export interface LdapPrincipalAuthorities {
	/** A current, fail-closed Platform DB read keyed by the opaque user ID. */
	readonly isPlatformDisabled: (userId: string) => Promise<boolean>;
	/** A complete, current #889 directory mapping for this LDAP account. */
	readonly organizationIds: (
		account: LdapAccount,
	) => Promise<readonly string[]>;
	/** Optional current directory authority; its binding stays opaque to callers. */
	readonly organizationAuthority?: (account: LdapAccount) => Promise<{
		readonly organizationIds: readonly string[];
		readonly binding: DirectorySnapshotBindingV1;
	}>;
}

export async function resolveLdapPrincipal(
	account: LdapAccount,
	authorities: LdapPrincipalAuthorities,
) {
	const disabled = await authorities.isPlatformDisabled(account.userId);
	if (typeof disabled !== "boolean")
		throw new Error("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
	const isDisabled = account.accountStatus === "disabled" || disabled;
	const organizationAuthority = authorities.organizationAuthority;
	const hasOrganizationAuthority =
		!isDisabled && organizationAuthority !== undefined;
	const authority =
		hasOrganizationAuthority && typeof organizationAuthority === "function"
			? await organizationAuthority(account)
			: null;
	if (
		hasOrganizationAuthority &&
		(!authority ||
			!Array.isArray(authority.organizationIds) ||
			!authority.binding)
	)
		throw new Error("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
	const organizationIds = isDisabled
		? []
		: authority
			? authority.organizationIds
			: await authorities.organizationIds(account);
	let directorySnapshotBinding: DirectorySnapshotBindingV1 | undefined;
	if (authority) {
		try {
			directorySnapshotBinding = parseDirectorySnapshotBindingV1(
				authority.binding,
			);
		} catch {
			throw new Error("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
		}
	}
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
		...(directorySnapshotBinding ? { directorySnapshotBinding } : {}),
	};
}
