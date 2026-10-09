import {
	type ConversationTaskAdmissionPolicyV1,
	createConversationExecutionUseCaseV1,
	createConversationTaskAdmissionUseCaseV1,
	createTaskApiAuditV1,
} from "@agent-infra/platform-core";
import type { PostgresConversationExecutionTransactionV1 } from "@agent-infra/platform-store";
import type { TaskRoutesDependencies } from "./task-route-support.js";

/** Assembly supplies its existing Store and query; this factory creates no connections. */
export function createTaskRoutesDependenciesV1(input: {
	readonly transaction: PostgresConversationExecutionTransactionV1;
	readonly query: TaskRoutesDependencies["query"];
	readonly policy: ConversationTaskAdmissionPolicyV1;
	readonly streamPollIntervalMs?: number;
	readonly streamReadTimeoutMs?: number;
}): TaskRoutesDependencies {
	const transaction = input.transaction;
	return {
		authorize: (request) => transaction.authorizeTaskApi(request),
		query: {
			getExecution: input.query.getExecution.bind(input.query),
			...(input.query.replayExecution
				? { replayExecution: input.query.replayExecution.bind(input.query) }
				: {}),
		},
		streamPollIntervalMs: input.streamPollIntervalMs,
		streamReadTimeoutMs: input.streamReadTimeoutMs,
		audit: createTaskApiAuditV1({
			write: (plan) => transaction.writeTaskApiAudit(plan),
		}),
		commands(authority) {
			const authorization = {
				async authorize() {
					return { outcome: "allowed" as const, authority };
				},
			};
			return {
				...createConversationTaskAdmissionUseCaseV1(
					{ authorization, transaction },
					input.policy,
				),
				stop: createConversationExecutionUseCaseV1({
					authorization,
					transaction,
				}).stop,
			};
		},
	};
}
