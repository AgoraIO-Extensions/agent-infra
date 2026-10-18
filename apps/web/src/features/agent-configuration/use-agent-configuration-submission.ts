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

type AgentConfigurationAttempt = {
	idempotencyKey: string;
	/** 页面据此区分配置保存与镜像升级的结果（NW-16）。 */
	kind: AgentConfigurationCommand["kind"];
};

type WecomChannelKind = "wecom_bot" | "wecom_app";

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

	// 企微解绑是独立请求：只提交该渠道 disabled，不经过整页保存，也不替换表单（O-01）。
	const channelUnbind = useMutation({
		mutationKey: ["agents", agentId, "channel-unbind"],
		mutationFn: (kind: WecomChannelKind) =>
			updateAgentConfiguration(
				agentId,
				{ schemaVersion: 2, channels: [{ kind, enabled: false }] },
				crypto.randomUUID(),
			),
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: ["agents"] }),
				queryClient.invalidateQueries({ queryKey: ["my-agents"] }),
			]),
	});

	useLayoutEffect(() => {
		if (currentAgentId.current === agentId) return;
		currentAgentId.current = agentId;
		activeSubmission.current = undefined;
		submission.reset();
	}, [agentId, submission.reset]);

	/** 返回 true 表示服务端已受理；已有提交进行中或失败时为 false。 */
	const startSubmission = (command: AgentConfigurationCommand) => {
		if (activeSubmission.current !== undefined) return Promise.resolve(false);
		const attempt: AgentConfigurationAttempt = {
			idempotencyKey: crypto.randomUUID(),
			kind: command.kind,
		};
		pendingCommands.current.set(attempt.idempotencyKey, command);
		activeSubmission.current = attempt.idempotencyKey;
		return new Promise<boolean>((resolve) => {
			submission.mutate(attempt, {
				onSuccess: () => resolve(true),
				onError: () => resolve(false),
			});
		});
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
		) => {
			void startSubmission({ kind: "configuration", body });
		},
		upgradeImage: (imageReference: string) =>
			startSubmission({ kind: "image", imageReference }),
		unbindWecomChannel: async (kind: WecomChannelKind) => {
			await channelUnbind.mutateAsync(kind);
		},
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
