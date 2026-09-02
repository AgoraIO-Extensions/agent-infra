import {
	type AgentConfigurationAccessTargetV1,
	type AgentConfigurationActionV1,
	type AgentConfigurationActorContextV1,
	type AgentConfigurationChannelChangeV1,
	AgentConfigurationError,
	type AgentConfigurationModelInputV1,
	type AgentConfigurationRecordV1,
	type AgentConfigurationSecretReplacementInputV1,
	type AgentConfigurationSourceSelectionV1,
	type AgentConfigurationUseCaseDependenciesV1,
	type AgentConfigurationWritePlanV1,
	createAgentConfigurationUseCaseV1,
	decodeAgentConfigurationRecordV1,
} from "./agent-configuration.js";
import {
	type AgentManagementActorContextV1,
	type AgentManagementStateV1,
	type AgentManagementWritePlanV1,
	createAgentManagementV1,
} from "./agent-management.js";
import {
	isAgentManagementText,
	parseAgentManagementActorContext,
	parseAgentManagementPortState,
	parseAgentManagementStringArray,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
	snapshotAgentManagementDenseArray,
} from "./agent-management-input.js";

export interface ReviseApplicationCommandV1 {
	readonly schemaVersion: 1;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
	readonly name: string;
	readonly description: string;
	readonly coOwnerIds: readonly string[];
	readonly availability: readonly AgentConfigurationAccessTargetV1[];
	readonly source: AgentConfigurationSourceSelectionV1;
	readonly modelConfiguration?: AgentConfigurationModelInputV1;
	readonly environment: readonly {
		readonly name: string;
		readonly value: string;
	}[];
	readonly secrets: readonly AgentConfigurationSecretReplacementInputV1[];
	readonly actions: readonly AgentConfigurationActionV1[];
	readonly channels: readonly AgentConfigurationChannelChangeV1[];
}

export interface ApplicationRevisionActorContextV1
	extends AgentManagementActorContextV1 {
	readonly applicationId: string;
	readonly rawRequestDigest: string;
}

export interface ApplicationRevisionResultV1 {
	readonly schemaVersion: 1;
	readonly applicationId: string;
	readonly agentId: string;
	readonly status: "pending_approval";
	readonly managementRevision: number;
	readonly configurationRevision: number;
}

export interface ApplicationRevisionReadStateV1 {
	readonly schemaVersion: 1;
	readonly application: {
		readonly applicationId: string;
		readonly agentId: string;
		readonly applicantId: string;
		readonly name: string;
		readonly description: string;
	};
	readonly management: AgentManagementStateV1;
	readonly configuration: AgentConfigurationRecordV1;
	readonly authorizationRevision: string;
}

export type ApplicationRevisionReadDecisionV1 =
	| {
			readonly outcome: "ready";
			readonly state: ApplicationRevisionReadStateV1;
	  }
	| {
			readonly outcome: "replayed";
			readonly result: ApplicationRevisionResultV1;
	  }
	| { readonly outcome: "unavailable" }
	| { readonly outcome: "idempotency_conflict" };

export interface ApplicationRevisionWritePlanV1 {
	readonly schemaVersion: 1;
	readonly application: {
		readonly applicationId: string;
		readonly agentId: string;
		readonly applicantId: string;
		readonly name: string;
		readonly description: string;
		readonly traceId: string;
		readonly requestId: string;
	};
	readonly expected: {
		readonly managementRevision: number;
		readonly configurationRevision: number;
		readonly authorizationRevision: string;
	};
	readonly nextAuthorizationRevision: string;
	readonly management: AgentManagementWritePlanV1;
	readonly configuration: AgentConfigurationWritePlanV1 | null;
	readonly result: ApplicationRevisionResultV1;
	readonly idempotency: {
		readonly key: string;
		readonly requestDigest: string;
	};
	readonly outboxIntent: {
		readonly operation: "agent.application.revised.v1";
		readonly payload: ApplicationRevisionResultV1;
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
	readonly auditEvent: AgentManagementWritePlanV1["auditEvent"];
}

export type ApplicationRevisionCommitDecisionV1 =
	| {
			readonly outcome: "committed" | "replayed";
			readonly result: ApplicationRevisionResultV1;
	  }
	| {
			readonly outcome: "conflict";
			readonly reason:
				| "idempotency_conflict"
				| "stale_authorization"
				| "stale_configuration"
				| "stale_management";
	  };

export interface ApplicationRevisionTransactionPortV1 {
	read(input: {
		readonly schemaVersion: 1;
		readonly applicationId: string;
		readonly actorId: string;
		readonly idempotencyKey: string;
		readonly requestDigest: string;
	}): Promise<ApplicationRevisionReadDecisionV1>;
	commit(
		plan: ApplicationRevisionWritePlanV1,
	): Promise<ApplicationRevisionCommitDecisionV1>;
}

export interface ApplicationRevisionUseCaseV1 {
	revise(
		command: ReviseApplicationCommandV1,
		actorContext: ApplicationRevisionActorContextV1,
	): Promise<ApplicationRevisionResultV1>;
}

export interface ApplicationRevisionUseCaseDependenciesV1
	extends Omit<AgentConfigurationUseCaseDependenciesV1, "transaction"> {
	readonly transaction: ApplicationRevisionTransactionPortV1;
}

export interface ApplicationRevisionUseCaseOptionsV1 {
	readonly now?: () => Date;
}

export type ApplicationRevisionErrorCode =
	| "invalid_command"
	| "not_authorized"
	| "not_admitted"
	| "no_change"
	| "stale_revision"
	| "idempotency_conflict"
	| "dependency_unavailable"
	| "persistence_failed";

export class ApplicationRevisionError extends Error {
	readonly code: ApplicationRevisionErrorCode;

