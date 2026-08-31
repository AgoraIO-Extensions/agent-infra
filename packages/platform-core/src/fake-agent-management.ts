import {
	type AgentManagementCommandDecisionV1,
	type AgentManagementInterfaceV1,
	type AgentManagementOptionsV1,
	type AgentManagementStateV1,
	type AgentManagementTransactionPortV1,
	type AgentManagementTransactionRequestV1,
	createAgentManagementV1,
} from "./agent-management.js";

export interface FakeAgentManagementOptionsV1 extends AgentManagementOptionsV1 {
	readonly states?: readonly AgentManagementStateV1[];
	readonly failure?: "transaction" | "access_read";
}

interface CompletedCommand {
	readonly digest: string;
	readonly result: Extract<
		AgentManagementCommandDecisionV1,
		{ outcome: "accepted" }
	>["result"];
}

function transactionKey(request: AgentManagementTransactionRequestV1): string {
	return JSON.stringify([
		request.operation,
		request.subjectType,
		request.subjectId,
		request.actorId,
		request.idempotencyKey,
	]);
}

export class FakeAgentManagementV1 implements AgentManagementInterfaceV1 {
	readonly #states = new Map<string, AgentManagementStateV1>();
	readonly #completed = new Map<string, CompletedCommand>();
	readonly #interface: AgentManagementInterfaceV1;

	constructor(options: FakeAgentManagementOptionsV1 = {}) {
		for (const state of options.states ?? []) {
			this.#states.set(state.agentId, structuredClone(state));
		}
		const transaction: AgentManagementTransactionPortV1 = {
			executeAgentManagementTransaction: async (request, decide) => {
				if (options.failure === "transaction")
					throw new Error("Injected failure");
				const key = transactionKey(request);
				const completed = this.#completed.get(key);
				if (completed) {
					if (completed.digest !== request.requestDigest) {
						return {
							outcome: "conflict",
							reason: "idempotency_conflict",
							writePlan: null,
						};
					}
					return {
						outcome: "replayed",
						result: structuredClone(completed.result),
						writePlan: null,
					};
				}
				const state = [...this.#states.values()].find((candidate) =>
					request.subjectType === "agent_application"
						? candidate.applicationId === request.subjectId
						: candidate.agentId === request.subjectId,
				);
				const decision = decide(state && structuredClone(state));
				if (decision.outcome !== "accepted") return decision;
				this.#states.set(
					decision.writePlan.state.agentId,
					structuredClone(decision.writePlan.state),
				);
				this.#completed.set(key, {
					digest: request.requestDigest,
					result: structuredClone(decision.result),
				});
				return structuredClone(decision);
			},
			resolveAgentAccessState: async (agentId) => {
				if (options.failure === "access_read")
					throw new Error("Injected failure");
				const state = this.#states.get(agentId);
				return state && structuredClone(state);
			},
		};
		this.#interface = createAgentManagementV1(transaction, {
			...options,
			now: options.now ?? (() => new Date(0)),
		});
	}

	executeManagementCommand: AgentManagementInterfaceV1["executeManagementCommand"] =
		(command, actorContext) =>
			this.#interface.executeManagementCommand(command, actorContext);

	recordWorkloadObservation: AgentManagementInterfaceV1["recordWorkloadObservation"] =
		(observation) => this.#interface.recordWorkloadObservation(observation);

	resolveAgentAccess: AgentManagementInterfaceV1["resolveAgentAccess"] = (
		query,
		actorContext,
	) => this.#interface.resolveAgentAccess(query, actorContext);
}
