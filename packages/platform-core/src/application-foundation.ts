export interface CommitApplicationFoundationCommandV1 {
	readonly schemaVersion: 1;
	readonly applicationId: string;
	readonly agentId: string;
	readonly applicantId: string;
	readonly requestId: string;
	readonly name: string;
	readonly description: string;
	readonly sourceReference: string;
	readonly traceId: string;
	readonly submittedAt: Date;
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
	): Promise<CommitApplicationFoundationResultV1>;
}

export type ApplicationFoundationErrorCode =
	| "invalid_command"
	| "conflict"
	| "persistence_failed";

const applicationFoundationErrorBrand = Symbol.for(
	"@agent-infra/platform-core/ApplicationFoundationErrorV1",
);

export class ApplicationFoundationError extends Error {
	readonly code: ApplicationFoundationErrorCode;

	constructor(code: ApplicationFoundationErrorCode) {
		super(`Application foundation ${code.replaceAll("_", " ")}`);
		this.name = "ApplicationFoundationError";
		this.code = code;
		Object.defineProperty(this, applicationFoundationErrorBrand, {
			value: true,
		});
	}
}

function isApplicationFoundationError(
	error: unknown,
): error is ApplicationFoundationError {
	return (
		error instanceof ApplicationFoundationError ||
		(typeof error === "object" &&
			error !== null &&
			(error as Record<PropertyKey, unknown>)[
				applicationFoundationErrorBrand
			] === true)
	);
}

const requiredStrings = [
	"applicationId",
	"agentId",
	"applicantId",
	"requestId",
	"name",
	"description",
	"sourceReference",
	"traceId",
] as const;

function assertApplicationFoundationCommandV1(
	command: unknown,
): asserts command is CommitApplicationFoundationCommandV1 {
	if (typeof command !== "object" || command === null) {
		throw new ApplicationFoundationError("invalid_command");
	}
	const candidate = command as Partial<CommitApplicationFoundationCommandV1>;
	const nameLength =
		typeof candidate.name === "string" ? Array.from(candidate.name).length : 0;
	if (
		candidate.schemaVersion !== 1 ||
		requiredStrings.some(
			(field) =>
				typeof candidate[field] !== "string" || candidate[field].length === 0,
		) ||
		nameLength > 200 ||
		!(candidate.submittedAt instanceof Date) ||
		!Number.isFinite(candidate.submittedAt.valueOf())
	) {
		throw new ApplicationFoundationError("invalid_command");
	}
}

const initialConfigurationRevision = 1 as const;

export function createApplicationFoundationUseCaseV1(
	transaction: ApplicationFoundationTransactionPortV1,
): ApplicationFoundationUseCaseV1 {
	return {
		async submit(command) {
			assertApplicationFoundationCommandV1(command);
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
					applicantId: command.applicantId,
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
					ownerId: command.applicantId,
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
					actorId: command.applicantId,
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
				if (isApplicationFoundationError(error)) throw error;
				throw new ApplicationFoundationError("persistence_failed");
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
