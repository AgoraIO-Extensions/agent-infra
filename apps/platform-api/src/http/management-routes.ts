import { randomBytes, randomUUID } from "node:crypto";

import {
	AgentApplicationCreateRequestV1Schema,
	AgentApplicationCreateRequestV2Schema,
	AgentApplicationProjectionV1Schema,
	AgentApplicationUpdateRequestV1Schema,
	AgentLifecycleCommandRequestV1Schema,
	AgentProjectionV1Schema,
	ApiAgentGrantProjectionV1Schema,
	ApiAgentGrantRequestV1Schema,
	ApiApplicationCreateRequestV1Schema,
	ApiApplicationCredentialIssueProjectionV1Schema,
	ApiApplicationProjectionV1Schema,
	ApiCredentialIssueProjectionV1Schema,
	ApiCredentialIssueRequestV1Schema,
	ApiCredentialMetadataProjectionV1Schema,
	ApiPrincipalV1Schema,
	ApprovalDecisionRequestV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	AgentConfigurationModelInputV1,
	AgentConfigurationSecretReplacementInputV1,
	AgentConfigurationUseCaseV1,
	AgentManagementActorContextV1,
	AgentManagementInterfaceV1,
	ApiCredentialMetadataV1,
	ApiCredentialScopeV1,
	ApiIdentityActorV1,
	ApiIdentityAuditActionV1,
	ApiIdentityAuditInputV1,
	ApiIdentityManagementInterfaceV1,
	ApplicationFoundationUseCaseV1,
	ApplicationRevisionUseCaseV1,
	PendingSecretRecordAttachmentResolverV1,
} from "@agent-infra/platform-core";
import {
	ApiIdentityError,
	generateApiCredentialV1,
} from "@agent-infra/platform-core";
import type {
	AgentManagementAgentProjectionV1,
	AgentManagementAgentScopeV1,
	AgentManagementApplicationProjectionV1,
	AgentManagementApplicationScopeV1,
	AgentManagementPageInputV1,
	AgentManagementPageV1,
} from "@agent-infra/platform-store";
import type { Context, Hono } from "hono";
import { allocateDeploymentDirectApplicationIds } from "../deployment-identity.js";
import { parsePendingSecretRecordAttachmentResolverV1 } from "../secret-preparation.js";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	parsePageQuery,
	type RequestMetadata,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveApiIdentity,
	resolveIdentity,
} from "./identity.js";

type ApplicationProjection = ReturnType<
	typeof AgentApplicationProjectionV1Schema.parse
>;
type AgentProjection = ReturnType<typeof AgentProjectionV1Schema.parse>;
type ApplicationCreateInput = ReturnType<
	typeof AgentApplicationCreateRequestV1Schema.parse
>;
type ApplicationPreparationInput = Pick<
	ApplicationCreateInput,
	"modelConfiguration"
> & { readonly secrets?: ApplicationCreateInput["secrets"] };
type ApplicationCommandInput = Pick<
	ApplicationCreateInput,
	| "name"
	| "description"
	| "coOwnerIds"
	| "availability"
	| "source"
	| "environment"
	| "modelConfiguration"
>;

export interface ManagementQuery {
	listApplications(
		scope: AgentManagementApplicationScopeV1,
		page: AgentManagementPageInputV1,
	): Promise<AgentManagementPageV1<AgentManagementApplicationProjectionV1>>;
	getApplication(
		scope: AgentManagementApplicationScopeV1,
		applicationId: string,
	): Promise<AgentManagementApplicationProjectionV1 | undefined>;
	listAgents(
		scope: AgentManagementAgentScopeV1,
		page: AgentManagementPageInputV1,
	): Promise<AgentManagementPageV1<AgentManagementAgentProjectionV1>>;
	getAgent(
		scope: AgentManagementAgentScopeV1,
		agentId: string,
	): Promise<AgentManagementAgentProjectionV1 | undefined>;
}

interface ProjectionInput<T> extends RequestMetadata {
	readonly identity: IdentityContext;
	readonly application?: T;
	readonly agent?: T;
}

export interface SecretPreparationInput extends RequestMetadata {
	readonly applicationId: string;
	readonly agentId: string;
	readonly identity: IdentityContext;
	readonly secrets: readonly {
		readonly name: string;
		readonly value: string;
	}[];
	readonly modelConfiguration: ApplicationCreateInput["modelConfiguration"];
}

export interface SecretPreparationResult {
	readonly secrets: readonly AgentConfigurationSecretReplacementInputV1[];
	readonly modelConfiguration?: AgentConfigurationModelInputV1;
	readonly attachment?: PendingSecretRecordAttachmentResolverV1;
}

export interface ManagementRouteDependencies {
	readonly identity: IdentityAdapter;
	readonly foundation: Pick<ApplicationFoundationUseCaseV1, "submit">;
	readonly revision: Pick<ApplicationRevisionUseCaseV1, "revise">;
	readonly management: Pick<
		AgentManagementInterfaceV1,
		"executeManagementCommand"
	>;
	readonly apiIdentity?: ApiIdentityManagementInterfaceV1;
	readonly configuration: Pick<
		AgentConfigurationUseCaseV1,
		"upgradeCustomImage"
	>;
	readonly query: ManagementQuery;
	readonly allocateApplicationIds: (input: {
		readonly identity: IdentityContext;
		readonly idempotencyKey: string;
	}) => Promise<{
		readonly applicationId: string;
		readonly agentId: string;
	}>;
	readonly prepareSecretReplacements: (
		input: SecretPreparationInput,
	) => Promise<SecretPreparationResult>;
	readonly readApplicationProjection: (
		input: ProjectionInput<AgentManagementApplicationProjectionV1>,
	) => Promise<unknown>;
	readonly readAgentProjection: (
		input: ProjectionInput<AgentManagementAgentProjectionV1>,
	) => Promise<unknown>;
}

