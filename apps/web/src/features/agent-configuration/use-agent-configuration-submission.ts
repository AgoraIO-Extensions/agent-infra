import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";

import type { AgentConfigurationUpdateRequestV1Writable } from "../../pilot/generated/types.gen.js";
import {
	updateAgentConfiguration,
	upgradeAgentCustomImage,
} from "./agent-configuration.js";

type AgentConfigurationCommand =
	| {
			body: AgentConfigurationUpdateRequestV1Writable;
			kind: "configuration";
	  }
	| {
			imageReference: string;
			kind: "image";
	  };

type AgentConfigurationAttempt = { idempotencyKey: string };

export function useAgentConfigurationSubmission(agentId: string) {
	const queryClient = useQueryClient();
	const currentAgentId = useRef(agentId);
	const activeSubmission = useRef<string | undefined>(undefined);
	const pendingCommands = useRef(new Map<string, AgentConfigurationCommand>());
	const submission = useMutation({
		mutationKey: ["agents", agentId, "configuration"],
		mutationFn: async (attempt: AgentConfigurationAttempt) => {
			const command = pendingCommands.current.get(attempt.idempotencyKey);
			if (!command) {
				throw new Error("Agent configuration command is unavailable");
			}
			try {
				return command.kind === "configuration"
					? await updateAgentConfiguration(
							agentId,
							command.body,
							attempt.idempotencyKey,
						)
					: await upgradeAgentCustomImage(
							agentId,
							command.imageReference,
							attempt.idempotencyKey,
						);
			} finally {
				pendingCommands.current.delete(attempt.idempotencyKey);
			}
		},
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: ["agents"] }),
				queryClient.invalidateQueries({ queryKey: ["my-agents"] }),
				queryClient.invalidateQueries({
					queryKey: ["admin", "agent-applications"],
				}),
			]),
		onSettled: (_data, _error, attempt) => {
			if (activeSubmission.current === attempt.idempotencyKey) {
				activeSubmission.current = undefined;
			}
		},
	});

	useLayoutEffect(() => {
		if (currentAgentId.current === agentId) return;
		currentAgentId.current = agentId;
		activeSubmission.current = undefined;
		submission.reset();
	}, [agentId, submission.reset]);

	const startSubmission = (command: AgentConfigurationCommand) => {
		if (activeSubmission.current !== undefined) return;
		const attempt: AgentConfigurationAttempt = {
			idempotencyKey: crypto.randomUUID(),
		};
		pendingCommands.current.set(attempt.idempotencyKey, command);
		activeSubmission.current = attempt.idempotencyKey;
		submission.mutate(attempt);
	};

	return {
		...submission,
		saveConfiguration: (body: AgentConfigurationUpdateRequestV1Writable) =>
			startSubmission({ kind: "configuration", body }),
		upgradeImage: (imageReference: string) =>
			startSubmission({ kind: "image", imageReference }),
	};
}
