import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { LoadingLine } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { Button } from "../../components/ui/button.js";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { RecoveryButton } from "../recovery-button.js";
import {
	type CapabilityCatalog,
	useCapabilityComposer,
} from "./conversation-capability-menu.js";
import { CommandNotice } from "./conversation-command-notice.js";
import type { ConversationCommandResult } from "./conversation-commands.js";
import { ConversationComposer } from "./conversation-composer.js";
import {
	ConversationHistoryHeading,
	ConversationHistoryLink,
} from "./conversation-history-item.js";
import { ConversationWelcome } from "./conversation-screen-messages.js";
import { useAmbiguousDenial } from "./use-ambiguous-denial.js";
import { useConversationCommands } from "./use-conversation-commands.js";
import { useConversationHistory } from "./use-conversation-history.js";
import type { ModelSelectionValue } from "./use-conversation-model-autosave.js";

export function PersonalHistory({
	agentId,
	identityKey,
	current,
	onSelect,
	onDenied,
}: {
	agentId: string;
	identityKey: string;
	current?: string;
	onSelect: (conversationId: string | undefined) => void;
	onDenied: () => void;
}) {
	const history = useConversationHistory({ agentId, identityKey });
	useLayoutEffect(() => {
		if (history.status === "denied") onDenied();
	}, [history.status, onDenied]);
	return (
		<section aria-label="个人历史" className="min-w-0 space-y-3">
			<ConversationHistoryHeading
				count={history.status === "ready" ? history.items.length : undefined}
				hasMore={history.hasNextPage}
			/>
			{history.status === "loading" && <LoadingLine>正在读取历史…</LoadingLine>}
			{history.status === "error" && (
				<Alert tone="danger" role="alert">
					<AlertDescription>历史暂时无法读取。</AlertDescription>
				</Alert>
			)}
			{history.status === "ready" && !history.items.length && (
				<Empty>
					<EmptyDescription>暂无 Web 会话。</EmptyDescription>
				</Empty>
			)}
			<ul className="conversation-history-list">
				{history.items.map((item) => (
					<li key={item.conversationId}>
						<ConversationHistoryLink
							agentId={agentId}
							conversationId={item.conversationId}
							title={item.title}
							updatedAt={item.updatedAt}
							current={current === item.conversationId}
							onNavigate={() => {
								onSelect(item.conversationId);
								return true;
							}}
						/>
					</li>
				))}
			</ul>
			{history.canRetry && (
				<RecoveryButton
					variant="outline"
					recoveryKey="重试读取历史"
					busy={history.isFetching}
					onClick={() => void history.retry()}
				>
					重试读取历史
				</RecoveryButton>
			)}
			{history.hasNextPage && (
				<Button
					variant="outline"
					disabled={history.isFetching}
					onClick={() => void history.loadMore()}
				>
					加载更多
				</Button>
			)}
		</section>
	);
}

/** 创建会话的唯一入口：页头「新会话」与无会话参数的入口页共用，沿用幂等键与 404 二次确认（#2570）。 */
export function useCreateConversation({
	agentId,
	identityKey,
	available,
	onCreated,
	onDenied,
	verifyAgent,
}: {
	agentId: string;
	identityKey: string;
	/** 页面当前读到的 Agent 是否可用，用于 404 复核后的状态判断。 */
	available: boolean;
	onCreated: (id: string) => void;
	onDenied: () => void;
	/** 见 ActiveConversation：true 表示 Agent 仍然可用，404 就是真的失去访问权限（#2570）。 */
	verifyAgent: () => Promise<boolean>;
}) {
	const command = useConversationCommands({ agentId, identityKey });
	const queryClient = useQueryClient();
	const toast = useToast();
	const handled = useRef<ConversationCommandResult | undefined>(undefined);
	useEffect(() => {
		if (command.result === handled.current) return;
		handled.current = command.result;
		if (command.result?.kind === "created") {
			void queryClient.resetQueries({
				queryKey: ["personal-recent", identityKey],
			});
			toast("新会话已创建，已出现在最近对话");
			onCreated(command.result.conversationId);
		}
		if (command.result?.kind === "denied" && !command.result.ambiguous)
			onDenied();
	}, [command.result, identityKey, onCreated, onDenied, queryClient, toast]);
	// 404 先重读 Agent：复核期间中性提示，确认不可用后只保留页顶提示（NW-12）。
	const denial = useAmbiguousDenial({
		result: command.result,
		available,
		verifyAgent,
		onDenialStands: onDenied,
	});
	return {
		command,
		denial,
		busy: command.isPending || command.result?.kind === "unknown",
		create: () => command.create(),
	};
}

