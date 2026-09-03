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
	createAgentConfigurationPlanCaptureUseCaseV1,
	decodeAgentConfigurationRecordV1,
	parseAgentConfigurationChangesV1,
	snapshotAgentConfigurationWritePlanV1,
	type UpdateAgentConfigurationCommandV1,
} from "./agent-configuration.js";
import {
	type AgentManagementActorContextV1,
	type AgentManagementStateV1,
	type AgentManagementWritePlanV1,
	createAgentManagementV1,
	snapshotAgentManagementWritePlanV1,
} from "./agent-management.js";
import {
	isAgentManagementText,
	parseAgentManagementActorContext,
	parseAgentManagementPortState,
	parseAgentManagementStringArray,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import {
	type PendingSecretRecordAttachmentResolverV1,
	type PendingSecretRecordAttachmentsV1,
	resolvePendingSecretRecordAttachmentsV1,
} from "./secret-record-attachments.js";

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
	readonly secrets?: readonly AgentConfigurationSecretReplacementInputV1[];
	readonly actions: readonly AgentConfigurationActionV1[];
	readonly channels?: readonly AgentConfigurationChannelChangeV1[];
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
		attachments?: PendingSecretRecordAttachmentsV1,
	): Promise<ApplicationRevisionCommitDecisionV1>;
}

