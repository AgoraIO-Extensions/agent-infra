import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";

import type { AgentConfigurationUpdateRequestV2Writable } from "../../pilot/generated-v2/types.gen.js";
import type { AgentSavedModelConfigurationUpdate } from "./agent-configuration.js";
import {
	checkAgentDefaultRelayKey,
	replaceAgentDefaultRelayKey,
	updateAgentConfiguration,
	updateAgentSavedModelConfiguration,
	upgradeAgentCustomImage,
} from "./agent-configuration.js";
import type { DefaultRelayKeyReplacement } from "./default-relay-key-dialog.js";

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
	const refreshAgent = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ["agents"] }),
			queryClient.invalidateQueries({ queryKey: ["my-agents"] }),
			queryClient.invalidateQueries({
				queryKey: ["admin", "agent-applications"],
			}),
		]);
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
		onSuccess: refreshAgent,
		onSettled: (_data, _error, attempt) => {
			if (activeSubmission.current === attempt.idempotencyKey) {
				activeSubmission.current = undefined;
			}
		},
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
		/**
		 * 替换或添加单个 Secret（O-10、NI-71）：独立请求，只带这一个 Secret，不读取页面草稿，
		 * 也不经过整页 mutation——明文不进入 mutation 变量或页面级错误。
		 */
		replaceSecret: async (name: string, value: string) => {
			const projection = await updateAgentConfiguration(
				agentId,
				{ schemaVersion: 2, secrets: [{ name, value }] },
				crypto.randomUUID(),
			);
			await refreshAgent();
			return projection;
		},
		/** 检查新 Key 可见的模型，并带回检查时的配置修订与 Key 版本（写入时作为 expected 值）。 */
		checkDefaultRelayKey: (keyValue: string) =>
			checkAgentDefaultRelayKey(agentId, keyValue),
		/** 只替换默认 Key（新候选覆盖当前模型，G-09）；成功后回读 Key 状态与候选。 */
		replaceDefaultRelayKey: async (replacement: DefaultRelayKeyReplacement) => {
			const state = await replaceAgentDefaultRelayKey(agentId, {
				configurationRevision: replacement.configurationRevision,
				expectedVersion: replacement.expectedVersion,
				keyValue: replacement.keyValue,
			});
			await refreshAgent();
			return state;
		},
		/** 新 Key 不覆盖当前模型时，Key 与模型集合一次提交；请求体由弹窗只用这几项组装。 */
		replaceDefaultRelayKeyWithModels: async (
			body: AgentConfigurationUpdateRequestV2Writable,
		) => {
			const projection = await updateAgentConfiguration(
				agentId,
				body,
				crypto.randomUUID(),
			);
			await refreshAgent();
			return projection;
		},
	};
}