	constructor(code: ApplicationRevisionErrorCode) {
		super(`Application revision ${code.replaceAll("_", " ")}`);
		this.name = "ApplicationRevisionError";
		this.code = code;
	}
}

function invalidCommand(): never {
	throw new ApplicationRevisionError("invalid_command");
}

function exactObject(
	input: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	try {
		const values = snapshotAgentManagementDataObject(input);
		const allowed = new Set([...required, ...optional]);
		if (
			Object.keys(values).some((key) => !allowed.has(key)) ||
			required.some((key) => !Object.hasOwn(values, key))
		) {
			invalidCommand();
		}
		return values;
	} catch {
		invalidCommand();
	}
}

function parseCommand(input: unknown): ReviseApplicationCommandV1 {
	const values = exactObject(
		input,
		[
			"schemaVersion",
			"idempotencyKey",
			"requestId",
			"traceId",
			"name",
			"description",
			"coOwnerIds",
			"availability",
			"source",
			"environment",
			"secrets",
			"actions",
			"channels",
		],
		["modelConfiguration"],
	);
	if (
		values.schemaVersion !== 1 ||
		!isAgentManagementText(values.idempotencyKey, 128) ||
		!/^[A-Za-z0-9._~-]{1,128}$/.test(values.idempotencyKey) ||
		!isAgentManagementText(values.requestId) ||
		!isAgentManagementText(values.traceId) ||
		!isAgentManagementText(values.name, 800) ||
		Array.from(values.name).length > 200 ||
		!isAgentManagementText(values.description, 65_536)
	) {
		invalidCommand();
	}
	let coOwnerIds: readonly string[];
	try {
		coOwnerIds = parseAgentManagementStringArray(values.coOwnerIds, true);
	} catch {
		invalidCommand();
	}
	return {
		schemaVersion: 1,
		idempotencyKey: values.idempotencyKey,
		requestId: values.requestId,
		traceId: values.traceId,
		name: values.name,
		description: values.description,
		coOwnerIds,
		availability:
			values.availability as readonly AgentConfigurationAccessTargetV1[],
		source: values.source as AgentConfigurationSourceSelectionV1,
		...(Object.hasOwn(values, "modelConfiguration")
			? {
					modelConfiguration:
						values.modelConfiguration as AgentConfigurationModelInputV1,
				}
			: {}),
		environment:
			values.environment as ReviseApplicationCommandV1["environment"],
		secrets: values.secrets as ReviseApplicationCommandV1["secrets"],
		actions: values.actions as ReviseApplicationCommandV1["actions"],
		channels: values.channels as ReviseApplicationCommandV1["channels"],
	};
}

function parseActorContext(input: unknown): ApplicationRevisionActorContextV1 {
	const values = exactObject(input, [
		"schemaVersion",
		"applicationId",
		"userId",
		"accountStatus",
		"organizationIds",
		"isAdministrator",
		"rawRequestDigest",
	]);
	if (
		!isAgentManagementText(values.applicationId) ||
		typeof values.rawRequestDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(values.rawRequestDigest)
	) {
		invalidCommand();
	}
	let actor: AgentManagementActorContextV1;
	try {
		actor = parseAgentManagementActorContext({
			schemaVersion: values.schemaVersion,
			userId: values.userId,
			accountStatus: values.accountStatus,
			organizationIds: values.organizationIds,
			isAdministrator: values.isAdministrator,
		});
	} catch {
		invalidCommand();
	}
	return {
		...actor,
		applicationId: values.applicationId,
		rawRequestDigest: values.rawRequestDigest,
	};
}

function parseResult(input: unknown): ApplicationRevisionResultV1 {
	try {
		const result = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(result, [
			"schemaVersion",
			"applicationId",
			"agentId",
			"status",
			"managementRevision",
			"configurationRevision",
		]);
		if (
			result.schemaVersion !== 1 ||
			!isAgentManagementText(result.applicationId) ||
			!isAgentManagementText(result.agentId) ||
			result.status !== "pending_approval" ||
			!Number.isSafeInteger(result.managementRevision) ||
			(result.managementRevision as number) < 1 ||
			!Number.isSafeInteger(result.configurationRevision) ||
			(result.configurationRevision as number) < 1
		) {
			throw new Error();
		}
		return {
			schemaVersion: 1,
			applicationId: result.applicationId,
			agentId: result.agentId,
			status: "pending_approval",
			managementRevision: result.managementRevision as number,
			configurationRevision: result.configurationRevision as number,
		};
	} catch {
		throw new ApplicationRevisionError("persistence_failed");
	}
}

function parseReadState(input: unknown): ApplicationRevisionReadStateV1 {
	try {
		const state = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(state, [
			"schemaVersion",
			"application",
			"management",
			"configuration",
			"authorizationRevision",
		]);
		const application = snapshotAgentManagementDataObject(state.application);
		requireAgentManagementExactKeys(application, [
			"applicationId",
			"agentId",
			"applicantId",
			"name",
			"description",
		]);
		const management = parseAgentManagementPortState(
			state.management as AgentManagementStateV1,
		);
		const configuration = decodeAgentConfigurationRecordV1(state.configuration);
		if (
			state.schemaVersion !== 1 ||
			!isAgentManagementText(application.applicationId) ||
			!isAgentManagementText(application.agentId) ||
			!isAgentManagementText(application.applicantId) ||
			!isAgentManagementText(application.name, 800) ||
			Array.from(application.name).length > 200 ||
			!isAgentManagementText(application.description, 65_536) ||
			!isAgentManagementText(state.authorizationRevision) ||
			management.applicationId !== application.applicationId ||
			management.agentId !== application.agentId ||
			management.applicantId !== application.applicantId ||
			configuration.agentId !== application.agentId
		) {
			throw new Error();
		}
		return {
			schemaVersion: 1,
			application: {
				applicationId: application.applicationId,
				agentId: application.agentId,
				applicantId: application.applicantId,
				name: application.name,
				description: application.description,
			},
			management,
			configuration,
			authorizationRevision: state.authorizationRevision,
		};
	} catch {
		throw new ApplicationRevisionError("persistence_failed");
	}
}

function parseReadDecision(input: unknown): ApplicationRevisionReadDecisionV1 {
	try {
		const decision = snapshotAgentManagementDataObject(input);
		if (decision.outcome === "ready") {
			requireAgentManagementExactKeys(decision, ["outcome", "state"]);
			return { outcome: "ready", state: parseReadState(decision.state) };
		}
		if (decision.outcome === "replayed") {
			requireAgentManagementExactKeys(decision, ["outcome", "result"]);
			return { outcome: "replayed", result: parseResult(decision.result) };
		}
		if (
			decision.outcome === "unavailable" ||
			decision.outcome === "idempotency_conflict"
		) {
			requireAgentManagementExactKeys(decision, ["outcome"]);
			return { outcome: decision.outcome };
		}
		throw new Error();
	} catch (error) {
		if (error instanceof ApplicationRevisionError) throw error;
		throw new ApplicationRevisionError("persistence_failed");
	}
}

function parseAuthorizationRevision(
	input: unknown,
	expectedAgentId: string,
	expectedActorId: string,
): string | null | undefined {
	try {
		const decision = snapshotAgentManagementDataObject(input);
		if (decision.status === "rejected") {
			requireAgentManagementExactKeys(decision, [
				"schemaVersion",
				"status",
				"agentId",
				"actorId",
			]);
			return decision.schemaVersion === 1 &&
				decision.agentId === expectedAgentId &&
				decision.actorId === expectedActorId
				? null
				: undefined;
		}
		if (decision.status !== "admitted") return undefined;
		const allowed = new Set([
			"schemaVersion",
			"status",
			"agentId",
			"actorId",
			"authorizationRevision",
			"accessAuthority",
			"authorityContext",
		]);
		if (
			Object.keys(decision).some((key) => !allowed.has(key)) ||
			![
				"schemaVersion",
				"status",
				"agentId",
				"actorId",
				"authorizationRevision",
			].every((key) => Object.hasOwn(decision, key))
		) {
			return undefined;
		}
		return decision.schemaVersion === 1 &&
			decision.agentId === expectedAgentId &&
			decision.actorId === expectedActorId &&
			isAgentManagementText(decision.authorizationRevision)
			? decision.authorizationRevision
			: undefined;
	} catch {
		return undefined;
	}
}

async function requireCurrentAuthorization(
	dependencies: ApplicationRevisionUseCaseDependenciesV1,
	agentId: string,
	actorContext: ApplicationRevisionActorContextV1,
	command: ReviseApplicationCommandV1,
): Promise<string> {
	let decision: unknown;
	try {
		decision = await dependencies.authorizationAdmission.authorize({
			schemaVersion: 1,
			agentId,
			actorId: actorContext.userId,
			requestId: command.requestId,
			traceId: command.traceId,
		});
	} catch {
		throw new ApplicationRevisionError("dependency_unavailable");
	}
	const revision = parseAuthorizationRevision(
		decision,
		agentId,
		actorContext.userId,
	);
	if (revision === undefined) {
		throw new ApplicationRevisionError("dependency_unavailable");
	}
	if (revision === null) {
		throw new ApplicationRevisionError("not_authorized");
	}
	return revision;
}

function cachedClock(now: () => Date): () => Date {
	let instant: Date | undefined;
	return () => {
		if (!instant) {
			try {
				const milliseconds = Date.prototype.getTime.call(now());
				if (!Number.isFinite(milliseconds)) throw new Error();
				instant = new Date(milliseconds);
			} catch {
				throw new ApplicationRevisionError("persistence_failed");
			}
		}
		return new Date(Date.prototype.getTime.call(instant));
	};
}

function snapshotData(
	input: unknown,
	depth = 0,
	budget = { remaining: 16_384 },
): unknown {
	if (depth > 32 || budget.remaining-- < 1) {
		throw new ApplicationRevisionError("persistence_failed");
	}
	if (typeof input !== "object" || input === null) return input;
	try {
		const milliseconds = Date.prototype.getTime.call(input);
		if (Number.isFinite(milliseconds) && Reflect.ownKeys(input).length === 0) {
			return new Date(milliseconds);
		}
	} catch {
		// Ordinary records and arrays are handled below.
	}
	try {
		if (Array.isArray(input)) {
			return snapshotAgentManagementDenseArray(input, 4096).map((value) =>
				snapshotData(value, depth + 1, budget),
			);
		}
		const values = snapshotAgentManagementDataObject(input);
		if (Object.keys(values).length > 128) throw new Error();
		return Object.fromEntries(
			Object.entries(values).map(([key, value]) => [
				key,
				snapshotData(value, depth + 1, budget),
			]),
		);
	} catch {
		throw new ApplicationRevisionError("persistence_failed");
	}
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function validDate(input: unknown): input is Date {
	try {
		return Number.isFinite(Date.prototype.getTime.call(input));
	} catch {
		return false;
	}
}

export function snapshotApplicationRevisionWritePlanV1(
	input: unknown,
): ApplicationRevisionWritePlanV1 {
	try {
		const plan = snapshotData(input) as ApplicationRevisionWritePlanV1;
		const top = snapshotAgentManagementDataObject(plan);
		requireAgentManagementExactKeys(top, [
			"schemaVersion",
			"application",
			"expected",
			"nextAuthorizationRevision",
			"management",
			"configuration",
			"result",
			"idempotency",
			"outboxIntent",
			"auditEvent",
		]);
		const application = snapshotAgentManagementDataObject(plan.application);
		requireAgentManagementExactKeys(application, [
			"applicationId",
			"agentId",
			"applicantId",
			"name",
			"description",
			"traceId",
			"requestId",
		]);
		const expected = snapshotAgentManagementDataObject(plan.expected);
		requireAgentManagementExactKeys(expected, [
			"managementRevision",
			"configurationRevision",
			"authorizationRevision",
		]);
		const managementValues = snapshotAgentManagementDataObject(plan.management);
		requireAgentManagementExactKeys(managementValues, [
			"schemaVersion",
			"operation",
			"subjectType",
			"subjectId",
			"expectedRevision",
			"state",
			"transition",
			"outboxIntent",
			"auditEvent",
			"idempotency",
		]);
		const managementState = parseAgentManagementPortState(
			plan.management.state,
		);
		const transition = snapshotAgentManagementDataObject(
			plan.management.transition,
		);
		requireAgentManagementExactKeys(transition, ["from", "to", "occurredAt"]);
		const managementAudit = snapshotAgentManagementDataObject(
			plan.management.auditEvent,
		);
		requireAgentManagementExactKeys(managementAudit, [
			"action",
			"actorId",
			"subjectType",
			"subjectId",
			"traceId",
			"requestId",
			"occurredAt",
		]);
		const managementIdempotency = snapshotAgentManagementDataObject(
			plan.management.idempotency,
		);
		requireAgentManagementExactKeys(managementIdempotency, [
			"key",
			"requestDigest",
		]);
		const result = parseResult(plan.result);
		const idempotency = snapshotAgentManagementDataObject(plan.idempotency);
		requireAgentManagementExactKeys(idempotency, ["key", "requestDigest"]);
		const outbox = snapshotAgentManagementDataObject(plan.outboxIntent);
		requireAgentManagementExactKeys(outbox, [
			"operation",
			"payload",
			"traceId",
			"requestId",
			"occurredAt",
		]);
		const outerAudit = snapshotAgentManagementDataObject(plan.auditEvent);
		if (
			plan.schemaVersion !== 1 ||
			!isAgentManagementText(application.applicationId) ||
			!isAgentManagementText(application.agentId) ||
			!isAgentManagementText(application.applicantId) ||
			!isAgentManagementText(application.name, 800) ||
			Array.from(application.name).length > 200 ||
			!isAgentManagementText(application.description, 65_536) ||
			!isAgentManagementText(application.traceId) ||
			!isAgentManagementText(application.requestId) ||
			!Number.isSafeInteger(expected.managementRevision) ||
			(expected.managementRevision as number) < 0 ||
			!Number.isSafeInteger(expected.configurationRevision) ||
			(expected.configurationRevision as number) < 1 ||
			!isAgentManagementText(expected.authorizationRevision) ||
			!isAgentManagementText(plan.nextAuthorizationRevision) ||
			plan.management.schemaVersion !== 1 ||
			plan.management.operation !== "update_application" ||
			plan.management.subjectType !== "agent_application" ||
			plan.management.subjectId !== application.applicationId ||
			plan.management.expectedRevision !== expected.managementRevision ||
			plan.management.outboxIntent !== null ||
			managementState.applicationId !== application.applicationId ||
			managementState.agentId !== application.agentId ||
			managementState.applicantId !== application.applicantId ||
			managementState.status !== "pending_approval" ||
			managementState.revision !== expected.managementRevision + 1 ||
			(transition.from !== "pending_approval" &&
				transition.from !== "rejected") ||
			transition.to !== "pending_approval" ||
			!validDate(transition.occurredAt) ||
			managementAudit.action !==
				(transition.from === "rejected"
					? "agent.application.resubmitted"
					: "agent.application.updated") ||
			managementAudit.actorId !== application.applicantId ||
			managementAudit.subjectType !== "agent_application" ||
			managementAudit.subjectId !== application.applicationId ||
			managementAudit.traceId !== application.traceId ||
			managementAudit.requestId !== application.requestId ||
			!validDate(managementAudit.occurredAt) ||
			Date.prototype.getTime.call(managementAudit.occurredAt) !==
				Date.prototype.getTime.call(transition.occurredAt) ||
			managementIdempotency.key !== idempotency.key ||
			typeof managementIdempotency.requestDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(managementIdempotency.requestDigest) ||
			!isAgentManagementText(idempotency.key, 128) ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(idempotency.key as string) ||
			typeof idempotency.requestDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(idempotency.requestDigest) ||
			result.applicationId !== application.applicationId ||
			result.agentId !== application.agentId ||
			result.managementRevision !== managementState.revision ||
			plan.outboxIntent.operation !== "agent.application.revised.v1" ||
			!sameValue(outbox.payload, result) ||
			outbox.traceId !== application.traceId ||
			outbox.requestId !== application.requestId ||
			!validDate(outbox.occurredAt) ||
			Date.prototype.getTime.call(outbox.occurredAt) !==
				Date.prototype.getTime.call(transition.occurredAt) ||
			!sameValue(outerAudit, managementAudit)
		) {
			throw new Error();
		}
		if (plan.configuration === null) {
			if (result.configurationRevision !== expected.configurationRevision) {
				throw new Error();
			}
		} else {
			const configurationValues = snapshotAgentManagementDataObject(
				plan.configuration,
			);
			requireAgentManagementExactKeys(configurationValues, [
				"schemaVersion",
				"agentId",
				"baseRevision",
				"nextRevision",
				"expectedAuthorizationRevision",
				"nextAuthorizationRevision",
				"configuration",
				"accessUpdate",
				"result",
				"idempotency",
				"outboxIntent",
				"auditEvent",
			]);
			const configuration = decodeAgentConfigurationRecordV1(
				plan.configuration.configuration,
			);
			const configurationResult = snapshotAgentManagementDataObject(
				plan.configuration.result,
			);
			requireAgentManagementExactKeys(configurationResult, [
				"schemaVersion",
				"agentId",
				"revision",
				"changedFields",
			]);
			const changedFields = snapshotAgentManagementDenseArray(
				configurationResult.changedFields,
				8,
			);
			const allowedChangedFields = new Set([
				"source",
				"environment",
				"modelConfiguration",
				"secrets",
				"actions",
				"channels",
				"owners",
				"availability",
			]);
			const configurationIdempotency = snapshotAgentManagementDataObject(
				plan.configuration.idempotency,
			);
			requireAgentManagementExactKeys(configurationIdempotency, [
				"key",
				"requestDigest",
			]);
			const configurationOutbox = snapshotAgentManagementDataObject(
				plan.configuration.outboxIntent,
			);
			requireAgentManagementExactKeys(configurationOutbox, [
				"operation",
				"payload",
				"traceId",
				"requestId",
				"occurredAt",
			]);
			const configurationPayload = snapshotAgentManagementDataObject(
				configurationOutbox.payload,
			);
			requireAgentManagementExactKeys(configurationPayload, [
				"schemaVersion",
				"agentId",
				"baseRevision",
				"configurationRevision",
				"changedFields",
			]);
			const configurationAudit = snapshotAgentManagementDataObject(
				plan.configuration.auditEvent,
			);
			requireAgentManagementExactKeys(configurationAudit, [
				"action",
				"actorId",
				"agentId",
				"subjectType",
				"subjectId",
				"changedFields",
				"traceId",
				"requestId",
				"occurredAt",
			]);
			let accessUpdate:
				| {
						agentId: unknown;
						expectedRevision: unknown;
						ownerIds: unknown;
						availability: unknown;
				  }
				| undefined;
			if (plan.configuration.accessUpdate !== null) {
				const values = snapshotAgentManagementDataObject(
					plan.configuration.accessUpdate,
				);
				requireAgentManagementExactKeys(values, [
					"schemaVersion",
					"fragmentType",
					"agentId",
					"expectedRevision",
					"ownerIds",
					"availability",
				]);
				if (
					values.schemaVersion !== 1 ||
					values.fragmentType !== "agent_access"
				) {
					throw new Error();
				}
				accessUpdate = {
					agentId: values.agentId,
					expectedRevision: values.expectedRevision,
					ownerIds: values.ownerIds,
					availability: values.availability,
				};
			}
			const expectedConfigurationAction =
				accessUpdate !== undefined &&
				changedFields.every(
					(field) => field === "owners" || field === "availability",
				)
					? "agent.access.updated"
					: "agent.configuration.revised";
			if (
				plan.configuration.schemaVersion !== 1 ||
				plan.configuration.agentId !== application.agentId ||
				plan.configuration.baseRevision !== expected.configurationRevision ||
				plan.configuration.nextRevision !==
					expected.configurationRevision + 1 ||
				plan.configuration.expectedAuthorizationRevision !==
					expected.authorizationRevision ||
				plan.configuration.nextAuthorizationRevision !==
					plan.nextAuthorizationRevision ||
				configuration.agentId !== application.agentId ||
				configuration.revision !== plan.configuration.nextRevision ||
				result.configurationRevision !== plan.configuration.nextRevision ||
				configurationResult.schemaVersion !== 1 ||
				configurationResult.agentId !== application.agentId ||
				configurationResult.revision !== plan.configuration.nextRevision ||
				changedFields.length === 0 ||
				new Set(changedFields).size !== changedFields.length ||
				changedFields.some(
					(field) => !allowedChangedFields.has(field as string),
				) ||
				configurationIdempotency.key !== idempotency.key ||
				typeof configurationIdempotency.requestDigest !== "string" ||
				!/^[a-f0-9]{64}$/.test(configurationIdempotency.requestDigest) ||
				configurationOutbox.operation !== "agent.configuration.revised.v1" ||
				configurationOutbox.traceId !== application.traceId ||
				configurationOutbox.requestId !== application.requestId ||
				!validDate(configurationOutbox.occurredAt) ||
				Date.prototype.getTime.call(configurationOutbox.occurredAt) !==
					Date.prototype.getTime.call(transition.occurredAt) ||
				configurationPayload.schemaVersion !== 1 ||
				configurationPayload.agentId !== application.agentId ||
				configurationPayload.baseRevision !== expected.configurationRevision ||
				configurationPayload.configurationRevision !==
					plan.configuration.nextRevision ||
				!sameValue(configurationPayload.changedFields, changedFields) ||
				configurationAudit.action !== expectedConfigurationAction ||
				configurationAudit.actorId !== application.applicantId ||
				configurationAudit.agentId !== application.agentId ||
				configurationAudit.subjectType !== "agent" ||
				configurationAudit.subjectId !== application.agentId ||
				!sameValue(configurationAudit.changedFields, changedFields) ||
				configurationAudit.traceId !== application.traceId ||
				configurationAudit.requestId !== application.requestId ||
				!validDate(configurationAudit.occurredAt) ||
				Date.prototype.getTime.call(configurationAudit.occurredAt) !==
					Date.prototype.getTime.call(transition.occurredAt)
			) {
				throw new Error();
			}
			if (
				accessUpdate &&
				(accessUpdate.agentId !== application.agentId ||
					accessUpdate.expectedRevision !== expected.managementRevision ||
					!sameValue(accessUpdate.ownerIds, managementState.ownerIds) ||
					!sameValue(accessUpdate.availability, managementState.availability))
			) {
				throw new Error();
			}
		}
		return plan;
	} catch {
		throw new ApplicationRevisionError("persistence_failed");
	}
}

function configurationError(error: unknown): ApplicationRevisionError {
	if (!(error instanceof AgentConfigurationError)) {
		return new ApplicationRevisionError("dependency_unavailable");
	}
	if (
		error.code === "invalid_command" ||
		error.code === "not_authorized" ||
		error.code === "not_admitted" ||
		error.code === "no_change" ||
		error.code === "idempotency_conflict"
	) {
		return new ApplicationRevisionError(error.code);
	}
	if (error.code === "stale_revision") {
		return new ApplicationRevisionError("stale_revision");
	}
	return new ApplicationRevisionError(
		error.code === "dependency_unavailable"
			? "dependency_unavailable"
			: "persistence_failed",
	);
}

async function captureConfigurationPlan(
	state: ApplicationRevisionReadStateV1,
	command: ReviseApplicationCommandV1,
	actorContext: ApplicationRevisionActorContextV1,
	dependencies: ApplicationRevisionUseCaseDependenciesV1,
	now: () => Date,
): Promise<{
	plan: AgentConfigurationWritePlanV1 | null;
	nextAuthorizationRevision: string;
}> {
	let capturedPlan: AgentConfigurationWritePlanV1 | undefined;
	let nextAuthorizationRevision: string | undefined;
	const authorizationAdmission = {
		async authorize(
			input: Parameters<
				typeof dependencies.authorizationAdmission.authorize
			>[0],
		) {
			const decision =
				await dependencies.authorizationAdmission.authorize(input);
			const revision = parseAuthorizationRevision(
				decision,
				state.application.agentId,
				actorContext.userId,
			);
			if (typeof revision === "string") nextAuthorizationRevision = revision;
			return decision;
		},
	};
	const useCase = createAgentConfigurationUseCaseV1(
		{
			...dependencies,
			authorizationAdmission,
			transaction: {
				async read() {
					return {
						outcome: "ready" as const,
						record: {
							schemaVersion: 1 as const,
							configuration: state.configuration,
							authorizationRevision: state.authorizationRevision,
						},
					};
				},
				async commit(plan) {
					capturedPlan = plan;
					return { outcome: "committed" as const, result: plan.result };
				},
			},
		},
		{ now },
	);
	const ownerIds = [
		...new Set([state.application.applicantId, ...command.coOwnerIds]),
	].toSorted();
	try {
		await useCase.update(
			{
				schemaVersion: 1,
				agentId: state.application.agentId,
				idempotencyKey: command.idempotencyKey,
				requestId: command.requestId,
				traceId: command.traceId,
				changes: {
					ownerIds,
					availability: command.availability,
					source: command.source,
					...(command.modelConfiguration === undefined
						? {}
						: { modelConfiguration: command.modelConfiguration }),
					environment: command.environment,
					secrets: command.secrets,
					actions: command.actions,
					channels: command.channels,
				},
			},
			{
				schemaVersion: 1,
				actorId: actorContext.userId,
				rawRequestDigest: actorContext.rawRequestDigest,
			} satisfies AgentConfigurationActorContextV1,
		);
	} catch (error) {
		const normalized = configurationError(error);
		if (normalized.code !== "no_change") throw normalized;
	}
	if (!nextAuthorizationRevision) {
		throw new ApplicationRevisionError("dependency_unavailable");
	}
	return { plan: capturedPlan ?? null, nextAuthorizationRevision };
}

async function captureManagementPlan(
	state: ApplicationRevisionReadStateV1,
	command: ReviseApplicationCommandV1,
	actorContext: ApplicationRevisionActorContextV1,
	now: () => Date,
): Promise<AgentManagementWritePlanV1> {
	let capturedPlan: AgentManagementWritePlanV1 | undefined;
	let decision: Awaited<
		ReturnType<
			ReturnType<typeof createAgentManagementV1>["executeManagementCommand"]
		>
	>;
	try {
		decision = await createAgentManagementV1(
			{
				async executeAgentManagementTransaction(_request, decide) {
					const result = decide(state.management);
					if (result.outcome === "accepted") capturedPlan = result.writePlan;
					return result;
				},
				async resolveAgentAccessState() {
					return state.management;
				},
			},
			{ now },
		).executeManagementCommand(
			{
				schemaVersion: 1,
				command: "update_application",
				applicationId: state.application.applicationId,
				expectedRevision: state.management.revision,
				idempotencyKey: command.idempotencyKey,
				requestId: command.requestId,
				traceId: command.traceId,
			},
			{
				schemaVersion: 1,
				userId: actorContext.userId,
				accountStatus: actorContext.accountStatus,
				organizationIds: actorContext.organizationIds,
				isAdministrator: actorContext.isAdministrator,
			},
		);
	} catch {
		throw new ApplicationRevisionError("dependency_unavailable");
	}
	if (decision.outcome === "denied") {
		throw new ApplicationRevisionError("not_authorized");
	}
	if (decision.outcome === "conflict") {
		throw new ApplicationRevisionError(
			decision.reason === "stale_revision"
				? "stale_revision"
				: "not_authorized",
		);
	}
	if (decision.outcome !== "accepted" || !capturedPlan) {
		throw new ApplicationRevisionError("persistence_failed");
	}
	return capturedPlan;
}

function parseCommitDecision(
	input: unknown,
	expected: ApplicationRevisionResultV1,
): ApplicationRevisionCommitDecisionV1 {
	try {
		const decision = snapshotAgentManagementDataObject(input);
		if (decision.outcome === "committed" || decision.outcome === "replayed") {
			requireAgentManagementExactKeys(decision, ["outcome", "result"]);
			const result = parseResult(decision.result);
			if (JSON.stringify(result) !== JSON.stringify(expected))
				throw new Error();
			return { outcome: decision.outcome, result };
		}
		if (decision.outcome === "conflict") {
			requireAgentManagementExactKeys(decision, ["outcome", "reason"]);
			if (
				decision.reason !== "idempotency_conflict" &&
				decision.reason !== "stale_authorization" &&
				decision.reason !== "stale_configuration" &&
				decision.reason !== "stale_management"
			) {
				throw new Error();
			}
			return {
				outcome: "conflict",
				reason: decision.reason,
			};
		}
		throw new Error();
	} catch (error) {
		if (error instanceof ApplicationRevisionError) throw error;
		throw new ApplicationRevisionError("persistence_failed");
	}
}

export function createApplicationRevisionUseCaseV1(
	dependencies: ApplicationRevisionUseCaseDependenciesV1,
	options: ApplicationRevisionUseCaseOptionsV1 = {},
): ApplicationRevisionUseCaseV1 {
	const now = options.now ?? (() => new Date());
	return {
		async revise(commandInput, actorContextInput) {
			const command = parseCommand(commandInput);
			const actorContext = parseActorContext(actorContextInput);
			let readDecision: ApplicationRevisionReadDecisionV1;
			try {
				readDecision = parseReadDecision(
					await dependencies.transaction.read({
						schemaVersion: 1,
						applicationId: actorContext.applicationId,
						actorId: actorContext.userId,
						idempotencyKey: command.idempotencyKey,
						requestDigest: actorContext.rawRequestDigest,
					}),
				);
			} catch {
				throw new ApplicationRevisionError("persistence_failed");
			}
			if (readDecision.outcome === "unavailable") {
				throw new ApplicationRevisionError("not_authorized");
			}
			if (readDecision.outcome === "idempotency_conflict") {
				throw new ApplicationRevisionError("idempotency_conflict");
			}
			if (readDecision.outcome === "replayed") {
				if (
					readDecision.result.applicationId !== actorContext.applicationId ||
					actorContext.accountStatus !== "active"
				) {
					throw new ApplicationRevisionError("not_authorized");
				}
				await requireCurrentAuthorization(
					dependencies,
					readDecision.result.agentId,
					actorContext,
					command,
				);
				return readDecision.result;
			}
			const state = readDecision.state;
			if (
				state.application.applicationId !== actorContext.applicationId ||
				state.application.applicantId !== actorContext.userId ||
				actorContext.accountStatus !== "active" ||
				(state.management.status !== "pending_approval" &&
					state.management.status !== "rejected")
			) {
				throw new ApplicationRevisionError("not_authorized");
			}
			const sharedNow = cachedClock(now);
			const configuration = await captureConfigurationPlan(
				state,
				command,
				actorContext,
				dependencies,
				sharedNow,
			);
			const contentChanged =
				state.application.name !== command.name ||
				state.application.description !== command.description;
			if (
				!configuration.plan &&
				!contentChanged &&
				state.management.status === "pending_approval"
			) {
				throw new ApplicationRevisionError("no_change");
			}
			let management = await captureManagementPlan(
				state,
				command,
				actorContext,
				sharedNow,
			);
			if (configuration.plan?.accessUpdate) {
				management = {
					...management,
					state: {
						...management.state,
						ownerIds: configuration.plan.accessUpdate.ownerIds,
						availability: configuration.plan.accessUpdate.availability,
					},
				};
			}
			const result: ApplicationRevisionResultV1 = {
				schemaVersion: 1,
				applicationId: state.application.applicationId,
				agentId: state.application.agentId,
				status: "pending_approval",
				managementRevision: management.state.revision,
				configurationRevision:
					configuration.plan?.nextRevision ?? state.configuration.revision,
			};
			const occurredAt = management.transition.occurredAt;
			const plan: ApplicationRevisionWritePlanV1 = {
				schemaVersion: 1,
				application: {
					applicationId: state.application.applicationId,
					agentId: state.application.agentId,
					applicantId: state.application.applicantId,
					name: command.name,
					description: command.description,
					traceId: command.traceId,
					requestId: command.requestId,
				},
				expected: {
					managementRevision: state.management.revision,
					configurationRevision: state.configuration.revision,
					authorizationRevision: state.authorizationRevision,
				},
				nextAuthorizationRevision: configuration.nextAuthorizationRevision,
				management,
				configuration: configuration.plan,
				result,
				idempotency: {
					key: command.idempotencyKey,
					requestDigest: actorContext.rawRequestDigest,
				},
				outboxIntent: {
					operation: "agent.application.revised.v1",
					payload: result,
					traceId: command.traceId,
					requestId: command.requestId,
					occurredAt,
				},
				auditEvent: management.auditEvent,
			};
			let commitDecision: ApplicationRevisionCommitDecisionV1;
			try {
				const capturedPlan = snapshotApplicationRevisionWritePlanV1(plan);
				commitDecision = parseCommitDecision(
					await dependencies.transaction.commit(capturedPlan),
					result,
				);
			} catch {
				throw new ApplicationRevisionError("persistence_failed");
			}
			if (commitDecision.outcome === "conflict") {
				throw new ApplicationRevisionError(
					commitDecision.reason === "idempotency_conflict"
						? "idempotency_conflict"
						: "stale_revision",
				);
			}
			return commitDecision.result;
		},
	};
}
