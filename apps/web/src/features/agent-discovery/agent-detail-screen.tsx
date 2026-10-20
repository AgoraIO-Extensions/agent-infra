import type { BrowserCapabilityProjectionV1 } from "@agent-infra/contracts/runtime";
import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	ExternalLink,
	History,
	MessageCircle,
	Settings,
} from "lucide-react";
import { Fragment } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { IdentifierText } from "@/components/ui/identifier-text";
import { reasoningLevelLabel } from "@/lib/reasoning-level-label";
import type { ChipTone } from "@/lib/status-tone";
import type {
	AgentDetailProjectionV1,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import {
	agentAvailabilityStatus,
	agentConversationSourceLabel,
	agentIdentityResponsibilityLabel,
} from "../agent-management-status.js";
import { AgentMark } from "../agent-mark.js";
import { DirectoryRecords } from "../directory-fields.js";
import { useDirectoryNames } from "../directory-names.js";
import { PageLoadingState } from "../page-loading-state.js";
import { ReadFailureCard } from "../page-state-card.js";
import {
	type TemplateNameLookup,
	templateDisplayName,
} from "../template-display-name.js";
import {
	type AgentDetailViewState,
	canStartPlatformConversation,
} from "./agent-discovery.js";
import { agentChannelKindLabels } from "./agent-discovery-screen.js";
import { BrowserCapabilityStatus } from "./browser-capability-status.js";
import { ConnectionNotice } from "./connection-notice.js";

type AgentDetailScreenProps = {
	browserCapability?: BrowserCapabilityProjectionV1;
	/** 壳层与本页共用的受控 Connection 入口；undefined 表示当前没有可用入口。 */
	connectionUrl?: string;
	onRetry?: () => void;
	ownerSettings?: { readonly agentId: string };
	/**
	 * 设计页头 ghost「可用 Skill」的目标是 Owner 配置下的 Agent Skill 页；该页只对当前 Owner 开放
	 * （PRD §11.5 由 Owner 配置 Skill 版本），所以路由只为当前 Owner 提供（D-03）。
	 */
	skillBindings?: { readonly agentId: string };
	retrying?: boolean;
	state: AgentDetailViewState | { kind: "loading" };
	/** 模板显示名（部署配置）；未提供或读不到时显示「标准模板」（F-02）。 */
	templateName?: TemplateNameLookup;
};
type AgentDetail = AgentDetailProjectionV1;
type AgentOwner = AgentDetail["configuration"]["owners"][number];
// 渠道 chip 只映射服务端投影的真实状态（#2910）：企微「已绑定」来自已认证连接，
// 「绑定中」是尚未证实连接，「连接异常」覆盖断开、认证失败或托管绑定失效。
const channelStatusLabels = {
	available: "可用",
	not_configured: "未配置",
	binding: "绑定中",
	bound: "已绑定",
	failed: "连接异常",
} satisfies Record<
	AgentProjectionV2["configuration"]["channels"][number]["status"],
	string
>;
const channelStatusTones = {
	available: "green",
	not_configured: "gray",
	binding: "amber",
	bound: "green",
	failed: "red",
} satisfies Record<
	AgentProjectionV2["configuration"]["channels"][number]["status"],
	ChipTone
>;

function safeInteractionUrl(input: string | null) {
	if (!input) return undefined;
	try {
		const url = new URL(input);
		return url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

/** 服务状态行的说明：按 PRD §6.4「用户看到的行为」，不展示运行时技术状态。 */
function serviceDescription(agent: AgentDetail) {
	if (agent.managementStatus !== "available")
		return "历史只读，当前不能发送消息";
	if (agent.serviceAvailability === "ready") return "可以发送消息并获得回复";
	if (agent.serviceAvailability === "unavailable")
		return "历史只读，可稍后重试";
	return "历史只读，暂时不能发送消息";
}

/**
 * Owner 状态 chip（#2910）：只显示服务端投影的状态，读不到时为「状态未知」，不推断为有效。
 * 所有 Owner 权限相同，不区分主要 / 共同 Owner（PRD §2.2）。
 */
const ownerStatusChips = {
	active: { label: "有效", tone: "green" },
	disabled: { label: "已禁用", tone: "amber" },
	departed: { label: "已离职", tone: "gray" },
	unavailable: { label: "状态未知", tone: "gray" },
} satisfies Record<AgentOwner["status"], { label: string; tone: ChipTone }>;

/** Owner 名称：服务端显示名，其次目录名称；都没有时只显示类型与 ID 短形式。 */
function OwnerName({
	owner,
	directoryName,
}: {
	owner: AgentOwner;
	directoryName?: string;
}) {
	const name = owner.displayName ?? directoryName;
	return name ? (
		<>{name}</>
	) : (
		<>
			用户 <IdentifierText value={owner.userId} label="用户 ID" />
		</>
	);
}

function OwnerNames({ owners }: { owners: readonly AgentOwner[] }) {
	const names = useDirectoryNames(
		"user",
		owners.map((owner) => owner.userId),
	);
	if (owners.length === 0) return <>未提供</>;
	return (
		<>
			{owners.map((owner, index) => {
				const directory = names.resolve(owner.userId);
				return (
					<Fragment key={owner.userId}>
						{index > 0 && "、"}
						<OwnerName
							owner={owner}
							directoryName={directory.resolved ? directory.name : undefined}
						/>
					</Fragment>
				);
			})}
		</>
	);
}

function OwnerList({ owners }: { owners: readonly AgentOwner[] }) {
	// 第二行是目录中的组织路径；读取失败或目录没有路径时只显示名称（D-04）。
	const names = useDirectoryNames(
		"user",
		owners.map((owner) => owner.userId),
	);
	return (
		<ul className="detail-list">
			{owners.map((owner) => {
				const directory = names.resolve(owner.userId);
				const chip = ownerStatusChips[owner.status];
				return (
					<li key={owner.userId}>
						<div className="detail-list-main">
							<strong>
								<OwnerName
									owner={owner}
									directoryName={
										directory.resolved ? directory.name : undefined
									}
								/>
							</strong>
							{directory.detail && <small>{directory.detail}</small>}
						</div>
						<Badge variant="chip" tone={chip.tone}>
							{chip.label}
						</Badge>
					</li>
				);
			})}
			{owners.length === 0 && <li>未提供 Owner</li>}
		</ul>
	);
}

/**
 * 「入口状态」行：只在自有交互入口时承载入口是否就绪等状态。标准模板与平台交互入口的旧文案
 * 只重复入口方式（已写进「模板 / 入口」），不再单独占一行，返回 undefined。
 */
function interactionReadiness(
	agent: AgentDetail,
	interactionUrl: string | undefined,
) {
	if (
		agent.source.kind === "standard" ||
		agent.source.interactionMode === "platform-adapter"
	)
		return undefined;
	if (agent.source.identityResponsibility === "self-managed")
		return interactionUrl ? "自有交互入口已就绪。" : "自有交互入口尚未就绪。";
	// 技术组件名不进入产品界面（PRD §6.4），未就绪时与自有身份入口同一说法。
	return interactionUrl ? "平台身份入口已就绪。" : "平台身份入口尚未就绪。";
}

/**
 * 设计 #agent-detail「模板 / 入口」：标准模板写「标准模板 · {显示名} · 平台交互入口」；
 * 自定义 Agent 的来源文案已含入口方式（「自定义 Agent · 自有交互入口」）。
 */
function templateAndEntryLabel(
	agent: AgentDetail,
	templateName: TemplateNameLookup | undefined,
) {
	const source = agentConversationSourceLabel(agent, templateName);
	return agent.source.kind === "standard" ? `${source} · 平台交互入口` : source;
}

export function AgentDetailScreen({
	browserCapability,
	connectionUrl,
	onRetry,
	ownerSettings,
	retrying = false,
	skillBindings,
	state,
	templateName,
}: AgentDetailScreenProps) {
	if (state.kind === "loading")
		return (
			<PageLoadingState title="Agent 详情" message="正在加载 Agent 详情…" />
		);
	if (state.kind === "unavailable")
		return (
			<section aria-labelledby="agent-detail-heading">
				<header className="page-heading">
					<div>
						<h1 id="agent-detail-heading">Agent 详情</h1>
					</div>
				</header>
				{/* 公共状态卡按 401/403/404/503/响应无效选择（P-01）；403 与 404 文案相同。
				    「重新登录」「重新加载 Agent」恢复后焦点落到详情 h1（Agent 名）。 */}
				<ReadFailureCard
					failure={state}
					deniedDescription="Agent 不存在，或你没有访问权限。"
					unavailableDescription="暂时无法读取 Agent，请稍后重试。"
					back={
						<Link
							activeOptions={{ exact: true }}
							className={buttonVariants({ variant: "outline" })}
							to="/agents"
						>
							返回 Agent 目录
						</Link>
					}
					onRetry={onRetry}
					// 401「重新登录」后会话仍有效：重读详情（W-03）。
					onStillValid={onRetry}
					retrying={retrying}
					retryLabel="重新加载 Agent"
				/>
			</section>
		);
	const { agent } = state;
	const selfManaged =
		agent.source.kind === "custom" &&
		agent.source.interactionMode === "self-managed";
	const interactionUrl =
		selfManaged &&
		agent.source.kind === "custom" &&
		agent.source.interactionMode === "self-managed"
			? safeInteractionUrl(agent.interactionUrl)
			: undefined;
	const ready = canStartPlatformConversation(agent);
	const availability = agentAvailabilityStatus(agent);
	const entryStatus = interactionReadiness(agent, interactionUrl);
	return (
		<section aria-labelledby="agent-detail-heading" className="agent-detail">
			<header className="page-heading">
				<div className="agent-detail-copy">
					{/* exact：返回链接不是当前页，不让 Link 按前缀补 aria-current（N-21）。 */}
					<Link
						activeOptions={{ exact: true }}
						className={buttonVariants({
							variant: "ghost",
							size: "sm",
							className: "agent-detail-back",
						})}
						to="/agents"
					>
						<ArrowLeft aria-hidden="true" />
						返回 Agent 目录
					</Link>
					<div className="agent-detail-heading">
						<AgentMark name={agent.name} agentId={agent.agentId} />
						<div className="min-w-0">
							<p className="page-eyebrow">
								Agent 详情 ·{" "}
								{agent.source.kind === "standard"
									? templateDisplayName(agent.source.templateId, templateName)
									: "自定义 Agent"}
							</p>
							<h1
								id="agent-detail-heading"
								tabIndex={-1}
								className="break-words font-semibold text-[28px]"
							>
								{agent.name}
							</h1>
							<p className="mt-2 max-w-2xl whitespace-pre-wrap break-words text-muted-foreground leading-7">
								{agent.description}
							</p>
						</div>
					</div>
				</div>
				<div className="actions agent-detail-actions">
					{!selfManaged &&
						(ready ? (
							<Link
								className={buttonVariants()}
								to="/chat/$agentId/{-$conversationId}"
								params={{ agentId: agent.agentId, conversationId: undefined }}
								search={{ view: undefined }}
							>
								<MessageCircle aria-hidden="true" />
								开始对话
							</Link>
						) : (
							<Button disabled>
								<MessageCircle aria-hidden="true" />
								开始对话
							</Button>
						))}
					{interactionUrl && (
						<a
							className={buttonVariants()}
							href={interactionUrl}
							rel="noopener noreferrer"
							target="_blank"
						>
							<ExternalLink aria-hidden="true" />
							打开 Agent
						</a>
					)}
					{ownerSettings && (
						<Link
							className={buttonVariants({ variant: "outline" })}
							params={{ agentId: ownerSettings.agentId }}
							to="/agents/$agentId/configuration"
						>
							<Settings aria-hidden="true" />
							Owner 配置
						</Link>
					)}
					{/* 与 Owner 配置「Skill」分区同一条件：自有交互入口不在平台会话中使用 Skill。 */}
					{skillBindings && !selfManaged && (
						<Link
							className={buttonVariants({ variant: "ghost" })}
							params={{ agentId: skillBindings.agentId }}
							to="/agents/$agentId/skills"
						>
							可用 Skill
						</Link>
					)}
				</div>
			</header>
			{/* D-03：一个派生状态 chip + 非状态 tag。 */}
			<div className="status-line agent-detail-status">
				<Badge variant="chip" tone={availability.tone}>
					{availability.label}
				</Badge>
				{!selfManaged && <Badge variant="tag">每个用户都有独立会话</Badge>}
				{agent.capabilities.connection && (
					<Badge variant="tag">支持 Connection</Badge>
				)}
			</div>
			<div className="agent-detail-grid">
				<div className="agent-detail-panel">
					<section
						className="detail-section space-y-4 border-border border-b py-6"
						aria-labelledby="about-agent-heading"
					>
						<h2 id="about-agent-heading" className="font-semibold text-lg">
							关于此 Agent
						</h2>
						<dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
							<dt className="text-muted-foreground">Owner</dt>
							<dd>
								<OwnerNames owners={agent.configuration.owners} />
							</dd>
							<dt className="text-muted-foreground">模板 / 入口</dt>
							<dd className="break-all">
								{templateAndEntryLabel(agent, templateName)}
							</dd>
							{/* F-07：身份责任只是自有交互入口的选择（PRD §5.3、§7.2）；标准模板与平台交互入口
							    始终由平台校验，设计 #agent-detail 不列这一行。 */}
							{selfManaged && (
								<>
									<dt className="text-muted-foreground">入口身份责任</dt>
									<dd>{agentIdentityResponsibilityLabel(agent)}</dd>
								</>
							)}
							{entryStatus && (
								<>
									<dt className="text-muted-foreground">入口状态</dt>
									<dd>{entryStatus}</dd>
								</>
							)}
							<dt className="text-muted-foreground">可用范围</dt>
							<dd className="break-words">
								{agent.configuration.availability.length ? (
									<DirectoryRecords
										targets={agent.configuration.availability}
									/>
								) : (
									"未提供范围信息"
								)}
							</dd>
							{!selfManaged && (
								<>
									<dt className="text-muted-foreground">模型范围</dt>
									<dd className="break-words">
										{agent.configuration.modelOptions
											.map(
												(option) =>
													`${option.displayName} · ${option.reasoningLevels.map(reasoningLevelLabel).join("、")}`,
											)
											.join("；") || "无可选择模型"}
									</dd>
									{/* F-07：只显示默认推理档位的中文名，不外露模型名与原始枚举。 */}
									<dt className="text-muted-foreground">默认推理档位</dt>
									<dd className="break-words">
										{agent.configuration.defaultReasoningLevel
											? reasoningLevelLabel(
													agent.configuration.defaultReasoningLevel,
												)
											: "未提供"}
									</dd>
								</>
							)}
						</dl>
					</section>
					{!selfManaged && (
						<section className="detail-section">
							<h2>个人历史</h2>
							<p className="mb-4 text-muted-foreground text-sm">
								只显示当前账号提交的消息与执行状态，Agent Owner
								无法替你查看正文。
							</p>
							<Link
								className={buttonVariants({ variant: "outline" })}
								to="/chat/$agentId/{-$conversationId}"
								params={{ agentId: agent.agentId, conversationId: undefined }}
								search={{ view: "history" }}
							>
								<History aria-hidden="true" />
								查看对话历史
							</Link>
						</section>
					)}
					<section
						className="detail-section space-y-3 border-border border-b py-6"
						aria-labelledby="agent-capability-heading"
					>
						<h2 id="agent-capability-heading" className="font-semibold text-lg">
							连接器
						</h2>
						<p>
							{agent.capabilities.connection
								? "此 Agent 支持独立 Connection 直连，使用前需由当前主体完成授权。"
								: "当前 Agent 未提供 Connection 能力。"}
						</p>
						{agent.capabilities.connection && (
							<ConnectionNotice href={connectionUrl} />
						)}
					</section>
					{browserCapability && (
						<BrowserCapabilityStatus capability={browserCapability} />
					)}
				</div>
				<aside className="agent-detail-aside" aria-label="Owner 与渠道">
					<section
						className="agent-detail-panel"
						aria-labelledby="agent-owner-heading"
					>
						<header className="detail-panel-heading">
							<h2 id="agent-owner-heading">Owner</h2>
							<p>负责范围与运行状态</p>
						</header>
						<OwnerList owners={agent.configuration.owners} />
					</section>
					<section
						className="agent-detail-panel"
						aria-labelledby="agent-runtime-heading"
					>
						<header className="detail-panel-heading">
							<h2 id="agent-runtime-heading">运行与渠道</h2>
							<p>平台当前观测</p>
						</header>
						<ul className="detail-list">
							<li>
								<div className="detail-list-main">
									<strong>服务状态</strong>
									<small>{serviceDescription(agent)}</small>
								</div>
								<Badge variant="chip" tone={availability.tone}>
									{availability.label}
								</Badge>
							</li>
							{agent.configuration.channels.map((channel) => (
								<li key={channel.kind}>
									<div className="detail-list-main">
										<strong>{agentChannelKindLabels[channel.kind]}</strong>
										{/* 企微渠道只显示真实绑定状态，不显示可见范围（#2910 决定）。 */}
										{channel.kind === "web" && <small>平台对话入口</small>}
									</div>
									<Badge
										variant="chip"
										tone={channelStatusTones[channel.status]}
									>
										{channelStatusLabels[channel.status]}
									</Badge>
								</li>
							))}
							{agent.configuration.channels.length === 0 && (
								<li>暂无平台渠道</li>
							)}
						</ul>
					</section>
				</aside>
			</div>
		</section>
	);
}
