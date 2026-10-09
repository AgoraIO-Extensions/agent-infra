import { parseActorContext } from "./agent-configuration-input.js";
import {
	parseResult,
	snapshotAgentConfigurationWritePlanV1,
} from "./agent-configuration-plan.js";
import type {
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
		| "dependency_unavailable"
		| "persistence_failed";

	constructor(code: SkillHubAgentBindingErrorV1["code"]) {
		super("Skill Hub Agent binding rejected");
		this.name = "SkillHubAgentBindingErrorV1";
		this.code = code;
	}
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
	if (
		!Array.isArray(value.bindings) ||
		value.bindings.length === 0 ||
		value.bindings.length > maxBindings
	)
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

export function createSkillHubAgentBindingUseCaseV1(dependencies: {
	readonly transaction: AgentConfigurationTransactionPortV1;
	readonly authorizationAdmission: AgentConfigurationAuthorizationAdmissionPortV1;
	readonly bindingAdmission: SkillHubAgentBindingAdmissionPortV1;
	readonly now?: () => Date;
}) {
	const now = dependencies.now ?? (() => new Date());
	return {
		async bind(
			commandInput: unknown,
			actorContextInput: unknown,
		): Promise<AgentConfigurationResultV1> {
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
			let authorization: Awaited<
				ReturnType<AgentConfigurationAuthorizationAdmissionPortV1["authorize"]>
			>;
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
			if (
				authorization.status !== "admitted" ||
				!authorization.accessAuthority ||
				authorization.accessAuthority.state.agentId !== command.agentId ||
				authorization.accessAuthority.actorContext.userId !== actor.actorId ||
				authorization.accessAuthority.actorContext.accountStatus !== "active" ||
				!authorization.accessAuthority.state.ownerIds.includes(actor.actorId)
			)
				throw new SkillHubAgentBindingErrorV1("not_authorized");
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
				return parseResult(readDecision.result, command.agentId);
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
			try {
				admitted = await dependencies.bindingAdmission.admit({
					schemaVersion: 1,
					agentId: command.agentId,
					agentVersion: command.agentVersion,
					actorId: actor.actorId,
					organizationIds:
						authorization.accessAuthority.actorContext.organizationIds,
					isAdministrator:
						authorization.accessAuthority.actorContext.isAdministrator,
					requestId: command.requestId,
					traceId: command.traceId,
					requested: command.bindings,
				});
			} catch {
				throw new SkillHubAgentBindingErrorV1("dependency_unavailable");
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
				expectedManagementRevision:
					authorization.accessAuthority.state.revision,
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
			return decision.result;
		},
	};
}
