import { parseActorContext } from "./agent-configuration-input.js";
import {
	parseResult,
	snapshotAgentConfigurationWritePlanV1,
} from "./agent-configuration-plan.js";
import type {
	AgentConfigurationAccessAuthorityV1,
	AgentConfigurationActorContextV1,
	AgentConfigurationAuthorizationAdmissionPortV1,
	AgentConfigurationResultV1,
	AgentConfigurationTransactionPortV1,
	AgentConfigurationWritePlanV1,
} from "./agent-configuration-types.js";
import { platformIdempotencyV1 } from "./idempotency.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const keyPattern = /^[A-Za-z0-9._~-]{1,128}$/;
const maxBindings = 32;
const maxGrantEntries = 128;

export type SkillHubGrantV1 = Readonly<{
	schemaVersion: 1;
	tools: readonly string[];
	connections: readonly string[];
	fileRoots: readonly string[];
	networkOrigins: readonly string[];
	scripts: false;
}>;

export type SkillHubAgentBindingRequestV1 = Readonly<{
	skillVersionId: string;
	grant: SkillHubGrantV1;
}>;

export type SkillHubAgentBindingCommandV1 = Readonly<{
	schemaVersion: 1;
	agentId: string;
	agentVersion: string;
	expectedConfigurationRevision: number;
	idempotencyKey: string;
	requestId: string;
	traceId: string;
	bindings: readonly SkillHubAgentBindingRequestV1[];
}>;

export type SkillHubAgentBindingWriteV1 = Readonly<{
	schemaVersion: 1;
	agentVersion: string;
	bindings: readonly {
		readonly skillVersionId: string;
		readonly principalType: "user" | "organization";
		readonly principalId: string;
		readonly grant: SkillHubGrantV1;
	}[];
}>;

export type SkillHubAgentBindingResultV1 = AgentConfigurationResultV1 &
	Readonly<{ replayed: boolean }>;

export type SkillHubAgentBindingAdmissionV1 = Readonly<{
	skillVersionId: string;
	principalType: "user" | "organization";
	principalId: string;
	grant: SkillHubGrantV1;
}>;

export interface SkillHubAgentBindingAdmissionPortV1 {
	admit(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly agentVersion: string;
		readonly actorId: string;
		readonly organizationIds: readonly string[];
		readonly isAdministrator: boolean;
		readonly requestId: string;
		readonly traceId: string;
		readonly requested: readonly SkillHubAgentBindingRequestV1[];
	}): Promise<
		| {
				readonly schemaVersion: 1;
				readonly status: "admitted";
				readonly bindings: readonly SkillHubAgentBindingAdmissionV1[];
		  }
		| {
				readonly schemaVersion: 1;
				readonly status: "rejected";
				readonly reason:
					| "forbidden"
					| "version_unavailable"
					| "dependency_unavailable";
		  }
	>;
}

export class SkillHubAgentBindingErrorV1 extends Error {
	readonly code:
		| "invalid_input"
		| "not_authorized"
		| "not_admitted"
		| "stale_revision"
		| "idempotency_conflict"
		| "agent_version_unavailable"
		| "agent_version_mismatch"
		| "dependency_unavailable"
		| "persistence_failed";

	constructor(code: SkillHubAgentBindingErrorV1["code"]) {
		super("Skill Hub Agent binding rejected");
		this.name = "SkillHubAgentBindingErrorV1";
		this.code = code;
	}
}

/**
 * 读取一个 Agent Version 当前绑定状态的端口（#2903）。实现方在同一快照里读取
 * `agents.current_configuration_revision` 与该修订下的绑定，调用方不提交修订号。
 */
export interface SkillHubAgentBindingStatusPortV1<Binding> {
	readCurrentConfigurationRevision(input: {
		readonly agentId: string;
	}): Promise<number>;
	readCurrentBindings(input: {
		readonly agentId: string;
		readonly agentVersion: string;
		readonly actorId: string;
		readonly organizationIds: readonly string[];
		readonly isAdministrator: boolean;
	}): Promise<{
		readonly configurationRevision: number;
		readonly bindings: readonly Binding[];
	}>;
}

