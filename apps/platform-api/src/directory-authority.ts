import {
	createDirectoryClient,
	createDirectoryOrganizationResolverV1,
	type DirectoryDepartment,
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
	const client = createDirectoryClient(input);
	const resolver = createDirectoryOrganizationResolverV1({
		snapshot: client,
		organizationIdForDepartment: input.organizationIdForDepartment,
	});
	return async (account) =>
		(await resolver.resolve({ email: account.email })).organizationIds;
}
