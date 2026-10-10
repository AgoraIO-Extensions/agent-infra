import {
	createDirectoryClient,
	createDirectoryOrganizationResolverV1,
	type DirectoryDepartment,
	type DirectoryOrganizationAuthorityV1,
} from "@agent-infra/enterprise-directory";
import type { LdapAccount } from "@agent-infra/identity";

export interface DirectorySnapshotDeploymentInputV1 {
	readonly endpoint: string;
	readonly token: string;
	readonly fetch?: typeof fetch;
	readonly organizationIdForDepartment: (
		department: DirectoryDepartment,
	) => string | null;
}

/** Deployment-owned Platform consumer for current directory organization facts. */
export function createDirectoryOrganizationIdsResolverV1(
	input: DirectorySnapshotDeploymentInputV1,
): (account: LdapAccount) => Promise<readonly string[]> {
	const resolveAuthority =
		createDirectoryOrganizationAuthorityResolverV1(input);
	return async (account) => (await resolveAuthority(account)).organizationIds;
}

/** Full sidecar for consumers that can carry snapshot binding metadata. */
export function createDirectoryOrganizationAuthorityResolverV1(
	input: DirectorySnapshotDeploymentInputV1,
): (account: LdapAccount) => Promise<DirectoryOrganizationAuthorityV1> {
	const client = createDirectoryClient(input);
	const resolver = createDirectoryOrganizationResolverV1({
		snapshot: client,
		organizationIdForDepartment: input.organizationIdForDepartment,
	});
	return async (account) => resolver.resolve({ email: account.email });
}
