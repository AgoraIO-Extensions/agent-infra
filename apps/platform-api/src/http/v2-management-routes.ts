import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	AgentApiLifecycleAcceptedResponseV1Schema,
	AgentApplicationCreateRequestV2Schema,
	AgentApplicationModelCandidatesRequestV2Schema,
	AgentApplicationModelCandidatesResponseV2Schema,
	AgentApplicationProjectionV1Schema,
	AgentApplicationProjectionV2Schema,
	AgentApplicationUpdateRequestV2Schema,
	AgentCreationFailureProjectionV1Schema,
	AgentDetailProjectionV1Schema,
	AgentLifecycleCommandRequestV1Schema,
	AgentProjectionV1Schema,
	AgentProjectionV2Schema,
	ApprovalDecisionRequestV1Schema,
	PersonalApiIdentityV1Schema,
} from "@agent-infra/contracts/pilot";
import { recordHttpFailureContext } from "@agent-infra/observability/http";
import type {
	AgentConfigurationModelInputV1,
	AgentConfigurationSecretReplacementInputV1,
	AgentConfigurationUseCaseV1,
	AgentManagementActorContextV1,
	AgentManagementInterfaceV1,
	ApplicationFoundationUseCaseV1,
	ApplicationRevisionUseCaseV1,
	CurrentTaskUserV1,
	createApplicationModelCandidatesUseCaseV1,
	PendingSecretRecordAttachmentResolverV1,
	PersonalApiAgentReadUseCaseV1,
	WorkloadFailureReasonCodeV1,
} from "@agent-infra/platform-core";
import {
	agentCreationFailureCategoryV1,
	isAdministratorAgentReadAllowedV1,
	isAgentCreationFailureReadAllowedV1,
	PersonalApiCredentialErrorV1,
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
import { parsePendingSecretRecordAttachmentResolverV1 } from "../secret-preparation.js";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	parsePageQuery,
	type RequestMetadata,
	requestMetadata,
	StaleProjectionError,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import { parseDefaultRelayKeyReplacement } from "./default-relay-key-replacement.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity,
} from "./identity.js";

type ApplicationProjection = ReturnType<
	typeof AgentApplicationProjectionV2Schema.parse
>;
type AgentProjection = ReturnType<typeof AgentProjectionV2Schema.parse>;
type AgentDetailProjection = ReturnType<
	typeof AgentDetailProjectionV1Schema.parse
>;
type ApplicationCreateInput = ReturnType<
	typeof AgentApplicationCreateRequestV2Schema.parse
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
	readonly requestScope?: object;
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
	readonly personalApiAgentRead?: PersonalApiAgentReadUseCaseV1;
	readonly readApiAgentProjection?: (
		input: RequestMetadata & {
			readonly apiUser: CurrentTaskUserV1;
			readonly agent: AgentManagementAgentProjectionV1;
			readonly requestScope?: object;
		},
	) => Promise<unknown>;
	readonly foundation: Pick<ApplicationFoundationUseCaseV1, "submit">;
	readonly applicationModelCandidates?: ReturnType<
		typeof createApplicationModelCandidatesUseCaseV1
	>;
	readonly revision: Pick<ApplicationRevisionUseCaseV1, "revise">;
	readonly management: Pick<
		AgentManagementInterfaceV1,
		"executeManagementCommand"
	>;
	readonly configuration: Pick<
		AgentConfigurationUseCaseV1,
		"upgradeCustomImage"
	> &
		Partial<Pick<AgentConfigurationUseCaseV1, "upgradeCustomManifest">>;
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
	readonly validateDefaultRelayKey?: (
		keyValue: string,
	) => Promise<"valid" | "invalid" | "unavailable">;
	readonly enforceDefaultRelayKey?: boolean;
	readonly readApplicationProjection: (
		input: ProjectionInput<AgentManagementApplicationProjectionV1>,
	) => Promise<unknown>;
	readonly readAgentProjection: (
		input: ProjectionInput<AgentManagementAgentProjectionV1>,
	) => Promise<unknown>;
	/** Agent 详情（#2910）：Owner 附带当前有效状态；未装配时详情入口返回依赖不可用。 */
	readonly readAgentDetailProjection?: (
		input: ProjectionInput<AgentManagementAgentProjectionV1>,
	) => Promise<unknown>;
	/** 创建失败类别（#3034）：Workload 最近一次失败的有界原因码；未装配时入口返回依赖不可用。 */
	readonly readWorkloadFailureReason?: (
		agentId: string,
	) => Promise<WorkloadFailureReasonCodeV1 | null>;
}

