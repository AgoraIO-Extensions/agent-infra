import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";

import type {
	AgentApplicationCreateRequestV1Writable,
	AgentApplicationUpdateRequestV1Writable,
} from "../../pilot/generated/types.gen.js";
import {
	createMyAgentApplication,
	updateMyAgentApplication,
} from "./my-agent-applications.js";

type SubmissionCommand =
	| {
			body: AgentApplicationCreateRequestV1Writable;
			kind: "create";
	  }
	| {
			applicationId: string;
			body: AgentApplicationUpdateRequestV1Writable;
			kind: "update";
	  };

type SubmissionAttempt = SubmissionCommand & { idempotencyKey: string };

export function useAgentApplicationSubmission(applicationId?: string) {
	const queryClient = useQueryClient();
	const currentApplicationId = useRef(applicationId);
	const activeSubmission = useRef<string | undefined>(undefined);
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
		onSettled: (_data, _error, attempt) => {
			if (activeSubmission.current === attempt.idempotencyKey) {
				activeSubmission.current = undefined;
			}
		},
	});

	useLayoutEffect(() => {
		if (currentApplicationId.current === applicationId) return;
		currentApplicationId.current = applicationId;
		activeSubmission.current = undefined;
		submission.reset();
	}, [applicationId, submission.reset]);

	const startSubmission = (command: SubmissionCommand) => {
		if (activeSubmission.current !== undefined) return;
		const attempt: SubmissionAttempt = {
			...command,
			idempotencyKey: crypto.randomUUID(),
		};
		activeSubmission.current = attempt.idempotencyKey;
		submission.mutate(attempt);
	};

	return {
		...submission,
		create: (body: AgentApplicationCreateRequestV1Writable) =>
			startSubmission({
				kind: "create",
				body,
			}),
		update: (
			applicationId: string,
			body: AgentApplicationUpdateRequestV1Writable,
		) =>
			startSubmission({
				kind: "update",
				applicationId,
				body,
			}),
	};
}
