import {
	pageSkillHubVersionsV1,
	projectSkillHubVersionMetadataV1,
	SkillHubOperationErrorV1,
} from "@agent-infra/platform-core";
import { PostgresSkillHubLifecycleV1 } from "@agent-infra/platform-store";
import { createDeploymentIdentityScope } from "./deployment-identity.js";
import type { IdentityAdapter } from "./http/identity.js";
import type { SkillHubInstallationRoutesDependenciesV1 } from "./http/skill-hub-installation-routes.js";
import type { SkillHubReadRoutesDependenciesV1 } from "./http/skill-hub-read-routes.js";

export function assembleSkillHubReadApiV1(input: {
	readonly databaseUrl: string;
	readonly identity: IdentityAdapter;
}) {
	const scope = createDeploymentIdentityScope(input.identity);
	const store = new PostgresSkillHubLifecycleV1({
		databaseUrl: input.databaseUrl,
		async resolveIdentity(userId) {
			// Resolve the original authenticated request at both transaction fences.
			const identity = await scope.currentIdentity("skill-hub-read");
			if (identity.userId !== userId)
				throw new SkillHubOperationErrorV1("forbidden");
			return {
				actor: {
					schemaVersion: 1,
					userId: identity.userId,
					accountStatus: identity.accountStatus,
					organizationIds: identity.organizationIds,
					isAdministrator: identity.roles.includes("system_admin"),
				},
				authorizationRevision: identity.authorizationRevision,
			};
		},
	});
	const dependencies: SkillHubReadRoutesDependenciesV1 = {
		identity: input.identity,
		list: (request, trusted, query) =>
			scope.requestScope(request, async () =>
				pageSkillHubVersionsV1(await store.listVisibleVersions(trusted), query),
			),
		read: (request, trusted, versionId) =>
			scope.requestScope(request, async () =>
				projectSkillHubVersionMetadataV1(
					await store.readVisibleVersion(trusted, versionId),
				),
			),
		recordRefusal: (metadata, userId, reason) =>
			store.recordReadRefusal(metadata, userId, reason),
	};
	const installationDependencies: SkillHubInstallationRoutesDependenciesV1 = {
		identity: input.identity,
		install: (request, trusted, key, command) =>
			scope.requestScope(request, async () =>
				store.installVersion(trusted, key, command),
			),
		uninstall: (request, trusted, installationId, key) =>
			scope.requestScope(request, async () =>
				store.uninstallInstallation(trusted, installationId, key),
			),
	};
	return {
		dependencies,
		installationDependencies,
		close: () => store.close(),
	};
}