export type SkillHubAgentBindingReadV1<Binding> = Readonly<{
	schemaVersion: 1;
	agentId: string;
	agentVersion: string;
	configurationRevision: number;
	bindings: readonly Binding[];
}>;

export type SkillHubAgentCurrentVersionV1 = Readonly<{
	schemaVersion: 1;
	agentId: string;
	agentVersion: string;
	configurationRevision: number;
}>;

/** Agent Version 与绑定接口路径使用同一标识规则；部署值不满足时视为未配置。 */
export function isSkillHubAgentVersionV1(value: unknown): value is string {
	return typeof value === "string" && idPattern.test(value);
}

type AgentConfigurationAuthorizationV1 = Awaited<
	ReturnType<AgentConfigurationAuthorizationAdmissionPortV1["authorize"]>
>;

/**
 * Skill 绑定的读、写与当前版本读取共用的 Owner 判定：授权已受理、事实属于同一 Agent 与
 * 同一当前用户、账号有效，并且当前用户在 Owner 列表中。系统管理员角色不构成 Owner 授权。
 */
function currentOwnerAuthority(
	authorization: AgentConfigurationAuthorizationV1,
	agentId: string,
	actorId: string,
): AgentConfigurationAccessAuthorityV1 | undefined {
	if (
		authorization.status !== "admitted" ||
		!authorization.accessAuthority ||
		authorization.accessAuthority.state.agentId !== agentId ||
		authorization.accessAuthority.actorContext.userId !== actorId ||
		authorization.accessAuthority.actorContext.accountStatus !== "active" ||
		!authorization.accessAuthority.state.ownerIds.includes(actorId)
	)
		return undefined;
	return authorization.accessAuthority;
}

function object(
	input: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
) {
	if (typeof input !== "object" || input === null || Array.isArray(input))
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	const value = input as Record<string, unknown>;
	const allowed = new Set([...required, ...optional]);
	if (
		Object.keys(value).some((key) => !allowed.has(key)) ||
		required.some((key) => !Object.hasOwn(value, key))
	)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	return value;
}

function id(input: unknown): string {
	if (typeof input !== "string" || !idPattern.test(input))
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	return input;
}

function boundedText(input: unknown): string {
	if (
		typeof input !== "string" ||
		input.length === 0 ||
		input.includes("\0") ||
		!input.isWellFormed() ||
		new TextEncoder().encode(input).byteLength > 1024
	)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	return input;
}

function sortedUnique(input: unknown, max: number): string[] {
	if (!Array.isArray(input) || input.length > max)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	const values = input.map((value) => id(value));
	if (new Set(values).size !== values.length)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	return values.toSorted();
}

function sortedTexts(input: unknown, max: number): string[] {
	if (!Array.isArray(input) || input.length > max)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	const values = input.map((value) => boundedText(value));
	if (new Set(values).size !== values.length)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	return values.toSorted();
}

function grant(input: unknown): SkillHubGrantV1 {
	const value = object(input, [
		"schemaVersion",
		"tools",
		"connections",
		"fileRoots",
		"networkOrigins",
		"scripts",
	]);
	if (value.schemaVersion !== 1 || value.scripts !== false)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	const fileRoots = sortedTexts(value.fileRoots, 32);
	if (
		fileRoots.some(
			(root) =>
				!/^\/[A-Za-z0-9._/-]{1,255}$/.test(root) ||
				root.split("/").includes(".."),
		)
	)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	if (!Array.isArray(value.networkOrigins) || value.networkOrigins.length > 32)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	const networkOrigins = value.networkOrigins.map((origin) => {
		if (typeof origin !== "string")
			throw new SkillHubAgentBindingErrorV1("invalid_input");
		try {
			const url = new URL(origin);
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.pathname !== "/" ||
				url.search ||
				url.hash
			)
				throw new Error();
		} catch {
			throw new SkillHubAgentBindingErrorV1("invalid_input");
		}
		return origin;
	});
	if (new Set(networkOrigins).size !== networkOrigins.length)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	return Object.freeze({
		schemaVersion: 1,
		tools: Object.freeze(sortedUnique(value.tools, maxGrantEntries)),
		connections: Object.freeze(
			sortedUnique(value.connections, maxGrantEntries),
		),
		fileRoots: Object.freeze(fileRoots),
		networkOrigins: Object.freeze(networkOrigins.toSorted()),
		scripts: false,
	});
}