export type CreateConversation = ReturnType<typeof useCreateConversation>;

/** 创建结果的反馈：受理中、待核实与被拒绝只在这里说明一次。 */
export function CreateConversationNotice({
	creation,
}: {
	creation: CreateConversation;
}) {
	const { command } = creation;
	return (
		<CommandNotice
			kind="create"
			result={command.result}
			pending={command.isPending}
			denial={creation.denial}
			retry={command.canRetry ? () => command.retry() : undefined}
		/>
	);
}

/**
 * 不带会话参数直接进入 /chat/:agentId：直接显示可输入的 composer（CH-10，设计 new-chat）。
 * 打开页面不产生写入；首次提交时先创建会话，再由新会话页用原草稿发送。创建失败时草稿保留，
 * 原因显示在 composer 上方。尚无 Execution，命令与 Skill 目录状态与刚创建的会话一致（CK-04）。
 */
export function NewConversationComposer({
	agent,
	available,
	creation,
	draft,
	onDraftChange,
	model,
	onModelChange,
	onSubmit,
}: {
	agent: AgentProjectionV2;
	available: boolean;
	creation: CreateConversation;
	draft: string;
	onDraftChange: (value: string) => void;
	/** 本页选择的模型与档位；未选择时显示 Agent 默认值。 */
	model?: ModelSelectionValue;
	onModelChange: (value: ModelSelectionValue) => void;
	onSubmit: () => void;
}) {
	const composerId = useId();
	const textarea = useRef<HTMLTextAreaElement>(null);
	const catalog = useMemo<CapabilityCatalog>(
		() =>
			agent.capabilities.nativeMetadata === true
				? { status: "no-execution" }
				: { status: "unsupported" },
		[agent.capabilities.nativeMetadata],
	);
	const capability = useCapabilityComposer({
		catalog,
		draft,
		setDraft: onDraftChange,
		textarea,
		busy: false,
	});
	// 与会话页一致：Agent 启动或更新中时草稿仍可编辑，只是不能发送。
	const agentTransitioning =
		agent.serviceAvailability === "starting" ||
		agent.serviceAvailability === "updating";
	const draftDisabled = creation.busy || (!available && !agentTransitioning);
	// 平台适配的自定义 Agent 由 Runtime 提供模型列表，需要会话才能读取；这里只给标准模板。
	const customPlatformAdapter =
		agent.source.kind === "custom" &&
		agent.source.interactionMode === "platform-adapter";
	const { modelOptions, defaultModelOptionId, defaultReasoningLevel } =
		agent.configuration;
	const modelSelectable =
		agent.capabilities.modelSelection &&
		!customPlatformAdapter &&
		modelOptions.length > 0;
	return (
		<>
			<div className="timeline min-h-48">
				<ConversationWelcome />
			</div>
			{/* 创建结果的反馈：composer 上方、任何折叠条之外（NI-83）。 */}
			<CreateConversationNotice creation={creation} />
			<ConversationComposer
				composerId={composerId}
				textarea={textarea}
				draft={draft}
				draftDisabled={draftDisabled}
				submitReady={
					available && !creation.busy && creation.denial !== "verifying"
				}
				invokeReady
				sendLabel="发送"
				capability={capability}
				model={
					modelSelectable
						? {
								options: modelOptions,
								modelId: model?.modelOptionId ?? defaultModelOptionId ?? "",
								reasoning: model?.reasoningLevel ?? defaultReasoningLevel ?? "",
								disabled: !available || creation.busy,
								phase: "idle",
								saved: false,
								onChoose: onModelChange,
								onRetry: () => {},
							}
						: undefined
				}
				formAttributes={{
					"data-new-conversation": "true",
					"data-pending-submit": creation.command.isPending ? "true" : "false",
				}}
				onSendMessage={onSubmit}
				// 尚无目录可选，不会发起命令或 Skill 调用。
				onInvokeCapability={() => {}}
			/>
		</>
	);
}