function actor(identity: IdentityContext): AgentManagementActorContextV1 {
	return {
		schemaVersion: 1,
		userId: identity.userId,
		accountStatus: identity.accountStatus,
		organizationIds: identity.organizationIds,
		isAdministrator: identity.roles.includes("system_admin"),
		...(identity.principal === undefined
			? {}
			: { principal: identity.principal }),
	};
}

function hasBearerCredential(request: Request): boolean {
	return /^Bearer\s+[^\s]+$/.test(request.headers.get("authorization") ?? "");
}

function apiIdentityContext(
	identity: Awaited<ReturnType<typeof resolveApiIdentity>>,
): IdentityContext {
	return {
		schemaVersion: 1,
		userId: identity.ownerId,
		displayName: identity.principal.id,
		accountStatus: "active",
		organizationIds: identity.organizationIds,
		roles: [],
		authorizationRevision: identity.authorizationRevision,
		principal: identity.principal,
	};
}

function apiActor(
	identity: Awaited<ReturnType<typeof resolveApiIdentity>>,
): ApiIdentityActorV1 {
	return {
		schemaVersion: 1,
		userId: identity.ownerId,
		accountStatus: identity.accountStatus,
		principal: identity.principal,
		isAdministrator: false,
		credential: identity.credential,
	};
}

function applicantScope(
	identity: IdentityContext,
): AgentManagementApplicationScopeV1 {
	return { kind: "applicant", applicantId: identity.userId };
}

function userScope(identity: IdentityContext): AgentManagementAgentScopeV1 {
	return {
		kind: "user",
		userId: identity.userId,
		organizationIds: identity.organizationIds,
	};
}

function ownerScope(identity: IdentityContext): AgentManagementAgentScopeV1 {
	return { kind: "owner", ownerId: identity.userId };
}

function pageInput(
	request: Request,
	traceId: string,
): AgentManagementPageInputV1 {
	const page = parsePageQuery(request, traceId);
	return {
		limit: page.limit ?? 50,
		...(page.cursor === undefined ? {} : { afterId: page.cursor }),
	};
}

function fail(
	code: ConstructorParameters<typeof HttpProtocolError>[0],
	traceId: string,
): never {
	throw new HttpProtocolError(code, traceId);
}

function preparedSecretAttachment(
	input: unknown,
	traceId: string,
): PendingSecretRecordAttachmentResolverV1 {
	try {
		return parsePendingSecretRecordAttachmentResolverV1(input);
	} catch {
		fail("DEPENDENCY_UNAVAILABLE", traceId);
	}
}

async function queryOrUnavailable<T>(
	task: () => Promise<T>,
	traceId: string,
): Promise<T> {
	try {
		return await task();
	} catch (error) {
		if (error instanceof ApiIdentityError) throw error;
		fail("DEPENDENCY_UNAVAILABLE", traceId);
	}
}

async function boundary(
	context: Context,
	task: (metadata: RequestMetadata) => Promise<Response>,
): Promise<Response> {
	const metadata = requestMetadata(context.req.raw);
	try {
		return await task(metadata);
	} catch (error) {
		const protocol = mapCoreError(error, metadata.traceId);
		return context.json(protocol.body, protocol.status);
	}
}

function requireAdministrator(
	identity: IdentityContext,
	traceId: string,
): void {
	if (!identity.roles.includes("system_admin")) fail("FORBIDDEN", traceId);
}

async function projectApplication(
	dependencies: ManagementRouteDependencies,
	application: AgentManagementApplicationProjectionV1,
	identity: IdentityContext,
	metadata: RequestMetadata,
): Promise<ApplicationProjection> {
	let value: unknown;
	try {
		value = await dependencies.readApplicationProjection({
			application,
			identity,
			...metadata,
		});
	} catch {
		fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	}
	const parsed = AgentApplicationProjectionV1Schema.safeParse(value);
	if (!parsed.success) fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	return parsed.data;
}

async function projectAgent(
	dependencies: ManagementRouteDependencies,
	agent: AgentManagementAgentProjectionV1,
	identity: IdentityContext,
	metadata: RequestMetadata,
): Promise<AgentProjection> {
	let value: unknown;
	try {
		value = await dependencies.readAgentProjection({
			agent,
			identity,
			...metadata,
		});
	} catch {
		fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	}
	const parsed = AgentProjectionV1Schema.safeParse(value);
	if (!parsed.success) fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	return parsed.data;
}

async function applicationOrUnavailable(
	dependencies: ManagementRouteDependencies,
	scope: AgentManagementApplicationScopeV1,
	applicationId: string,
	traceId: string,
): Promise<AgentManagementApplicationProjectionV1> {
	const application = await queryOrUnavailable(
		() => dependencies.query.getApplication(scope, applicationId),
		traceId,
	);
	if (!application) fail("RESOURCE_UNAVAILABLE", traceId);
	return application;
}