export interface ApplicationRevisionUseCaseV1 {
	revise(
		command: ReviseApplicationCommandV1,
		actorContext: ApplicationRevisionActorContextV1,
		attachment?: PendingSecretRecordAttachmentResolverV1,
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
			"actions",
		],
		["modelConfiguration", "secrets", "channels"],
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
	let changes: UpdateAgentConfigurationCommandV1["changes"];
	try {
		changes = parseAgentConfigurationChangesV1({
			coOwnerIds,
			availability: values.availability,
			source: values.source,
			...(Object.hasOwn(values, "modelConfiguration")
				? { modelConfiguration: values.modelConfiguration }
				: {}),
			environment: values.environment,
			...(Object.hasOwn(values, "secrets") ? { secrets: values.secrets } : {}),
			actions: values.actions,
			...(Object.hasOwn(values, "channels")
				? { channels: values.channels }
				: {}),
		});
	} catch {
		invalidCommand();
	}
	if (
		!changes.coOwnerIds ||
		!changes.availability ||
		!changes.source ||
		!changes.environment ||
		!changes.actions
	) {
		invalidCommand();
	}
	return {
		schemaVersion: 1,
		idempotencyKey: values.idempotencyKey,
		requestId: values.requestId,
		traceId: values.traceId,
		name: values.name,
		description: values.description,
		coOwnerIds: changes.coOwnerIds,
		availability: changes.availability,
		source: changes.source,
		...(Object.hasOwn(changes, "modelConfiguration")
			? { modelConfiguration: changes.modelConfiguration }
			: {}),
		environment: changes.environment,
		...(Object.hasOwn(changes, "secrets") ? { secrets: changes.secrets } : {}),
		actions: changes.actions,
		...(Object.hasOwn(changes, "channels")
			? { channels: changes.channels }
			: {}),
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

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function revisionPlanObject(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	try {
		const values = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(values, keys);
		return values;
	} catch {
		throw new ApplicationRevisionError("persistence_failed");
	}
}

function revisionPlanDate(input: unknown): Date {
	try {
		const milliseconds = Date.prototype.getTime.call(input);
		if (!Number.isFinite(milliseconds)) throw new Error();
		return new Date(milliseconds);
	} catch {
		throw new ApplicationRevisionError("persistence_failed");
	}
}

export function snapshotApplicationRevisionWritePlanV1(
	input: unknown,
): ApplicationRevisionWritePlanV1 {
	try {
		const top = revisionPlanObject(input, [
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
		const application = revisionPlanObject(top.application, [
			"applicationId",
			"agentId",
			"applicantId",
			"name",
			"description",
			"traceId",
			"requestId",
		]);
		const expected = revisionPlanObject(top.expected, [
			"managementRevision",
			"configurationRevision",
			"authorizationRevision",
		]);
		const management = snapshotAgentManagementWritePlanV1(top.management);
		const configuration =
			top.configuration === null
				? null
				: snapshotAgentConfigurationWritePlanV1(top.configuration);
		const result = parseResult(top.result);
		const idempotency = revisionPlanObject(top.idempotency, [
			"key",
			"requestDigest",
		]);
		const outbox = revisionPlanObject(top.outboxIntent, [
			"operation",
			"payload",
			"traceId",
			"requestId",
			"occurredAt",
		]);
		const outboxPayload = parseResult(outbox.payload);
		const outboxOccurredAt = revisionPlanDate(outbox.occurredAt);
		const outerAudit = revisionPlanObject(top.auditEvent, [
			"action",
			"actorId",
			"subjectType",
			"subjectId",
			"traceId",
			"requestId",
			"occurredAt",
		]);
		const outerAuditOccurredAt = revisionPlanDate(outerAudit.occurredAt);
		if (
			top.schemaVersion !== 1 ||
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
			!isAgentManagementText(top.nextAuthorizationRevision) ||
			management.operation !== "update_application" ||
			management.subjectType !== "agent_application" ||
			management.subjectId !== application.applicationId ||
			management.expectedRevision !== expected.managementRevision ||
			management.outboxIntent !== null ||
			management.state.applicationId !== application.applicationId ||
			management.state.agentId !== application.agentId ||
			management.state.applicantId !== application.applicantId ||
			!management.state.ownerIds.includes(application.applicantId) ||
			management.state.status !== "pending_approval" ||
			management.auditEvent.actorId !== application.applicantId ||
			management.auditEvent.traceId !== application.traceId ||
			management.auditEvent.requestId !== application.requestId ||
			management.idempotency.key !== idempotency.key ||
			!isAgentManagementText(idempotency.key, 128) ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(idempotency.key as string) ||
			typeof idempotency.requestDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(idempotency.requestDigest) ||
			result.applicationId !== application.applicationId ||
			result.agentId !== application.agentId ||
			result.managementRevision !== management.state.revision ||
			outbox.operation !== "agent.application.revised.v1" ||
			!sameValue(outboxPayload, result) ||
			outbox.traceId !== application.traceId ||
			outbox.requestId !== application.requestId ||
			outboxOccurredAt.getTime() !==
				management.transition.occurredAt.getTime() ||
			outerAuditOccurredAt.getTime() !==
				management.auditEvent.occurredAt.getTime() ||
			!sameValue(
				{ ...outerAudit, occurredAt: outerAuditOccurredAt },
				management.auditEvent,
			)
		) {
			throw new Error();
		}
		if (configuration === null) {
			if (result.configurationRevision !== expected.configurationRevision) {
				throw new Error();
			}
		} else {
			if (
				configuration.agentId !== application.agentId ||
				configuration.baseRevision !== expected.configurationRevision ||
				configuration.nextRevision !== expected.configurationRevision + 1 ||
				configuration.expectedAuthorizationRevision !==
					expected.authorizationRevision ||
				configuration.nextAuthorizationRevision !==
					top.nextAuthorizationRevision ||
				result.configurationRevision !== configuration.nextRevision ||
				configuration.idempotency.key !== idempotency.key ||
				configuration.outboxIntent.traceId !== application.traceId ||
				configuration.outboxIntent.requestId !== application.requestId ||
				configuration.outboxIntent.occurredAt.getTime() !==
					management.transition.occurredAt.getTime() ||
				configuration.auditEvent.actorId !== application.applicantId
			) {
				throw new Error();
			}
			if (
				configuration.accessUpdate &&
				(configuration.accessUpdate.expectedRevision !==
					expected.managementRevision ||
					!sameValue(
						configuration.accessUpdate.ownerIds,
						management.state.ownerIds,
					) ||
					!sameValue(
						configuration.accessUpdate.availability,
						management.state.availability,
					))
			) {
				throw new Error();
			}
		}
		return {
			schemaVersion: 1,
			application: {
				applicationId: application.applicationId,
				agentId: application.agentId,
				applicantId: application.applicantId,
				name: application.name,
				description: application.description,
				traceId: application.traceId,
				requestId: application.requestId,
			},
			expected: {
				managementRevision: expected.managementRevision as number,
				configurationRevision: expected.configurationRevision as number,
				authorizationRevision: expected.authorizationRevision,
			},
			nextAuthorizationRevision: top.nextAuthorizationRevision,
			management,
			configuration,
			result,
			idempotency: {
				key: idempotency.key,
				requestDigest: idempotency.requestDigest,
			},
			outboxIntent: {
				operation: "agent.application.revised.v1",
				payload: result,
				traceId: application.traceId,
				requestId: application.requestId,
				occurredAt: outboxOccurredAt,
			},
			auditEvent: management.auditEvent,
		};
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
	const useCase = createAgentConfigurationPlanCaptureUseCaseV1(
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
	try {
		await useCase.update(
			{
				schemaVersion: 1,
				agentId: state.application.agentId,
				idempotencyKey: command.idempotencyKey,
				requestId: command.requestId,
				traceId: command.traceId,
				changes: {
					coOwnerIds: [
						...new Set([state.application.applicantId, ...command.coOwnerIds]),
					].toSorted(),
					availability: command.availability,
					source: command.source,
					...(command.modelConfiguration === undefined
						? {}
						: { modelConfiguration: command.modelConfiguration }),
					environment: command.environment,
					...(Object.hasOwn(command, "secrets")
						? { secrets: command.secrets }
						: {}),
					actions: command.actions,
					...(Object.hasOwn(command, "channels")
						? { channels: command.channels }
						: {}),
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
		async revise(commandInput, actorContextInput, attachment) {
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
			let attachments: PendingSecretRecordAttachmentsV1 | undefined;
			if (plan.configuration !== null) {
				try {
					attachments = await resolvePendingSecretRecordAttachmentsV1({
						attachment,
						previousConfiguration: state.configuration,
						configuration: plan.configuration.configuration,
						ownerId: actorContext.userId,
						occurredAt,
					});
				} catch {
					throw new ApplicationRevisionError("dependency_unavailable");
				}
			} else if (attachment !== undefined) {
				throw new ApplicationRevisionError("dependency_unavailable");
			}
			let commitDecision: ApplicationRevisionCommitDecisionV1;
			try {
				const capturedPlan = snapshotApplicationRevisionWritePlanV1(plan);
				commitDecision = parseCommitDecision(
					await dependencies.transaction.commit(capturedPlan, attachments),
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
