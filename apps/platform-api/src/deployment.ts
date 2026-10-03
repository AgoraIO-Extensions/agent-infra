import { AgentResourceProfileProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { OciImageReferenceV1Schema } from "@agent-infra/contracts/workload";
import {
	type AgentConfigurationAuthorityContextV1,
	PersonalRelayKeyErrorV1,
} from "@agent-infra/platform-core";
import {
	createRelayKeyEncryptorV1,
	createSecretEncryptorV1,
} from "@agent-infra/secret-store";

import type { PlatformApiAssemblyInput } from "./assembly.js";
import { createConnectionCapability } from "./connection-consumer-profile.js";
import {
	createDeploymentAdmissionsV1,
	createDeploymentConfigurationProjectionV2,
	type DeploymentAdmissionInputV1,
} from "./deployment-admissions.js";
import { createDeploymentAuthorizationAdmission } from "./deployment-authorization.js";
import {
	allocateDeploymentApplicationIds,
	createDeploymentIdentityScope,
} from "./deployment-identity.js";
import { createDeploymentPresentation } from "./deployment-presentation.js";
import { createDeploymentSecretPreparation } from "./deployment-secrets.js";
import { HttpProtocolError } from "./http/common.js";
import type { IdentityAdapter } from "./http/identity.js";
import { createPersonalRelayKeyValidatorV1 } from "./relay-key-validation.js";

export interface ProductionPlatformApiInputV1
	extends Omit<DeploymentAdmissionInputV1, "currentIdentity"> {
	readonly connectionConsumerProfile?: unknown;
	readonly connectionConsumerProfileApproved?: boolean;
	readonly wecom?: PlatformApiAssemblyInput["wecom"];
	readonly wecomIdentity?: PlatformApiAssemblyInput["wecomIdentity"];
	readonly wecomCredentialEncryptionKeys?: PlatformApiAssemblyInput["wecomCredentialEncryptionKeys"];
	readonly wecomApplicationSetup?: PlatformApiAssemblyInput["wecomApplicationSetup"];
	readonly databaseUrl: string;
	/** Same immutable image repository used by the Worker's resource policy. */
	readonly imageRepository: string;
	/** An actual deployment identity boundary; no browser-provided identity headers. */
	readonly identity: IdentityAdapter;
	readonly loadAuthorityContext: () => Promise<AgentConfigurationAuthorityContextV1>;
	/** Public wrapping keys only. Worker private keys belong to the Worker deployment. */
	readonly encryptionKeys: unknown;
	/** Approved fixed billing profile and deployment-owned CA/TLS transport only. */
	readonly personalRelayKeyValidation?: Parameters<
		typeof createPersonalRelayKeyValidatorV1
	>[0];
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
	const identityScope = createDeploymentIdentityScope(input.identity);
	const admissions = createDeploymentAdmissionsV1({
		...input,
		currentIdentity: identityScope.currentIdentity,
	});
	const deploymentConfiguration =
		createDeploymentConfigurationProjectionV2(input);
	const connectionCapability = createConnectionCapability(
		input.connectionConsumerProfile,
		input.connectionConsumerProfileApproved === true,
	);
	const secrets = createDeploymentSecretPreparation(
		createSecretEncryptorV1({ encryptionKeys: input.encryptionKeys }),
	);
	const validatePersonalRelayKey = input.personalRelayKeyValidation
		? createPersonalRelayKeyValidatorV1(input.personalRelayKeyValidation)
		: undefined;
	const relayKeyEncryptor = validatePersonalRelayKey
		? createRelayKeyEncryptorV1({ encryptionKeys: input.encryptionKeys })
		: undefined;
	const personalRelayKeys: PlatformApiAssemblyInput["personalRelayKeys"] =
		validatePersonalRelayKey && relayKeyEncryptor
			? {
					validate: validatePersonalRelayKey,
					encrypt: (binding, keyValue) =>
						relayKeyEncryptor.encrypt({ ...binding, plaintext: keyValue }),
					async currentIdentity(traceId) {
						try {
							const current = await identityScope.currentIdentity(traceId);
							return {
								userId: current.userId,
								accountStatus: current.accountStatus,
								authorizationRevision: current.authorizationRevision,
							};
						} catch (error) {
							throw new PersonalRelayKeyErrorV1(
								error instanceof HttpProtocolError && error.status === 401
									? "authentication_required"
									: error instanceof HttpProtocolError && error.status === 403
										? "not_authorized"
										: "unavailable",
							);
						}
					},
				}
			: undefined;
	return {
		...(personalRelayKeys ? { personalRelayKeys } : {}),
		...(input.wecom ? { wecom: input.wecom } : {}),
		...(input.wecomIdentity ? { wecomIdentity: input.wecomIdentity } : {}),
		...(input.wecomCredentialEncryptionKeys
			? { wecomCredentialEncryptionKeys: input.wecomCredentialEncryptionKeys }
			: {}),
		...(input.wecomApplicationSetup
			? { wecomApplicationSetup: input.wecomApplicationSetup }
			: {}),
		databaseUrl: input.databaseUrl,
		identity: input.identity,
		requestScope: identityScope.requestScope,
		conversationReplayWindow: input.conversationReplayWindow,
		conversationReplayWindowMs: input.conversationReplayWindowMs,
		connectionCapability,
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