function actor(identity: IdentityContext): AgentManagementActorContextV1 {
	return {
		schemaVersion: 1,
		userId: identity.userId,
		accountStatus: identity.accountStatus,
		organizationIds: identity.organizationIds,
		isAdministrator: identity.roles.includes("system_admin"),
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

const personalApiIdentityHeaders = [
	"x-user-id",
	"x-application-id",
	"x-principal",
	"x-principal-id",
	"x-recipient",
	"x-recipient-user-id",
	"x-role",
	"x-roles",
	"x-scope",
	"x-agent-id",
	"x-identity-context",
];

async function personalBearerRead(
	request: Request,
	metadata: RequestMetadata,
	reader: PersonalApiAgentReadUseCaseV1 | undefined,
	action: "api.agent.metadata.read" | "api.credential.identity.read",
) {
	const matched = /^Bearer (papi_[A-Za-z0-9_-]{43})$/.exec(
		request.headers.get("Authorization") ?? "",
	);
	if (!matched || request.headers.has("Cookie")) {
		await reader?.recordRefusal(metadata, "authentication_required", action);
		fail("AUTHENTICATION_REQUIRED", metadata.traceId);
	}
	if (!reader || !matched[1]) fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	if (
		new URL(request.url).search ||
		request.body !== null ||
		personalApiIdentityHeaders.some((name) => request.headers.has(name))
	) {
		await reader.recordRefusal(metadata, "invalid_input", action);
		fail("INVALID_REQUEST", metadata.traceId);
	}
	return { reader, material: matched[1] };
}

async function projectApiAgent(
	dependencies: ManagementRouteDependencies,
	metadata: RequestMetadata,
	apiUser: CurrentTaskUserV1,
	agent: AgentManagementAgentProjectionV1,
) {
	const project = dependencies.readApiAgentProjection;
	if (!project) fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	const value = await project({
		...metadata,
		apiUser,
		agent,
		requestScope: metadata,
	});
	const parsed = AgentProjectionV1Schema.safeParse(value);
	if (!parsed.success) fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	const { actions: _actions, ...configuration } = parsed.data.configuration;
	return AgentProjectionV2Schema.parse({
		...parsed.data,
		schemaVersion: 2,
		configuration,
	});
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
			requestScope: metadata,
			...metadata,
		});
	} catch (error) {
		recordHttpFailureContext({ failureStep: "projection.read", error });
		// 快照过期原样抛出，由读取路由决定是否重读（#2661）。
		if (error instanceof StaleProjectionError) throw error;
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
			requestScope: metadata,
			...metadata,
		});
	} catch (error) {
		recordHttpFailureContext({ failureStep: "projection.read", error });
		// 快照过期原样抛出，由读取路由决定是否重读（#2661）。
		if (error instanceof StaleProjectionError) throw error;
		fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	}
	const parsed = AgentProjectionV1Schema.safeParse(value);
	if (!parsed.success) fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	const { actions: _actions, ...configuration } = parsed.data.configuration;
	// 只有当前 Owner 能经浏览器会话授予或撤销用户 API 授权（工程 Spec），管理修订号也只给 Owner（#3070）。
	const owner = agent.management.ownerIds.includes(identity.userId);
	return AgentProjectionV2Schema.parse({
		...parsed.data,
		schemaVersion: 2,
		configuration,
		...(owner ? { managementRevision: agent.management.revision } : {}),
	});
}

async function projectAgentDetail(
	dependencies: ManagementRouteDependencies,
	agent: AgentManagementAgentProjectionV1,
	identity: IdentityContext,
	metadata: RequestMetadata,
): Promise<AgentDetailProjection> {
	const read = dependencies.readAgentDetailProjection;
	if (!read) fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	let value: unknown;
	try {
		value = await read({
			agent,
			identity,
			requestScope: metadata,
			...metadata,
		});
	} catch (error) {
		recordHttpFailureContext({ failureStep: "projection.read", error });
		// 快照过期原样抛出，由读取路由决定是否重读（#2661）。
		if (error instanceof StaleProjectionError) throw error;
		fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	}
	const parsed = AgentDetailProjectionV1Schema.safeParse(value);
	if (!parsed.success || parsed.data.agentId !== agent.agentId)
		fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
	return parsed.data;
}

