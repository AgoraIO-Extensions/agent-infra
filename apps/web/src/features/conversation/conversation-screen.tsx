import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, History, Plus } from "lucide-react";
import {
	useCallback,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { getAgentV2 } from "../../pilot/generated-v2/sdk.gen.js";
import { agentServiceAvailabilityLabel } from "../agent-discovery/agent-discovery-screen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import { ActiveConversation } from "./active-conversation.js";
import { NewConversation, PersonalHistory } from "./conversation-navigation.js";
import { ConversationReadError, responseFailure } from "./execution-detail.js";
import { RecentConversationHistory } from "./recent-conversation-history.js";

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
	const [historyScope, setHistoryScope] = useState<"agent" | "recent">("agent");
	const historyPanel = useRef<HTMLElement>(null);
	const historyToggle = useRef<HTMLButtonElement>(null);
	const showHistory =
		props.view === undefined ? internalHistory : props.view === "history";
	useLayoutEffect(() => {
		if (showHistory) historyPanel.current?.focus();
	}, [showHistory]);
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
	const agent = agentQuery.data;
	if (denied || !identityKey || !agent)
		return (
			<section className="chat-layout">
				<header className="conversation-header">
					<div className="conversation-heading-copy">
						<p className="conversation-eyebrow">工作区 / 对话</p>
						<h1>对话</h1>
					</div>
				</header>
				{denied || !identityKey ? (
					<Alert>
						<AlertDescription>
							当前登录或访问权限已失效，请重新登录或返回 Agent 列表。
						</AlertDescription>
					</Alert>
				) : agentQuery.isPending ? (
					<p role="status">正在读取 Agent…</p>
				) : (
					<Alert>
						<AlertDescription>Agent 信息暂时无法读取。</AlertDescription>
					</Alert>
				)}
				<div className="mt-4 flex flex-wrap gap-2">
					{!denied && identityKey && !agentQuery.isPending && (
						<Button onClick={() => void agentQuery.refetch()}>重新读取</Button>
					)}
					<Link to="/agents" className={buttonVariants({ variant: "outline" })}>
						返回 Agent 列表
					</Link>
				</div>
			</section>
		);
	const available =
		agent.managementStatus === "available" &&
		agent.serviceAvailability === "ready";
	const selfManaged =
		agent.source.kind === "custom" &&
		agent.source.interactionMode === "self-managed";
	return (
		<section className="chat-layout">
			<header className="conversation-header">
				<div className="flex min-w-0 gap-3">
					<div className="conversation-heading-copy">
						<p className="conversation-eyebrow">工作区 / 对话</p>
						<h1 className="font-semibold text-[26px]">{agent.name}</h1>
						<p className="conversation-summary text-muted-foreground text-sm">
							{agent.source.kind === "standard"
								? `标准模板 · ${agent.source.templateId}`
								: `自定义 Agent · ${selfManaged ? "自有交互入口" : "平台交互入口"}`}
						</p>
						<p className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-sm">
							<span>
								管理状态：
								{agentManagementStatusLabels[agent.managementStatus]}
							</span>
							{agent.serviceAvailability !== null && (
								<span>
									服务状态：
									{agentServiceAvailabilityLabel(agent.serviceAvailability)}
								</span>
							)}
						</p>
						{!selfManaged && (
							<p className="conversation-summary text-muted-foreground text-sm">
								个人 Web 对话 · 离开页面不会取消已提交的任务
							</p>
						)}
					</div>
				</div>
				<div className="conversation-heading-actions">
					<Link
						to="/agents"
						search={{ mode: "conversation" }}
						className={buttonVariants({ variant: "ghost" })}
					>
						切换 Agent
					</Link>
					<Button
						variant="outline"
						ref={historyToggle}
						aria-expanded={showHistory}
						aria-controls={`${instanceId}-history`}
						onClick={() => {
							if (showHistory) {
								setHistory(false);
								historyToggle.current?.focus();
							} else {
								setHistoryScope("agent");
								setHistory(true);
							}
						}}
					>
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
			<div className="conversation-columns" data-history-open={showHistory}>
				<div className="chat-workspace">
					{!available && (
						<Alert role="status" className="mb-5 bg-muted">
							<AlertDescription>
								{agent.serviceAvailability === "updating"
									? "Agent 更新中"
									: agent.serviceAvailability === "starting"
										? "Agent 启动中"
										: "Agent 当前不可用"}
								，历史保持只读。
								<Button
									variant="ghost"
									onClick={() => void agentQuery.refetch()}
								>
									刷新 Agent 状态
								</Button>
							</AlertDescription>
						</Alert>
					)}
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
				<aside
					ref={historyPanel}
					id={`${instanceId}-history`}
					aria-label="对话历史"
					tabIndex={-1}
					className="conversation-history-panel"
				>
					{showHistory && historyScope === "agent" ? (
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
					) : (
						<RecentConversationHistory
							agentId={agentId}
							conversationId={conversationId}
							identityKey={identityKey}
							onSelect={(id) => {
								setInternalHistory(false);
								onConversationChange(id);
							}}
						/>
					)}
					<div className="history-scope-actions">
						<Button
							variant="ghost"
							onClick={() => {
								setHistoryScope(
									showHistory && historyScope === "agent" ? "recent" : "agent",
								);
								setHistory(true);
							}}
						>
							{showHistory && historyScope === "agent"
								? "最近对话"
								: "此 Agent 的全部历史"}
						</Button>
					</div>
				</aside>
			</div>
		</section>
	);
}
