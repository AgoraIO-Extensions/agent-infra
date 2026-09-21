import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, History, Plus } from "lucide-react";
import {
	useCallback,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "../../components/ui/button.js";
import { getAgentV2 } from "../../pilot/generated-v2/sdk.gen.js";
import { ActiveConversation } from "./active-conversation.js";
import { NewConversation, PersonalHistory } from "./conversation-navigation.js";
import { ConversationReadError, responseFailure } from "./execution-detail.js";

export type ConversationScreenProps = {
	agentId: string;
	conversationId?: string;
	identityKey: string;
	view?: "history" | "conversation";
	onViewChange?: (view: "history" | "conversation") => void;
	onConversationChange: (conversationId: string | undefined) => void;
	onAccessDenied?: () => void;
};

/** The React key is an additional UI boundary: drafts, selections and receipts
 * cannot cross a login/session or Agent change. Identity is never sent as input. */
export function ConversationScreen(props: ConversationScreenProps) {
	return (
		<ConversationWorkspace
			key={JSON.stringify([props.identityKey, props.agentId])}
			{...props}
		/>
	);
}

function ConversationWorkspace(props: ConversationScreenProps) {
	const {
		agentId,
		identityKey,
		conversationId,
		onConversationChange,
		onAccessDenied,
	} = props;
	const queryClient = useQueryClient();
	const instanceId = useId();
	const queryKey = useMemo(
		() => ["conversation-screen-agent", instanceId, identityKey, agentId],
		[instanceId, identityKey, agentId],
	);
	const [denied, setDenied] = useState(false);
	const [internalHistory, setInternalHistory] = useState(false);
	const showHistory =
		props.view === undefined ? internalHistory : props.view === "history";
	function setHistory(value: boolean) {
		setInternalHistory(value);
		props.onViewChange?.(value ? "history" : "conversation");
	}
	const agentQuery = useQuery({
		queryKey,
		enabled: Boolean(identityKey && agentId) && !denied,
		retry: false,
		gcTime: 0,
		placeholderData: undefined,
		queryFn: async ({ signal }) => {
			const result = await getAgentV2({
				path: { agentId },
				signal,
				responseStyle: "fields",
				throwOnError: false,
			});
			signal.throwIfAborted();
			if (!result.data || result.response?.status !== 200)
				throw new ConversationReadError(
					responseFailure(result.error, result.response?.status),
				);
			const parsed = AgentProjectionV2Schema.safeParse(result.data);
			if (!parsed.success || parsed.data.agentId !== agentId)
				throw new ConversationReadError({ kind: "invalid" });
			return parsed.data;
		},
	});
	useLayoutEffect(
		() => () => {
			void queryClient.cancelQueries({ queryKey, exact: true });
			queryClient.removeQueries({ queryKey, exact: true });
		},
		[queryClient, queryKey],
	);
	const deny = useCallback(() => setDenied(true), []);
	const deniedCallback = useRef(onAccessDenied);
	deniedCallback.current = onAccessDenied;
	useLayoutEffect(() => {
		if (
			agentQuery.error instanceof ConversationReadError &&
			agentQuery.error.failure.kind === "authorization"
		)
			setDenied(true);
	}, [agentQuery.error]);
	useLayoutEffect(() => {
		if (!denied) return;
		void queryClient.cancelQueries({ queryKey, exact: true });
		queryClient.removeQueries({ queryKey, exact: true });
		deniedCallback.current?.();
	}, [denied, queryClient, queryKey]);
	if (denied || !identityKey)
		return (
			<p role="alert" className="py-6">
				当前登录或访问权限已失效，请重新登录或返回 Agent 列表。
			</p>
		);
	const agent = agentQuery.data;
	if (!agent)
		return (
			<section className="space-y-4 py-6">
				<h1 className="font-semibold text-[28px]">对话</h1>
				{agentQuery.isPending ? (
					<p role="status">正在读取 Agent…</p>
				) : (
					<>
						<p role="alert">Agent 信息暂时无法读取。</p>
						<Button onClick={() => void agentQuery.refetch()}>重新读取</Button>
					</>
				)}
			</section>
		);
	const available =
		agent.managementStatus === "available" &&
		agent.serviceAvailability === "ready";
	const selfManaged =
		agent.source.kind === "custom" &&
		agent.source.interactionMode === "self-managed";
	return (
		<section className="chat-layout min-w-0 space-y-5">
			<header className="flex flex-wrap items-start justify-between gap-3 border-border border-b pb-4">
				<div>
					<h1 className="font-semibold text-[28px]">
						{showHistory ? "个人历史" : agent.name}
					</h1>
					<p className="mt-1 text-muted-foreground text-sm">
						个人 Web 对话 · 离开页面不会取消已提交的任务
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button variant="outline" onClick={() => setHistory(!showHistory)}>
						{showHistory ? (
							<ArrowLeft aria-hidden="true" />
						) : (
							<History aria-hidden="true" />
						)}
						{showHistory ? "返回对话" : "个人历史"}
					</Button>
					<Button
						variant="outline"
						disabled={!available || selfManaged}
						onClick={() => {
							setInternalHistory(false);
							onConversationChange(undefined);
						}}
					>
						<Plus aria-hidden="true" />
						新建会话
					</Button>
				</div>
			</header>
			{!available && (
				<p role="status" className="border border-border bg-muted p-3">
					{agent.serviceAvailability === "updating"
						? "Agent 更新中"
						: agent.serviceAvailability === "starting"
							? "Agent 启动中"
							: "Agent 当前不可用"}
					，历史保持只读。
					<Button variant="ghost" onClick={() => void agentQuery.refetch()}>
						刷新 Agent 状态
					</Button>
				</p>
			)}
			{showHistory ? (
				<PersonalHistory
					agentId={agentId}
					identityKey={identityKey}
					current={conversationId}
					onSelect={(id) => {
						setInternalHistory(false);
						onConversationChange(id);
					}}
					onDenied={deny}
				/>
			) : null}
			<div hidden={showHistory} className="chat-workspace">
				{selfManaged ? (
					<p>此 Agent 使用自有交互入口，请从 Agent 详情进入。</p>
				) : conversationId ? (
					<ActiveConversation
						key={conversationId}
						{...props}
						agent={agent}
						available={available}
						onDenied={deny}
						refreshAgent={() => void agentQuery.refetch()}
					/>
				) : (
					<NewConversation
						agentId={agentId}
						identityKey={identityKey}
						available={available}
						onCreated={onConversationChange}
						onDenied={deny}
					/>
				)}
			</div>
		</section>
	);
}
