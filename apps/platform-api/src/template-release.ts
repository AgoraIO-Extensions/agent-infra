import {
	StandardTemplateReleaseApplyRequestV1Schema,
	StandardTemplateReleaseApplyResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type AgentConfigurationAuthorityContextV1,
	createAgentConfigurationUseCaseV1,
	parseStandardTemplateReleaseTargetV1,
	type StandardTemplateReleaseAuthorizationPortV1,
	type StandardTemplateReleaseTargetV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresAgentConfigurationTransactionV1,
} from "@agent-infra/platform-store";
import { createPlatformHealthApp } from "./app.js";
import {
	createDeploymentAdmissionsV1,
	type DeploymentAdmissionInputV1,
} from "./deployment-admissions.js";
import { createDeploymentAuthorizationAdmission } from "./deployment-authorization.js";
import { createDeploymentIdentityScope } from "./deployment-identity.js";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./http/common.js";
import { mapCoreError } from "./http/core-errors.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity,
} from "./http/identity.js";

export interface StandardTemplateReleaseDeploymentBindingV1 {
	readonly schemaVersion: 1;
	readonly revision: string;
	readonly target: StandardTemplateReleaseTargetV1;
	readonly operatorIds: readonly string[];
}
export interface ProductionSingleAgentTemplateReleaseInputV1
	extends Omit<DeploymentAdmissionInputV1, "currentIdentity"> {
	readonly databaseUrl: string;
	readonly identity: IdentityAdapter;
	readonly imageRepository: string;
	readonly loadAuthorityContext: () => Promise<AgentConfigurationAuthorityContextV1>;
	readonly target: StandardTemplateReleaseTargetV1;
	/** Current deployment-owned binding; reload on each admission so revocation is effective. */
	readonly loadReleaseBinding: () => Promise<StandardTemplateReleaseDeploymentBindingV1>;
}

function releasePath(target: StandardTemplateReleaseTargetV1) {
	return `/internal/ops/standard-template-releases/${target.releaseId}/apply`;
}

/** Separate purpose-bound authority; never used by ordinary configuration update. */
export function createDeploymentStandardTemplateReleaseAuthorizationV1(input: {
	readonly target: StandardTemplateReleaseTargetV1;
	readonly identityScope: ReturnType<typeof createDeploymentIdentityScope>;
	readonly configurationQuery: Pick<
		PostgresAgentConfigurationQueryV1,
		"readStandardTemplateReleaseAuthority"
	>;
	readonly loadReleaseBinding: ProductionSingleAgentTemplateReleaseInputV1["loadReleaseBinding"];
}): StandardTemplateReleaseAuthorizationPortV1 {
	const target = parseStandardTemplateReleaseTargetV1(input.target);
	const loadBinding = input.loadReleaseBinding;
	return {
		async authorize(request) {
			const rejected = {
				schemaVersion: 1 as const,
				status: "rejected" as const,
			};
			const actual = input.identityScope.currentRequest();
			if (
				request.intent !== "standard_template.release_to_agent" ||
				actual.method !== "POST" ||
				new URL(actual.url).pathname !== releasePath(target) ||
				new URL(actual.url).search !== "" ||
				JSON.stringify(parseStandardTemplateReleaseTargetV1(request.target)) !==
					JSON.stringify(target)
			)
				return rejected;
			let actor: IdentityContext;
			try {
				actor = await input.identityScope.currentIdentity(request.traceId);
			} catch (error) {
				if (
					error instanceof HttpProtocolError &&
					(error.status === 401 || error.status === 403)
				)
					return rejected;
				throw error;
			}
			if (
				actor.userId !== request.actorId ||
				actor.accountStatus !== "active" ||
				!actor.roles.includes("system_admin")
			)
				return rejected;
			const binding = await loadBinding();
			if (
				binding.schemaVersion !== 1 ||
				typeof binding.revision !== "string" ||
				binding.revision.length < 1 ||
				binding.revision.length > 1024 ||
				!Array.isArray(binding.operatorIds) ||
				binding.operatorIds.length > 1024 ||
				binding.operatorIds.some(
					(id) => typeof id !== "string" || id.length < 1 || id.length > 1024,
				) ||
				!binding.operatorIds.includes(actor.userId) ||
				JSON.stringify(parseStandardTemplateReleaseTargetV1(binding.target)) !==
					JSON.stringify(target)
			)
				return rejected;
			const current =
				await input.configurationQuery.readStandardTemplateReleaseAuthority({
					agentId: target.agentId,
					templateId: target.templateId,
				});
			if (current.outcome !== "found") return rejected;
			return {
				schemaVersion: 1,
				status: "admitted",
				intent: "standard_template.release_to_agent",
				target,
				actorId: actor.userId,
				accountStatus: "active",
				isAdministrator: true,
				identityRevision: actor.authorizationRevision,
				deploymentRevision: binding.revision,
				authorizationRevision: current.authorizationRevision,
			};
		},
	};
}

