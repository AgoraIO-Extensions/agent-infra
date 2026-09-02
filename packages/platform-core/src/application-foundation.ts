import { Buffer } from "node:buffer";

import {
	type AdmittedInitialAgentConfigurationV1,
	type AgentConfigurationAccessTargetV1,
	type AgentConfigurationActorContextV1,
	AgentConfigurationError,
	type AgentConfigurationRecordV1,
	beginInitialAgentConfigurationAdmissionV1,
	decodeAgentConfigurationRecordV1,
	type InitialAgentConfigurationAdmissionDependenciesV1,
	type InitialAgentConfigurationCommandV1,
} from "./agent-configuration.js";

export interface CommitApplicationFoundationCommandV1
	extends InitialAgentConfigurationCommandV1 {
	readonly applicationId: string;
	readonly idempotencyKey: string;
	readonly name: string;
	readonly description: string;
}

export interface ApplicationFoundationActorContextV1 {
	readonly schemaVersion: 1;
	readonly userId: string;
	readonly rawRequestDigest: string;
}

export interface CommitApplicationFoundationResultV1 {
	readonly schemaVersion: 1;
	readonly applicationId: string;
	readonly agentId: string;
	readonly configurationRevision: 1;
	readonly status: "pending_approval";
}

export interface ApplicationFoundationWritePlanV1 {
	readonly schemaVersion: 1;
	readonly agent: {
		readonly agentId: string;
		readonly currentConfigurationRevision: 1;
		readonly authorizationRevision: string;
		readonly createdAt: Date;
	};
	readonly application: {
		readonly applicationId: string;
		readonly agentId: string;
		readonly applicantId: string;
		readonly name: string;
		readonly description: string;
		readonly status: "pending_approval";
		readonly traceId: string;
		readonly requestId: string;
		readonly submittedAt: Date;
	};
	readonly configurationRevision: {
		readonly agentId: string;
		readonly revision: 1;
		readonly configuration: AgentConfigurationRecordV1;
		readonly createdAt: Date;
	};
	readonly access: {
		readonly agentId: string;
		readonly ownerIds: readonly string[];
		readonly availability: readonly AgentConfigurationAccessTargetV1[];
		readonly createdAt: Date;
	};
	readonly result: CommitApplicationFoundationResultV1;
	readonly idempotency: {
		readonly key: string;
		readonly requestDigest: string;
	};
	readonly outboxIntent: {
		readonly scopeType: "agent";
		readonly scopeId: string;
		readonly operation: "agent.application.submitted.v1";
		readonly payload: {
			readonly schemaVersion: 1;
			readonly applicationId: string;
			readonly agentId: string;
			readonly configurationRevision: 1;
		};
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
	readonly auditEvent: {
		readonly traceId: string;
		readonly requestId: string;
		readonly agentId: string;
		readonly actorType: "user";
		readonly actorId: string;
		readonly action: "agent.application.submitted";
		readonly targetType: "agent_application";
		readonly targetId: string;
		readonly outcome: "succeeded";
		readonly occurredAt: Date;
	};
}

export type ApplicationFoundationCommitDecisionV1 =
	| {
			readonly outcome: "committed" | "replayed";
			readonly result: CommitApplicationFoundationResultV1;
	  }
	| {
			readonly outcome: "conflict";
			readonly reason: "duplicate" | "idempotency_conflict";
	  };

export type ApplicationFoundationReadDecisionV1 =
	| { readonly outcome: "ready" }
	| {
			readonly outcome: "replayed";
			readonly result: CommitApplicationFoundationResultV1;
	  }
	| { readonly outcome: "idempotency_conflict" };

export interface ApplicationFoundationTransactionPortV1 {
	read(input: {
		readonly schemaVersion: 1;
		readonly applicationId: string;
		readonly agentId: string;
		readonly actorId: string;
		readonly idempotencyKey: string;
		readonly requestDigest: string;
	}): Promise<ApplicationFoundationReadDecisionV1>;
	commit(
		plan: ApplicationFoundationWritePlanV1,
	): Promise<ApplicationFoundationCommitDecisionV1>;
}

export interface ApplicationFoundationUseCaseV1 {
	submit(
		command: CommitApplicationFoundationCommandV1,
		actorContext: ApplicationFoundationActorContextV1,
	): Promise<CommitApplicationFoundationResultV1>;
}

export interface ApplicationFoundationUseCaseOptionsV1 {
	readonly now?: () => Date;
}

export interface ApplicationFoundationUseCaseDependenciesV1
	extends InitialAgentConfigurationAdmissionDependenciesV1 {
	readonly transaction: ApplicationFoundationTransactionPortV1;
}

export type ApplicationFoundationErrorCode =
	| "invalid_command"
	| "not_authorized"
	| "not_admitted"
	| "dependency_unavailable"
	| "conflict"
	| "idempotency_conflict"
	| "persistence_failed";

const applicationFoundationErrorBrand = Symbol.for(
	"@agent-infra/platform-core/ApplicationFoundationErrorV1",
);

function applicationFoundationErrorMessage(
	code: ApplicationFoundationErrorCode,
): string {
	return `Application foundation ${code.replaceAll("_", " ")}`;
}

export class ApplicationFoundationError extends Error {
	readonly code: ApplicationFoundationErrorCode;

