export interface CommitApplicationFoundationCommandV1 {
	readonly schemaVersion: 1;
	readonly applicationId: string;
	readonly agentId: string;
	readonly requestId: string;
	readonly name: string;
	readonly description: string;
	readonly sourceReference: string;
	readonly traceId: string;
}

export interface ApplicationFoundationActorContextV1 {
	readonly schemaVersion: 1;
	readonly userId: string;
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
		readonly sourceReference: string;
		readonly createdAt: Date;
	};
	readonly owner: {
		readonly agentId: string;
		readonly ownerId: string;
		readonly createdAt: Date;
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

export interface ApplicationFoundationTransactionPortV1 {
	commit(plan: ApplicationFoundationWritePlanV1): Promise<void>;
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

export type ApplicationFoundationErrorCode =
	| "invalid_command"
	| "conflict"
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
		value === "conflict" ||
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

const requiredStrings = [
	"applicationId",
	"agentId",
	"requestId",
	"name",
	"description",
	"sourceReference",
	"traceId",
] as const;
const commandKeys = ["schemaVersion", ...requiredStrings] as const;
const actorContextKeys = ["schemaVersion", "userId"] as const;

function snapshotExactDataValues(
	value: unknown,
	expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
	try {
		if (typeof value !== "object" || value === null) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const ownKeys = Reflect.ownKeys(descriptors);
		const expected = new Set(expectedKeys);
		if (
			ownKeys.length !== expected.size ||
			ownKeys.some((key) => typeof key !== "string" || !expected.has(key))
		) {
			return undefined;
		}
		const normalized: Record<string, unknown> = {};
		for (const key of expectedKeys) {
			const descriptor = descriptors[key];
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

function parseApplicationFoundationCommandV1(
	command: unknown,
): CommitApplicationFoundationCommandV1 {
	try {
		const values = snapshotExactDataValues(command, commandKeys);
		if (!values) invalidApplicationFoundationInput();
		const {
			schemaVersion,
			applicationId,
			agentId,
			requestId,
			name,
			description,
			sourceReference,
			traceId,
		} = values;
		if (
			schemaVersion !== 1 ||
			![
				applicationId,
				agentId,
				requestId,
				name,
				description,
				sourceReference,
				traceId,
			].every((value) => typeof value === "string" && value.length > 0) ||
			typeof name !== "string"
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
			applicationId: applicationId as string,
			agentId: agentId as string,
			requestId: requestId as string,
			name,
			description: description as string,
			sourceReference: sourceReference as string,
			traceId: traceId as string,
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
	const { schemaVersion, userId } = values;
	if (
		schemaVersion !== 1 ||
		typeof userId !== "string" ||
		userId.length === 0
	) {
		invalidApplicationFoundationInput();
	}
	return { schemaVersion, userId };
}

const initialConfigurationRevision = 1 as const;
const systemNow = (): Date => new Date();

export function createApplicationFoundationUseCaseV1(
	transaction: ApplicationFoundationTransactionPortV1,
	options: ApplicationFoundationUseCaseOptionsV1 = {},
): ApplicationFoundationUseCaseV1 {
	const now = options.now ?? systemNow;
	return {
		async submit(command, actorContext) {
			const normalizedCommand = parseApplicationFoundationCommandV1(command);
			const normalizedActorContext =
				parseApplicationFoundationActorContextV1(actorContext);
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
					agentId: normalizedCommand.agentId,
					currentConfigurationRevision: initialConfigurationRevision,
					createdAt: submittedAt,
				},
				application: {
					applicationId: normalizedCommand.applicationId,
					agentId: normalizedCommand.agentId,
					applicantId: normalizedActorContext.userId,
					name: normalizedCommand.name,
					description: normalizedCommand.description,
					status: "pending_approval",
					traceId: normalizedCommand.traceId,
					requestId: normalizedCommand.requestId,
					submittedAt,
				},
				configurationRevision: {
					agentId: normalizedCommand.agentId,
					revision: initialConfigurationRevision,
					sourceReference: normalizedCommand.sourceReference,
					createdAt: submittedAt,
				},
				owner: {
					agentId: normalizedCommand.agentId,
					ownerId: normalizedActorContext.userId,
					createdAt: submittedAt,
				},
				outboxIntent: {
					scopeType: "agent",
					scopeId: normalizedCommand.agentId,
					operation: "agent.application.submitted.v1",
					payload: {
						schemaVersion: 1,
						applicationId: normalizedCommand.applicationId,
						agentId: normalizedCommand.agentId,
						configurationRevision: initialConfigurationRevision,
					},
					traceId: normalizedCommand.traceId,
					requestId: normalizedCommand.requestId,
					occurredAt: submittedAt,
				},
				auditEvent: {
					traceId: normalizedCommand.traceId,
					requestId: normalizedCommand.requestId,
					agentId: normalizedCommand.agentId,
					actorType: "user",
					actorId: normalizedActorContext.userId,
					action: "agent.application.submitted",
					targetType: "agent_application",
					targetId: normalizedCommand.applicationId,
					outcome: "succeeded",
					occurredAt: submittedAt,
				},
			};
			try {
				await transaction.commit(plan);
			} catch (error) {
				throw new ApplicationFoundationError(
					recognizedApplicationFoundationErrorCode(error) === "conflict"
						? "conflict"
						: "persistence_failed",
				);
			}
			return {
				schemaVersion: 1,
				applicationId: plan.application.applicationId,
				agentId: plan.agent.agentId,
				configurationRevision: plan.configurationRevision.revision,
				status: plan.application.status,
			};
		},
	};
}
