export interface CommitApplicationFoundationCommandV1 {
	readonly schemaVersion: 1;
	readonly applicationId: string;
	readonly agentId: string;
	readonly requestId: string;
	readonly name: string;
	readonly description: string;
	readonly sourceReference: string;
	readonly traceId: string;
	readonly submittedAt: Date;
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
const commandKeys = new Set<PropertyKey>([
	"schemaVersion",
	...requiredStrings,
	"submittedAt",
]);
const actorContextKeys = new Set<PropertyKey>(["schemaVersion", "userId"]);

function hasExactOwnKeys(
	value: object,
	allowed: ReadonlySet<PropertyKey>,
): boolean {
	const ownKeys = Reflect.ownKeys(value);
	return (
		ownKeys.length === allowed.size && ownKeys.every((key) => allowed.has(key))
	);
}

function invalidApplicationFoundationInput(): never {
	throw new ApplicationFoundationError("invalid_command");
}

function isApplicationFoundationCommandV1(
	command: unknown,
): command is CommitApplicationFoundationCommandV1 {
	try {
		if (typeof command !== "object" || command === null) return false;
		const candidate = command as Partial<CommitApplicationFoundationCommandV1>;
		const nameLength =
			typeof candidate.name === "string"
				? Array.from(candidate.name).length
				: 0;
		return !(
			!hasExactOwnKeys(command, commandKeys) ||
			candidate.schemaVersion !== 1 ||
			requiredStrings.some(
				(field) =>
					typeof candidate[field] !== "string" || candidate[field].length === 0,
			) ||
			nameLength > 200 ||
			!(candidate.submittedAt instanceof Date) ||
			!Number.isFinite(candidate.submittedAt.valueOf())
		);
	} catch {
		return false;
	}
}

function assertApplicationFoundationCommandV1(
	command: unknown,
): asserts command is CommitApplicationFoundationCommandV1 {
	if (!isApplicationFoundationCommandV1(command)) {
		invalidApplicationFoundationInput();
	}
}

function isApplicationFoundationActorContextV1(
	actorContext: unknown,
): actorContext is ApplicationFoundationActorContextV1 {
	try {
		if (typeof actorContext !== "object" || actorContext === null) return false;
		const candidate =
			actorContext as Partial<ApplicationFoundationActorContextV1>;
		return !(
			!hasExactOwnKeys(actorContext, actorContextKeys) ||
			candidate.schemaVersion !== 1 ||
			typeof candidate.userId !== "string" ||
			candidate.userId.length === 0
		);
	} catch {
		return false;
	}
}

function assertApplicationFoundationActorContextV1(
	actorContext: unknown,
): asserts actorContext is ApplicationFoundationActorContextV1 {
	if (!isApplicationFoundationActorContextV1(actorContext)) {
		invalidApplicationFoundationInput();
	}
}

const initialConfigurationRevision = 1 as const;

export function createApplicationFoundationUseCaseV1(
	transaction: ApplicationFoundationTransactionPortV1,
): ApplicationFoundationUseCaseV1 {
	return {
		async submit(command, actorContext) {
			assertApplicationFoundationCommandV1(command);
			assertApplicationFoundationActorContextV1(actorContext);
			const submittedAt = new Date(command.submittedAt.valueOf());
			const plan: ApplicationFoundationWritePlanV1 = {
				schemaVersion: 1,
				agent: {
					agentId: command.agentId,
					currentConfigurationRevision: initialConfigurationRevision,
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
					sourceReference: command.sourceReference,
					createdAt: submittedAt,
				},
				owner: {
					agentId: command.agentId,
					ownerId: actorContext.userId,
					createdAt: submittedAt,
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
			try {
				await transaction.commit(plan);
			} catch (error) {
				throw new ApplicationFoundationError(
					recognizedApplicationFoundationErrorCode(error) ??
						"persistence_failed",
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