/**
 * 投影期间快照过期时最多重读几次（#2661）。一次重读只重新投影变化了的项，窗口只有几十毫秒，
 * 而 Agent 的状态变化（命令、Worker 观测）通常间隔数百毫秒以上，两次足够收敛。
 */
const STALE_PROJECTION_REREADS = 2;

/**
 * 读取一页并逐项投影。某一项的快照在投影期间过期（读取之后 Agent 的状态或配置刚变化）时，
 * 用同一个查询（同一可见范围、同一分页参数）重读这一页再投影，最多重读
 * STALE_PROJECTION_REREADS 次（#2661）：
 * - 重读后不在这一页里的项不再出现，不会扩大可见范围；
 * - 快照没有变化的项沿用上一轮的投影（列表各项本来就是分别投影的），只重新投影变化了的项；
 * - 其他失败照旧直接失败，不重读。
 */
async function projectPage<Item, Projection>(
	read: () => Promise<AgentManagementPageV1<Item>>,
	key: (item: Item) => string,
	project: (item: Item) => Promise<Projection>,
): Promise<{
	items: Projection[];
	nextCursor: AgentManagementPageV1<Item>["nextAfterId"];
}> {
	const projected = new Map<string, { item: Item; projection: Projection }>();
	for (let rereads = 0; ; rereads += 1) {
		const page = await read();
		// 等全部投影结束再决定：不让上一轮还在进行的投影和重读叠在一起。
		const settled = await Promise.allSettled(
			page.items.map(async (item) => {
				const previous = projected.get(key(item));
				if (previous && isDeepStrictEqual(previous.item, item)) {
					return previous.projection;
				}
				const projection = await project(item);
				projected.set(key(item), { item, projection });
				return projection;
			}),
		);
		const items: Projection[] = [];
		let stale: StaleProjectionError | undefined;
		for (const result of settled) {
			if (result.status === "fulfilled") items.push(result.value);
			else if (result.reason instanceof StaleProjectionError)
				stale ??= result.reason;
			else throw result.reason;
		}
		if (!stale) return { items, nextCursor: page.nextAfterId };
		if (rereads >= STALE_PROJECTION_REREADS) throw stale;
	}
}

/** 单项读取：快照过期时用同一个查询重读再投影，上限与列表相同（#2661）。 */
async function projectCurrent<Item, Projection>(
	read: () => Promise<Item>,
	project: (item: Item) => Promise<Projection>,
): Promise<Projection> {
	for (let rereads = 0; ; rereads += 1) {
		const item = await read();
		try {
			return await project(item);
		} catch (error) {
			if (
				!(error instanceof StaleProjectionError) ||
				rereads >= STALE_PROJECTION_REREADS
			)
				throw error;
		}
	}
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
	const preparedModelConfiguration = modelInput(prepared, body, traceId);
	const keyless =
		body.source.kind === "standard" &&
		"defaultRelayKey" in body &&
		body.defaultRelayKey !== undefined;
	const modelConfiguration =
		keyless && preparedModelConfiguration
			? {
					...preparedModelConfiguration,
					options: preparedModelConfiguration.options.map(
						({ replaceCredential: _replaceCredential, ...option }) => option,
					),
				}
			: preparedModelConfiguration;
	return {
		name: body.name,
		description: body.description,
		coOwnerIds: body.coOwnerIds,
		availability: body.availability,
		source: body.source,
		...("defaultRelayKey" in body && body.defaultRelayKey !== undefined
			? { defaultRelayKey: body.defaultRelayKey }
			: {}),
		...(modelConfiguration === undefined ? {} : { modelConfiguration }),
		environment: body.environment,
	};
}

async function requireManagementAccepted(
	decision: Awaited<
		ReturnType<AgentManagementInterfaceV1["executeManagementCommand"]>
	>,
	traceId: string,
): Promise<
	Extract<
		Awaited<ReturnType<AgentManagementInterfaceV1["executeManagementCommand"]>>,
		{ readonly outcome: "accepted" | "replayed" }
	>
> {
	if (decision.outcome === "denied") fail("RESOURCE_UNAVAILABLE", traceId);
	if (decision.outcome === "conflict") fail("CONFLICT", traceId);
	return decision;
}

