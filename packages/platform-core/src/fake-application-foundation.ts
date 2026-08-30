import {
	ApplicationFoundationError,
	type ApplicationFoundationTransactionV1,
	assertApplicationFoundationCommandV1,
	type CommitApplicationFoundationCommandV1,
	type CommitApplicationFoundationResultV1,
} from "./application-foundation.js";

type FailurePoint =
	| "agent"
	| "application"
	| "configuration_revision"
	| "owner"
	| "outbox"
	| "audit"
	| "commit";

export interface ApplicationFoundationSnapshot {
	agents: { agentId: string; currentConfigurationRevision: number }[];
	applications: {
		applicationId: string;
		agentId: string;
		applicantId: string;
		name: string;
		description: string;
		status: "pending_approval";
		traceId: string;
	}[];
	configurationRevisions: {
		agentId: string;
		revision: number;
		sourceReference: string;
	}[];
	owners: { agentId: string; ownerId: string }[];
	outboxIntents: {
		scopeType: "agent";
		scopeId: string;
		operation: "agent.application.submitted.v1";
		payload: {
			schemaVersion: 1;
			applicationId: string;
			agentId: string;
			configurationRevision: 1;
		};
		traceId: string;
	}[];
	auditEvents: {
		traceId: string;
		actorType: "user";
		actorId: string;
		action: "agent.application.submitted";
		targetType: "agent_application";
		targetId: string;
		outcome: "succeeded";
	}[];
}

function cloneSnapshot(
	snapshot: ApplicationFoundationSnapshot,
): ApplicationFoundationSnapshot {
	return structuredClone(snapshot);
}

const emptySnapshot = (): ApplicationFoundationSnapshot => ({
	agents: [],
	applications: [],
	configurationRevisions: [],
	owners: [],
	outboxIntents: [],
	auditEvents: [],
});

export class FakeApplicationFoundationTransactionV1
	implements ApplicationFoundationTransactionV1
{
	#state = emptySnapshot();
	#failurePoint: FailurePoint | undefined;

	failNextBefore(point: FailurePoint): void {
		this.#failurePoint = point;
	}

	snapshot(): ApplicationFoundationSnapshot {
		return cloneSnapshot(this.#state);
	}

	async commit(
		command: CommitApplicationFoundationCommandV1,
	): Promise<CommitApplicationFoundationResultV1> {
		assertApplicationFoundationCommandV1(command);
		if (
			this.#state.agents.some(({ agentId }) => agentId === command.agentId) ||
			this.#state.applications.some(
				({ applicationId }) => applicationId === command.applicationId,
			)
		) {
			throw new ApplicationFoundationError("conflict");
		}

		const draft = cloneSnapshot(this.#state);
		try {
			this.#failBefore("agent");
			draft.agents.push({
				agentId: command.agentId,
				currentConfigurationRevision: 1,
			});

			this.#failBefore("application");
			draft.applications.push({
				applicationId: command.applicationId,
				agentId: command.agentId,
				applicantId: command.applicantId,
				name: command.name,
				description: command.description,
				status: "pending_approval",
				traceId: command.traceId,
			});

			this.#failBefore("configuration_revision");
			draft.configurationRevisions.push({
				agentId: command.agentId,
				revision: 1,
				sourceReference: command.sourceReference,
			});

			this.#failBefore("owner");
			draft.owners.push({
				agentId: command.agentId,
				ownerId: command.applicantId,
			});

			this.#failBefore("outbox");
			draft.outboxIntents.push({
				scopeType: "agent",
				scopeId: command.agentId,
				operation: "agent.application.submitted.v1",
				payload: {
					schemaVersion: 1,
					applicationId: command.applicationId,
					agentId: command.agentId,
					configurationRevision: 1,
				},
				traceId: command.traceId,
			});

			this.#failBefore("audit");
			draft.auditEvents.push({
				traceId: command.traceId,
				actorType: "user",
				actorId: command.applicantId,
				action: "agent.application.submitted",
				targetType: "agent_application",
				targetId: command.applicationId,
				outcome: "succeeded",
			});

			this.#failBefore("commit");
			this.#state = draft;
			return {
				schemaVersion: 1,
				applicationId: command.applicationId,
				agentId: command.agentId,
				configurationRevision: 1,
				status: "pending_approval",
			};
		} catch (error) {
			if (error instanceof ApplicationFoundationError) throw error;
			throw new ApplicationFoundationError("persistence_failed");
		}
	}

	#failBefore(point: FailurePoint): void {
		if (this.#failurePoint !== point) return;
		this.#failurePoint = undefined;
		throw new Error(`Injected failure before ${point}`);
	}
}
