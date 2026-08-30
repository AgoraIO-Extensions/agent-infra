export interface CommitApplicationFoundationCommandV1 {
	readonly schemaVersion: 1;
	readonly applicationId: string;
	readonly agentId: string;
	readonly applicantId: string;
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

export interface ApplicationFoundationTransactionV1 {
	commit(
		command: CommitApplicationFoundationCommandV1,
	): Promise<CommitApplicationFoundationResultV1>;
}

export type ApplicationFoundationErrorCode =
	| "invalid_command"
	| "conflict"
	| "persistence_failed";

export class ApplicationFoundationError extends Error {
	readonly code: ApplicationFoundationErrorCode;

	constructor(code: ApplicationFoundationErrorCode) {
		super(`Application foundation ${code.replaceAll("_", " ")}`);
		this.name = "ApplicationFoundationError";
		this.code = code;
	}
}

const requiredStrings = [
	"applicationId",
	"agentId",
	"applicantId",
	"name",
	"description",
	"sourceReference",
	"traceId",
] as const;

export function assertApplicationFoundationCommandV1(
	command: unknown,
): asserts command is CommitApplicationFoundationCommandV1 {
	if (typeof command !== "object" || command === null) {
		throw new ApplicationFoundationError("invalid_command");
	}
	const candidate = command as Partial<CommitApplicationFoundationCommandV1>;
	if (
		candidate.schemaVersion !== 1 ||
		requiredStrings.some(
			(field) =>
				typeof candidate[field] !== "string" || candidate[field].length === 0,
		) ||
		(candidate.name?.length ?? 0) > 200 ||
		!(candidate.submittedAt instanceof Date) ||
		!Number.isFinite(candidate.submittedAt.valueOf())
	) {
		throw new ApplicationFoundationError("invalid_command");
	}
}
