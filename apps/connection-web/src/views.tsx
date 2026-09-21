import type {
	Connection,
	Consumer,
	IssuedToken,
	TokenRecord,
} from "@agent-infra/connection-contracts";
import {
	BookOpen,
	Boxes,
	Code2,
	Copy,
	GitBranch,
	KeyRound,
	Link2,
	LogIn,
	RefreshCw,
	Search,
	ShieldCheck,
	SlidersHorizontal,
	Trash2,
} from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";

export function LoginView(props: {
	busy: boolean;
	error: string | null;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
	return (
		<main className="login-layout">
			<section className="login-brand" aria-label="Connection">
				<div className="brand-lockup">
					<span className="brand-mark" aria-hidden="true">
						C
					</span>
					<span>Connection</span>
				</div>
				<p>统一管理你的外部账号、访问授权和 AI 客户端连接。</p>
			</section>
			<section className="login-panel" aria-labelledby="login-title">
				<div>
					<h1 id="login-title">登录 Connection</h1>
					<p className="lead">使用公司账号继续。</p>
				</div>
				{props.error ? (
					<p className="alert alert-error" role="alert">
						{props.error}
					</p>
				) : null}
				<form className="form-stack" onSubmit={props.onSubmit}>
					<label htmlFor="username">公司账号</label>
					<input
						id="username"
						name="username"
						type="text"
						autoComplete="username"
						maxLength={256}
						required
					/>
					<label htmlFor="password">密码</label>
					<input
						id="password"
						name="password"
						type="password"
						autoComplete="current-password"
						maxLength={1024}
						required
					/>
					<button
						className="button button-primary"
						type="submit"
						disabled={props.busy}
					>
						<LogIn aria-hidden="true" size={17} />
						{props.busy ? "正在登录" : "登录"}
					</button>
				</form>
			</section>
		</main>
	);
}

export function PageHeader(props: { action?: ReactNode; title: string }) {
	return (
		<header className="page-header">
			<h1>{props.title}</h1>
			{props.action}
		</header>
	);
}

export function EmptyState(props: { children: ReactNode; title: string }) {
	return (
		<div className="empty-state">
			<h2>{props.title}</h2>
			<p>{props.children}</p>
		</div>
	);
}

export function TokensView(props: {
	busy: boolean;
	consumers: Consumer[];
	issued: IssuedToken | null;
	onCopy?: () => void;
	onIssue: (event: FormEvent<HTMLFormElement>) => void;
	onRevoke: (tokenId: string) => void;
	tokens: TokenRecord[];
}) {
	return (
		<div className="content-stack">
			<section className="toolbar-section">
				<form className="inline-form" onSubmit={props.onIssue}>
					<div>
						<label htmlFor="token-consumer">客户端</label>
						<select id="token-consumer" name="consumerId" required>
							{props.consumers.map((consumer) => (
								<option key={consumer.id} value={consumer.id}>
									{consumer.name}
								</option>
							))}
						</select>
					</div>
					<div className="field-grow">
						<label htmlFor="token-name">令牌名称</label>
						<input
							id="token-name"
							name="name"
							maxLength={100}
							placeholder="例如：Codex 本机"
							required
						/>
					</div>
					<button
						className="button button-primary"
						type="submit"
						disabled={props.busy}
					>
						<KeyRound aria-hidden="true" size={17} />
						{props.busy ? "正在签发" : "签发令牌"}
					</button>
				</form>
			</section>

			{props.issued ? (
				<section className="secret-callout" aria-live="polite">
					<div>
						<h2>令牌已签发，只显示一次</h2>
						<p>离开本页后将无法再次查看明文。</p>
					</div>
					<code>{props.issued.token}</code>
					{props.onCopy ? (
						<button
							className="button button-secondary"
							type="button"
							onClick={props.onCopy}
						>
							<Copy aria-hidden="true" size={16} />
							复制
						</button>
					) : null}
				</section>
			) : null}

			<section className="data-section" aria-labelledby="tokens-title">
				<div className="section-heading">
					<div>
						<h2 id="tokens-title">访问令牌</h2>
						<p>为不同客户端分别签发，便于独立撤销和审计。</p>
					</div>
				</div>
				{props.tokens.length ? (
					<div className="table-scroll">
						<table>
							<thead>
								<tr>
									<th>名称</th>
									<th>客户端</th>
									<th>状态</th>
									<th>创建时间</th>
									<th>到期时间</th>
									<th className="table-action">操作</th>
								</tr>
							</thead>
							<tbody>
								{props.tokens.map((token) => (
									<tr key={token.tokenId}>
										<td className="primary-cell">{token.name}</td>
										<td>{token.consumerName}</td>
										<td>
											<Status value={token.status} />
										</td>
										<td>{formatTime(token.createdAt)}</td>
										<td>{formatTime(token.expiresAt)}</td>
										<td className="table-action">
											<button
												className="icon-button danger"
												type="button"
												onClick={() => props.onRevoke(token.tokenId)}
												aria-label={`撤销 ${token.name}`}
												title="撤销令牌"
											>
												<Trash2 aria-hidden="true" size={17} />
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<EmptyState title="还没有访问令牌">
						签发一个令牌后，它会显示在这里。
					</EmptyState>
				)}
			</section>
		</div>
	);
}

export function ConnectionsView(props: {
	connections: Connection[];
	onAuthorize: (connectionId: string) => void;
	onDisconnect: (connectionId: string) => void;
	onReconnect: (connectionId: string) => void;
	onUpgrade: (connectionId: string) => void;
	upgradingConnectionId?: string | null;
}) {
	if (!props.connections.length) {
		return (
			<EmptyState title="还没有 Connection">
				连接 GitHub、公司 Atlassian 或 Jenkins 账号后即可授权给你的客户端。
			</EmptyState>
		);
	}
	return (
		<div className="connection-list">
			{props.connections.map((connection) => {
				const upgrading = props.upgradingConnectionId === connection.id;
				const versions = [
					...new Set(
						connection.actionVersionIds.flatMap((id) => {
							const version = id.match(/@(v\d+)$/)?.[1];
							return version ? [version] : [];
						}),
					),
				];
				return (
					<article className="connection-row" key={connection.id}>
						<div className="connection-icon" aria-hidden="true">
							<Link2 size={20} />
						</div>
						<div className="connection-main">
							<div className="connection-title-line">
								<h2>{connection.displayName}</h2>
								<span className="ownership-badge">
									{providerLabel(connection.providerId)}
								</span>
								<span className="ownership-badge">
									{connection.ownerType === "PERSONAL" ? "个人" : "共享"}
								</span>
							</div>
							<p>{connection.externalAccount}</p>
							{versions.length ? <p>授权版本 {versions.join(", ")}</p> : null}
							{connection.requiresReconnect ? (
								<p role="alert">
									Provider 已升级。请先
									{connection.providerId === "github" ? "重新连接" : "升级连接"}
									，再确认新增授权。
								</p>
							) : null}
						</div>
						<Status value={connection.status} />
						<div className="row-actions">
							{connection.requiresReconnect ? (
								<button
									className="button button-secondary"
									disabled={upgrading}
									type="button"
									onClick={() =>
										connection.providerId === "github"
											? props.onReconnect(connection.id)
											: props.onUpgrade(connection.id)
									}
								>
									<RefreshCw aria-hidden="true" size={16} />
									{connection.providerId === "github"
										? "重新连接"
										: upgrading
											? "正在升级"
											: "升级连接"}
								</button>
							) : (
								<button
									className="button button-secondary"
									type="button"
									onClick={() => props.onAuthorize(connection.id)}
								>
									<ShieldCheck aria-hidden="true" size={16} />
									授权客户端
								</button>
							)}
							{connection.requiresReconnect &&
							connection.ownerType === "PERSONAL" ? (
								<button
									className="button button-secondary"
									type="button"
									onClick={() => props.onReconnect(connection.id)}
								>
									更新凭证
								</button>
							) : null}
							{connection.ownerType === "PERSONAL" ? (
								<button
									className="icon-button danger"
									type="button"
									onClick={() => props.onDisconnect(connection.id)}
									aria-label={`断开 ${connection.displayName}`}
									title="断开 Connection"
								>
									<Trash2 aria-hidden="true" size={17} />
								</button>
							) : null}
						</div>
					</article>
				);
			})}
		</div>
	);
}

export type ConnectorProviderId =
	| "bitbucket"
	| "confluence"
	| "github"
	| "jenkins-ci"
	| "jenkins-release"
	| "jira";

const connectorDefinitions: Array<{
	category: "代码托管" | "研发协作" | "知识库" | "CI/CD";
	description: string;
	icon: typeof Boxes;
	name: string;
	providerId: ConnectorProviderId;
}> = [
	{
		category: "代码托管",
		description: "仓库、Issue 与 Pull Request",
		icon: Code2,
		name: "GitHub",
		providerId: "github",
	},
	{
		category: "代码托管",
		description: "公司仓库与 Pull Request",
		icon: GitBranch,
		name: "Bitbucket",
		providerId: "bitbucket",
	},
	{
		category: "研发协作",
		description: "Issue、项目与研发流程",
		icon: KeyRound,
		name: "Jira",
		providerId: "jira",
	},
	{
		category: "知识库",
		description: "空间、页面与团队知识",
		icon: BookOpen,
		name: "Confluence",
		providerId: "confluence",
	},
	{
		category: "CI/CD",
		description: "发布 Job、Build 与 Queue",
		icon: SlidersHorizontal,
		name: "Jenkins Release",
		providerId: "jenkins-release",
	},
	{
		category: "CI/CD",
		description: "研发 Job、Build 与 Console",
		icon: SlidersHorizontal,
		name: "Jenkins CI",
		providerId: "jenkins-ci",
	},
];

export function ConnectorCatalog(props: {
	connections: Connection[];
	onConnect: (providerId: ConnectorProviderId) => void;
}) {
	const [category, setCategory] = useState("全部");
	const [query, setQuery] = useState("");
	const categories = ["全部", "代码托管", "研发协作", "知识库", "CI/CD"];
	const visibleConnectors = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return connectorDefinitions.filter(
			(connector) =>
				(category === "全部" || connector.category === category) &&
				(!normalized ||
					`${connector.name} ${connector.category} ${connector.description}`
						.toLowerCase()
						.includes(normalized)),
		);
	}, [category, query]);

	return (
		<section className="connector-workspace" aria-labelledby="connector-title">
			<aside className="connector-catalog-sidebar">
				<label className="connector-search" htmlFor="connector-search">
					<Search aria-hidden="true" size={17} />
					<span className="sr-only">搜索连接器</span>
					<input
						id="connector-search"
						maxLength={120}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="搜索连接器"
						type="search"
						value={query}
					/>
				</label>
				<nav aria-label="连接器分类" className="connector-categories">
					{categories.map((item) => {
						const count =
							item === "全部"
								? connectorDefinitions.length
								: connectorDefinitions.filter(
										(connector) => connector.category === item,
									).length;
						return (
							<button
								aria-pressed={category === item}
								className="connector-category"
								key={item}
								onClick={() => setCategory(item)}
								type="button"
							>
								<span>{item}</span>
								<small>{count}</small>
							</button>
						);
					})}
				</nav>
			</aside>
			<div className="connector-catalog-main">
				<div className="connector-catalog-heading">
					<div>
						<h2 id="connector-title">
							{query ? `“${query}” 的结果` : `${category}连接器`}
						</h2>
						<p>选择服务后进入对应的安全连接流程。</p>
					</div>
					<span className="connector-result-count">
						{visibleConnectors.length} 个
					</span>
				</div>
				{visibleConnectors.length ? (
					<div className="connector-grid">
						{visibleConnectors.map((connector) => {
							const connectionCount = props.connections.filter(
								(connection) =>
									connection.providerId === connector.providerId &&
									connection.status === "ACTIVE",
							).length;
							const Icon = connector.icon;
							return (
								<article className="connector-card" key={connector.providerId}>
									<div className="connector-logo" aria-hidden="true">
										<Icon size={20} />
									</div>
									<div className="connector-card-copy">
										<h3>{connector.name}</h3>
										<p>{connector.description}</p>
										<span>
											{connectionCount
												? `已连接 ${connectionCount} 个账号`
												: connector.category}
										</span>
									</div>
									<button
										aria-label={`连接 ${connector.name}`}
										className={`button ${connectionCount ? "button-secondary" : "button-primary"}`}
										onClick={() => props.onConnect(connector.providerId)}
										type="button"
									>
										{connectionCount ? "再连接" : "连接"}
									</button>
								</article>
							);
						})}
					</div>
				) : (
					<div className="connector-empty">
						<Boxes aria-hidden="true" size={22} />
						<strong>没有匹配的连接器</strong>
						<p>尝试搜索名称或切换分类。</p>
					</div>
				)}
			</div>
		</section>
	);
}

export function Status(props: { value: string }) {
	const active = props.value === "ACTIVE";
	return (
		<span className={`status ${active ? "status-active" : "status-muted"}`}>
			{active ? "正常" : statusLabel(props.value)}
		</span>
	);
}

function statusLabel(value: string) {
	return (
		{
			DISCONNECTED: "已断开",
			DISABLED: "已停用",
			PAUSED_CONNECTION: "Connection 已暂停",
			PAUSED_CREDENTIAL: "凭证已暂停",
			REPLACED: "已被替换",
			REVOKED: "已撤销",
			SUSPENDED: "已暂停",
			TERMINATED: "已终止",
		}[value] ?? value
	);
}

export function providerLabel(value: string) {
	return (
		{
			bitbucket: "Bitbucket",
			confluence: "Confluence",
			github: "GitHub",
			"jenkins-ci": "Jenkins CI",
			"jenkins-release": "Jenkins Release",
			jira: "Jira",
		}[value] ?? value
	);
}

function formatTime(value: string) {
	return new Intl.DateTimeFormat("zh-CN", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}
