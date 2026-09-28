import { AgentResourceProfileProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { OciImageReferenceV1Schema } from "@agent-infra/contracts/workload";
import type { AgentConfigurationAuthorityContextV1 } from "@agent-infra/platform-core";
import { PostgresApiIdentityStoreV1 } from "@agent-infra/platform-store";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";

import type { PlatformApiAssemblyInput } from "./assembly.js";
import {
	createDeploymentAdmissionsV1,
	createDeploymentConfigurationProjectionV2,
	type DeploymentAdmissionInputV1,
} from "./deployment-admissions.js";
import { createDeploymentAuthorizationAdmission } from "./deployment-authorization.js";
import {
	allocateDeploymentApplicationIds,
	createDeploymentIdentityScope,
	withApiIdentityResolverV1,
} from "./deployment-identity.js";
import { createDeploymentPresentation } from "./deployment-presentation.js";
import { createDeploymentSecretPreparation } from "./deployment-secrets.js";
import type { IdentityAdapter } from "./http/identity.js";

export interface ProductionPlatformApiInputV1
	extends Omit<DeploymentAdmissionInputV1, "currentIdentity"> {
	readonly databaseUrl: string;
	/** Same immutable image repository used by the Worker's resource policy. */
	readonly imageRepository: string;
	/** An actual deployment identity boundary; no browser-provided identity headers. */
	readonly identity: IdentityAdapter;
	readonly loadAuthorityContext: () => Promise<AgentConfigurationAuthorityContextV1>;
	/** Public wrapping keys only. Worker private keys belong to the Worker deployment. */
	readonly encryptionKeys: unknown;
	readonly resourceProfile: Parameters<
		typeof createDeploymentPresentation
	>[0]["resourceProfile"];
	readonly conversationReplayWindow?: number;
	readonly conversationReplayWindowMs?: number;
}

export function createProductionPlatformApiAssemblyInputV1(
	input: ProductionPlatformApiInputV1,
): PlatformApiAssemblyInput {
	let resourceProfile: ProductionPlatformApiInputV1["resourceProfile"];
	try {
		OciImageReferenceV1Schema.parse(
			`${input.imageRepository}@sha256:${"0".repeat(64)}`,
		);
		if (
			!["postgres:", "postgresql:"].includes(
				new URL(input.databaseUrl).protocol,
			) ||
			typeof input.identity?.resolve !== "function" ||
			typeof input.identity?.hydrateUsers !== "function" ||
			typeof input.loadAuthorityContext !== "function"
		)
			throw new Error();
		resourceProfile = AgentResourceProfileProjectionV1Schema.parse(
			input.resourceProfile,
		);
	} catch {
		throw new Error("PLATFORM_DEPLOYMENT_CONFIGURATION_INVALID");
	}
	const apiIdentity = new PostgresApiIdentityStoreV1({
		databaseUrl: input.databaseUrl,
	});
	const identity: IdentityAdapter = withApiIdentityResolverV1(
		input.identity,
		apiIdentity,
	);
	const identityScope = createDeploymentIdentityScope(identity);
	const admissions = createDeploymentAdmissionsV1({
		...input,
		currentIdentity: identityScope.currentIdentity,
	});
	const deploymentConfiguration =
		createDeploymentConfigurationProjectionV2(input);
	const secrets = createDeploymentSecretPreparation(
		createSecretEncryptorV1({ encryptionKeys: input.encryptionKeys }),
	);
	return {
		databaseUrl: input.databaseUrl,
		identity,
		apiIdentity,
		requestScope: identityScope.requestScope,
		conversationReplayWindow: input.conversationReplayWindow,
		conversationReplayWindowMs: input.conversationReplayWindowMs,
		allocateApplicationIds: allocateDeploymentApplicationIds,
		...secrets,
		admissions: ({ configurationQuery }) => ({
			...admissions,
			authorizationAdmission: createDeploymentAuthorizationAdmission({
				identityScope,
				configurationQuery,
				loadAuthorityContext: input.loadAuthorityContext,
			}),
		}),
		deploymentConfiguration: {
			identity: input.identity,
			read: deploymentConfiguration,
		},
		presentAgent: {
			create: ({ configurationQuery }) =>
				createDeploymentPresentation({
					identityScope,
					configurationQuery,
					resourceProfile,
					imageRepository: input.imageRepository,
				}),
		},
	};
}
