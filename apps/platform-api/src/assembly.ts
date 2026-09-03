import {
	type AgentConfigurationUseCaseDependenciesV1,
	createAgentConfigurationUseCaseV1,
	createAgentManagementV1,
	createApplicationFoundationUseCaseV1,
	createApplicationRevisionUseCaseV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresAgentConfigurationTransactionV1,
	PostgresAgentManagementQueryV1,
	PostgresAgentManagementTransactionV1,
	PostgresApplicationFoundationTransactionV1,
	PostgresApplicationRevisionTransactionV1,
	PostgresPlatformAuditQueryV1,
} from "@agent-infra/platform-store";

import type { PlatformAppDependencies } from "./app.js";
import type { ConfigurationRoutesDependencies } from "./http/configuration-routes.js";
import type { IdentityAdapter } from "./http/identity.js";
import type { ManagementRouteDependencies } from "./http/management-routes.js";
import {
	createPlatformProjectionReaders,
	type PresentPlatformAgent,
} from "./projection.js";

type Admissions = Omit<AgentConfigurationUseCaseDependenciesV1, "transaction">;

export interface PlatformApiAssemblyInput {
	readonly databaseUrl: string;
	readonly identity: IdentityAdapter;
	readonly admissions: Admissions;
	readonly allocateApplicationIds: ManagementRouteDependencies["allocateApplicationIds"];
	readonly prepareApplicationSecrets: ManagementRouteDependencies["prepareSecretReplacements"];
	readonly prepareConfigurationSecrets: ConfigurationRoutesDependencies["prepareSecretReplacements"];
	readonly presentAgent: PresentPlatformAgent;
}

export interface PlatformApiAssembly {
	readonly dependencies: PlatformAppDependencies;
	close(): Promise<void>;
}

export function assemblePlatformApi(
	input: PlatformApiAssemblyInput,
): PlatformApiAssembly {
	const foundationTransaction = new PostgresApplicationFoundationTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const revisionTransaction = new PostgresApplicationRevisionTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const managementTransaction = new PostgresAgentManagementTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const managementQuery = new PostgresAgentManagementQueryV1({
		databaseUrl: input.databaseUrl,
	});
	const configurationTransaction = new PostgresAgentConfigurationTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const configurationQuery = new PostgresAgentConfigurationQueryV1({
		databaseUrl: input.databaseUrl,
	});
	const auditQuery = new PostgresPlatformAuditQueryV1({
		databaseUrl: input.databaseUrl,
	});
	const foundation = createApplicationFoundationUseCaseV1({
		transaction: foundationTransaction,
		...input.admissions,
	});
	const revision = createApplicationRevisionUseCaseV1({
		transaction: revisionTransaction,
		...input.admissions,
	});
	const management = createAgentManagementV1(managementTransaction);
	const configuration = createAgentConfigurationUseCaseV1({
		transaction: configurationTransaction,
		...input.admissions,
	});
	const projections = createPlatformProjectionReaders({
		identity: input.identity,
		managementQuery,
		configurationQuery,
		presentAgent: input.presentAgent,
	});
	const dependencies: PlatformAppDependencies = {
		management: {
			identity: input.identity,
			foundation,
			revision,
			management,
			configuration,
			query: managementQuery,
			allocateApplicationIds: input.allocateApplicationIds,
			prepareSecretReplacements: input.prepareApplicationSecrets,
			readApplicationProjection: projections.readApplicationProjection,
			readAgentProjection: projections.readManagementAgentProjection,
		},
		configuration: {
			identity: input.identity,
			configuration,
			configurationQuery,
			prepareSecretReplacements: input.prepareConfigurationSecrets,
			readAgentProjection: projections.readConfigurationAgentProjection,
		},
		sessionAudit: { identity: input.identity, audit: auditQuery },
	};
	const adapters = [
		foundationTransaction,
		revisionTransaction,
		managementTransaction,
		managementQuery,
		configurationTransaction,
		configurationQuery,
		auditQuery,
	];
	return {
		dependencies,
		async close() {
			let failed = false;
			for (const adapter of adapters.toReversed()) {
				try {
					await adapter.close();
				} catch {
					failed = true;
				}
			}
			if (failed) {
				throw new Error("Platform API dependencies did not close cleanly");
			}
		},
	};
}
