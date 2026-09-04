import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import {
	type AgentApplicationDecision,
	decideAgentApplication,
} from "./agent-administration.js";

export type AgentApplicationDecisionAttempt = {
	readonly applicationId: string;
	readonly decision: AgentApplicationDecision;
	readonly idempotencyKey: string;
};

function sameDecision(
	left: AgentApplicationDecision,
	right: AgentApplicationDecision,
) {
	if (left.decision !== right.decision) return false;
	if (left.decision === "approve") return true;
	return right.decision === "reject" && left.reason === right.reason;
}

export function useAgentApplicationDecision() {
	const queryClient = useQueryClient();
	const pendingDecision = useRef<AgentApplicationDecisionAttempt | undefined>(
		undefined,
	);
	const startAttempt = (
		applicationId: string,
		decision: AgentApplicationDecision,
	): AgentApplicationDecisionAttempt => {
		if (
			pendingDecision.current?.applicationId !== applicationId ||
			!pendingDecision.current ||
			!sameDecision(pendingDecision.current.decision, decision)
		) {
			pendingDecision.current = {
				applicationId,
				decision,
				idempotencyKey: crypto.randomUUID(),
			};
		}
		return pendingDecision.current;
	};
	const clearAttempt = (attempt: AgentApplicationDecisionAttempt) => {
		if (
			pendingDecision.current?.applicationId === attempt.applicationId &&
			pendingDecision.current.idempotencyKey === attempt.idempotencyKey &&
			sameDecision(pendingDecision.current.decision, attempt.decision)
		) {
			pendingDecision.current = undefined;
		}
	};

	const decision = useMutation({
		mutationKey: ["admin", "agent-applications", "decision"],
		mutationFn: (attempt: AgentApplicationDecisionAttempt) =>
			decideAgentApplication(
				attempt.applicationId,
				attempt.decision,
				attempt.idempotencyKey,
			),
		onSuccess: (result, attempt) => {
			clearAttempt(attempt);
			return Promise.all([
				queryClient.invalidateQueries({
					queryKey: ["admin", "agent-applications"],
				}),
				queryClient.invalidateQueries({ queryKey: ["my-agents"] }),
				queryClient.invalidateQueries({ queryKey: ["agents"] }),
				...(result.agentId
					? [
							queryClient.invalidateQueries({
								queryKey: ["agents", result.agentId],
							}),
						]
					: []),
			]);
		},
	});

	return {
		...decision,
		mutate: (applicationId: string, nextDecision: AgentApplicationDecision) =>
			decision.mutate(startAttempt(applicationId, nextDecision)),
		mutateAsync: (
			applicationId: string,
			nextDecision: AgentApplicationDecision,
		) => decision.mutateAsync(startAttempt(applicationId, nextDecision)),
	};
}
