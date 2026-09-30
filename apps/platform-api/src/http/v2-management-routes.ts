import {
	AgentApplicationCreateRequestV2Schema,
	AgentApplicationCreateRequestV3Schema,
	AgentApplicationProjectionV1Schema,
	AgentApplicationProjectionV2Schema,
	AgentApplicationUpdateRequestV2Schema,
	AgentDefaultRelayKeyReplaceRequestV1Schema,
	AgentDirectCreationProjectionV2Schema,
	AgentLifecycleCommandRequestV1Schema,
	AgentProjectionV1Schema,
	AgentProjectionV2Schema,
	ApprovalDecisionRequestV1Schema,
} from "@agent-infra/contracts/pilot";
import { ModelConfigurationErrorV1 } from "@agent-infra/model-catalog";
import type {
	AgentConfigurationModelInputV1,
	AgentConfigurationUseCaseV1,
	AgentDefaultModelAdmissionV1,
	AgentDefaultRelayKeyActorV1,
	AgentDefaultRelayKeyAttachmentV1,
	AgentManagementActorContextV1,
	AgentManagementInterfaceV1,
	ApiCredentialScopeV1,
	ApiIdentityAccessAuditContextV1,
	ApiIdentityManagementInterfaceV1,
	ApplicationCreationPreparedInputV1,
	ApplicationFoundationUseCaseV1,
	ApplicationRevisionUseCaseV1,
	createAgentDefaultRelayKeyUseCaseV1,
	PendingSecretRecordAttachmentResolverV1,
} from "@agent-infra/platform-core";
import {
	AgentConfigurationError,
	AgentDefaultRelayKeyErrorV1,
	isAgentAdministratorListAllowedV1,
	isApiAgentLifecycleCommandAllowedV1,
	isSameApiCreationAuthorityV1,
} from "@agent-infra/platform-core";
import type {
	AgentManagementAgentProjectionV1,
	AgentManagementAgentScopeV1,
	AgentManagementApplicationProjectionV1,
	AgentManagementApplicationScopeV1,
	AgentManagementPageInputV1,
	AgentManagementPageV1,
} from "@agent-infra/platform-store";
import type { RelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import type { Context, Hono } from "hono";
import { allocateDeploymentDirectApplicationIds } from "../deployment-identity.js";
import { parsePendingSecretRecordAttachmentResolverV1 } from "../secret-preparation.js";
import {
	HttpProtocolError,
	type JsonSchema,
	parseIdempotencyKey,
	parseJson,
	parsePageQuery,
	type RequestMetadata,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import {
	projectApiIdentityActor as apiActor,
	projectApiIdentityContext as apiIdentityContext,
	type IdentityAdapter,
	type IdentityContext,
	resolveApiIdentity,
	resolveIdentity,
} from "./identity.js";

type ApplicationProjection = ReturnType<
	typeof AgentApplicationProjectionV2Schema.parse
>;
type AgentProjection = ReturnType<typeof AgentProjectionV2Schema.parse>;
type ApplicationCreateInput = ReturnType<
	typeof AgentApplicationCreateRequestV2Schema.parse
>;
type ApplicationCreateInputV3 = ReturnType<
	typeof AgentApplicationCreateRequestV3Schema.parse
>;
type ApplicationUpdateInput = ReturnType<
	typeof AgentApplicationUpdateRequestV2Schema.parse
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

export type SecretPreparationResult = ApplicationCreationPreparedInputV1;

export interface ManagementRouteDependencies {
	readonly identity: IdentityAdapter;
	readonly foundation: Pick<
		ApplicationFoundationUseCaseV1,
		"submit" | "prepareApiCreation" | "prepareWebCreation"
	>;
	readonly revision: Pick<ApplicationRevisionUseCaseV1, "revise">;
	readonly management: Pick<
		AgentManagementInterfaceV1,
		"executeManagementCommand"
	>;
	readonly apiIdentity?: ApiIdentityManagementInterfaceV1;
	readonly agentDefaultRelayKeyEncryptor?: RelayKeyEncryptorV1;
	readonly agentDefaultRelayKey?: ReturnType<
		typeof createAgentDefaultRelayKeyUseCaseV1
	>;
	readonly admitAgentDefaultModels?: (
		input: Parameters<AgentDefaultModelAdmissionV1["admitModels"]>[0] & {
			readonly requested: NonNullable<
				ApplicationCreateInputV3["modelSelection"]
			>;
			readonly candidateRelayKey: string;
		},
	) => ReturnType<AgentDefaultModelAdmissionV1["admitModels"]>;
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

function actor(
	identity: IdentityContext,
	apiAuthority?: AgentManagementActorContextV1["apiAuthority"],
): AgentManagementActorContextV1 {
	return {
		schemaVersion: 1,
		userId: identity.userId,
		accountStatus: identity.accountStatus,
		organizationIds: identity.organizationIds,
		isAdministrator: identity.roles.includes("system_admin"),
		...(identity.principal === undefined
			? {}
			: { principal: identity.principal }),
		...(apiAuthority === undefined ? {} : { apiAuthority }),
	};
}

function hasAuthorizationHeader(request: Request): boolean {
	return request.headers.has("authorization");
}

function apiManagementOrUnavailable(
	management: ApiIdentityManagementInterfaceV1 | undefined,
	traceId: string,
): ApiIdentityManagementInterfaceV1 {
	if (!management) fail("DEPENDENCY_UNAVAILABLE", traceId);
	return management;
}

function apiAccessAudit(
	identity: IdentityContext,
	metadata: RequestMetadata,
	targetId: string,
	reason: ApiIdentityAccessAuditContextV1["reason"],
	requiredScopes?: readonly ApiCredentialScopeV1[],
): ApiIdentityAccessAuditContextV1 {
	if (!identity.principal) fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	return {
		audit: {
			traceId: metadata.traceId,
			requestId: metadata.requestId,
			actor: identity.principal,
			action: "api.access.rejected",
		},
		targetId,
		reason,
		...(requiredScopes === undefined ? {} : { requiredScopes }),
	};
}

async function resolveRequestIdentity(
	dependencies: ManagementRouteDependencies,
	request: Request,
	traceId: string,
): Promise<{
	readonly identity: IdentityContext;
	readonly api?: Awaited<ReturnType<typeof resolveApiIdentity>>;
}> {
	if (!hasAuthorizationHeader(request)) {
		return {
			identity: await resolveIdentity(dependencies.identity, request, traceId),
		};
	}
	const api = await resolveApiIdentity(dependencies.identity, request, traceId);
	return { api, identity: apiIdentityContext(api) };
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
	additionalQueryKeys: readonly string[] = [],
): AgentManagementPageInputV1 {
	const url = new URL(request.url);
	for (const key of additionalQueryKeys) url.searchParams.delete(key);
	const page = parsePageQuery(new Request(url), traceId);
	return {
		limit: page.limit ?? 50,
		...(page.cursor === undefined ? {} : { afterId: page.cursor }),
	};
}

function agentListScope(request: Request, traceId: string): "user" | "owner" {
	const values = new URL(request.url).searchParams.getAll("scope");
	if (values.length === 0) return "user";
	if (values.length !== 1 || values[0] !== "owner") {
		fail("INVALID_REQUEST", traceId);
	}
	return "owner";
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
	} catch {
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
	const { actions: _actions, ...configuration } = parsed.data.configuration;
	return AgentApplicationProjectionV2Schema.parse({
		...parsed.data,
		schemaVersion: 2,
		configuration,
	});
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
	const { actions: _actions, ...configuration } = parsed.data.configuration;
	return AgentProjectionV2Schema.parse({
		...parsed.data,
		schemaVersion: 2,
		configuration,
	});
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
	onDenied?: () => Promise<void>,
): Promise<AgentManagementAgentProjectionV1> {
	const agent = await queryOrUnavailable(
		() => dependencies.query.getAgent(scope, agentId),
		traceId,
	);
	if (!agent) {
		await onDenied?.();
		fail("RESOURCE_UNAVAILABLE", traceId);
	}
	return agent;
}

function modelInput(
	prepared: SecretPreparationResult,
	body: ApplicationCreateInput | ApplicationUpdateInput,
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
	body: ApplicationCreateInput | ApplicationUpdateInput,
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
	body: ApplicationCreateInput | ApplicationUpdateInput,
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

function legacyPreparationBody(
	body: ApplicationCreateInputV3,
): ApplicationCreateInput {
	const {
		agentDefaultRelayKey: _key,
		modelSelection: _selection,
		...fields
	} = body;
	return { ...fields, schemaVersion: 2 };
}

function agentDefaultKeyAttachment(
	dependencies: ManagementRouteDependencies,
	body: ApplicationCreateInputV3,
	traceId: string,
): AgentDefaultRelayKeyAttachmentV1 | undefined {
	if (body.source.kind !== "standard") return undefined;
	const candidateRelayKey = body.agentDefaultRelayKey;
	const requested = body.modelSelection;
	if (!candidateRelayKey || !requested) fail("INVALID_REQUEST", traceId);
	return {
		async admitModels(input) {
			const admit = dependencies.admitAgentDefaultModels;
			if (!admit) throw new AgentConfigurationError("dependency_unavailable");
			try {
				return await admit({ ...input, requested, candidateRelayKey });
			} catch (error) {
				if (error instanceof ModelConfigurationErrorV1)
					throw new AgentConfigurationError(
						error.retryable ? "dependency_unavailable" : "not_admitted",
					);
				throw error;
			}
		},
		encrypt(binding) {
			const encryptor = dependencies.agentDefaultRelayKeyEncryptor;
			if (!encryptor)
				throw new AgentConfigurationError("dependency_unavailable");
			return encryptor.encrypt({ ...binding, plaintext: candidateRelayKey });
		},
	};
}

function createApplication(
	context: Context,
	dependencies: ManagementRouteDependencies,
	schema: JsonSchema<ApplicationCreateInput | ApplicationCreateInputV3>,
): Promise<Response> {
	return boundary(context, async (metadata) => {
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			metadata.traceId,
		);
		const { value: body, rawRequestDigest } = await parseJson(
			context.req.raw,
			schema,
			metadata.traceId,
		);
		if (body.schemaVersion === 2 && body.source.kind === "standard")
			fail("INVALID_REQUEST", metadata.traceId);
		const preparationBody =
			body.schemaVersion === 3 ? legacyPreparationBody(body) : body;
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
		const applicant = {
			schemaVersion: 1 as const,
			userId: identity.userId,
			rawRequestDigest,
		};
		const preparation = await dependencies.foundation.prepareWebCreation(
			{ schemaVersion: 1, ...ids, idempotencyKey },
			applicant,
			() =>
				prepareApplicationInput(
					dependencies,
					preparationBody,
					identity,
					metadata,
					ids,
				),
		);
		if (preparation.outcome === "replayed") {
			const replayed = preparation.result;
			if (
				replayed.applicationId !== ids.applicationId ||
				replayed.agentId !== ids.agentId ||
				replayed.status !== "pending_approval"
			)
				fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
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
		}
		const prepared = preparation.prepared;
		const attachment =
			body.schemaVersion === 3
				? agentDefaultKeyAttachment(dependencies, body, metadata.traceId)
				: undefined;
		await dependencies.foundation.submit(
			{
				schemaVersion: 2,
				...ids,
				idempotencyKey,
				requestId: metadata.requestId,
				traceId: metadata.traceId,
				...applicationCommandFields(
					preparationBody,
					prepared,
					metadata.traceId,
				),
				secrets: prepared.secrets,
				channels: [],
			},
			applicant,
			prepared.attachment,
			attachment,
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
	});
}

export function registerV2ManagementRoutes(
	app: Hono,
	dependencies: ManagementRouteDependencies,
): void {
	async function defaultKeyResponse(
		context: Context,
		work: (
			actor: AgentDefaultRelayKeyActorV1,
			agentId: string,
			metadata: RequestMetadata,
			keys: NonNullable<ManagementRouteDependencies["agentDefaultRelayKey"]>,
		) => Promise<unknown>,
	): Promise<Response> {
		const metadata = requestMetadata(context.req.raw);
		const agentId = context.req.param("agentId");
		if (!agentId) fail("INVALID_REQUEST", metadata.traceId);
		let actorUserId: string | null = null;
		try {
			const { identity, api } = await resolveRequestIdentity(
				dependencies,
				context.req.raw,
				metadata.traceId,
			);
			actorUserId = identity.userId;
			if (api)
				await apiManagementOrUnavailable(
					dependencies.apiIdentity,
					metadata.traceId,
				).authorizeCredentialScope(
					apiActor(api),
					["agent:manage"],
					apiAccessAudit(identity, metadata, agentId, "missing_scope", [
						"agent:manage",
					]),
				);
			const keys = dependencies.agentDefaultRelayKey;
			if (!keys) fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			return context.json(
				await work(
					{
						userId: identity.userId,
						accountStatus: identity.accountStatus,
						...(api
							? {
									principal: api.principal,
									credential: api.credential,
									identityRevision: api.authorizationRevision,
								}
							: {}),
					},
					agentId,
					metadata,
					keys,
				),
			);
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			try {
				if (
					error instanceof AgentDefaultRelayKeyErrorV1 &&
					error.code === "conflict"
				)
					return context.json(protocol.body, protocol.status);
				if (!dependencies.agentDefaultRelayKey)
					throw new Error("Agent default Relay Key audit is unavailable");
				await dependencies.agentDefaultRelayKey.recordRejected({
					agentId,
					actorUserId,
					traceId: metadata.traceId,
					requestId: metadata.requestId,
					reason: protocol.body.code,
					outcome: protocol.status < 500 ? "rejected" : "failed",
				});
			} catch {
				const unavailable = new HttpProtocolError(
					"DEPENDENCY_UNAVAILABLE",
					metadata.traceId,
				);
				return context.json(unavailable.body, unavailable.status);
			}
			return context.json(protocol.body, protocol.status);
		}
	}

	app.post("/api/v2/agent-applications", (context) =>
		createApplication(
			context,
			dependencies,
			AgentApplicationCreateRequestV2Schema,
		),
	);
	app.post("/api/v2/agent-applications/default-key", (context) =>
		createApplication(
			context,
			dependencies,
			AgentApplicationCreateRequestV3Schema,
		),
	);

	app.get("/api/v2/agent-applications", (context) =>
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

	app.get("/api/v2/agent-applications/:applicationId", (context) =>
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

	app.put("/api/v2/agent-applications/:applicationId", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const { value: body, rawRequestDigest } = await parseJson(
				context.req.raw,
				AgentApplicationUpdateRequestV2Schema,
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

	app.post("/api/v2/agent-applications/:applicationId/withdraw", (context) =>
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

	app.get("/api/v2/admin/agent-applications", (context) =>
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
		"/api/v2/admin/agent-applications/:applicationId/decision",
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

	// Direct creation is an API-principal operation. Browser sessions must use
	// the application workflow above and never inherit this authority.
	app.post("/api/v2/agents", (context) =>
		boundary(context, async (metadata) => {
			const apiIdentity = await resolveApiIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const management = apiManagementOrUnavailable(
				dependencies.apiIdentity,
				metadata.traceId,
			);
			const initialIdentity = apiIdentityContext(apiIdentity);
			await management.authorizeCredentialScope(
				apiActor(apiIdentity),
				["agent:create"],
				apiAccessAudit(initialIdentity, metadata, "agents", "missing_scope", [
					"agent:create",
				]),
			);
			const { value: body, rawRequestDigest } = await parseJson(
				context.req.raw,
				AgentApplicationCreateRequestV3Schema,
				metadata.traceId,
			);
			const preparationBody = legacyPreparationBody(body);
			const idempotencyKey = parseIdempotencyKey(
				context.req.raw,
				metadata.traceId,
			);
			const ids = allocateDeploymentDirectApplicationIds(
				apiIdentity.principal.kind,
				apiIdentity.principal.id,
				idempotencyKey,
			);
			const preparation = await dependencies.foundation.prepareApiCreation(
				{ schemaVersion: 1, ...ids, idempotencyKey },
				{
					schemaVersion: 1,
					userId: apiIdentity.ownerId,
					rawRequestDigest,
					principal: apiIdentity.principal,
					creationMode: "api",
					apiAuthority: {
						credentialId: apiIdentity.credential.credentialId,
						identityRevision: apiIdentity.authorizationRevision,
					},
				},
				() =>
					prepareApplicationInput(
						dependencies,
						preparationBody,
						initialIdentity,
						metadata,
						ids,
					),
			);
			if (preparation.outcome === "replayed") {
				const replayed = preparation.result;
				if (
					replayed.applicationId !== ids.applicationId ||
					replayed.agentId !== ids.agentId ||
					replayed.status !== "creating"
				)
					fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
				return context.json(
					AgentDirectCreationProjectionV2Schema.parse({
						schemaVersion: 2,
						applicationId: replayed.applicationId,
						agentId: replayed.agentId,
						status: replayed.status,
					}),
					201,
				);
			}
			const prepared = preparation.prepared;
			const currentApiIdentity = await resolveApiIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			if (!isSameApiCreationAuthorityV1(apiIdentity, currentApiIdentity))
				fail("FORBIDDEN", metadata.traceId);
			await management.authorizeCredentialScope(
				apiActor(currentApiIdentity),
				["agent:create"],
				apiAccessAudit(
					apiIdentityContext(currentApiIdentity),
					metadata,
					"agents",
					"missing_scope",
					["agent:create"],
				),
			);
			const agentDefaultRelayKey = agentDefaultKeyAttachment(
				dependencies,
				body,
				metadata.traceId,
			);
			const result = await dependencies.foundation.submit(
				{
					schemaVersion: 2,
					...ids,
					idempotencyKey,
					requestId: metadata.requestId,
					traceId: metadata.traceId,
					...applicationCommandFields(
						preparationBody,
						prepared,
						metadata.traceId,
					),
					secrets: prepared.secrets,
					channels: [],
				},
				{
					schemaVersion: 1,
					userId: currentApiIdentity.ownerId,
					rawRequestDigest,
					principal: currentApiIdentity.principal,
					creationMode: "api",
					apiAuthority: {
						credentialId: currentApiIdentity.credential.credentialId,
						identityRevision: currentApiIdentity.authorizationRevision,
					},
				},
				prepared.attachment,
				agentDefaultRelayKey,
			);
			if (
				result.applicationId !== ids.applicationId ||
				result.agentId !== ids.agentId ||
				result.status !== "creating"
			)
				fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			return context.json(
				AgentDirectCreationProjectionV2Schema.parse({
					schemaVersion: 2,
					applicationId: result.applicationId,
					agentId: result.agentId,
					status: result.status,
				}),
				201,
			);
		}),
	);

	app.get("/api/v2/agents", (context) =>
		boundary(context, async (metadata) => {
			const { identity, api } = await resolveRequestIdentity(
				dependencies,
				context.req.raw,
				metadata.traceId,
			);
			if (api) {
				if (new URL(context.req.raw.url).searchParams.has("scope"))
					fail("INVALID_REQUEST", metadata.traceId);
				const management = apiManagementOrUnavailable(
					dependencies.apiIdentity,
					metadata.traceId,
				);
				const grantType = await management.resolveAgentQueryGrantType(
					apiActor(api),
					apiAccessAudit(identity, metadata, "agents", "missing_scope", [
						"agent:read",
					]),
				);
				const queryPage = pageInput(context.req.raw, metadata.traceId);
				const page = await queryOrUnavailable(
					() =>
						dependencies.query.listAgents(
							{ kind: "principal", principal: api.principal, grantType },
							queryPage,
						),
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
			}
			const scope = agentListScope(context.req.raw, metadata.traceId);
			const queryPage = pageInput(context.req.raw, metadata.traceId, ["scope"]);
			const page = await queryOrUnavailable(
				() =>
					dependencies.query.listAgents(
						scope === "owner" ? ownerScope(identity) : userScope(identity),
						queryPage,
					),
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

	app.get("/api/v2/admin/agents", (context) =>
		boundary(context, async (metadata) => {
			if (hasAuthorizationHeader(context.req.raw))
				fail("AUTHENTICATION_REQUIRED", metadata.traceId);
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			if (!isAgentAdministratorListAllowedV1(identity))
				fail("FORBIDDEN", metadata.traceId);
			const page = await queryOrUnavailable(
				() =>
					dependencies.query.listAgents(
						{ kind: "administrator" },
						pageInput(context.req.raw, metadata.traceId),
					),
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

	app.get("/api/v2/agents/:agentId", (context) =>
		boundary(context, async (metadata) => {
			const { identity, api } = await resolveRequestIdentity(
				dependencies,
				context.req.raw,
				metadata.traceId,
			);
			const agentId = context.req.param("agentId");
			const scope = api
				? {
						kind: "principal" as const,
						principal: api.principal,
						grantType: await apiManagementOrUnavailable(
							dependencies.apiIdentity,
							metadata.traceId,
						).resolveAgentQueryGrantType(
							apiActor(api),
							apiAccessAudit(identity, metadata, agentId, "missing_scope", [
								"agent:read",
							]),
						),
					}
				: userScope(identity);
			const agent = await agentOrUnavailable(
				dependencies,
				scope,
				agentId,
				metadata.traceId,
				api
					? async () =>
							await apiManagementOrUnavailable(
								dependencies.apiIdentity,
								metadata.traceId,
							).recordAccessRejection(
								apiActor(api),
								apiAccessAudit(
									identity,
									metadata,
									agentId,
									"resource_unavailable",
								),
							)
					: undefined,
			);
			return context.json(
				await projectAgent(dependencies, agent, identity, metadata),
			);
		}),
	);

	app.get("/api/v2/agents/:agentId/default-relay-key", (context) =>
		defaultKeyResponse(context, (identity, agentId, metadata, keys) =>
			keys.current(identity, agentId, metadata.traceId, metadata.requestId),
		),
	);
	app.put("/api/v2/agents/:agentId/default-relay-key", (context) =>
		defaultKeyResponse(context, async (identity, agentId, metadata, keys) => {
			const { value } = await parseJson(
				context.req.raw,
				AgentDefaultRelayKeyReplaceRequestV1Schema,
				metadata.traceId,
			);
			return keys.replace(
				identity,
				agentId,
				value,
				metadata.traceId,
				metadata.requestId,
			);
		}),
	);

	app.post("/api/v2/agents/:agentId/lifecycle", (context) =>
		boundary(context, async (metadata) => {
			const { identity, api } = await resolveRequestIdentity(
				dependencies,
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
				const management = apiManagementOrUnavailable(
					dependencies.apiIdentity,
					metadata.traceId,
				);
				await management.authorizeCredentialScope(
					apiActor(api),
					["agent:manage"],
					apiAccessAudit(
						identity,
						metadata,
						context.req.param("agentId"),
						"missing_scope",
						["agent:manage"],
					),
				);
				if (!isApiAgentLifecycleCommandAllowedV1(body.command)) {
					await management.recordAccessRejection(
						apiActor(api),
						apiAccessAudit(
							identity,
							metadata,
							context.req.param("agentId"),
							"operation_forbidden",
						),
					);
					fail("FORBIDDEN", metadata.traceId);
				}
			}
			if (body.command === "upgrade_custom_image") {
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
						...(api ? { principal: api.principal } : {}),
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
				? {
						kind: "principal" as const,
						principal: api.principal,
						grantType: "manage" as const,
					}
				: identity.roles.includes("system_admin") &&
						(body.command === "disable" || body.command === "retry_creation")
					? ({ kind: "administrator" } as const)
					: ownerScope(identity);
			const current = await agentOrUnavailable(
				dependencies,
				scope,
				agentId,
				metadata.traceId,
				api
					? async () =>
							await apiManagementOrUnavailable(
								dependencies.apiIdentity,
								metadata.traceId,
							).recordAccessRejection(
								apiActor(api),
								apiAccessAudit(
									identity,
									metadata,
									agentId,
									"resource_unavailable",
								),
							)
					: undefined,
			);
			const commands = {
				start: "start_agent",
				stop: "stop_agent",
				restart: "restart_agent",
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
					actor(
						identity,
						api
							? {
									credentialId: api.credential.credentialId,
									identityRevision: api.authorizationRevision,
								}
							: undefined,
					),
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