export function parseSkillHubAgentBindingCommandV1(
	input: unknown,
): SkillHubAgentBindingCommandV1 {
	const value = object(input, [
		"schemaVersion",
		"agentId",
		"agentVersion",
		"expectedConfigurationRevision",
		"idempotencyKey",
		"requestId",
		"traceId",
		"bindings",
	]);
	if (
		value.schemaVersion !== 1 ||
		!Number.isSafeInteger(value.expectedConfigurationRevision) ||
		(value.expectedConfigurationRevision as number) < 1
	)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	const agentId = id(value.agentId);
	const agentVersion = id(value.agentVersion);
	const idempotencyKey = boundedText(value.idempotencyKey);
	const requestId = boundedText(value.requestId);
	const traceId = boundedText(value.traceId);
	if (!keyPattern.test(idempotencyKey))
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	// 完整集合：空数组表示解除该 Agent Version 的全部绑定（#2903）。
	if (!Array.isArray(value.bindings) || value.bindings.length > maxBindings)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	const bindings = value.bindings.map((entry) => {
		const binding = object(entry, ["skillVersionId", "grant"]);
		return Object.freeze({
			skillVersionId: id(binding.skillVersionId),
			grant: grant(binding.grant),
		});
	});
	if (
		new Set(bindings.map((binding) => binding.skillVersionId)).size !==
		bindings.length
	)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	return Object.freeze({
		schemaVersion: 1,
		agentId,
		agentVersion,
		expectedConfigurationRevision:
			value.expectedConfigurationRevision as number,
		idempotencyKey,
		requestId,
		traceId,
		bindings: Object.freeze(bindings),
	});
}

export function parseSkillHubGrantV1(input: unknown): SkillHubGrantV1 {
	return grant(input);
}

export function isSkillHubGrantWithinBoundaryV1(
	requestedInput: SkillHubGrantV1,
	allowedInput: SkillHubGrantV1,
): boolean {
	const requested = grant(requestedInput);
	const allowed = grant(allowedInput);
	const subset = (values: readonly string[], boundary: readonly string[]) =>
		values.every((value) => boundary.includes(value));
	const fileSubset = requested.fileRoots.every((root) =>
		allowed.fileRoots.some(
			(boundary) => root === boundary || root.startsWith(`${boundary}/`),
		),
	);
	return (
		requested.scripts === false &&
		subset(requested.tools, allowed.tools) &&
		subset(requested.connections, allowed.connections) &&
		fileSubset &&
		subset(requested.networkOrigins, allowed.networkOrigins)
	);
}

