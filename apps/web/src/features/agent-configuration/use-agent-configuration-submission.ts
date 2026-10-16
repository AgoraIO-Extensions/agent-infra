import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";

import type { AgentConfigurationUpdateRequestV2Writable } from "../../pilot/generated-v2/types.gen.js";
import type { AgentSavedModelConfigurationUpdate } from "./agent-configuration.js";
import {
	checkAgentDefaultRelayKey,
	loadAgentDefaultRelayKey,
	replaceAgentDefaultRelayKey,
	updateAgentConfiguration,
	updateAgentSavedModelConfiguration,
	upgradeAgentCustomImage,
} from "./agent-configuration.js";

type AgentConfigurationCommand =
	| {
			body:
				| AgentConfigurationUpdateRequestV2Writable
				| AgentSavedModelConfigurationUpdate;
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
					? command.body.schemaVersion === 4
						? await updateAgentSavedModelConfiguration(
								agentId,
								command.body,
								attempt.idempotencyKey,
							)
						: await updateAgentConfiguration(
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
	const relayKeySubmission = useMutation({
		mutationKey: ["agents", agentId, "default-relay-key"],
		mutationFn: async (keyValue: string) => {
			const state = await loadAgentDefaultRelayKey(agentId);
			return replaceAgentDefaultRelayKey(agentId, {
				configurationRevision: state.configurationRevision,
				expectedVersion: state.isSet ? state.keyVersion : null,
				keyValue,
			});
		},
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: ["agents", agentId] }),
				queryClient.invalidateQueries({ queryKey: ["agents"] }),
			]),
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
		relayKeySubmission,
		relayKeyError:
			relayKeySubmission.isError && relayKeySubmission.error instanceof Error
				? relayKeySubmission.error
				: null,
		relayKeySubmitting: relayKeySubmission.isPending,
		saveConfiguration: (
			body:
				| AgentConfigurationUpdateRequestV2Writable
				| AgentSavedModelConfigurationUpdate,
		) => startSubmission({ kind: "configuration", body }),
		upgradeImage: (imageReference: string) =>
			startSubmission({ kind: "image", imageReference }),
		/** 仅替换 Key 成功后的状态（含新版本），供页面给出确认提示。 */
		relayKeyResult: relayKeySubmission.isSuccess
			? relayKeySubmission.data
			: undefined,
		replaceDefaultRelayKey: relayKeySubmission.mutate,
		/** 返回候选模型，以及检查时看到的配置修订和 Key 版本（保存时作为 expected 值）。 */
		previewDefaultRelayKeyCandidates: (keyValue: string) =>
			checkAgentDefaultRelayKey(agentId, keyValue),
	};
}
