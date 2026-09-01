import { Buffer } from "node:buffer";

import {
	type AdmittedInitialAgentConfigurationV1,
	type AgentConfigurationAccessTargetV1,
	type AgentConfigurationActorContextV1,
	AgentConfigurationError,
	type AgentConfigurationRecordV1,
	admitInitialAgentConfigurationV1,
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

export interface ApplicationFoundationTransactionPortV1 {
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
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			) {
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
			Object.keys(decision).length !== 2 ||
			typeof decision.result !== "object" ||
			decision.result === null ||
			Array.isArray(decision.result)
		) {
			throw new Error();
		}
		const result = decision.result as Record<string, unknown>;
		if (
			Object.keys(result).length !== 5 ||
			result.schemaVersion !== expected.schemaVersion ||
			result.applicationId !== expected.applicationId ||
			result.agentId !== expected.agentId ||
			result.configurationRevision !== expected.configurationRevision ||
			result.status !== expected.status
		) {
			throw new Error();
		}
		return {
			outcome: decision.outcome,
			result: structuredClone(expected),
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
			let admitted: AdmittedInitialAgentConfigurationV1;
			try {
				admitted = await admitInitialAgentConfigurationV1(
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
			let submittedAt: Date;
			try {
				const milliseconds = Date.prototype.getTime.call(now());
				if (!Number.isFinite(milliseconds)) throw new Error();
				submittedAt = new Date(milliseconds);
			} catch {
				throw new ApplicationFoundationError("persistence_failed");
			}
			const result: CommitApplicationFoundationResultV1 = {
				schemaVersion: 1,
				applicationId: command.applicationId,
				agentId: command.agentId,
				configurationRevision: initialConfigurationRevision,
				status: "pending_approval",
			};
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
