import type {
	OperationsQuantitiesV2,
	OperationsResourcesV2,
} from "@agent-infra/contracts/pilot";
import { RefreshCw } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Timestamp } from "@/components/ui/timestamp";
import { RecoveryButton } from "../recovery-button.js";

export function resourceNumber(value: number | null, unit: "cpu" | "bytes") {
	if (value === null) return "未知";
	if (unit === "cpu")
		return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(value)} 核`;
	if (value === 0) return "0 B";
	const exponent = Math.min(
		4,
		Math.max(0, Math.floor(Math.log(value) / Math.log(1024))),
	);
	return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value / 1024 ** exponent)} ${["B", "KiB", "MiB", "GiB", "TiB"][exponent]}`;
}
const sourceNames: Record<
	OperationsResourcesV2["sources"][number]["kind"],
	string
> = {
	platform: "平台预算与队列",
	kubernetes: "运行对象与配额",
	"pod-metrics": "容器用量",
	"node-metrics": "节点用量",
	"image-cache": "镜像缓存",
	prometheus: "指标历史",
	logs: "日志",
	traces: "Trace",
};
const stateNames = {
	available: "可用",
	"not-configured": "未接入",
	unavailable: "暂不可用",
	missing: "没有样本",
	stale: "数据过期",
};
const ownershipNames = {
	agent: "Agent 专属",
	shared: "平台共享",
	reserve: "未领取备用",
	unknown: "归属未知",
};
const placementNames = { ecs: "ECS", eci: "ECI", unknown: "未知" };
const roleNames = {
	sandbox: "Sandbox",
	workload: "Agent Workload",
	api: "API",
	worker: "Worker",
	database: "数据库",
	web: "Web",
	directory: "目录",
	unknown: "未知",
};
const alertNames = {
	MEMORY_PRESSURE: "内存容量风险",
	NODE_PRESSURE: "节点压力异常",
	CPU_PRESSURE: "CPU 容量风险",
	QUOTA_PRESSURE: "配额接近上限",
	RESERVE_PRESSURE: "预留预算接近上限",
	CACHE_INVENTORY: "缓存库存接近上限",
	CACHE_EXPIRED: "缓存已到期",
	POD_UNAVAILABLE: "运行实例异常",
	QUEUE_BACKLOG: "任务或后台队列积压",
	ERROR_RATE: "错误率过高",
	DATABASE_PRESSURE: "数据库连接接近上限",
	SOURCE_UNAVAILABLE: "观测来源不可用",
};
const coverageNames = {
	covered: "镜像已覆盖",
	partial: "部分覆盖",
	missing: "未覆盖",
	unknown: "覆盖未知",
};
const hitNames = {
	confirmed: "命中已确认",
	"pull-observed": "观察到拉取",
	unknown: "命中未知",
	"not-applicable": "不适用",
};

function alertTarget(alert: OperationsResourcesV2["alerts"][number]) {
	if (alert.code === "DATABASE_PRESSURE") return "#ops-database";
	if (alert.code === "QUOTA_PRESSURE" || alert.code === "RESERVE_PRESSURE")
		return "#ops-capacity";
	if (alert.code === "CACHE_INVENTORY" || alert.code === "CACHE_EXPIRED")
		return "#ops-cache";
	if (alert.code === "SOURCE_UNAVAILABLE") return "#ops-sources";
	return alert.objectUid
		? `#resource-${encodeURIComponent(alert.objectUid)}`
		: "#ops-history";
}

function Quantities({
	values,
	ephemeral = false,
}: {
	values: OperationsQuantitiesV2;
	ephemeral?: boolean;
}) {
	return (
		<span className="ops-resource-quantities">
			<span>{resourceNumber(values.cpuCores, "cpu")}</span>
			<span>{resourceNumber(values.memoryBytes, "bytes")}</span>
			<span>存储 {resourceNumber(values.storageBytes, "bytes")}</span>
			{ephemeral && (
				<span>
					临时盘 {resourceNumber(values.ephemeralStorageBytes, "bytes")}
				</span>
			)}
		</span>
	);
}
function Panel({
	title,
	id,
	children,
}: {
	title: string;
	id: string;
	children: ReactNode;
}) {
	return (
		<Card
			render={<section aria-labelledby={`${id}-heading`} />}
			className="ops-resource-panel"
			id={id}
		>
			<h2 id={`${id}-heading`}>{title}</h2>
			{children}
		</Card>
	);
}

