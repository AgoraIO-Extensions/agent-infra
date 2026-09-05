import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";

import {
	type AgentLifecycleCommand,
	commandAgentLifecycle,
} from "./agent-administration.js";

type LifecycleAttempt = {
	readonly agentId: string;
	readonly command: AgentLifecycleCommand;
	readonly idempotencyKey: string;
};

export function useAgentLifecycleCommand(agentId: string) {
	const queryClient = useQueryClient();
	const inFlight = useRef(false);
	const pendingCommand = useRef<{
		agentId: string;
		command?: AgentLifecycleCommand;
		idempotencyKey?: string;
	}>({ agentId });
	const startAttempt = (command: AgentLifecycleCommand): LifecycleAttempt => {
		if (
			pendingCommand.current.agentId !== agentId ||
			pendingCommand.current.command !== command
		) {
			pendingCommand.current = { agentId, command };
		}
		const idempotencyKey =
			pendingCommand.current.idempotencyKey ?? crypto.randomUUID();
		pendingCommand.current.idempotencyKey = idempotencyKey;
		return { agentId, command, idempotencyKey };
	};
	const clearAttempt = (attempt: LifecycleAttempt) => {
		if (
			pendingCommand.current.agentId === attempt.agentId &&
			pendingCommand.current.command === attempt.command &&
			pendingCommand.current.idempotencyKey === attempt.idempotencyKey
		) {
			pendingCommand.current.idempotencyKey = undefined;
		}
	};

	const lifecycle = useMutation({
		mutationKey: ["agents", agentId, "lifecycle"],
		mutationFn: (attempt: LifecycleAttempt) =>
			commandAgentLifecycle(
				attempt.agentId,
				attempt.command,
				attempt.idempotencyKey,
			),
		onSuccess: (_result, attempt) => {
			clearAttempt(attempt);
			return Promise.all([
				queryClient.invalidateQueries({ queryKey: ["agents"] }),
				queryClient.invalidateQueries({ queryKey: ["my-agents"] }),
				queryClient.invalidateQueries({
					queryKey: ["admin", "agent-applications"],
				}),
			]);
		},
	});

	useLayoutEffect(() => {
		if (pendingCommand.current.agentId === agentId) return;
		pendingCommand.current = { agentId };
		lifecycle.reset();
	}, [agentId, lifecycle.reset]);
	const runCommand = async (command: AgentLifecycleCommand) => {
		if (inFlight.current) {
			throw new Error("A lifecycle command is already in progress");
		}
		inFlight.current = true;
		try {
			return await lifecycle.mutateAsync(startAttempt(command));
		} finally {
			inFlight.current = false;
		}
	};

	return {
		...lifecycle,
		mutate: (command: AgentLifecycleCommand) => {
			void runCommand(command).catch(() => undefined);
		},
		mutateAsync: runCommand,
	};
}
