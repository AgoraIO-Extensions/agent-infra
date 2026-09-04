import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
	AgentApplicationCreateRequestV1Writable,
	AgentApplicationUpdateRequestV1Writable,
} from "../../pilot/generated/types.gen.js";
import {
	createMyAgentApplication,
	updateMyAgentApplication,
} from "./my-agent-applications.js";

type SubmissionAttempt =
	| {
			body: AgentApplicationCreateRequestV1Writable;
			idempotencyKey: string;
			kind: "create";
	  }
	| {
			applicationId: string;
			body: AgentApplicationUpdateRequestV1Writable;
			idempotencyKey: string;
			kind: "update";
	  };

export function useAgentApplicationSubmission() {
	const queryClient = useQueryClient();
	const submission = useMutation({
		mutationKey: ["my-agents", "application-submission"],
		mutationFn: (attempt: SubmissionAttempt) =>
			attempt.kind === "create"
				? createMyAgentApplication(attempt.body, attempt.idempotencyKey)
				: updateMyAgentApplication(
						attempt.applicationId,
						attempt.body,
						attempt.idempotencyKey,
					),
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: ["my-agents"] }),
				queryClient.invalidateQueries({ queryKey: ["agents"] }),
			]),
	});

	return {
		...submission,
		create: (body: AgentApplicationCreateRequestV1Writable) =>
			submission.mutate({
				kind: "create",
				body,
				idempotencyKey: crypto.randomUUID(),
			}),
		update: (
			applicationId: string,
			body: AgentApplicationUpdateRequestV1Writable,
		) =>
			submission.mutate({
				kind: "update",
				applicationId,
				body,
				idempotencyKey: crypto.randomUUID(),
			}),
	};
}