function committedProjection(
	projection: AgentProjection,
	status: AgentProjection["managementStatus"],
): AgentProjection {
	return {
		...projection,
		managementStatus: status,
		...(status === "stopped" || status === "disabled"
			? { serviceAvailability: null }
			: {}),
	};
}

function acceptedLifecycleResponse(input: {
	readonly agentId: string;
	readonly status?: AgentProjection["managementStatus"];
	readonly revision?: number;
	readonly replayed: boolean;
}) {
	return AgentApiLifecycleAcceptedResponseV1Schema.parse({
		schemaVersion: 1,
		accepted: true,
		agentId: input.agentId,
		...(input.status === undefined ? {} : { status: input.status }),
		...(input.revision === undefined ? {} : { revision: input.revision }),
		replayed: input.replayed,
	});
}

export function registerV2ManagementRoutes(
	app: Hono,
	dependencies: ManagementRouteDependencies,
): void {
	app.post("/api/v2/agent-applications/model-candidates", (context) =>
		boundary(context, async (metadata) => {
			context.header("Cache-Control", "no-store");
			context.header("Referrer-Policy", "no-referrer");
			const request = context.req.raw;
			if (request.headers.has("Authorization"))
				fail("AUTHENTICATION_REQUIRED", metadata.traceId);
			if (new URL(request.url).search)
				fail("INVALID_REQUEST", metadata.traceId);
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			const { value: body, rawRequestDigest } = await parseJson(
				request,
				AgentApplicationModelCandidatesRequestV2Schema,
				metadata.traceId,
			);
			if (
				!dependencies.applicationModelCandidates ||
				!dependencies.validateDefaultRelayKey
			)
				fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			const validity = await dependencies.validateDefaultRelayKey(
				body.defaultRelayKey,
			);
			if (validity === "invalid") fail("INVALID_REQUEST", metadata.traceId);
			if (validity !== "valid")
				fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			const result = await dependencies.applicationModelCandidates(
				{
					agentId: randomUUID(),
					...metadata,
					templateId: body.templateId,
					defaultRelayKey: body.defaultRelayKey,
				},
				{ schemaVersion: 1, userId: identity.userId, rawRequestDigest },
			);
			return context.json(
				AgentApplicationModelCandidatesResponseV2Schema.parse({
					schemaVersion: 2,
					candidates: result.candidates,
				}),
			);
		}),
	);
	app.post("/api/v2/agent-applications", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const { value: body, rawRequestDigest } = await parseJson(
				context.req.raw,
				AgentApplicationCreateRequestV2Schema,
				metadata.traceId,
			);
			const hasDefaultRelayKey =
				"defaultRelayKey" in body && body.defaultRelayKey !== undefined;
			if (
				body.source.kind === "standard" &&
				!hasDefaultRelayKey &&
				dependencies.enforceDefaultRelayKey
			) {
				fail("INVALID_REQUEST", metadata.traceId);
			}
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
			if (body.defaultRelayKey !== undefined) {
				if (!dependencies.validateDefaultRelayKey)
					fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
				const validity = await dependencies.validateDefaultRelayKey(
					body.defaultRelayKey,
				);
				if (validity === "invalid") fail("INVALID_REQUEST", metadata.traceId);
				if (validity === "unavailable")
					fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			}
			const prepared = await prepareApplicationInput(
				dependencies,
				body,
				identity,
				metadata,
				ids,
			);
			const schemaVersion =
				body.source.kind === "standard" && hasDefaultRelayKey ? 3 : 2;
			if (schemaVersion === 3 && body.defaultRelayKey === undefined)
				fail("INVALID_REQUEST", metadata.traceId);
			await dependencies.foundation.submit(
				{
					schemaVersion,
					...ids,
					idempotencyKey,
					requestId: metadata.requestId,
					traceId: metadata.traceId,
					...applicationCommandFields(body, prepared, metadata.traceId),
					...(schemaVersion === 3
						? { defaultRelayKey: body.defaultRelayKey as string }
						: {}),
					secrets: prepared.secrets,
					channels: [],
				} as unknown as Parameters<ApplicationFoundationUseCaseV1["submit"]>[0],
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

	app.get("/api/v2/agent-applications", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const queryPage = pageInput(context.req.raw, metadata.traceId);
			const scope = applicantScope(identity);
			return context.json(
				await projectPage(
					() =>
						queryOrUnavailable(
							() => dependencies.query.listApplications(scope, queryPage),
							metadata.traceId,
						),
					(item) => item.applicationId,
					(item) => projectApplication(dependencies, item, identity, metadata),
				),
			);
		}),
	);

	app.get("/api/v2/agent-applications/:applicationId", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const scope = applicantScope(identity);
			const applicationId = context.req.param("applicationId");
			return context.json(
				await projectCurrent(
					() =>
						applicationOrUnavailable(
							dependencies,
							scope,
							applicationId,
							metadata.traceId,
						),
					(application) =>
						projectApplication(dependencies, application, identity, metadata),
				),
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
			// 带默认 Key 的重新提交：Key、版本与模型选择成套出现，走 V3 命令（#2421）；
			// 只有标准模板申请才有默认 Key。
			const keyReplacement = parseDefaultRelayKeyReplacement(
				body,
				metadata.traceId,
			);
			if (keyReplacement?.kind === "saved")
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			if (keyReplacement && body.source.kind !== "standard")
				fail("INVALID_REQUEST", metadata.traceId);
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
					schemaVersion: keyReplacement ? 3 : 2,
					idempotencyKey,
					requestId: metadata.requestId,
					traceId: metadata.traceId,
					...applicationCommandFields(body, prepared, metadata.traceId),
					...(keyReplacement
						? {
								expectedConfigurationRevision:
									keyReplacement.expectedConfigurationRevision,
								expectedKeyVersion: keyReplacement.expectedKeyVersion,
							}
						: {}),
					...(body.secrets === undefined ? {} : { secrets: prepared.secrets }),
				} as Parameters<ApplicationRevisionUseCaseV1["revise"]>[0],
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
			return context.json(
				await projectPage(
					() =>
						queryOrUnavailable(
							() =>
								dependencies.query.listApplications(
									{ kind: "administrator" },
									queryPage,
								),
							metadata.traceId,
						),
					(item) => item.applicationId,
					(item) => projectApplication(dependencies, item, identity, metadata),
				),
			);
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

	app.get("/api/v2/admin/agents", (context) =>
		boundary(context, async (metadata) => {
			if (context.req.raw.headers.has("authorization")) {
				fail("AUTHENTICATION_REQUIRED", metadata.traceId);
			}
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			if (!isAdministratorAgentReadAllowedV1(actor(identity))) {
				fail("FORBIDDEN", metadata.traceId);
			}
			const queryPage = pageInput(context.req.raw, metadata.traceId);
			return context.json(
				await projectPage(
					() =>
						queryOrUnavailable(
							() =>
								dependencies.query.listAgents(
									{ kind: "administrator" },
									queryPage,
								),
							metadata.traceId,
						),
					(item) => item.agentId,
					(item) => projectAgent(dependencies, item, identity, metadata),
				),
			);
		}),
	);

	// #3033：系统管理员按职责读取单个 Agent，可见范围与管理员列表相同（administrator scope），
	// 投影与列表项一致，Owner 等字段由服务端读取。只接受浏览器会话；
	// GET /api/v2/agents/:agentId 的使用范围不随之扩大，也不授予配置或授权写入。
	app.get("/api/v2/admin/agents/:agentId", (context) =>
		boundary(context, async (metadata) => {
			context.header("Cache-Control", "no-store");
			const request = context.req.raw;
			if (request.headers.has("authorization"))
				fail("AUTHENTICATION_REQUIRED", metadata.traceId);
			// 调用方不能用查询参数选择范围、身份或角色。
			if (new URL(request.url).search)
				fail("INVALID_REQUEST", metadata.traceId);
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			if (!isAdministratorAgentReadAllowedV1(actor(identity))) {
				fail("FORBIDDEN", metadata.traceId);
			}
			const agentId = context.req.param("agentId");
			const scope = { kind: "administrator" } as const;
			return context.json(
				await projectCurrent(
					() =>
						agentOrUnavailable(dependencies, scope, agentId, metadata.traceId),
					(agent) => projectAgent(dependencies, agent, identity, metadata),
				),
			);
		}),
	);

	app.get("/api/v2/me/api-identity", (context) =>
		boundary(context, async (metadata) => {
			context.header("Cache-Control", "no-store");
			const { reader, material } = await personalBearerRead(
				context.req.raw,
				metadata,
				dependencies.personalApiAgentRead,
				"api.credential.identity.read",
			);
			const result = await reader.readIdentity(metadata, material);
			return context.json(PersonalApiIdentityV1Schema.parse(result));
		}),
	);

	app.get("/api/v2/agents", (context) =>
		boundary(context, async (metadata) => {
			const request = context.req.raw;
			if (request.headers.has("Authorization")) {
				context.header("Cache-Control", "no-store");
				const reader = dependencies.personalApiAgentRead;
				const authorization = request.headers.get("Authorization") ?? "";
				const matched = /^Bearer (papi_[A-Za-z0-9_-]{43})$/.exec(authorization);
				if (
					!matched ||
					request.headers.has("Cookie") ||
					new URL(request.url).searchParams.has("scope")
				) {
					await reader?.recordRefusal(metadata, "authentication_required");
					fail("AUTHENTICATION_REQUIRED", metadata.traceId);
				}
				const material = matched[1];
				const project = dependencies.readApiAgentProjection;
				if (!reader || !project || !material)
					fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
				if (
					request.body !== null ||
					personalApiIdentityHeaders.some((name) => request.headers.has(name))
				) {
					await reader.recordRefusal(metadata, "invalid_input");
					fail("INVALID_REQUEST", metadata.traceId);
				}
				let queryPage: AgentManagementPageInputV1;
				try {
					queryPage = pageInput(request, metadata.traceId);
				} catch (error) {
					await reader.recordRefusal(metadata, "invalid_input");
					throw error;
				}
				const result = await reader.readAgents(
					metadata,
					material,
					async (apiUser) => {
						const apiScope = {
							kind: "api_user",
							userId: apiUser.userId,
						} as const;
						const projectedPage = await projectPage(
							() => dependencies.query.listAgents(apiScope, queryPage),
							(agent) => agent.agentId,
							(agent) =>
								projectApiAgent(dependencies, metadata, apiUser, agent),
						);
						return {
							result: projectedPage,
							returnedAgentIds: projectedPage.items.map(
								({ agentId }) => agentId,
							),
						};
					},
				);
				return context.json(result);
			}
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const scope = agentListScope(context.req.raw, metadata.traceId);
			const queryPage = pageInput(context.req.raw, metadata.traceId, ["scope"]);
			const visibleScope =
				scope === "owner" ? ownerScope(identity) : userScope(identity);
			return context.json(
				await projectPage(
					() =>
						queryOrUnavailable(
							() => dependencies.query.listAgents(visibleScope, queryPage),
							metadata.traceId,
						),
					(item) => item.agentId,
					(item) => projectAgent(dependencies, item, identity, metadata),
				),
			);
		}),
	);

	app.get("/api/v2/agents/:agentId", (context) =>
		boundary(context, async (metadata) => {
			if (context.req.raw.headers.has("Authorization")) {
				context.header("Cache-Control", "no-store");
				const { reader, material } = await personalBearerRead(
					context.req.raw,
					metadata,
					dependencies.personalApiAgentRead,
					"api.agent.metadata.read",
				);
				const result = await reader.readAgents(
					metadata,
					material,
					async (apiUser) => {
						const agent = await dependencies.query.getAgent(
							{ kind: "api_user", userId: apiUser.userId },
							context.req.param("agentId"),
						);
						if (!agent) throw new PersonalApiCredentialErrorV1("not_found");
						return {
							result: await projectApiAgent(
								dependencies,
								metadata,
								apiUser,
								agent,
							),
							returnedAgentIds: [agent.agentId],
						};
					},
				);
				return context.json(result);
			}
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const scope = userScope(identity);
			const agentId = context.req.param("agentId");
			return context.json(
				await projectCurrent(
					() =>
						agentOrUnavailable(dependencies, scope, agentId, metadata.traceId),
					(agent) => projectAgent(dependencies, agent, identity, metadata),
				),
			);
		}),
	);

	// Agent 详情（#2910）：可见性与 GET /api/v2/agents/:agentId 相同，Owner 附带当前有效状态。
	// 只接受浏览器会话；不可见与不存在同为 RESOURCE_UNAVAILABLE，不探知其他 Agent 的 Owner。
	app.get("/api/v2/agents/:agentId/detail", (context) =>
		boundary(context, async (metadata) => {
			context.header("Cache-Control", "no-store");
			const request = context.req.raw;
			if (request.headers.has("authorization"))
				fail("AUTHENTICATION_REQUIRED", metadata.traceId);
			if (new URL(request.url).search)
				fail("INVALID_REQUEST", metadata.traceId);
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			const scope = userScope(identity);
			const agentId = context.req.param("agentId");
			return context.json(
				await projectCurrent(
					() =>
						agentOrUnavailable(dependencies, scope, agentId, metadata.traceId),
					(agent) =>
						projectAgentDetail(dependencies, agent, identity, metadata),
				),
			);
		}),
	);

	// 创建失败类别（#3034）：只给当前 Owner 与系统管理员，且 Agent 必须处于创建失败。
	// 只接受浏览器会话；其他主体、其他状态与不存在同为 RESOURCE_UNAVAILABLE。
	app.get("/api/v2/agents/:agentId/creation-failure", (context) =>
		boundary(context, async (metadata) => {
			context.header("Cache-Control", "no-store");
			const request = context.req.raw;
			if (request.headers.has("authorization"))
				fail("AUTHENTICATION_REQUIRED", metadata.traceId);
			if (new URL(request.url).search)
				fail("INVALID_REQUEST", metadata.traceId);
			const identity = await resolveIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			const readFailureReason = dependencies.readWorkloadFailureReason;
			if (!readFailureReason) fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			const currentActor = actor(identity);
			const scope = isAdministratorAgentReadAllowedV1(currentActor)
				? ({ kind: "administrator" } as const)
				: ownerScope(identity);
			const agentId = context.req.param("agentId");
			const agent = await agentOrUnavailable(
				dependencies,
				scope,
				agentId,
				metadata.traceId,
			);
			if (!isAgentCreationFailureReadAllowedV1(currentActor, agent.management))
				fail("RESOURCE_UNAVAILABLE", metadata.traceId);
			const workloadFailureReason = await queryOrUnavailable(
				() => readFailureReason(agent.agentId),
				metadata.traceId,
			);
			return context.json(
				AgentCreationFailureProjectionV1Schema.parse({
					schemaVersion: 1,
					agentId: agent.agentId,
					category: agentCreationFailureCategoryV1({
						failureCode: agent.management.failureCode,
						workloadFailureReason,
					}),
				}),
			);
		}),
	);

	app.post("/api/v2/agents/:agentId/lifecycle", (context) =>
		boundary(context, async (metadata) => {
			const identity = await resolveIdentity(
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
			if (
				body.command === "upgrade_custom_image" ||
				body.command === "upgrade_custom_manifest"
			) {
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
						},
					);
				} else {
					const upgradeCustomManifest =
						dependencies.configuration.upgradeCustomManifest;
					if (!upgradeCustomManifest)
						fail("DEPENDENCY_UNAVAILABLE", metadata.traceId);
					await upgradeCustomManifest(
						{
							schemaVersion: 1,
							agentId,
							manifest: body.manifest,
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
				}
				const projectionScope = identity.roles.includes("system_admin")
					? ({ kind: "administrator" } as const)
					: ownerScope(identity);
				try {
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
				} catch {
					return context.json(
						acceptedLifecycleResponse({ agentId, replayed: false }),
						202,
					);
				}
			}
			const scope =
				identity.roles.includes("system_admin") &&
				(body.command === "disable" || body.command === "retry_creation")
					? ({ kind: "administrator" } as const)
					: ownerScope(identity);
			const current = await agentOrUnavailable(
				dependencies,
				scope,
				agentId,
				metadata.traceId,
			);
			const fallbackPromise = projectAgent(
				dependencies,
				current,
				identity,
				metadata,
			).catch(() => undefined);
			const commands = {
				stop: "stop_agent",
				restart: "restart_agent",
				retry_creation: "retry_agent_creation",
				disable: "disable_agent",
			} as const;
			const decision = await requireManagementAccepted(
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
			try {
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
			} catch {
				const fallback = await fallbackPromise;
				if (decision.outcome === "replayed" && fallback !== undefined)
					return context.json(fallback, 202);
				if (fallback === undefined)
					return context.json(
						acceptedLifecycleResponse({
							agentId,
							status: decision.result.status,
							revision: decision.result.revision,
							replayed: decision.outcome === "replayed",
						}),
						202,
					);
				return context.json(
					committedProjection(fallback, decision.result.status),
					202,
				);
			}
		}),
	);
}
