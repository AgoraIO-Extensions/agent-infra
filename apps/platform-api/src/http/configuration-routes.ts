import {
	AgentConfigurationUpdateRequestV1Schema,
	AgentProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import type { AgentConfigurationUseCaseV1 } from "@agent-infra/platform-core";
import type {
	AgentConfigurationQueryInputV1,
	AgentConfigurationQueryResultV1,
} from "@agent-infra/platform-store";
import type { Hono } from "hono";

import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity,
} from "./identity.js";

type AgentProjection = ReturnType<typeof AgentProjectionV1Schema.parse>;

export interface ConfigurationRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly configuration: AgentConfigurationUseCaseV1;
	readonly configurationQuery: {
		read(
			input: AgentConfigurationQueryInputV1,
		): Promise<AgentConfigurationQueryResultV1>;
	};
	readonly readAgentProjection: (input: {
		readonly agentId: string;
		readonly identity: IdentityContext;
		readonly requestId: string;
		readonly traceId: string;
	}) => Promise<AgentProjection | null>;
	readonly prepareSecretReplacements: (input: {
		readonly agentId: string;
		readonly configurationRevision: number;
		readonly identityAuthorizationRevision: string;
		readonly identity: IdentityContext;
		readonly secrets: readonly {
			readonly name: string;
			readonly value: string;
		}[];
		readonly modelCredentials: readonly {
			readonly optionId: string;
			readonly credentialValue: string;
		}[];
		readonly requestId: string;
		readonly traceId: string;
	}) => Promise<{
		readonly secrets: readonly {
			readonly name: string;
			readonly replace: true;
		}[];
		readonly modelCredentialOptionIds: readonly string[];
	}>;
}

function configurationChanges(
	input: ReturnType<typeof AgentConfigurationUpdateRequestV1Schema.parse>,
	prepared: Awaited<
		ReturnType<ConfigurationRoutesDependencies["prepareSecretReplacements"]>
	>,
) {
	return {
		...(input.coOwnerIds === undefined ? {} : { ownerIds: input.coOwnerIds }),
		...(input.availability === undefined
			? {}
			: { availability: input.availability }),
		...(input.modelConfiguration === undefined
			? {}
			: {
					modelConfiguration: {
						...input.modelConfiguration,
						options: input.modelConfiguration.options.map(
							({ credentialValue: _credentialValue, ...option }) => ({
								...option,
								replaceCredential: prepared.modelCredentialOptionIds.includes(
									option.optionId,
								),
							}),
						),
					},
				}),
		...(input.actions === undefined ? {} : { actions: input.actions }),
		...(input.environment === undefined
			? {}
			: { environment: input.environment }),
		...(input.channels === undefined ? {} : { channels: input.channels }),
		...(input.secrets === undefined ? {} : { secrets: prepared.secrets }),
	};
}

function validatePreparedSecrets(
	input: ReturnType<typeof AgentConfigurationUpdateRequestV1Schema.parse>,
	prepared: Awaited<
		ReturnType<ConfigurationRoutesDependencies["prepareSecretReplacements"]>
	>,
	traceId: string,
): void {
	const requestedSecrets = (input.secrets ?? [])
		.map(({ name }) => name)
		.toSorted();
	const preparedSecrets = prepared.secrets.map(({ name }) => name).toSorted();
	const requestedModels = (input.modelConfiguration?.options ?? [])
		.filter(({ credentialValue }) => credentialValue !== undefined)
		.map(({ optionId }) => optionId)
		.toSorted();
	const preparedModels = [...prepared.modelCredentialOptionIds].toSorted();
	if (
		new Set(preparedSecrets).size !== preparedSecrets.length ||
		new Set(preparedModels).size !== preparedModels.length ||
		JSON.stringify(requestedSecrets) !== JSON.stringify(preparedSecrets) ||
		JSON.stringify(requestedModels) !== JSON.stringify(preparedModels)
	) {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
}

export function registerConfigurationRoutes(
	app: Hono,
	dependencies: ConfigurationRoutesDependencies,
): void {
	app.put("/api/v1/agents/:agentId/configuration", async (context) => {
		const request = context.req.raw;
		const metadata = requestMetadata(request);
		const identity = await resolveIdentity(
			dependencies.identity,
			request,
			metadata.traceId,
		);
		const idempotencyKey = parseIdempotencyKey(request, metadata.traceId);
		const { value: body, rawRequestDigest } = await parseJson(
			request,
			AgentConfigurationUpdateRequestV1Schema,
			metadata.traceId,
		);
		let prepared: Awaited<
			ReturnType<ConfigurationRoutesDependencies["prepareSecretReplacements"]>
		> = { secrets: [], modelCredentialOptionIds: [] };
		const modelCredentials = (body.modelConfiguration?.options ?? []).flatMap(
			({ optionId, credentialValue }) =>
				credentialValue === undefined ? [] : [{ optionId, credentialValue }],
		);
		if ((body.secrets?.length ?? 0) > 0 || modelCredentials.length > 0) {
			let authorization: AgentConfigurationQueryResultV1;
			try {
				authorization = await dependencies.configurationQuery.read({
					agentId: context.req.param("agentId"),
					actorId: identity.userId,
					organizationIds: identity.organizationIds,
					isAdministrator: identity.roles.includes("system_admin"),
					intent: "manage",
				});
			} catch {
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			}
			if (authorization.outcome !== "found") {
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			}
			try {
				prepared = await dependencies.prepareSecretReplacements({
					agentId: context.req.param("agentId"),
					configurationRevision: authorization.configuration.revision,
					identityAuthorizationRevision: identity.authorizationRevision,
					identity,
					secrets: body.secrets ?? [],
					modelCredentials,
					requestId: metadata.requestId,
					traceId: metadata.traceId,
				});
			} catch (error) {
				if (error instanceof HttpProtocolError) throw error;
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			}
		}
		validatePreparedSecrets(body, prepared, metadata.traceId);
		try {
			await dependencies.configuration.update(
				{
					schemaVersion: 1,
					agentId: context.req.param("agentId"),
					idempotencyKey,
					requestId: metadata.requestId,
					traceId: metadata.traceId,
					changes: configurationChanges(body, prepared),
				},
				{
					schemaVersion: 1,
					actorId: identity.userId,
					rawRequestDigest,
				},
			);
		} catch (error) {
			throw mapCoreError(error, metadata.traceId);
		}
		let projection: AgentProjection | null;
		try {
			projection = await dependencies.readAgentProjection({
				agentId: context.req.param("agentId"),
				identity,
				requestId: metadata.requestId,
				traceId: metadata.traceId,
			});
		} catch {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
		if (!projection) {
			throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
		}
		const parsed = AgentProjectionV1Schema.safeParse(projection);
		if (!parsed.success) {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
		return context.json(parsed.data);
	});
}
