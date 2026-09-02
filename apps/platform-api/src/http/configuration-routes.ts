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
	readonly configuration: Pick<AgentConfigurationUseCaseV1, "update">;
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
	preparedModelCredentialOptionIds: ReadonlySet<string>,
) {
	return {
		...(input.coOwnerIds === undefined ? {} : { coOwnerIds: input.coOwnerIds }),
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
								replaceCredential: preparedModelCredentialOptionIds.has(
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
		...(input.secrets === undefined
			? {}
			: {
					secrets: input.secrets.map(({ name }) => ({
						name,
						replace: true as const,
					})),
				}),
	};
}

function snapshotArray(input: unknown): unknown[] {
	if (!Array.isArray(input)) throw new Error();
	const snapshot: unknown[] = [];
	for (let index = 0; index < input.length; index += 1) {
		if (!Object.hasOwn(input, index)) throw new Error();
		snapshot.push(input[index]);
	}
	return snapshot;
}

function validatePreparedSecrets(
	input: ReturnType<typeof AgentConfigurationUpdateRequestV1Schema.parse>,
	prepared: Awaited<
		ReturnType<ConfigurationRoutesDependencies["prepareSecretReplacements"]>
	>,
	traceId: string,
): ReadonlySet<string> {
	try {
		const requestedSecrets = (input.secrets ?? [])
			.map(({ name }) => name)
			.toSorted();
		const preparedSecrets = snapshotArray(prepared.secrets)
			.map((secret) => {
				if (!secret || typeof secret !== "object" || Array.isArray(secret)) {
					throw new Error();
				}
				const { name, replace } = secret as {
					name?: unknown;
					replace?: unknown;
				};
				if (typeof name !== "string" || replace !== true) throw new Error();
				return name;
			})
			.toSorted();
		const requestedModels = (input.modelConfiguration?.options ?? [])
			.filter(({ credentialValue }) => credentialValue !== undefined)
			.map(({ optionId }) => optionId)
			.toSorted();
		const preparedModels = snapshotArray(prepared.modelCredentialOptionIds);
		if (
			new Set(preparedSecrets).size !== preparedSecrets.length ||
			new Set(preparedModels).size !== preparedModels.length ||
			preparedModels.some((optionId) => typeof optionId !== "string") ||
			JSON.stringify(requestedSecrets) !== JSON.stringify(preparedSecrets) ||
			JSON.stringify(requestedModels) !==
				JSON.stringify(preparedModels.toSorted())
		) {
			throw new Error();
		}
		return new Set(preparedModels as string[]);
	} catch {
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
		const hasSecretChanges =
			(body.secrets?.length ?? 0) > 0 || modelCredentials.length > 0;
		let authorization: AgentConfigurationQueryResultV1 | undefined;
		if (hasSecretChanges) {
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
		}
		if (hasSecretChanges) {
			if (authorization?.outcome !== "found") {
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
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
			} catch {
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			}
		}
		const preparedModelCredentialOptionIds = validatePreparedSecrets(
			body,
			prepared,
			metadata.traceId,
		);
		try {
			await dependencies.configuration.update(
				{
					schemaVersion: 1,
					agentId: context.req.param("agentId"),
					idempotencyKey,
					requestId: metadata.requestId,
					traceId: metadata.traceId,
					changes: configurationChanges(body, preparedModelCredentialOptionIds),
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
