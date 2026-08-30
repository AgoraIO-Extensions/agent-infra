import {
	ApplicationFoundationError,
	type ApplicationFoundationTransactionPortV1,
	type ApplicationFoundationWritePlanV1,
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
		requestId: string;
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
		requestId: string;
	}[];
	auditEvents: {
		traceId: string;
		requestId: string;
		agentId: string;
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
	implements ApplicationFoundationTransactionPortV1
{
	#state = emptySnapshot();
	#failurePoint: FailurePoint | undefined;

	failNextBefore(point: FailurePoint): void {
		this.#failurePoint = point;
	}

	snapshot(): ApplicationFoundationSnapshot {
		return cloneSnapshot(this.#state);
	}

	async commit(plan: ApplicationFoundationWritePlanV1): Promise<void> {
		if (
			this.#state.agents.some(
				({ agentId }) => agentId === plan.agent.agentId,
			) ||
			this.#state.applications.some(
				({ applicationId }) => applicationId === plan.application.applicationId,
			)
		) {
			throw new ApplicationFoundationError("conflict");
		}

		const draft = cloneSnapshot(this.#state);
		try {
			this.#failBefore("agent");
			draft.agents.push({
				agentId: plan.agent.agentId,
				currentConfigurationRevision: plan.agent.currentConfigurationRevision,
			});

			this.#failBefore("application");
			draft.applications.push({
				applicationId: plan.application.applicationId,
				agentId: plan.application.agentId,
				applicantId: plan.application.applicantId,
				name: plan.application.name,
				description: plan.application.description,
				status: plan.application.status,
				traceId: plan.application.traceId,
				requestId: plan.application.requestId,
			});

			this.#failBefore("configuration_revision");
			draft.configurationRevisions.push({
				agentId: plan.configurationRevision.agentId,
				revision: plan.configurationRevision.revision,
				sourceReference: plan.configurationRevision.sourceReference,
			});

			this.#failBefore("owner");
			draft.owners.push({
				agentId: plan.owner.agentId,
				ownerId: plan.owner.ownerId,
			});

			this.#failBefore("outbox");
			draft.outboxIntents.push({
				scopeType: plan.outboxIntent.scopeType,
				scopeId: plan.outboxIntent.scopeId,
				operation: plan.outboxIntent.operation,
				payload: { ...plan.outboxIntent.payload },
				traceId: plan.outboxIntent.traceId,
				requestId: plan.outboxIntent.requestId,
			});

			this.#failBefore("audit");
			draft.auditEvents.push({
				traceId: plan.auditEvent.traceId,
				requestId: plan.auditEvent.requestId,
				agentId: plan.auditEvent.agentId,
				actorType: plan.auditEvent.actorType,
				actorId: plan.auditEvent.actorId,
				action: plan.auditEvent.action,
				targetType: plan.auditEvent.targetType,
				targetId: plan.auditEvent.targetId,
				outcome: plan.auditEvent.outcome,
			});

			this.#failBefore("commit");
			this.#state = draft;
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