/** Dedicated HTTP application. Deployment supplies actual identity and Registry adapters, not admissions. */
export function createProductionSingleAgentTemplateReleaseAppV1(
	input: ProductionSingleAgentTemplateReleaseInputV1,
) {
	let target: StandardTemplateReleaseTargetV1;
	try {
		target = parseStandardTemplateReleaseTargetV1(input.target);
		if (
			!["postgres:", "postgresql:"].includes(
				new URL(input.databaseUrl).protocol,
			) ||
			typeof input.identity?.resolve !== "function" ||
			typeof input.identity?.hydrateUsers !== "function" ||
			typeof input.loadReleaseBinding !== "function" ||
			typeof input.loadAuthorityContext !== "function" ||
			input.templates.filter(
				(template) =>
					template.templateId === target.templateId &&
					template.imageDigest === target.targetImageDigest,
			).length !== 1
		)
			throw new Error();
	} catch {
		throw new Error("PLATFORM_TEMPLATE_RELEASE_CONFIGURATION_INVALID");
	}
	const identity = input.identity;
	const identityScope = createDeploymentIdentityScope(identity);
	const admissions = createDeploymentAdmissionsV1({
		...input,
		currentIdentity: identityScope.currentIdentity,
	});
	const query = new PostgresAgentConfigurationQueryV1({
		databaseUrl: input.databaseUrl,
	});
	const transaction = new PostgresAgentConfigurationTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const configuration = createAgentConfigurationUseCaseV1({
		...admissions,
		transaction,
		authorizationAdmission: createDeploymentAuthorizationAdmission({
			identityScope,
			configurationQuery: query,
			loadAuthorityContext: input.loadAuthorityContext,
		}),
		standardTemplateReleaseAuthorization:
			createDeploymentStandardTemplateReleaseAuthorizationV1({
				target,
				identityScope,
				configurationQuery: query,
				loadReleaseBinding: input.loadReleaseBinding,
			}),
	});
	const app = createPlatformHealthApp();
	app.use("*", (context, next) =>
		identityScope.requestScope(context.req.raw, next),
	);
	app.post(
		"/internal/ops/standard-template-releases/:releaseId/apply",
		async (context) => {
			const request = context.req.raw;
			const metadata = requestMetadata(request);
			const actor = await resolveIdentity(identity, request, metadata.traceId);
			if (context.req.param("releaseId") !== target.releaseId)
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			if (new URL(request.url).search !== "")
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const idempotencyKey = parseIdempotencyKey(request, metadata.traceId);
			const { rawRequestDigest } = await parseJson(
				request,
				StandardTemplateReleaseApplyRequestV1Schema,
				metadata.traceId,
			);
			try {
				const result = await configuration.releaseStandardTemplate(
					{ schemaVersion: 1, target, idempotencyKey, ...metadata },
					{ schemaVersion: 1, actorId: actor.userId, rawRequestDigest },
				);
				return context.json(
					StandardTemplateReleaseApplyResponseV1Schema.parse({
						schemaVersion: 1,
						agentId: result.agentId,
						configurationRevision: result.revision,
						changedFields: result.changedFields,
					}),
					202,
				);
			} catch (error) {
				throw mapCoreError(error, metadata.traceId);
			}
		},
	);
	return {
		app,
		async close() {
			await Promise.all([transaction.close(), query.close()]);
		},
	};
}