export function parseSkillHubAgentBindingWriteV1(
	input: unknown,
): SkillHubAgentBindingWriteV1 {
	const value = object(input, ["schemaVersion", "agentVersion", "bindings"]);
	if (value.schemaVersion !== 1)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	const bindingsInput = value.bindings;
	if (!Array.isArray(bindingsInput) || bindingsInput.length > maxBindings)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	const bindings = bindingsInput.map((entry) => {
		const binding = object(entry, [
			"skillVersionId",
			"principalType",
			"principalId",
			"grant",
		]);
		if (
			binding.principalType !== "user" &&
			binding.principalType !== "organization"
		)
			throw new SkillHubAgentBindingErrorV1("invalid_input");
		return Object.freeze({
			skillVersionId: id(binding.skillVersionId),
			principalType: binding.principalType,
			principalId: id(binding.principalId),
			grant: grant(binding.grant),
		});
	});
	if (
		new Set(bindings.map((binding) => binding.skillVersionId)).size !==
		bindings.length
	)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	return Object.freeze({
		schemaVersion: 1,
		agentVersion: id(value.agentVersion),
		bindings: Object.freeze(bindings),
	});
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function parseReadInput(input: unknown, withAgentVersion: boolean) {
	const value = object(input, [
		"schemaVersion",
		"agentId",
		...(withAgentVersion ? ["agentVersion"] : []),
		"actorId",
		"requestId",
		"traceId",
	]);
	if (value.schemaVersion !== 1)
		throw new SkillHubAgentBindingErrorV1("invalid_input");
	return {
		agentId: id(value.agentId),
		agentVersion: withAgentVersion ? id(value.agentVersion) : undefined,
		actorId: boundedText(value.actorId),
		requestId: boundedText(value.requestId),
		traceId: boundedText(value.traceId),
	};
}

export function createSkillHubAgentBindingUseCaseV1<
	Binding = never,
>(dependencies: {
	readonly transaction: AgentConfigurationTransactionPortV1;
	readonly authorizationAdmission: AgentConfigurationAuthorizationAdmissionPortV1;
	readonly bindingAdmission: SkillHubAgentBindingAdmissionPortV1;
	/**
	 * 部署级固定 Agent Version（工程 Spec §11.6）。未配置或不满足标识规则时，绑定读取与
	 * 写入一律拒绝。
	 */
	readonly agentVersion?: string;
	/** 当前绑定状态读取；缺失时读取不可用。 */
	readonly bindingStatus?: SkillHubAgentBindingStatusPortV1<Binding>;
	readonly now?: () => Date;
}) {
	const now = dependencies.now ?? (() => new Date());
	const configuredAgentVersion = isSkillHubAgentVersionV1(
		dependencies.agentVersion,
	)
		? dependencies.agentVersion
		: undefined;
	/** 先完成 Owner 授权再比较版本，非 Owner 不能用路径探测当前版本。 */
	function currentAgentVersion(requested: string | undefined): string {
		if (configuredAgentVersion === undefined)
			throw new SkillHubAgentBindingErrorV1("agent_version_unavailable");
		if (requested !== undefined && requested !== configuredAgentVersion)
			throw new SkillHubAgentBindingErrorV1("agent_version_mismatch");
		return configuredAgentVersion;
	}
	async function authorizeOwner(input: {
		readonly agentId: string;
		readonly actorId: string;
		readonly requestId: string;
		readonly traceId: string;
	}): Promise<AgentConfigurationAccessAuthorityV1> {
		let authorization: AgentConfigurationAuthorizationV1;
		try {
			authorization = await dependencies.authorizationAdmission.authorize({
				schemaVersion: 1,
				...input,
			});
		} catch {
			throw new SkillHubAgentBindingErrorV1("dependency_unavailable");
		}
		const authority = currentOwnerAuthority(
			authorization,
			input.agentId,
			input.actorId,
		);
		if (!authority) throw new SkillHubAgentBindingErrorV1("not_authorized");
		return authority;
	}
	return {
		/** 当前 Owner 读取部署级 Agent Version 与当前配置修订。 */
		async currentVersion(
			input: unknown,
		): Promise<SkillHubAgentCurrentVersionV1> {
			const query = parseReadInput(input, false);
			await authorizeOwner(query);
			const agentVersion = currentAgentVersion(undefined);
			if (!dependencies.bindingStatus)
				throw new SkillHubAgentBindingErrorV1("dependency_unavailable");
			let configurationRevision: number;
			try {
				configurationRevision =
					await dependencies.bindingStatus.readCurrentConfigurationRevision({
						agentId: query.agentId,
					});
			} catch {
				throw new SkillHubAgentBindingErrorV1("dependency_unavailable");
			}
			if (
				!Number.isSafeInteger(configurationRevision) ||
				configurationRevision < 1
			)
				throw new SkillHubAgentBindingErrorV1("dependency_unavailable");
			return {
				schemaVersion: 1,
				agentId: query.agentId,
				agentVersion,
				configurationRevision,
			};
		},
		/** 当前 Owner 读取当前 Agent Version 在当前配置修订下的绑定。 */
		async read(input: unknown): Promise<SkillHubAgentBindingReadV1<Binding>> {
			const query = parseReadInput(input, true);
			const authority = await authorizeOwner(query);
			const agentVersion = currentAgentVersion(query.agentVersion);
			if (!dependencies.bindingStatus)
				throw new SkillHubAgentBindingErrorV1("dependency_unavailable");
			let current: Awaited<
				ReturnType<
					SkillHubAgentBindingStatusPortV1<Binding>["readCurrentBindings"]
				>
			>;
			try {
				current = await dependencies.bindingStatus.readCurrentBindings({
					agentId: query.agentId,
					agentVersion,
					actorId: query.actorId,
					organizationIds: authority.actorContext.organizationIds,
					isAdministrator: authority.actorContext.isAdministrator,
				});
			} catch {
				throw new SkillHubAgentBindingErrorV1("dependency_unavailable");
			}
			if (
				!Number.isSafeInteger(current?.configurationRevision) ||
				current.configurationRevision < 1 ||
				!Array.isArray(current.bindings) ||
				current.bindings.length > maxBindings
			)
				throw new SkillHubAgentBindingErrorV1("dependency_unavailable");
			return {
				schemaVersion: 1,
				agentId: query.agentId,
				agentVersion,
				configurationRevision: current.configurationRevision,
				bindings: current.bindings,
			};
		},
		async bind(
			commandInput: unknown,
			actorContextInput: unknown,
		): Promise<SkillHubAgentBindingResultV1> {
			let command: SkillHubAgentBindingCommandV1;
			let actor: AgentConfigurationActorContextV1;
			try {
				command = parseSkillHubAgentBindingCommandV1(commandInput);
				actor = parseActorContext(actorContextInput);
			} catch (error) {
				if (error instanceof SkillHubAgentBindingErrorV1) throw error;
				throw new SkillHubAgentBindingErrorV1("invalid_input");
			}
			const digest = platformIdempotencyV1.canonicalRequestDigest({
				schemaVersion: 1,
				operation: "agent.skill.bind.v1",
				agentId: command.agentId,
				agentVersion: command.agentVersion,
				expectedConfigurationRevision: command.expectedConfigurationRevision,
				bindings: command.bindings,
				actorId: actor.actorId,
				rawRequestDigest: actor.rawRequestDigest,
			});
			let authorization: AgentConfigurationAuthorizationV1;
			try {
				authorization = await dependencies.authorizationAdmission.authorize({
					schemaVersion: 1,
					agentId: command.agentId,
					actorId: actor.actorId,
					requestId: command.requestId,
					traceId: command.traceId,
				});
			} catch {
				throw new SkillHubAgentBindingErrorV1("dependency_unavailable");
			}
			const accessAuthority = currentOwnerAuthority(
				authorization,
				command.agentId,
				actor.actorId,
			);
			if (authorization.status !== "admitted" || !accessAuthority)
				throw new SkillHubAgentBindingErrorV1("not_authorized");
			// 路径中的 Agent Version 必须等于部署当前值；未配置时一律拒绝（#2903）。
			currentAgentVersion(command.agentVersion);
			let readDecision: Awaited<
				ReturnType<AgentConfigurationTransactionPortV1["read"]>
			>;
			try {
				readDecision = await dependencies.transaction.read({
					schemaVersion: 1,
					agentId: command.agentId,
					actorId: actor.actorId,
					idempotencyKey: command.idempotencyKey,
					requestDigest: digest,
					scopeType: "agent",
					commandType: "agent.skill.bind.v1",
				});
			} catch {
				throw new SkillHubAgentBindingErrorV1("persistence_failed");
			}
			if (readDecision.outcome === "replayed")
				return {
					...parseResult(readDecision.result, command.agentId),
					replayed: true,
				};
			if (readDecision.outcome === "idempotency_conflict")
				throw new SkillHubAgentBindingErrorV1("idempotency_conflict");
			if (readDecision.outcome === "missing")
				throw new SkillHubAgentBindingErrorV1("not_authorized");
			const current = readDecision.record.configuration;
			if (current.revision !== command.expectedConfigurationRevision)
				throw new SkillHubAgentBindingErrorV1("stale_revision");
			let admitted: Awaited<
				ReturnType<SkillHubAgentBindingAdmissionPortV1["admit"]>
			>;
			if (command.bindings.length === 0) {
				// 解除全部绑定：没有待准入的版本，直接提交空集合。
				admitted = { schemaVersion: 1, status: "admitted", bindings: [] };
			} else {
				try {
					admitted = await dependencies.bindingAdmission.admit({
						schemaVersion: 1,
						agentId: command.agentId,
						agentVersion: command.agentVersion,
						actorId: actor.actorId,
						organizationIds: accessAuthority.actorContext.organizationIds,
						isAdministrator: accessAuthority.actorContext.isAdministrator,
						requestId: command.requestId,
						traceId: command.traceId,
						requested: command.bindings,
					});
				} catch {
					throw new SkillHubAgentBindingErrorV1("dependency_unavailable");
				}
			}
			if (admitted.status !== "admitted") {
				throw new SkillHubAgentBindingErrorV1(
					admitted.reason === "forbidden" ? "not_authorized" : "not_admitted",
				);
			}
			if (
				admitted.bindings.length !== command.bindings.length ||
				admitted.bindings.some((binding, index) => {
					const requested = command.bindings[index];
					return (
						requested === undefined ||
						binding.skillVersionId !== requested.skillVersionId ||
						!isSkillHubGrantWithinBoundaryV1(binding.grant, requested.grant) ||
						(binding.principalType !== "user" &&
							binding.principalType !== "organization") ||
						!idPattern.test(binding.principalId)
					);
				})
			)
				throw new SkillHubAgentBindingErrorV1("dependency_unavailable");
			let occurredAt: Date;
			try {
				occurredAt = new Date(now().getTime());
				if (!Number.isFinite(occurredAt.getTime())) throw new Error();
			} catch {
				throw new SkillHubAgentBindingErrorV1("persistence_failed");
			}
			const nextRevision = current.revision + 1;
			if (!Number.isSafeInteger(nextRevision))
				throw new SkillHubAgentBindingErrorV1("persistence_failed");
			const changedFields = ["skills"] as const;
			const plan: AgentConfigurationWritePlanV1 = {
				schemaVersion: 1,
				agentId: command.agentId,
				baseRevision: current.revision,
				nextRevision,
				expectedManagementRevision: accessAuthority.state.revision,
				expectedAuthorizationRevision:
					readDecision.record.authorizationRevision,
				nextAuthorizationRevision: authorization.authorizationRevision,
				configuration: { ...current, revision: nextRevision },
				skillBindings: {
					schemaVersion: 1,
					agentVersion: command.agentVersion,
					bindings: admitted.bindings,
				},
				accessUpdate: null,
				result: {
					schemaVersion: 1,
					agentId: command.agentId,
					revision: nextRevision,
					changedFields,
				},
				idempotency: {
					key: command.idempotencyKey,
					requestDigest: digest,
					scopeType: "agent",
					commandType: "agent.skill.bind.v1",
				},
				outboxIntent: {
					operation: "agent.configuration.revised.v1",
					payload: {
						schemaVersion: 1,
						agentId: command.agentId,
						baseRevision: current.revision,
						configurationRevision: nextRevision,
						changedFields,
					},
					traceId: command.traceId,
					requestId: command.requestId,
					occurredAt,
				},
				auditEvent: {
					action: "agent.configuration.revised",
					actorId: actor.actorId,
					agentId: command.agentId,
					subjectType: "agent",
					subjectId: command.agentId,
					changedFields,
					traceId: command.traceId,
					requestId: command.requestId,
					occurredAt,
				},
			};
			let decision: Awaited<
				ReturnType<AgentConfigurationTransactionPortV1["commit"]>
			>;
			try {
				decision = await dependencies.transaction.commit(
					snapshotAgentConfigurationWritePlanV1(plan),
				);
			} catch {
				throw new SkillHubAgentBindingErrorV1("persistence_failed");
			}
			if (decision.outcome === "stale")
				throw new SkillHubAgentBindingErrorV1("stale_revision");
			if (decision.outcome === "idempotency_conflict")
				throw new SkillHubAgentBindingErrorV1("idempotency_conflict");
			if (
				(decision.outcome !== "committed" && decision.outcome !== "replayed") ||
				!sameValue(decision.result, plan.result)
			)
				throw new SkillHubAgentBindingErrorV1("persistence_failed");
			return { ...decision.result, replayed: decision.outcome === "replayed" };
		},
	};
}