export function ResourceDashboard({
	data,
	refreshing,
	onRefresh,
	agentId,
	sessionId,
	onSelectAgent,
	onSelectSession,
	history,
}: {
	data: OperationsResourcesV2;
	refreshing: boolean;
	onRefresh: () => void;
	agentId: string;
	sessionId: string;
	onSelectAgent: (value: string) => void;
	onSelectSession: (value: string) => void;
	history?: ReactNode;
}) {
	const id = useId();
	const [visible, setVisible] = useState(50);
	const sessions = [
		...new Set(
			data.resources.flatMap((resource) =>
				resource.sessionId ? [resource.sessionId] : [],
			),
		),
	];
	const firing = data.alerts.filter((alert) => alert.state === "firing");
	const sourceOutages = new Map(
		firing
			.filter((alert) => alert.code === "SOURCE_UNAVAILABLE")
			.map((alert) => [alert.objectName, alert.firstAt]),
	);
	const platform = data.sources.find((source) => source.kind === "platform");
	const waitingAge = data.queue?.oldestWaitingAt
		? Date.parse(data.generatedAt) - Date.parse(data.queue.oldestWaitingAt)
		: null;
	return (
		<section className="ops-resource-dashboard" aria-labelledby={`${id}-title`}>
			<header className="page-heading">
				<div className="min-w-0">
					<p className="page-eyebrow">系统管理 / 运维观测</p>
					<h1 id={`${id}-title`} tabIndex={-1}>
						资源与运行状态
					</h1>
					<p>从集群容量下钻到 Agent、会话和运行实例，查看瓶颈证据。</p>
					<p className="ops-resource-scope">
						集群 {data.scope.clusterId} · {data.scope.namespace} · 每{" "}
						{data.refreshSeconds} 秒刷新
					</p>
				</div>
				<RecoveryButton
					variant="outline"
					recoveryKey="刷新资源观测"
					busy={refreshing}
					onClick={onRefresh}
				>
					<RefreshCw aria-hidden="true" />
					刷新
				</RecoveryButton>
			</header>
			{(data.selection?.agent === "not-found" ||
				data.selection?.session === "not-found") && (
				<Alert tone="warn" role="status">
					所选 Agent
					或会话不存在，或二者不匹配；集群和共享资源仍按当前范围展示。
				</Alert>
			)}
			{data.truncated && (
				<p role="status">
					当前结果已达到查询上限，部分对象未显示；请缩小范围后查看。
				</p>
			)}
			<section className="ops-resource-summary" aria-label="当前概览">
				<Card>
					<span>当前告警</span>
					<strong>{firing.length}</strong>
					<small>仅显示已取得证据的规则结果</small>
				</Card>
				<Card>
					<span>等待投递</span>
					<strong>{data.queue?.waiting ?? "未知"}</strong>
					<small>
						{platform?.state === "available"
							? waitingAge !== null && waitingAge >= 0
								? `最久等待 ${Math.floor(waitingAge / 60000)} 分 ${Math.floor(waitingAge / 1000) % 60} 秒`
								: data.queue?.waiting === 0
									? "当前无待投递任务"
									: "等待时长未知"
							: "平台来源未确认"}
					</small>
				</Card>
				<Card>
					<span>后台积压</span>
					<strong>{data.queue?.outboxPending ?? "未知"}</strong>
					<small>包含任务之外的后台工作</small>
				</Card>
				<Card>
					<span>观测来源</span>
					<strong>
						{
							data.sources.filter((source) => source.state === "available")
								.length
						}{" "}
						/ {data.sources.length}
					</strong>
					<small>可用来源 / 已声明来源</small>
				</Card>
			</section>
			<Panel title="定位入口" id={`${id}-diagnosis`}>
				<nav className="ops-diagnosis-links" aria-label="按问题定位">
					{data.links
						.filter((link) => link.kind === "metrics")
						.map((link) => (
							<a
								key={link.kind}
								href={link.url}
								target="_blank"
								rel="noreferrer"
							>
								执行影响看板 ↗
							</a>
						))}
					<a href="#ops-capacity">创建受阻 · 预算与配额</a>
					<a href="#ops-cache">启动缓慢 · 镜像与事件</a>
					<a href="#ops-resources">资源占用 · Agent 与实例</a>
					<a href="#ops-history">任务缓慢或失败 · 历史与依赖</a>
					<a href="#ops-sources">没有数据 · 观测来源</a>
				</nav>
			</Panel>
			<Panel title="页面告警" id="ops-alerts">
				<p className="ops-resource-note">
					相同故障合并展示。观测中断期间保留已有告警，处置由管理员决定。
				</p>
				{data.alerts.length ? (
					<ul className="ops-alert-list">
						{data.alerts.slice(0, 50).map((alert) => (
							<li key={alert.id}>
								<div>
									<Badge
										tone={
											alert.state === "resolved"
												? "gray"
												: alert.severity === "critical"
													? "red"
													: "amber"
										}
									>
										{alert.state === "resolved"
											? "已恢复"
											: alert.severity === "critical"
												? "严重"
												: "预警"}
									</Badge>
									<strong>{alertNames[alert.code]}</strong>
									<span>{alert.objectName}</span>
								</div>
								<small>
									首次 <Timestamp value={alert.firstAt} /> · 最近{" "}
									<Timestamp value={alert.lastAt} />
									{alert.resolvedAt && (
										<>
											{" "}
											· 恢复 <Timestamp value={alert.resolvedAt} />
										</>
									)}
								</small>
								{alert.value !== null && alert.threshold !== null && (
									<small>
										观测值{" "}
										{alert.code === "QUEUE_BACKLOG"
											? alert.value
											: `${(alert.value * 100).toFixed(1)}%`}{" "}
										/ 阈值{" "}
										{alert.code === "QUEUE_BACKLOG"
											? alert.threshold
											: `${(alert.threshold * 100).toFixed(1)}%`}
									</small>
								)}
								<a href={alertTarget(alert)}>查看关联对象</a>
							</li>
						))}
					</ul>
				) : (
					<p>暂无已确认告警。请同时检查数据来源是否可用。</p>
				)}
			</Panel>
			<Panel title="集群节点" id="ops-nodes">
				{data.nodes.length ? (
					<Table mobileLayout="cards">
						<TableHeader>
							<TableRow>
								<TableHead>节点</TableHead>
								<TableHead>CPU 实测 / 可分配</TableHead>
								<TableHead>内存实测 / 可分配</TableHead>
								<TableHead>状态</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.nodes.map((node) => (
								<TableRow
									key={node.uid}
									id={`resource-${encodeURIComponent(node.uid)}`}
								>
									<TableCell data-label="节点">
										{node.name}
										<small>{node.virtual ? "ECI 虚拟节点" : "ECS 节点"}</small>
									</TableCell>
									<TableCell data-label="CPU">
										{node.virtual
											? "按 ECI 容器查看"
											: `${resourceNumber(node.usage.cpuCores, "cpu")} / ${resourceNumber(node.allocatable.cpuCores, "cpu")}`}
									</TableCell>
									<TableCell data-label="内存">
										{node.virtual
											? "云容量独立核实"
											: `${resourceNumber(node.usage.memoryBytes, "bytes")} / ${resourceNumber(node.allocatable.memoryBytes, "bytes")}`}
									</TableCell>
									<TableCell data-label="状态">
										{node.ready === null
											? "未知"
											: node.ready
												? "Ready"
												: "未就绪"}
										{node.pressures.length
											? ` · ${node.pressures.join(" / ")}`
											: ""}
										<small>
											<Timestamp value={node.observedAt} />
										</small>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				) : (
					<p>暂无节点样本。节点读取与容器用量的接入状态分别显示。</p>
				)}
			</Panel>
			<Panel title="预算与资源配额" id="ops-capacity">
				{data.budget ? (
					<>
						<p>以下按预留预算口径展示，会话用量与保留存储单列。</p>
						<Table mobileLayout="cards">
							<TableHeader>
								<TableRow>
									<TableHead>口径</TableHead>
									<TableHead>CPU / 内存 / 存储</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								<TableRow>
									<TableCell data-label="口径">
										预留预算上限 ·{" "}
										{data.budget.enabled === null
											? "未配置"
											: data.budget.enabled
												? "启用"
												: "关闭"}
									</TableCell>
									<TableCell data-label="上限">
										{data.budget.limits ? (
											<Quantities values={data.budget.limits} />
										) : (
											"未知"
										)}
									</TableCell>
								</TableRow>
								<TableRow>
									<TableCell data-label="口径">
										未领取备用占用 · {data.budget.counts.unclaimedReserves} 个
									</TableCell>
									<TableCell data-label="占用">
										<Quantities values={data.budget.reserveUsage} />
									</TableCell>
								</TableRow>
								<TableRow>
									<TableCell data-label="口径">
										{data.budget.sessionRequestCoverage
											? "会话申请占用"
											: "会话占账"}{" "}
										· {data.budget.counts.sessions} 个
									</TableCell>
									<TableCell data-label="占用">
										<Quantities values={data.budget.sessionUsage} />
									</TableCell>
								</TableRow>
								<TableRow>
									<TableCell data-label="口径">归属待核实</TableCell>
									<TableCell data-label="占用">
										<Quantities values={data.budget.unknownUsage} />
									</TableCell>
								</TableRow>
							</TableBody>
						</Table>
						<p className="ops-resource-note">
							保留存储 {data.budget.counts.retainedStorage} 项。
							{data.budget.sessionRequestCoverage
								? "会话申请或预算记录有缺口"
								: "成本记录缺失或无效"}{" "}
							{data.budget.unaccountedCount} 项。
							{data.budget.sessionRequestCoverage && (
								<>
									申请量覆盖（会话数） CPU{" "}
									{data.budget.sessionRequestCoverage.cpuCores}/
									{data.budget.counts.sessions}，内存{" "}
									{data.budget.sessionRequestCoverage.memoryBytes}/
									{data.budget.counts.sessions}，存储{" "}
									{data.budget.sessionRequestCoverage.storageBytes}/
									{data.budget.counts.sessions}。
									{data.budget.sessionRequestCoverage.unscopedSessions > 0 &&
										` 另有 ${data.budget.sessionRequestCoverage.unscopedSessions} 个会话的部署归属待确认，未纳入覆盖分母。`}
								</>
							)}
						</p>
					</>
				) : (
					<p>平台预算数据未取得。</p>
				)}
				{data.quotas.length ? (
					data.quotas.map((quota) => (
						<div
							key={quota.uid}
							id={`resource-${encodeURIComponent(quota.uid)}`}
						>
							<h3>{quota.name}</h3>
							<dl className="review-facts">
								{quota.values.map((entry) => (
									<div className="ops-fact-row" key={entry.resource}>
										<dt>{entry.resource}</dt>
										<dd>
											{entry.used ?? "未知"} / {entry.hard} {entry.unit}
										</dd>
									</div>
								))}
							</dl>
						</div>
					))
				) : (
					<p>
						ResourceQuota：
						{data.sources.find((source) => source.kind === "kubernetes")
							?.state === "available"
							? "未配置"
							: "未知"}
						。云资源配额仍需从批准的云数据源核实。
					</p>
				)}
			</Panel>
			<Panel title="PostgreSQL 连接" id="ops-database">
				{data.database ? (
					<>
						<dl className="review-facts">
							<dt>API 账号连接</dt>
							<dd>
								{data.database.connections}（活跃 {data.database.active} / 空闲{" "}
								{data.database.idle}）
							</dd>
							<dt>事务内空闲 / 锁等待</dt>
							<dd>
								{data.database.idleInTransaction} / {data.database.lockWaiting}
							</dd>
							<dt>账号连接上限</dt>
							<dd>{data.database.roleConnectionLimit ?? "未单独限制"}</dd>
							<dt>当前数据库 / 服务端上限</dt>
							<dd>
								{data.database.databaseConnections} /{" "}
								{data.database.maxConnections}
							</dd>
							<dt>采样时间</dt>
							<dd>
								<Timestamp value={data.database.observedAt} />
							</dd>
						</dl>
						<p className="ops-resource-note">
							包含观测查询自身。服务端上限可能由多个数据库共享；不返回 SQL
							或其他会话内容。
						</p>
					</>
				) : (
					<p>数据库连接汇总未知。</p>
				)}
			</Panel>
			<Panel title="Agent 资源排行" id="ops-agents">
				<div className="ops-resource-filters">
					<Button
						variant="outline"
						onClick={() => onSelectAgent("")}
						aria-pressed={!agentId}
					>
						全部 Agent
					</Button>
					<div>
						<Label htmlFor={`${id}-session`}>会话</Label>
						<NativeSelect
							id={`${id}-session`}
							value={sessionId}
							onChange={(event) => onSelectSession(event.target.value)}
						>
							<NativeSelectOption value="">全部会话</NativeSelectOption>
							{sessions.map((session) => (
								<NativeSelectOption key={session} value={session}>
									{session}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
				</div>
				{data.agents.length ? (
					<Table mobileLayout="cards">
						<TableHeader>
							<TableRow>
								<TableHead>Agent</TableHead>
								<TableHead>CPU 实测</TableHead>
								<TableHead>内存实测</TableHead>
								<TableHead>存储实测 / 申请</TableHead>
								<TableHead>实例</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.agents.map((agent) => (
								<TableRow key={agent.agentId}>
									<TableCell data-label="Agent">
										<Button
											variant="link"
											onClick={() => onSelectAgent(agent.agentId)}
										>
											{agent.name}
										</Button>
										<small>{agent.agentId}</small>
									</TableCell>
									<TableCell data-label="CPU 实测">
										{resourceNumber(agent.usage.cpuCores, "cpu")}
									</TableCell>
									<TableCell data-label="内存实测">
										{resourceNumber(agent.usage.memoryBytes, "bytes")}
									</TableCell>
									<TableCell data-label="存储">
										{resourceNumber(agent.usage.storageBytes, "bytes")} /{" "}
										{resourceNumber(agent.requests.storageBytes, "bytes")}
									</TableCell>
									<TableCell data-label="实例">
										{agent.sessions} 会话 · {agent.pods} Pod · {agent.volumes}{" "}
										PVC
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				) : (
					<p>当前范围没有已确认归属的 Agent 样本。</p>
				)}
			</Panel>
			<Panel title="运行实例与保留存储" id="ops-resources">
				<p className="ops-resource-note">
					共享组件、备用实例和归属未知的资源单列。展开对象可看容器与声明；缺失实测标为未知。
				</p>
				<div className="ops-resource-list">
					{data.resources.slice(0, visible).map((resource) => (
						<Collapsible
							key={resource.uid}
							id={`resource-${encodeURIComponent(resource.uid)}`}
						>
							<CollapsibleTrigger className="ops-disclosure-trigger">
								<span className="ops-resource-name">
									{resource.name}
									<small>
										{roleNames[resource.role]} ·{" "}
										{ownershipNames[resource.ownership]}
										{resource.retainedStorage ? " · 保留存储" : ""}
									</small>
								</span>
								<span>
									{resourceNumber(resource.usage.cpuCores, "cpu")} ·{" "}
									{resourceNumber(resource.usage.memoryBytes, "bytes")}
								</span>
								<Badge tone={resource.reason ? "amber" : "gray"}>
									{resource.reason ?? resource.phase}
								</Badge>
							</CollapsibleTrigger>
							<CollapsiblePanel>
								<div className="ops-resource-detail">
									<dl className="review-facts">
										<dt>对象 UID</dt>
										<dd>{resource.uid}</dd>
										<dt>Agent / 会话</dt>
										<dd>
											{resource.agentName ?? resource.agentId ?? "未知"} /{" "}
											{resource.sessionId ?? "不适用"}
										</dd>
										<dt>计算放置</dt>
										<dd>{placementNames[resource.placement ?? "unknown"]}</dd>
										<dt>归属原因</dt>
										<dd>
											{resource.ownershipReason ??
												(resource.ownership === "unknown" ? "未知" : "不适用")}
										</dd>
										<dt>Sandbox</dt>
										<dd>{resource.sandboxId ?? "不适用"}</dd>
										<dt>采样时间</dt>
										<dd>
											<Timestamp value={resource.observedAt} />
										</dd>
										<dt>申请量</dt>
										<dd>
											<Quantities values={resource.requests} ephemeral />
										</dd>
										<dt>资源上限</dt>
										<dd>
											<Quantities values={resource.limits} ephemeral />
										</dd>
										<dt>存储实测</dt>
										<dd>
											{resourceNumber(resource.usage.storageBytes, "bytes")}
										</dd>
										<dt>临时盘实测</dt>
										<dd>
											{resourceNumber(
												resource.usage.ephemeralStorageBytes,
												"bytes",
											)}
										</dd>
									</dl>
									{resource.containers.length > 0 && (
										<Table mobileLayout="cards">
											<TableHeader>
												<TableRow>
													<TableHead>容器</TableHead>
													<TableHead>实测 CPU / 内存</TableHead>
													<TableHead>状态 / 重启</TableHead>
												</TableRow>
											</TableHeader>
											<TableBody>
												{resource.containers.map((container) => (
													<TableRow key={container.name}>
														<TableCell data-label="容器">
															{container.name}
															<small>{container.role}</small>
															<small>声明镜像：{container.image}</small>
															<small>
																实际镜像：{container.imageId ?? "未知"}
															</small>
														</TableCell>
														<TableCell data-label="实测">
															{resourceNumber(container.usage.cpuCores, "cpu")}{" "}
															/{" "}
															{resourceNumber(
																container.usage.memoryBytes,
																"bytes",
															)}
														</TableCell>
														<TableCell data-label="状态">
															{container.reason ?? container.state} ·{" "}
															{container.restarts} 次
														</TableCell>
													</TableRow>
												))}
											</TableBody>
										</Table>
									)}
								</div>
							</CollapsiblePanel>
						</Collapsible>
					))}
				</div>
				{!data.resources.length && <p>当前范围暂无运行对象样本。</p>}
				{data.resources.length > visible && (
					<Button
						variant="outline"
						onClick={() => setVisible((value) => value + 50)}
					>
						再显示 50 个对象
					</Button>
				)}
			</Panel>
			<Panel title="镜像缓存与启动证据" id="ops-cache">
				<p>
					库存{" "}
					{data.sources.find((source) => source.kind === "image-cache")
						?.state === "available"
						? data.imageCaches.length
						: "未知"}{" "}
					项。缓存就绪、镜像覆盖和实际命中分别核对。
				</p>
				{data.imageCaches.map((cache) => (
					<Collapsible
						key={cache.uid}
						id={`resource-${encodeURIComponent(cache.uid)}`}
					>
						<CollapsibleTrigger className="ops-disclosure-trigger">
							{cache.name} · {cache.phase}
							{cache.deleting ? " · 删除中" : ""}
						</CollapsibleTrigger>
						<CollapsiblePanel>
							<dl className="review-facts">
								<dt>缓存 ID</dt>
								<dd>{cache.cacheId ?? "未知"}</dd>
								<dt>所属库存上限</dt>
								<dd>
									{cache.owner} / {cache.inventoryLimit ?? "未知"}
								</dd>
								<dt>到期时间</dt>
								<dd>
									{cache.expiresAt ? (
										<Timestamp value={cache.expiresAt} />
									) : (
										"未知"
									)}
								</dd>
								<dt>镜像</dt>
								<dd>
									{cache.images.map((image) => (
										<div key={image}>{image}</div>
									))}
								</dd>
							</dl>
						</CollapsiblePanel>
					</Collapsible>
				))}
				{data.cacheEvidence.length > 0 && (
					<ul className="ops-evidence-list">
						{data.cacheEvidence.slice(0, 50).map((entry) => (
							<li key={entry.podUid}>
								<a href={`#resource-${encodeURIComponent(entry.podUid)}`}>
									{entry.podName}
								</a>
								<span>
									{coverageNames[entry.coverage]} · {hitNames[entry.hit]} ·
									Cache ID {entry.cacheId ?? "未知"}
								</span>
							</li>
						))}
					</ul>
				)}
				{data.events.length > 0 && (
					<Collapsible>
						<CollapsibleTrigger className="ops-disclosure-trigger">
							运行事件（{data.events.length}）
						</CollapsibleTrigger>
						<CollapsiblePanel>
							<ul className="ops-evidence-list">
								{data.events.slice(0, 100).map((event) => (
									<li key={event.uid}>
										<span>
											{event.objectName} · {event.reason} · {event.count} 次 ·{" "}
											{event.source === "container-status"
												? "容器终止记录"
												: "集群事件"}
										</span>
										{event.lastAt && <Timestamp value={event.lastAt} />}
									</li>
								))}
							</ul>
						</CollapsiblePanel>
					</Collapsible>
				)}
			</Panel>
			{history}
			<Panel title="观测来源与数据时效" id="ops-sources">
				<ul className="ops-source-list">
					{data.sources.map((source) => (
						<li key={source.kind}>
							<strong>{sourceNames[source.kind]}</strong>
							<Badge
								tone={
									source.state === "available"
										? "green"
										: source.state === "unavailable" || source.state === "stale"
											? "amber"
											: "gray"
								}
							>
								{stateNames[source.state]}
							</Badge>
							<span>
								{source.observedAt ? (
									<>
										最后有效采样{" "}
										<Timestamp value={source.observedAt} style="absolute" />
									</>
								) : (
									"尚无有效采样时间"
								)}
								{(source.state === "missing" ||
									source.state === "unavailable") &&
									sourceOutages.has(source.kind) && (
										<>
											{" "}
											· 首次发现异常{" "}
											<Timestamp
												value={sourceOutages.get(source.kind)}
												style="absolute"
											/>
										</>
									)}
							</span>
						</li>
					))}
				</ul>
				<p className="ops-resource-note">
					保留目标：细粒度指标 {data.retention.target.detailDays} 天、聚合趋势{" "}
					{data.retention.target.aggregateDays} 天，日志 / Trace 各{" "}
					{data.retention.target.logDays} / {data.retention.target.traceDays}{" "}
					天。
					{data.retention.configured && (
						<span>
							部署声明：细粒度 {data.retention.configured.detailDays ?? "未知"}{" "}
							天、聚合 {data.retention.configured.aggregateDays ?? "未知"} 天（
							{data.retention.configured.aggregateStepSeconds ?? "未知"}{" "}
							秒），日志 / Trace {data.retention.configured.logDays ?? "未知"} /{" "}
							{data.retention.configured.traceDays ?? "未知"}{" "}
							天。声明不代表后端已验证。
						</span>
					)}
					{data.retention.effective
						? "实际保留策略已声明。"
						: "实际保留范围尚待数据源确认。"}
				</p>
				<ul className="ops-resource-sources">
					{(data.errorRates ?? []).map((entry) => (
						<li key={entry.stage}>
							<span>
								{entry.stage} 错误率（{entry.windowSeconds} 秒窗口）
							</span>
							<span>
								{entry.ratio === null
									? "无有效采样"
									: `${(entry.ratio * 100).toFixed(1)}%`}
							</span>
							{entry.observedAt && <Timestamp value={entry.observedAt} />}
						</li>
					))}
				</ul>
				{data.links.map((link) => (
					<a key={link.kind} href={link.url} target="_blank" rel="noreferrer">
						打开
						{link.kind === "logs"
							? "日志"
							: link.kind === "traces"
								? "Trace"
								: "指标"}
						查询 ↗
					</a>
				))}
			</Panel>
		</section>
	);
}
