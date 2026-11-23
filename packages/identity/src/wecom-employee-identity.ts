import {
	createDirectoryOrganizationResolverV1,
	type DirectoryOrganizationResolverOptionsV1,
	requireCurrentSnapshot,
	resolveActiveMemberByEmail,
} from "@agent-infra/enterprise-directory";
import type {
	WecomIdentityPortV1,
	WecomScopeV1,
} from "@agent-infra/platform-core";
import {
	directoryEmployeeKey,
	resolveDirectoryEmployeeAccount,
} from "./directory-employee-account.js";
import { resolveLdapPrincipal } from "./ldap-principal.js";

export interface WecomEmployeeConfiguration
	extends DirectoryOrganizationResolverOptionsV1 {
	/** Deployment authenticates the scoped WeCom sender and converts it to a member of this source. */
	verifiedWecomMember(
		scope: WecomScopeV1,
	): Promise<{ source: string; userId: string } | null>;
	administratorUserIds?: readonly string[];
}

export function createWecomEmployeeIdentity(
	config: WecomEmployeeConfiguration,
	store: {
		findByUserId(id: string): Promise<{
			employeeId: string;
			issuer: string | null;
			subject: string | null;
		} | null>;
		resolveDirectoryEmployee(employee: {
			employeeId: string;
			email: string;
		}): Promise<{ userId: string }>;
	},
	isPlatformDisabled: (userId: string) => Promise<boolean>,
) {
	if (typeof config?.verifiedWecomMember !== "function")
		throw new Error("WECOM_EMPLOYEE_SOURCE_INVALID");
	const admins = new Set(config.administratorUserIds);
	const now = config.now ?? Date.now;
	const snapshot = async () =>
		requireCurrentSnapshot(await config.snapshot.loadCurrent(now()), now());
	// Resolve the directory member and their organizations from the same publication.
	async function resolveUser(
		userId: string,
		current?: Awaited<ReturnType<typeof snapshot>>,
	) {
		const record = await store.findByUserId(userId);
		if (!record) return null;
		const publication = current ?? (await snapshot());
		const account = resolveDirectoryEmployeeAccount({
			userId,
			uid: userId,
			record,
			snapshot: publication,
			isAdministrator: admins.has(userId),
		});
		if (!account) return null;
		const organizations = createDirectoryOrganizationResolverV1({
			...config,
			snapshot: { loadCurrent: async () => publication },
		});
		const principal = await resolveLdapPrincipal(account, {
			isPlatformDisabled,
			organizationAuthority: () => organizations.resolve(account),
			organizationIds: async () =>
				(await organizations.resolve(account)).organizationIds,
		});
		return {
			schemaVersion: principal.schemaVersion,
			userId,
			accountStatus: principal.accountStatus,
			organizationIds: principal.organizationIds,
			authorizationRevision: principal.authorizationRevision,
			...(principal.directorySnapshotBinding
				? { directorySnapshotBinding: principal.directorySnapshotBinding }
				: {}),
		};
	}
	const identity: WecomIdentityPortV1 = {
		async resolveSender(scope) {
			if (scope.kind !== "wecom_bot") return null;
			const verified = await config.verifiedWecomMember(scope);
			if (!verified) return null;
			const current = await snapshot();
			if (current.source !== verified.source) return null;
			const member = current.members.find((m) => m.userId === verified.userId);
			if (
				!member?.active ||
				resolveActiveMemberByEmail(current, member.email, now())?.userId !==
					member.userId
			)
				return null;
			const account = await store.resolveDirectoryEmployee({
				employeeId: directoryEmployeeKey(current.source, member.userId),
				email: member.email,
			});
			return resolveUser(account.userId, current);
		},
		async activeUsers(ids) {
			const active = [];
			for (const id of new Set(ids))
				if ((await resolveUser(id))?.accountStatus === "active")
					active.push(id);
			return active;
		},
	};
	return {
		identity,
		directory: { resolveUser: (id: string) => resolveUser(id) },
	};
}