	constructor(code: ApplicationFoundationErrorCode) {
		super(applicationFoundationErrorMessage(code));
		this.name = "ApplicationFoundationError";
		this.code = code;
		Object.defineProperty(this, applicationFoundationErrorBrand, {
			value: true,
		});
	}
}

function isApplicationFoundationErrorCode(
	value: unknown,
): value is ApplicationFoundationErrorCode {
	return (
		value === "invalid_command" ||
		value === "not_authorized" ||
		value === "not_admitted" ||
		value === "dependency_unavailable" ||
		value === "conflict" ||
		value === "idempotency_conflict" ||
		value === "persistence_failed"
	);
}

function recognizedApplicationFoundationErrorCode(
	error: unknown,
): ApplicationFoundationErrorCode | undefined {
	try {
		if (!(error instanceof Error)) return undefined;
		const code = (error as Error & { code?: unknown }).code;
		if (
			error.name !== "ApplicationFoundationError" ||
			!isApplicationFoundationErrorCode(code) ||
			error.message !== applicationFoundationErrorMessage(code)
		) {
			return undefined;
		}
		const descriptor = Object.getOwnPropertyDescriptor(
			error,
			applicationFoundationErrorBrand,
		);
		if (
			descriptor?.value !== true ||
			descriptor.writable !== false ||
			descriptor.configurable !== false ||
			descriptor.enumerable !== false
		) {
			return undefined;
		}
		return code;
	} catch {
		return undefined;
	}
}

const commandRequiredKeys = [
	"schemaVersion",
	"applicationId",
	"agentId",
	"idempotencyKey",
	"requestId",
	"name",
	"description",
	"coOwnerIds",
	"availability",
	"source",
	"environment",
	"secrets",
	"actions",
	"channels",
	"traceId",
] as const;
const commandOptionalKeys = ["modelConfiguration"] as const;
const actorContextKeys = [
	"schemaVersion",
	"userId",
	"rawRequestDigest",
] as const;

function isEnumerableDataDescriptor(
	descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
	return (
		descriptor?.enumerable === true &&
		Object.hasOwn(descriptor, "value") &&
		!Object.hasOwn(descriptor, "get") &&
		!Object.hasOwn(descriptor, "set")
	);
}

function snapshotExactDataValues(
	value: unknown,
	expectedKeys: readonly string[],
	optionalKeys: readonly string[] = [],
): Record<string, unknown> | undefined {
	try {
		if (typeof value !== "object" || value === null) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const ownKeys = Reflect.ownKeys(descriptors);
		const expected = new Set(expectedKeys);
		const allowed = new Set([...expectedKeys, ...optionalKeys]);
		if (
			ownKeys.length < expected.size ||
			ownKeys.length > allowed.size ||
			ownKeys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
			expectedKeys.some((key) => !Object.hasOwn(descriptors, key))
		) {
			return undefined;
		}
		const normalized: Record<string, unknown> = {};
		for (const key of [...expectedKeys, ...optionalKeys]) {
			const descriptor = descriptors[key];
			if (!descriptor && optionalKeys.includes(key)) continue;
			if (!isEnumerableDataDescriptor(descriptor)) {
				return undefined;
			}
			normalized[key] = descriptor.value;
		}
		return normalized;
	} catch {
		return undefined;
	}
}

function invalidApplicationFoundationInput(): never {
	throw new ApplicationFoundationError("invalid_command");
}

function isCapturedText(value: unknown, maxBytes = 1024): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

function parseApplicationFoundationCommandV1(
	command: unknown,
): CommitApplicationFoundationCommandV1 {
	try {
		const values = snapshotExactDataValues(
			command,
			commandRequiredKeys,
			commandOptionalKeys,
		);
		if (!values) invalidApplicationFoundationInput();
		const {
			schemaVersion,
			applicationId,
			agentId,
			idempotencyKey,
			requestId,
			name,
			description,
			traceId,
		} = values;
		if (
			schemaVersion !== 1 ||
			!isCapturedText(applicationId) ||
			!isCapturedText(agentId) ||
			!isCapturedText(idempotencyKey, 128) ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(idempotencyKey) ||
			!isCapturedText(requestId) ||
			!isCapturedText(name, 800) ||
			!isCapturedText(description, 65_536) ||
			!isCapturedText(traceId)
		) {
			invalidApplicationFoundationInput();
		}
		let nameCodePointCount = 0;
		for (let offset = 0; offset < name.length; nameCodePointCount += 1) {
			const codePoint = name.codePointAt(offset);
			offset += (codePoint ?? 0) > 0xffff ? 2 : 1;
			if (nameCodePointCount >= 200) invalidApplicationFoundationInput();
		}
		return {
			schemaVersion,
			applicationId,
			agentId,
			idempotencyKey,
			requestId,
			name,
			description,
			coOwnerIds: values.coOwnerIds as readonly string[],
			availability:
				values.availability as readonly AgentConfigurationAccessTargetV1[],
			source: values.source as InitialAgentConfigurationCommandV1["source"],
			...(Object.hasOwn(values, "modelConfiguration")
				? {
						modelConfiguration:
							values.modelConfiguration as InitialAgentConfigurationCommandV1["modelConfiguration"],
					}
				: {}),
			environment:
				values.environment as InitialAgentConfigurationCommandV1["environment"],
			secrets: values.secrets as InitialAgentConfigurationCommandV1["secrets"],
			actions: values.actions as InitialAgentConfigurationCommandV1["actions"],
			channels:
				values.channels as InitialAgentConfigurationCommandV1["channels"],
			traceId,
		};
	} catch {
		invalidApplicationFoundationInput();
	}
}

function parseApplicationFoundationActorContextV1(
	actorContext: unknown,
): ApplicationFoundationActorContextV1 {
	const values = snapshotExactDataValues(actorContext, actorContextKeys);
	if (!values) invalidApplicationFoundationInput();
	const { schemaVersion, userId, rawRequestDigest } = values;
	if (
		schemaVersion !== 1 ||
		!isCapturedText(userId) ||
		typeof rawRequestDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(rawRequestDigest)
	) {
		invalidApplicationFoundationInput();
	}
	return { schemaVersion, userId, rawRequestDigest };
}

function requiredPlanObject(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	const values = snapshotExactDataValues(input, keys);
	if (!values) throw new ApplicationFoundationError("persistence_failed");
	return values;
}

function snapshotPlanArray(input: unknown, maximum: number): unknown[] {
	try {
		if (!Array.isArray(input) || input.length > maximum) throw new Error();
		const descriptors = Object.getOwnPropertyDescriptors(input);
		if (Reflect.ownKeys(descriptors).length !== input.length + 1) {
			throw new Error();
		}
		return Array.from({ length: input.length }, (_, index) => {
			const descriptor = descriptors[String(index)];
			if (!isEnumerableDataDescriptor(descriptor)) {
				throw new Error();
			}
			return descriptor.value;
		});
	} catch {
		throw new ApplicationFoundationError("persistence_failed");
	}
}

function snapshotPlanDate(input: unknown): Date {
	try {
		return new Date(Date.prototype.getTime.call(input));
	} catch {
		throw new ApplicationFoundationError("persistence_failed");
	}
}

function snapshotPlanAccessTarget(
	input: unknown,
): AgentConfigurationAccessTargetV1 {
	const user = snapshotExactDataValues(input, ["kind", "userId"]);
	if (user?.kind === "user") {
		return { kind: "user", userId: user.userId as string };
	}
	const organization = snapshotExactDataValues(input, [
		"kind",
		"organizationId",
	]);
	if (organization?.kind === "organization") {
		return {
			kind: "organization",
			organizationId: organization.organizationId as string,
		};
	}
	throw new ApplicationFoundationError("persistence_failed");
}

export function snapshotApplicationFoundationWritePlanV1(
	input: unknown,
): ApplicationFoundationWritePlanV1 {
	try {
		const plan = requiredPlanObject(input, [
			"schemaVersion",
			"agent",
			"application",
			"configurationRevision",
			"access",
			"result",
			"idempotency",
			"outboxIntent",
			"auditEvent",
		]);
		const agent = requiredPlanObject(plan.agent, [
			"agentId",
			"currentConfigurationRevision",
			"authorizationRevision",
			"createdAt",
		]);
		const application = requiredPlanObject(plan.application, [
			"applicationId",
			"agentId",
			"applicantId",
			"name",
			"description",
			"status",
			"traceId",
			"requestId",
			"submittedAt",
		]);
		const configurationRevision = requiredPlanObject(
			plan.configurationRevision,
			["agentId", "revision", "configuration", "createdAt"],
		);
		const access = requiredPlanObject(plan.access, [
			"agentId",
			"ownerIds",
			"availability",
			"createdAt",
		]);
		const result = requiredPlanObject(plan.result, [
			"schemaVersion",
			"applicationId",
			"agentId",
			"configurationRevision",
			"status",
		]);
		const idempotency = requiredPlanObject(plan.idempotency, [
			"key",
			"requestDigest",
		]);
		const outboxIntent = requiredPlanObject(plan.outboxIntent, [
			"scopeType",
			"scopeId",
			"operation",
			"payload",
			"traceId",
			"requestId",
			"occurredAt",
		]);
		const outboxPayload = requiredPlanObject(outboxIntent.payload, [
			"schemaVersion",
			"applicationId",
			"agentId",
			"configurationRevision",
		]);
		const auditEvent = requiredPlanObject(plan.auditEvent, [
			"traceId",
			"requestId",
			"agentId",
			"actorType",
			"actorId",
			"action",
			"targetType",
			"targetId",
			"outcome",
			"occurredAt",
		]);
		return {
			schemaVersion: plan.schemaVersion as 1,
			agent: {
				agentId: agent.agentId as string,
				currentConfigurationRevision: agent.currentConfigurationRevision as 1,
				authorizationRevision: agent.authorizationRevision as string,
				createdAt: snapshotPlanDate(agent.createdAt),
			},
			application: {
				applicationId: application.applicationId as string,
				agentId: application.agentId as string,
				applicantId: application.applicantId as string,
				name: application.name as string,
				description: application.description as string,
				status: application.status as "pending_approval",
				traceId: application.traceId as string,
				requestId: application.requestId as string,
				submittedAt: snapshotPlanDate(application.submittedAt),
			},
			configurationRevision: {
				agentId: configurationRevision.agentId as string,
				revision: configurationRevision.revision as 1,
				configuration: decodeAgentConfigurationRecordV1(
					configurationRevision.configuration,
				),
				createdAt: snapshotPlanDate(configurationRevision.createdAt),
			},
			access: {
				agentId: access.agentId as string,
				ownerIds: snapshotPlanArray(access.ownerIds, 256) as string[],
				availability: snapshotPlanArray(access.availability, 256).map(
					snapshotPlanAccessTarget,
				),
				createdAt: snapshotPlanDate(access.createdAt),
			},
			result: {
				schemaVersion: result.schemaVersion as 1,
				applicationId: result.applicationId as string,
				agentId: result.agentId as string,
				configurationRevision: result.configurationRevision as 1,
				status: result.status as "pending_approval",
			},
			idempotency: {
				key: idempotency.key as string,
				requestDigest: idempotency.requestDigest as string,
			},
			outboxIntent: {
				scopeType: outboxIntent.scopeType as "agent",
				scopeId: outboxIntent.scopeId as string,
				operation: outboxIntent.operation as "agent.application.submitted.v1",
				payload: {
					schemaVersion: outboxPayload.schemaVersion as 1,
					applicationId: outboxPayload.applicationId as string,
					agentId: outboxPayload.agentId as string,
					configurationRevision: outboxPayload.configurationRevision as 1,
				},
				traceId: outboxIntent.traceId as string,
				requestId: outboxIntent.requestId as string,
				occurredAt: snapshotPlanDate(outboxIntent.occurredAt),
			},
			auditEvent: {
				traceId: auditEvent.traceId as string,
				requestId: auditEvent.requestId as string,
				agentId: auditEvent.agentId as string,
				actorType: auditEvent.actorType as "user",
				actorId: auditEvent.actorId as string,
				action: auditEvent.action as "agent.application.submitted",
				targetType: auditEvent.targetType as "agent_application",
				targetId: auditEvent.targetId as string,
				outcome: auditEvent.outcome as "succeeded",
				occurredAt: snapshotPlanDate(auditEvent.occurredAt),
			},
		};
	} catch {
		throw new ApplicationFoundationError("persistence_failed");
	}
}

function parseCommitDecision(
	input: unknown,
	expected: CommitApplicationFoundationResultV1,
): ApplicationFoundationCommitDecisionV1 {
	try {
		if (typeof input !== "object" || input === null) throw new Error();
		const decision = input as Record<string, unknown>;
		if (decision.outcome === "conflict") {
			if (
				Object.keys(decision).length !== 2 ||
				(decision.reason !== "duplicate" &&
					decision.reason !== "idempotency_conflict")
			) {
				throw new Error();
			}
			return { outcome: "conflict", reason: decision.reason };
		}
		if (
			(decision.outcome !== "committed" && decision.outcome !== "replayed") ||
			Object.keys(decision).length !== 2
		) {
			throw new Error();
		}
		return {
			outcome: decision.outcome,
			result: parseExpectedResult(decision.result, expected),
		};
	} catch {
		throw new ApplicationFoundationError("persistence_failed");
	}
}

function parseExpectedResult(
	input: unknown,
	expected: CommitApplicationFoundationResultV1,
): CommitApplicationFoundationResultV1 {
	const result = snapshotExactDataValues(input, [
		"schemaVersion",
		"applicationId",
		"agentId",
		"configurationRevision",
		"status",
	]);
	if (
		!result ||
		result.schemaVersion !== expected.schemaVersion ||
		result.applicationId !== expected.applicationId ||
		result.agentId !== expected.agentId ||
		result.configurationRevision !== expected.configurationRevision ||
		result.status !== expected.status
	) {
		throw new ApplicationFoundationError("persistence_failed");
	}
	return structuredClone(expected);
}

function parseReadDecision(
	input: unknown,
	expected: CommitApplicationFoundationResultV1,
): ApplicationFoundationReadDecisionV1 {
	try {
		if (typeof input !== "object" || input === null) throw new Error();
		const outcomeDescriptor = Object.getOwnPropertyDescriptor(input, "outcome");
		if (
			outcomeDescriptor?.enumerable !== true ||
			!Object.hasOwn(outcomeDescriptor, "value") ||
			Object.hasOwn(outcomeDescriptor, "get") ||
			Object.hasOwn(outcomeDescriptor, "set")
		) {
			throw new Error();
		}
		if (
			outcomeDescriptor.value === "ready" ||
			outcomeDescriptor.value === "idempotency_conflict"
		) {
			const decision = snapshotExactDataValues(input, ["outcome"]);
			if (!decision || decision.outcome !== outcomeDescriptor.value) {
				throw new Error();
			}
			return { outcome: outcomeDescriptor.value };
		}
		if (outcomeDescriptor.value !== "replayed") throw new Error();
		const decision = snapshotExactDataValues(input, ["outcome", "result"]);
		if (decision?.outcome !== "replayed") throw new Error();
		return {
			outcome: "replayed",
			result: parseExpectedResult(decision.result, expected),
		};
	} catch {
		throw new ApplicationFoundationError("persistence_failed");
	}
}

const initialConfigurationRevision = 1 as const;
const systemNow = (): Date => new Date();

function normalizeInitialAdmissionError(
	error: unknown,
): ApplicationFoundationError {
	if (error instanceof AgentConfigurationError) {
		switch (error.code) {
			case "invalid_command":
			case "not_authorized":
			case "not_admitted":
			case "dependency_unavailable":
				return new ApplicationFoundationError(error.code);
		}
	}
	return new ApplicationFoundationError("dependency_unavailable");
}

export function createApplicationFoundationUseCaseV1(
	dependencies: ApplicationFoundationUseCaseDependenciesV1,
	options: ApplicationFoundationUseCaseOptionsV1 = {},
): ApplicationFoundationUseCaseV1 {
	const now = options.now ?? systemNow;
	return {
		async submit(commandInput, actorContextInput) {
			const actorContext =
				parseApplicationFoundationActorContextV1(actorContextInput);
			const command = parseApplicationFoundationCommandV1(commandInput);
			let admission: Awaited<
				ReturnType<typeof beginInitialAgentConfigurationAdmissionV1>
			>;
			try {
				admission = await beginInitialAgentConfigurationAdmissionV1(
					{
						schemaVersion: 1,
						agentId: command.agentId,
						requestId: command.requestId,
						traceId: command.traceId,
						coOwnerIds: command.coOwnerIds,
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
					{
						schemaVersion: 1,
						actorId: actorContext.userId,
						rawRequestDigest: actorContext.rawRequestDigest,
					} satisfies AgentConfigurationActorContextV1,
					dependencies,
				);
			} catch (error) {
				throw normalizeInitialAdmissionError(error);
			}
			const result: CommitApplicationFoundationResultV1 = {
				schemaVersion: 1,
				applicationId: command.applicationId,
				agentId: command.agentId,
				configurationRevision: initialConfigurationRevision,
				status: "pending_approval",
			};
			let readDecision: ApplicationFoundationReadDecisionV1;
			try {
				readDecision = parseReadDecision(
					await dependencies.transaction.read({
						schemaVersion: 1,
						applicationId: command.applicationId,
						agentId: command.agentId,
						actorId: actorContext.userId,
						idempotencyKey: command.idempotencyKey,
						requestDigest: actorContext.rawRequestDigest,
					}),
					result,
				);
			} catch {
				throw new ApplicationFoundationError("persistence_failed");
			}
			if (readDecision.outcome === "replayed") return readDecision.result;
			if (readDecision.outcome === "idempotency_conflict") {
				throw new ApplicationFoundationError("idempotency_conflict");
			}
			let admitted: AdmittedInitialAgentConfigurationV1;
			try {
				admitted = await admission.complete();
			} catch (error) {
				throw normalizeInitialAdmissionError(error);
			}
			let submittedAt: Date;
			try {
				const milliseconds = Date.prototype.getTime.call(now());
				if (!Number.isFinite(milliseconds)) throw new Error();
				submittedAt = new Date(milliseconds);
			} catch {
				throw new ApplicationFoundationError("persistence_failed");
			}
			const plan: ApplicationFoundationWritePlanV1 = {
				schemaVersion: 1,
				agent: {
					agentId: command.agentId,
					currentConfigurationRevision: initialConfigurationRevision,
					authorizationRevision: admitted.authorizationRevision,
					createdAt: submittedAt,
				},
				application: {
					applicationId: command.applicationId,
					agentId: command.agentId,
					applicantId: actorContext.userId,
					name: command.name,
					description: command.description,
					status: "pending_approval",
					traceId: command.traceId,
					requestId: command.requestId,
					submittedAt,
				},
				configurationRevision: {
					agentId: command.agentId,
					revision: initialConfigurationRevision,
					configuration: admitted.configuration,
					createdAt: submittedAt,
				},
				access: {
					agentId: command.agentId,
					ownerIds: admitted.ownerIds,
					availability: admitted.availability,
					createdAt: submittedAt,
				},
				result,
				idempotency: {
					key: command.idempotencyKey,
					requestDigest: actorContext.rawRequestDigest,
				},
				outboxIntent: {
					scopeType: "agent",
					scopeId: command.agentId,
					operation: "agent.application.submitted.v1",
					payload: {
						schemaVersion: 1,
						applicationId: command.applicationId,
						agentId: command.agentId,
						configurationRevision: initialConfigurationRevision,
					},
					traceId: command.traceId,
					requestId: command.requestId,
					occurredAt: submittedAt,
				},
				auditEvent: {
					traceId: command.traceId,
					requestId: command.requestId,
					agentId: command.agentId,
					actorType: "user",
					actorId: actorContext.userId,
					action: "agent.application.submitted",
					targetType: "agent_application",
					targetId: command.applicationId,
					outcome: "succeeded",
					occurredAt: submittedAt,
				},
			};
			let decision: ApplicationFoundationCommitDecisionV1;
			try {
				decision = parseCommitDecision(
					await dependencies.transaction.commit(plan),
					result,
				);
			} catch (error) {
				const code = recognizedApplicationFoundationErrorCode(error);
				throw new ApplicationFoundationError(
					code === "conflict" || code === "idempotency_conflict"
						? code
						: "persistence_failed",
				);
			}
			if (decision.outcome === "conflict") {
				throw new ApplicationFoundationError(
					decision.reason === "idempotency_conflict"
						? "idempotency_conflict"
						: "conflict",
				);
			}
			return decision.result;
		},
	};
}
