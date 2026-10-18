import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, History, Plus } from "lucide-react";
import {
	type ReactNode,
	type Ref,
	useCallback,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/ui/alert";
import { Button, buttonVariants } from "../../components/ui/button.js";
import type { BrowserSessionProjectionV1 } from "../../pilot/generated/types.gen.js";
import { getAgentV2 } from "../../pilot/generated-v2/sdk.gen.js";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { isAgentConfigurationOwner } from "../agent-configuration/agent-configuration.js";
import { ActiveConversation } from "./active-conversation.js";
import {
	CreateConversationNotice,
	NewConversation,
	PersonalHistory,
	useCreateConversation,
} from "./conversation-navigation.js";
import { ConversationReadError, responseFailure } from "./execution-detail.js";
import { RecentConversationHistory } from "./recent-conversation-history.js";

export type ConversationScreenProps = {
	agentId: string;
	conversationId?: string;
	identityKey: string;
	/** 当前登录会话：只用于决定是否显示 Owner 入口，权限仍由 Owner 配置页和服务端校验。 */
	session?: BrowserSessionProjectionV1;
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

const subtitle = "Web 对话 · 已提交的任务会继续处理。";

function ConversationHeader({
	title,
	headingRef,
	actions,
}: {
	title: string;
	headingRef?: Ref<HTMLHeadingElement>;
	actions?: ReactNode;
}) {
	return (
		<header className="conversation-header">
			<div className="conversation-heading-copy">
				<p className="conversation-eyebrow">工作区 / 对话</p>
				<h1 ref={headingRef} tabIndex={-1}>
					{title}
				</h1>
				<p className="conversation-subtitle">{subtitle}</p>
			</div>
			{actions && <div className="conversation-heading-actions">{actions}</div>}
		</header>
	);
}

/** 设计 notice.warn：Agent 不是「可用 + 就绪」时横跨页头下方，说明历史可读、能否继续编辑草稿。 */
function AgentUnavailableNotice({
	agent,
	canManage,
	onRefresh,
}: {
	agent: AgentProjectionV2;
	canManage: boolean;
	onRefresh: () => void;
}) {
	const readOnly = "可以查看历史，暂时不能发送消息。";
	const notice: {
		title: string;
		description: string;
		action?: "owner" | "refresh";
	} =
		agent.managementStatus === "stopped"
			? canManage
				? {
						title: "已停止",
						description: "历史会话仍可查看，Owner 可以重启或修改运行配置。",
						action: "owner",
					}
				: { title: "已停止", description: readOnly }
			: agent.managementStatus === "disabled"
				? // 已停用的 Agent 不能由 Owner 恢复（PRD §6.3），不给 Owner 入口。
					{ title: "已停用", description: readOnly }
				: agent.serviceAvailability === "updating"
					? {
							title: "更新中",
							description: "可以查看历史，草稿仍可编辑；更新完成后才能发送。",
						}
					: agent.serviceAvailability === "starting"
						? {
								title: "启动中",
								description: "可以查看历史，草稿仍可编辑；启动完成后才能发送。",
							}
						: agent.managementStatus === "creating"
							? { title: "创建中", description: readOnly }
							: // 暂时不可用：保留手动重读入口（PRD §6.4 重试提示）。
								{
									title: "暂时不可用",
									description: readOnly,
									action: "refresh",
								};
	return (
		<Alert role="status" tone="warn" className="conversation-unavailable">
			<AlertTitle>{notice.title}</AlertTitle>
			<AlertDescription>{notice.description}</AlertDescription>
			{notice.action && (
				<AlertAction>
					{notice.action === "owner" ? (
						<Link
							to="/agents/$agentId/configuration"
							params={{ agentId: agent.agentId }}
							className={buttonVariants({ variant: "outline" })}
						>
							进入 Owner 操作
						</Link>
					) : (
						<Button variant="outline" onClick={onRefresh}>
							刷新 Agent 状态
						</Button>
					)}
				</AlertAction>
			)}
		</Alert>
	);
}

function ConversationWorkspace(props: ConversationScreenProps) {
	const {
		agentId,
		identityKey,
		conversationId,
		session,
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
	const [recentOpen, setRecentOpen] = useState(false);
	const historyPanel = useRef<HTMLElement>(null);
	const historyToggle = useRef<HTMLButtonElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const showHistory =
		props.view === undefined ? internalHistory : props.view === "history";
	const historyExpanded = showHistory || recentOpen;
	function setHistory(value: boolean) {
		setInternalHistory(value);
		props.onViewChange?.(value ? "history" : "conversation");
	}
	function selectConversation(id: string | undefined) {
		setRecentOpen(false);
		setInternalHistory(false);
		historyToggle.current?.focus();
		onConversationChange(id);
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
		// A starting or updating Agent keeps the page read-only; poll so it
		// resumes on its own once ready (same cadence as the Agent page).
		refetchInterval: (query) =>
			query.state.status === "success" &&
			(query.state.data?.managementStatus === "creating" ||
				query.state.data?.serviceAvailability === "starting" ||
				query.state.data?.serviceAvailability === "updating")
				? 2000
				: false,
	});
	useLayoutEffect(() => {
		if (agentQuery.data && (showHistory || recentOpen))
			historyPanel.current?.focus();
	}, [agentQuery.data, showHistory, recentOpen]);
	useLayoutEffect(
		() => () => {
			void queryClient.cancelQueries({ queryKey, exact: true });
			queryClient.removeQueries({ queryKey, exact: true });
		},
		[queryClient, queryKey],
	);
	const deny = useCallback(() => setDenied(true), []);
	// 命令得到 404 时用它确认：Agent 已停止/停用/更新中时 404 只是「不可用」，不是失去访问权限。
	// 读取失败或结果仍然可用时按原来的方式处理（#2570）。
	const refetchAgent = agentQuery.refetch;
	const verifyAgent = useCallback(async () => {
		const result = await refetchAgent();
		if (result.isError || !result.data) return true;
		return (
			result.data.managementStatus === "available" &&
			result.data.serviceAvailability === "ready"
		);
	}, [refetchAgent]);
	const onCreated = useCallback(
		(id: string) => {
			setRecentOpen(false);
			setInternalHistory(false);
			onConversationChange(id);
		},
		[onConversationChange],
	);
	// 页头「新会话」一步创建会话并进入可输入的 composer（设计 new-chat）。
	const creation = useCreateConversation({
		agentId,
		identityKey,
		onCreated,
		onDenied: deny,
		verifyAgent,
	});
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
				<ConversationHeader title="对话" />
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
	const canManage =
		session !== undefined &&
		(isAgentConfigurationOwner(agent, session) ||
			session.user.roles.includes("system_admin"));
	return (
		<section className="chat-layout">
			<ConversationHeader
				title={agent.name}
				headingRef={heading}
				actions={
					<>
						<Button
							variant="outline"
							ref={historyToggle}
							className="conversation-history-toggle"
							aria-expanded={historyExpanded}
							aria-controls={`${instanceId}-history`}
							onClick={() => {
								if (historyExpanded) {
									setRecentOpen(false);
									setHistory(false);
									historyToggle.current?.focus();
								} else {
									setRecentOpen(true);
								}
							}}
						>
							{historyExpanded ? (
								<ArrowLeft aria-hidden="true" />
							) : (
								<History aria-hidden="true" />
							)}
							{historyExpanded ? "返回对话" : "个人历史"}
						</Button>
						<Button
							variant="outline"
							disabled={!available || selfManaged || creation.busy}
							onClick={() => creation.create()}
						>
							<Plus aria-hidden="true" />
							新会话
						</Button>
					</>
				}
			/>
			{!available && (
				<AgentUnavailableNotice
					agent={agent}
					canManage={canManage}
					onRefresh={() => void agentQuery.refetch()}
				/>
			)}
			{conversationId && !selfManaged && (
				<CreateConversationNotice creation={creation} />
			)}
			<div className="conversation-columns" data-history-open={historyExpanded}>
				<div className="chat-workspace">
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
							verifyAgent={verifyAgent}
							focusFallback={heading}
						/>
					) : (
						<NewConversation available={available} creation={creation} />
					)}
				</div>
				<aside
					ref={historyPanel}
					id={`${instanceId}-history`}
					aria-label="对话历史"
					tabIndex={-1}
					className="conversation-history-panel"
				>
					{showHistory ? (
						<PersonalHistory
							agentId={agentId}
							identityKey={identityKey}
							current={conversationId}
							onSelect={selectConversation}
							onDenied={deny}
						/>
					) : (
						<RecentConversationHistory
							agentId={agentId}
							conversationId={conversationId}
							identityKey={identityKey}
							onSelect={selectConversation}
						/>
					)}
					<div className="history-scope-actions">
						<Button
							variant="ghost"
							onClick={() => {
								setRecentOpen(showHistory);
								setHistory(!showHistory);
							}}
						>
							{showHistory ? "最近对话" : "此 Agent 的全部历史"}
						</Button>
					</div>
				</aside>
			</div>
		</section>
	);
}