async function agentOrUnavailable(
	dependencies: ManagementRouteDependencies,
	scope: AgentManagementAgentScopeV1,
	agentId: string,
	traceId: string,
): Promise<AgentManagementAgentProjectionV1> {
	const agent = await queryOrUnavailable(
		() => dependencies.query.getAgent(scope, agentId),
		traceId,
	);
	if (!agent) fail("RESOURCE_UNAVAILABLE", traceId);
	return agent;
}

function modelInput(
	prepared: SecretPreparationResult,
	body: Pick<ApplicationCreateInput, "modelConfiguration">,
	traceId: string,
):
	| Pick<
			AgentConfigurationModelInputV1,
			"options" | "defaultOptionId" | "defaultReasoningLevel"
	  >
	| undefined {
	if (body.modelConfiguration === undefined) {
		if (prepared.modelConfiguration !== undefined)
			fail("DEPENDENCY_UNAVAILABLE", traceId);
		return undefined;
	}
	if (prepared.modelConfiguration === undefined)
		fail("DEPENDENCY_UNAVAILABLE", traceId);
	return prepared.modelConfiguration;
}

async function prepareApplicationInput(
	dependencies: ManagementRouteDependencies,
	body: ApplicationPreparationInput,
	identity: IdentityContext,
	metadata: RequestMetadata,
	resource: { readonly applicationId: string; readonly agentId: string },
): Promise<SecretPreparationResult> {
	const hasModelCredential = body.modelConfiguration?.options.some(
		({ credentialValue }) => credentialValue !== undefined,
	);
	if ((body.secrets?.length ?? 0) === 0 && !hasModelCredential) {
		return {
			secrets: [],
			...(body.modelConfiguration === undefined
				? {}
				: {
						modelConfiguration: {
							...body.modelConfiguration,
							options: body.modelConfiguration.options.map(
								({ credentialValue: _credentialValue, ...option }) => ({
									...option,
									replaceCredential: false,
								}),
							),
						},
					}),
		};
	}
	try {
		const prepared = await dependencies.prepareSecretReplacements({
			...resource,
			identity,
			secrets: body.secrets ?? [],
			modelConfiguration: body.modelConfiguration,
			...metadata,
		});
		const requestedSecrets = (body.secrets ?? [])
			.map(({ name }) => name)
			.toSorted();
		const preparedSecrets = prepared.secrets.map(({ name }) => name).toSorted();
		if (
			new Set(preparedSecrets).size !== preparedSecrets.length ||
			prepared.secrets.some(({ replace }) => replace !== true) ||
			JSON.stringify(requestedSecrets) !== JSON.stringify(preparedSecrets)
		) {
			fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
		if (body.modelConfiguration === undefined) {
			if (prepared.modelConfiguration !== undefined) {
				fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			}
		} else {
			const model = prepared.modelConfiguration;
			if (
				!model ||
				model.defaultOptionId !== body.modelConfiguration.defaultOptionId ||
				model.defaultReasoningLevel !==
					body.modelConfiguration.defaultReasoningLevel ||
				model.options.length !== body.modelConfiguration.options.length ||
				model.options.some((option, index) => {
					const requested = body.modelConfiguration?.options[index];
					return (
						!requested ||
						option.optionId !== requested.optionId ||
						option.endpointId !== requested.endpointId ||
						option.modelId !== requested.modelId ||
						JSON.stringify(option.reasoningLevels) !==
							JSON.stringify(requested.reasoningLevels) ||
						option.replaceCredential !==
							(requested.credentialValue !== undefined)
					);
				})
			) {
				fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			}
		}
		const attachment = preparedSecretAttachment(
			prepared.attachment,
			metadata.traceId,
		);
		return {
			secrets: prepared.secrets.map(({ name }) => ({
				name,
				replace: true as const,
			})),
			attachment,
			...(prepared.modelConfiguration === undefined
				? {}
				: {
						modelConfiguration: {
							options: prepared.modelConfiguration.options.map(
								({
									optionId,
									endpointId,
									modelId,
									reasoningLevels,
									replaceCredential,
								}) => ({
									optionId,
									endpointId,
									modelId,
									reasoningLevels: [...reasoningLevels],
									replaceCredential,
								}),
							),
							defaultOptionId: prepared.modelConfiguration.defaultOptionId,
							defaultReasoningLevel:
								prepared.modelConfiguration.defaultReasoningLevel,
						},
					}),
		};
	} catch {
		fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	}
}

function applicationCommandFields(
	body: ApplicationCommandInput,
	prepared: SecretPreparationResult,
	traceId: string,
) {
	const modelConfiguration = modelInput(prepared, body, traceId);
	return {
		name: body.name,
		description: body.description,
		coOwnerIds: body.coOwnerIds,
		availability: body.availability,
		source: body.source,
		...(modelConfiguration === undefined ? {} : { modelConfiguration }),
		environment: body.environment,
	};
}

async function requireManagementAccepted(
	decision: Awaited<
		ReturnType<AgentManagementInterfaceV1["executeManagementCommand"]>
	>,
	traceId: string,
): Promise<void> {
	if (decision.outcome === "denied") fail("RESOURCE_UNAVAILABLE", traceId);
	if (decision.outcome === "conflict") fail("CONFLICT", traceId);
}

function apiIdentityOrUnavailable(
	store: ApiIdentityManagementInterfaceV1 | undefined,
	traceId: string,
): ApiIdentityManagementInterfaceV1 {
	if (!store) fail("DEPENDENCY_UNAVAILABLE", traceId);
	return store;
}

async function resolveAgentGrantContext(
	dependencies: ManagementRouteDependencies,
	request: Request,
	traceId: string,
) {
	const api = hasBearerCredential(request)
		? await resolveApiIdentity(dependencies.identity, request, traceId)
		: null;
	const identity = api
		? apiIdentityContext(api)
		: await resolveIdentity(dependencies.identity, request, traceId);
	return {
		identity,
		management: apiIdentityOrUnavailable(dependencies.apiIdentity, traceId),
		managementActor: api ? apiActor(api) : actor(identity),
	};
}

function apiCredentialProjection(
	metadata: ApiCredentialMetadataV1,
	traceId: string,
) {
	try {
		return ApiCredentialMetadataProjectionV1Schema.parse({
			schemaVersion: 1,
			credentialId: metadata.credentialId,
			principal: metadata.principal,
			scopes: metadata.scopes,
			expiresAt: metadata.expiresAt?.toISOString() ?? null,
			revokedAt: metadata.revokedAt?.toISOString() ?? null,
			createdAt: metadata.createdAt.toISOString(),
		});
	} catch {
		fail("DEPENDENCY_UNAVAILABLE", traceId);
	}
}

function apiAudit(
	identity: IdentityContext,
	metadata: RequestMetadata,
	action: ApiIdentityAuditActionV1,
): ApiIdentityAuditInputV1 {
	return {
		traceId: metadata.traceId,
		requestId: metadata.requestId,
		actor: identity.principal ?? { kind: "user", id: identity.userId },
		action,
	};
}

export function registerManagementRoutes(
	app: Hono,
	dependencies: ManagementRouteDependencies,
): void {
	app.get("/api/v1/api-credentials", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const management = apiIdentityOrUnavailable(
				dependencies.apiIdentity,
				metadata.traceId,
			);
			const items = await queryOrUnavailable(
				() => management.listUserCredentials(actor(identity)),
				metadata.traceId,
			);
			return context.json({
				items: items.map((item) =>
					apiCredentialProjection(item, metadata.traceId),
				),
				nextCursor: null,
			});
		}),
	);

	app.post("/api/v1/api-credentials", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const { value: body } = await parseJson(
				context.req.raw,
				ApiCredentialIssueRequestV1Schema,
				metadata.traceId,
			);
			if (body.recipient !== undefined) fail("FORBIDDEN", metadata.traceId);
			const management = apiIdentityOrUnavailable(
				dependencies.apiIdentity,
				metadata.traceId,
			);
			const credential = generateApiCredentialV1(randomBytes);
			const issued = await queryOrUnavailable(
				() =>
					management.issueUserCredential(actor(identity), {
						credential,
						scopes: body.scopes as ApiCredentialScopeV1[],
						expiresAt:
							body.expiresAt === null ? null : new Date(body.expiresAt),
						audit: apiAudit(identity, metadata, "api.credential.issued"),
					}),
				metadata.traceId,
			);
			const projection = {
				metadata: apiCredentialProjection(issued.metadata, metadata.traceId),
				credential,
			};
			return context.json(
				ApiCredentialIssueProjectionV1Schema.parse(projection),
				201,
			);
		}),
	);

	app.delete("/api/v1/api-credentials/:credentialId", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const management = apiIdentityOrUnavailable(
				dependencies.apiIdentity,
				metadata.traceId,
			);
			await queryOrUnavailable(
				() =>
					management.revokeUserCredential(
						actor(identity),
						context.req.param("credentialId"),
						new Date(),
						apiAudit(identity, metadata, "api.credential.revoked"),
					),
				metadata.traceId,
			);
			return new Response(null, { status: 204 });
		}),
	);

	app.get("/api/v1/applications", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const management = apiIdentityOrUnavailable(
				dependencies.apiIdentity,
				metadata.traceId,
			);
			const items = await queryOrUnavailable(
				() => management.listApplications(actor(identity)),
				metadata.traceId,
			);
			return context.json({
				items: items.map((item) =>
					ApiApplicationProjectionV1Schema.parse({
						schemaVersion: 1,
						applicationId: item.id,
						name: item.name,
						responsibleUserId: item.responsibleUserId,
						status: item.status,
						authorizationRevision: item.authorizationRevision,
					}),
				),
				nextCursor: null,
			});
		}),
	);

	app.post("/api/v1/applications", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const { value: body } = await parseJson(
				context.req.raw,
				ApiApplicationCreateRequestV1Schema,
				metadata.traceId,
			);
			const management = apiIdentityOrUnavailable(
				dependencies.apiIdentity,
				metadata.traceId,
			);
			const applicationId = `application_${randomUUID()}`;
			const application = await queryOrUnavailable(
				() =>
					management.createApplication({
						actor: actor(identity),
						applicationId,
						name: body.name,
						authorizationRevision: randomUUID(),
						audit: apiAudit(identity, metadata, "api.application.created"),
					}),
				metadata.traceId,
			);
			return context.json(
				ApiApplicationProjectionV1Schema.parse({
					schemaVersion: 1,
					applicationId: application.id,
					name: application.name,
					responsibleUserId: application.responsibleUserId,
					status: application.status,
					authorizationRevision: application.authorizationRevision,
				}),
				201,
			);
		}),
	);

	app.post(
		"/api/v1/applications/:applicationId/credential-delivery",
		(context) =>
			boundary(context, async (metadata) => {
				const identity = await resolveIdentity(
					dependencies.identity,
					context.req.raw,
					metadata.traceId,
				);
				const { value: principal } = await parseJson(
					context.req.raw,
					ApiPrincipalV1Schema,
					metadata.traceId,
				);
				const management = apiIdentityOrUnavailable(
					dependencies.apiIdentity,
					metadata.traceId,
				);
				await queryOrUnavailable(
					() =>
						management.grantCredentialDelivery({
							actor: actor(identity),
							applicationId: context.req.param("applicationId"),
							principal,
							audit: apiAudit(
								identity,
								metadata,
								"api.credential.delivery.granted",
							),
						}),
					metadata.traceId,
				);
				return new Response(null, { status: 204 });
			}),
	);

	app.delete(
		"/api/v1/applications/:applicationId/credential-delivery",
		(context) =>
			boundary(context, async (metadata) => {
				const identity = await resolveIdentity(
					dependencies.identity,
					context.req.raw,
					metadata.traceId,
				);
				const { value: principal } = await parseJson(
					context.req.raw,
					ApiPrincipalV1Schema,
					metadata.traceId,
				);
				const management = apiIdentityOrUnavailable(
					dependencies.apiIdentity,
					metadata.traceId,
				);
				await queryOrUnavailable(
					() =>
						management.revokeCredentialDelivery({
							actor: actor(identity),
							applicationId: context.req.param("applicationId"),
							principal,
							audit: apiAudit(
								identity,
								metadata,
								"api.credential.delivery.revoked",
							),
						}),
					metadata.traceId,
				);
				return new Response(null, { status: 204 });
			}),
	);

	app.get("/api/v1/applications/:applicationId/credentials", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const management = apiIdentityOrUnavailable(
				dependencies.apiIdentity,
				metadata.traceId,
			);
			const items = await queryOrUnavailable(
				() =>
					management.listApplicationCredentials(
						actor(identity),
						context.req.param("applicationId"),
					),
				metadata.traceId,
			);
			return context.json({
				items: items.map((item) =>
					apiCredentialProjection(item, metadata.traceId),
				),
				nextCursor: null,
			});
		}),
	);

	app.post("/api/v1/applications/:applicationId/credentials", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const { value: body } = await parseJson(
				context.req.raw,
				ApiCredentialIssueRequestV1Schema,
				metadata.traceId,
			);
			const management = apiIdentityOrUnavailable(
				dependencies.apiIdentity,
				metadata.traceId,
			);
			const recipient =
				body.recipient ?? ({ kind: "user", id: identity.userId } as const);
			const credential = generateApiCredentialV1(randomBytes);
			const issued = await queryOrUnavailable(
				() =>
					management.issueApplicationCredential(
						actor(identity),
						context.req.param("applicationId"),
						{
							credential,
							recipient,
							scopes: body.scopes as ApiCredentialScopeV1[],
							expiresAt:
								body.expiresAt === null ? null : new Date(body.expiresAt),
							audit: apiAudit(identity, metadata, "api.credential.issued"),
						},
					),
				metadata.traceId,
			);
			const projection =
				recipient.kind === "user" && recipient.id === identity.userId
					? {
							metadata: apiCredentialProjection(
								issued.metadata,
								metadata.traceId,
							),
							credential,
						}
					: {
							metadata: apiCredentialProjection(
								issued.metadata,
								metadata.traceId,
							),
						};
			return context.json(
				ApiApplicationCredentialIssueProjectionV1Schema.parse(projection),
				201,
			);
		}),
	);

	app.delete(
		"/api/v1/applications/:applicationId/credentials/:credentialId",
		(context) =>
			boundary(context, async (metadata) => {
				const identity = await resolveIdentity(
					dependencies.identity,
					context.req.raw,
					metadata.traceId,
				);
				const management = apiIdentityOrUnavailable(
					dependencies.apiIdentity,
					metadata.traceId,
				);
				await queryOrUnavailable(
					() =>
						management.revokeApplicationCredential(
							actor(identity),
							context.req.param("applicationId"),
							context.req.param("credentialId"),
							new Date(),
							apiAudit(identity, metadata, "api.credential.revoked"),
						),
					metadata.traceId,
				);
				return new Response(null, { status: 204 });
			}),
	);

	app.post("/api/v1/agents/:agentId/grants", (context) =>
		boundary(context, async (metadata) => {
			const { identity, management, managementActor } =
				await resolveAgentGrantContext(
					dependencies,
					context.req.raw,
					metadata.traceId,
				);
			const { value: body } = await parseJson(
				context.req.raw,
				ApiAgentGrantRequestV1Schema,
				metadata.traceId,
			);
			const agentId = context.req.param("agentId");
			const authorizationRevision = await queryOrUnavailable(
				() =>
					management.grantAgent({
						actor: managementActor,
						agentId,
						principal: body.principal,
						grantType: body.grantType,
						audit: apiAudit(identity, metadata, "api.agent.grant.granted"),
					}),
				metadata.traceId,
			);
			return context.json(
				ApiAgentGrantProjectionV1Schema.parse({
					schemaVersion: 1,
					agentId,
					principal: body.principal,
					grantType: body.grantType,
					authorizationRevision,
					revokedAt: null,
				}),
			);
		}),
	);

	app.delete("/api/v1/agents/:agentId/grants", (context) =>
		boundary(context, async (metadata) => {
			const { identity, management, managementActor } =
				await resolveAgentGrantContext(
					dependencies,
					context.req.raw,
					metadata.traceId,
				);
			const { value: body } = await parseJson(
				context.req.raw,
				ApiAgentGrantRequestV1Schema,
				metadata.traceId,
			);
			const agentId = context.req.param("agentId");
			await queryOrUnavailable(
				() =>
					management.revokeAgentGrant({
						actor: managementActor,
						agentId,
						principal: body.principal,
						grantType: body.grantType,
						audit: apiAudit(identity, metadata, "api.agent.grant.revoked"),
					}),
				metadata.traceId,
			);
			return new Response(null, { status: 204 });
		}),
	);

	app.post("/api/v1/agents", (context) =>
		boundary(context, async (metadata) => {
			const apiIdentity = await resolveApiIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const management = apiIdentityOrUnavailable(
				dependencies.apiIdentity,
				metadata.traceId,
			);
			management.authorizeCredentialScope(apiActor(apiIdentity), [
				"agent:create",
			]);
			const { value: body, rawRequestDigest } = await parseJson(
				context.req.raw,
				AgentApplicationCreateRequestV2Schema,
				metadata.traceId,
			);
			const idempotencyKey = parseIdempotencyKey(
				context.req.raw,
				metadata.traceId,
			);
			const ids = allocateDeploymentDirectApplicationIds(
				apiIdentity.principal.kind,
				apiIdentity.principal.id,
				idempotencyKey,
			);
			const identity: IdentityContext = {
				schemaVersion: 1,
				userId: apiIdentity.ownerId,
				displayName: apiIdentity.principal.id,
				accountStatus: "active",
				organizationIds: apiIdentity.organizationIds,
				roles: [],
				authorizationRevision: apiIdentity.authorizationRevision,
				principal: apiIdentity.principal,
			};
			const prepared = await prepareApplicationInput(
				dependencies,
				body,
				identity,
				metadata,
				ids,
			);
			await dependencies.foundation.submit(
				{
					schemaVersion: 2,
					...ids,
					idempotencyKey,
					requestId: metadata.requestId,
					traceId: metadata.traceId,
					...applicationCommandFields(body, prepared, metadata.traceId),
					secrets: prepared.secrets,
					channels: [],
				},
				{
					schemaVersion: 1,
					userId: apiIdentity.ownerId,
					rawRequestDigest,
					principal: apiIdentity.principal,
					creationMode: "api",
				},
				prepared.attachment,
			);
			return context.json(
				{
					schemaVersion: 1,
					applicationId: ids.applicationId,
					agentId: ids.agentId,
					status: "creating",
				},
				201,
			);
		}),
	);

	app.post("/api/v1/agent-applications", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const { value: body, rawRequestDigest } = await parseJson(
				context.req.raw,
				AgentApplicationCreateRequestV1Schema,
				metadata.traceId,
			);
			const idempotencyKey = parseIdempotencyKey(
				context.req.raw,
				metadata.traceId,
			);
			let ids: Awaited<
				ReturnType<ManagementRouteDependencies["allocateApplicationIds"]>
			>;
			try {
				ids = await dependencies.allocateApplicationIds({
					identity,
					idempotencyKey,
				});
			} catch {
				fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			}
			const prepared = await prepareApplicationInput(
				dependencies,
				body,
				identity,
				metadata,
				ids,
			);
			await dependencies.foundation.submit(
				{
					schemaVersion: 2,
					...ids,
					idempotencyKey,
					requestId: metadata.requestId,
					traceId: metadata.traceId,
					...applicationCommandFields(body, prepared, metadata.traceId),
					secrets: prepared.secrets,
					channels: [],
				},
				{ schemaVersion: 1, userId: identity.userId, rawRequestDigest },
				prepared.attachment,
			);
			const application = await applicationOrUnavailable(
				dependencies,
				applicantScope(identity),
				ids.applicationId,
				metadata.traceId,
			);
			return context.json(
				await projectApplication(dependencies, application, identity, metadata),
				201,
			);
		}),
	);

	app.get("/api/v1/agent-applications", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const queryPage = pageInput(context.req.raw, metadata.traceId);
			const page = await queryOrUnavailable(
				() =>
					dependencies.query.listApplications(
						applicantScope(identity),
						queryPage,
					),
				metadata.traceId,
			);
			return context.json({
				items: await Promise.all(
					page.items.map((item) =>
						projectApplication(dependencies, item, identity, metadata),
					),
				),
				nextCursor: page.nextAfterId,
			});
		}),
	);

	app.get("/api/v1/agent-applications/:applicationId", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const application = await applicationOrUnavailable(
				dependencies,
				applicantScope(identity),
				context.req.param("applicationId"),
				metadata.traceId,
			);
			return context.json(
				await projectApplication(dependencies, application, identity, metadata),
			);
		}),
	);

	app.put("/api/v1/agent-applications/:applicationId", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const { value: body, rawRequestDigest } = await parseJson(
				context.req.raw,
				AgentApplicationUpdateRequestV1Schema,
				metadata.traceId,
			);
			const idempotencyKey = parseIdempotencyKey(
				context.req.raw,
				metadata.traceId,
			);
			const applicationId = context.req.param("applicationId");
			const current = await applicationOrUnavailable(
				dependencies,
				applicantScope(identity),
				applicationId,
				metadata.traceId,
			);
			const prepared = await prepareApplicationInput(
				dependencies,
				body,
				identity,
				metadata,
				{ applicationId, agentId: current.agentId },
			);
			await dependencies.revision.revise(
				{
					schemaVersion: 2,
					idempotencyKey,
					requestId: metadata.requestId,
					traceId: metadata.traceId,
					...applicationCommandFields(body, prepared, metadata.traceId),
					...(body.secrets === undefined ? {} : { secrets: prepared.secrets }),
				},
				{
					schemaVersion: 1,
					applicationId,
					userId: identity.userId,
					accountStatus: identity.accountStatus,
					organizationIds: identity.organizationIds,
					isAdministrator: identity.roles.includes("system_admin"),
					rawRequestDigest,
				},
				prepared.attachment,
			);
			const application = await applicationOrUnavailable(
				dependencies,
				applicantScope(identity),
				applicationId,
				metadata.traceId,
			);
			return context.json(
				await projectApplication(dependencies, application, identity, metadata),
			);
		}),
	);

	app.post("/api/v1/agent-applications/:applicationId/withdraw", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const applicationId = context.req.param("applicationId");
			const scope = applicantScope(identity);
			const current = await applicationOrUnavailable(
				dependencies,
				scope,
				applicationId,
				metadata.traceId,
			);
			await requireManagementAccepted(
				await dependencies.management.executeManagementCommand(
					{
						schemaVersion: 1,
						command: "withdraw_application",
						applicationId,
						expectedRevision: current.management.revision,
						idempotencyKey: parseIdempotencyKey(
							context.req.raw,
							metadata.traceId,
						),
						requestId: metadata.requestId,
						traceId: metadata.traceId,
					},
					actor(identity),
				),
				metadata.traceId,
			);
			const application = await applicationOrUnavailable(
				dependencies,
				scope,
				applicationId,
				metadata.traceId,
			);
			return context.json(
				await projectApplication(dependencies, application, identity, metadata),
			);
		}),
	);

	app.get("/api/v1/admin/agent-applications", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			requireAdministrator(identity, metadata.traceId);
			const queryPage = pageInput(context.req.raw, metadata.traceId);
			const page = await queryOrUnavailable(
				() =>
					dependencies.query.listApplications(
						{ kind: "administrator" },
						queryPage,
					),
				metadata.traceId,
			);
			return context.json({
				items: await Promise.all(
					page.items.map((item) =>
						projectApplication(dependencies, item, identity, metadata),
					),
				),
				nextCursor: page.nextAfterId,
			});
		}),
	);

	app.post(
		"/api/v1/admin/agent-applications/:applicationId/decision",
		(context) =>
			boundary(context, async (metadata) => {
				const identity = await resolveIdentity(
					dependencies.identity,
					context.req.raw,
					metadata.traceId,
				);
				requireAdministrator(identity, metadata.traceId);
				const { value: body } = await parseJson(
					context.req.raw,
					ApprovalDecisionRequestV1Schema,
					metadata.traceId,
				);
				const applicationId = context.req.param("applicationId");
				const scope = { kind: "administrator" as const };
				const current = await applicationOrUnavailable(
					dependencies,
					scope,
					applicationId,
					metadata.traceId,
				);
				const command =
					body.decision === "approve"
						? {
								schemaVersion: 1 as const,
								command: "approve_application" as const,
								applicationId,
								expectedRevision: current.management.revision,
								idempotencyKey: parseIdempotencyKey(
									context.req.raw,
									metadata.traceId,
								),
								requestId: metadata.requestId,
								traceId: metadata.traceId,
							}
						: {
								schemaVersion: 1 as const,
								command: "reject_application" as const,
								applicationId,
								expectedRevision: current.management.revision,
								idempotencyKey: parseIdempotencyKey(
									context.req.raw,
									metadata.traceId,
								),
								requestId: metadata.requestId,
								traceId: metadata.traceId,
								reason: body.reason,
							};
				await requireManagementAccepted(
					await dependencies.management.executeManagementCommand(
						command,
						actor(identity),
					),
					metadata.traceId,
				);
				const application = await applicationOrUnavailable(
					dependencies,
					scope,
					applicationId,
					metadata.traceId,
				);
				return context.json(
					await projectApplication(
						dependencies,
						application,
						identity,
						metadata,
					),
				);
			}),
	);

	app.get("/api/v1/agents", (context) =>
		boundary(context, async (metadata) => {
			const api = hasBearerCredential(context.req.raw)
				? await resolveApiIdentity(
						dependencies.identity,
						context.req.raw,
						metadata.traceId,
					)
				: null;
			const identity = api
				? apiIdentityContext(api)
				: await resolveIdentity(
						dependencies.identity,
						context.req.raw,
						metadata.traceId,
					);
			const queryPage = pageInput(context.req.raw, metadata.traceId);
			const scope = api
				? ({
						kind: "principal" as const,
						principal: api.principal,
						grantType: apiIdentityOrUnavailable(
							dependencies.apiIdentity,
							metadata.traceId,
						).resolveAgentQueryGrantType(apiActor(api)),
					} satisfies AgentManagementAgentScopeV1)
				: userScope(identity);
			const page = await queryOrUnavailable(
				() => dependencies.query.listAgents(scope, queryPage),
				metadata.traceId,
			);
			return context.json({
				items: await Promise.all(
					page.items.map((item) =>
						projectAgent(dependencies, item, identity, metadata),
					),
				),
				nextCursor: page.nextAfterId,
			});
		}),
	);

	app.get("/api/v1/agents/:agentId", (context) =>
		boundary(context, async (metadata) => {
			const api = hasBearerCredential(context.req.raw)
				? await resolveApiIdentity(
						dependencies.identity,
						context.req.raw,
						metadata.traceId,
					)
				: null;
			const identity = api
				? apiIdentityContext(api)
				: await resolveIdentity(
						dependencies.identity,
						context.req.raw,
						metadata.traceId,
					);
			const scope = api
				? ({
						kind: "principal" as const,
						principal: api.principal,
						grantType: apiIdentityOrUnavailable(
							dependencies.apiIdentity,
							metadata.traceId,
						).resolveAgentQueryGrantType(apiActor(api)),
					} satisfies AgentManagementAgentScopeV1)
				: userScope(identity);
			const agent = await agentOrUnavailable(
				dependencies,
				scope,
				context.req.param("agentId"),
				metadata.traceId,
			);
			return context.json(
				await projectAgent(dependencies, agent, identity, metadata),
			);
		}),
	);

	app.post("/api/v1/agents/:agentId/lifecycle", (context) =>
		boundary(context, async (metadata) => {
			const api = hasBearerCredential(context.req.raw)
				? await resolveApiIdentity(
						dependencies.identity,
						context.req.raw,
						metadata.traceId,
					)
				: null;
			const identity = api
				? apiIdentityContext(api)
				: await resolveIdentity(
						dependencies.identity,
						context.req.raw,
						metadata.traceId,
					);
			const { value: body, rawRequestDigest } = await parseJson(
				context.req.raw,
				AgentLifecycleCommandRequestV1Schema,
				metadata.traceId,
			);
			const agentId = context.req.param("agentId");
			const idempotencyKey = parseIdempotencyKey(
				context.req.raw,
				metadata.traceId,
			);
			if (api) {
				apiIdentityOrUnavailable(
					dependencies.apiIdentity,
					metadata.traceId,
				).authorizeCredentialScope(apiActor(api), ["agent:manage"]);
			}
			if (body.command === "upgrade_custom_image") {
				if (api) fail("FORBIDDEN", metadata.traceId);
				await dependencies.configuration.upgradeCustomImage(
					{
						schemaVersion: 1,
						agentId,
						imageReference: body.imageReference,
						idempotencyKey,
						requestId: metadata.requestId,
						traceId: metadata.traceId,
					},
					{
						schemaVersion: 1,
						actorId: identity.userId,
						rawRequestDigest,
					},
				);
				const projectionScope = identity.roles.includes("system_admin")
					? ({ kind: "administrator" } as const)
					: ownerScope(identity);
				const agent = await agentOrUnavailable(
					dependencies,
					projectionScope,
					agentId,
					metadata.traceId,
				);
				return context.json(
					await projectAgent(dependencies, agent, identity, metadata),
					202,
				);
			}
			const scope = api
				? ({
						kind: "principal" as const,
						principal: api.principal,
						grantType: "manage" as const,
					} satisfies AgentManagementAgentScopeV1)
				: identity.roles.includes("system_admin") &&
						(body.command === "disable" || body.command === "retry_creation")
					? ({ kind: "administrator" } as const)
					: ownerScope(identity);
			const current = await agentOrUnavailable(
				dependencies,
				scope,
				agentId,
				metadata.traceId,
			);
			if (api && body.command === "disable")
				fail("FORBIDDEN", metadata.traceId);
			if (
				api &&
				body.command === "start" &&
				current.management.status !== "stopped"
			)
				fail("CONFLICT", metadata.traceId);
			const commands = {
				stop: "stop_agent",
				restart: "restart_agent",
				start: "restart_agent",
				retry_creation: "retry_agent_creation",
				disable: "disable_agent",
			} as const;
			await requireManagementAccepted(
				await dependencies.management.executeManagementCommand(
					{
						schemaVersion: 1,
						command: commands[body.command],
						agentId,
						expectedRevision: current.management.revision,
						idempotencyKey,
						requestId: metadata.requestId,
						traceId: metadata.traceId,
					},
					actor(identity),
				),
				metadata.traceId,
			);
			const agent = await agentOrUnavailable(
				dependencies,
				scope,
				agentId,
				metadata.traceId,
			);
			return context.json(
				await projectAgent(dependencies, agent, identity, metadata),
				202,
			);
		}),
	);
}
